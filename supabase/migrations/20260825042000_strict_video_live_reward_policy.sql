-- Strict host reward policy.
-- Audio earns nothing. Video earns once per Dhaka day after 3,600
-- server-measured continuous seconds on one stream.

ALTER TABLE public.live_streams
  ADD COLUMN IF NOT EXISTS reward_continuous_seconds BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reward_last_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reward_progress_date DATE;

CREATE TABLE IF NOT EXISTS public.host_daily_live_rewards (
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reward_date DATE NOT NULL,
  eligible_seconds BIGINT NOT NULL DEFAULT 0,
  reward_beans BIGINT NOT NULL DEFAULT 0,
  rewarded_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, reward_date)
);

ALTER TABLE public.host_daily_live_rewards
  ADD COLUMN IF NOT EXISTS source_stream_id UUID;

ALTER TABLE public.host_daily_live_rewards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS host_reward_own_read ON public.host_daily_live_rewards;
CREATE POLICY host_reward_own_read ON public.host_daily_live_rewards
  FOR SELECT USING (user_id = auth.uid() OR public.is_admin(auth.uid()));

INSERT INTO public.system_settings(key, value)
VALUES ('host_hour_reward', jsonb_build_object('enabled', TRUE, 'beans', 5000, 'minutes', 60))
ON CONFLICT (key) DO UPDATE
SET value = COALESCE(public.system_settings.value, '{}'::JSONB)
  || jsonb_build_object('enabled', TRUE, 'minutes', 60);

-- Heartbeat is the only live-duration reward. Retain old progress for audit,
-- but retire every legacy host-live or explicit audio reward task.
UPDATE public.tasks
   SET is_active = FALSE, updated_at = NOW()
 WHERE (LOWER(COALESCE(audience, '')) = 'host' AND LOWER(COALESCE(action, '')) = 'live')
    OR LOWER(COALESCE(action, '')) IN ('audio', 'audio_live', 'live_audio')
    OR LOWER(COALESCE(id, '')) LIKE '%audio_live%'
    OR LOWER(COALESCE(title, '')) LIKE '%audio live%'
    OR LOWER(COALESCE(description, '')) LIKE '%audio live%';

-- The obsolete trigger counted elapsed audio and video minutes identically.
DROP TRIGGER IF EXISTS trg_live_task_progress ON public.live_streams;

CREATE OR REPLACE FUNCTION public.live_stream_heartbeat(
  p_stream_id UUID,
  p_viewer_count INT DEFAULT NULL,
  p_current_viewers INT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  v_stream public.live_streams%ROWTYPE;
  v_now TIMESTAMPTZ := clock_timestamp();
  v_reward_date DATE := (v_now AT TIME ZONE 'Asia/Dhaka')::DATE;
  v_day_start TIMESTAMPTZ := (v_reward_date::TIMESTAMP AT TIME ZONE 'Asia/Dhaka');
  v_stream_type TEXT;
  v_delta_seconds BIGINT := 0;
  v_seconds BIGINT := 0;
  v_previous_date_rewarded BOOLEAN := FALSE;
  v_cfg JSONB;
  v_enabled BOOLEAN := TRUE;
  v_beans BIGINT := 5000;
  v_awarded BOOLEAN := FALSE;
  v_new_balance BIGINT;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', FALSE, 'message', 'Not authenticated');
  END IF;

  SELECT * INTO v_stream
    FROM public.live_streams
   WHERE id = p_stream_id AND status = 'live'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', FALSE, 'message', 'Stream is not live');
  END IF;
  IF v_stream.broadcaster_id <> me THEN
    RETURN json_build_object('success', FALSE, 'message', 'Not your stream');
  END IF;

  v_stream_type := LOWER(BTRIM(COALESCE(v_stream.type, '')));

  IF v_stream_type = 'video' THEN
    IF v_stream.reward_last_heartbeat_at IS NULL THEN
      v_seconds := 0;
    ELSE
      v_delta_seconds := GREATEST(
        0,
        FLOOR(EXTRACT(EPOCH FROM (v_now - v_stream.reward_last_heartbeat_at)))::BIGINT
      );
      IF v_delta_seconds > 45 THEN
        -- Background/disconnect/missed heartbeat starts a fresh attempt.
        v_seconds := 0;
      ELSIF v_stream.reward_progress_date IS DISTINCT FROM v_reward_date THEN
        -- Midnight is not a break. Carry an unfinished continuous attempt into
        -- the new Dhaka day. If yesterday already paid, however, the new day
        -- starts a fresh one-hour earning window at midnight.
        IF v_stream.reward_progress_date IS NOT NULL THEN
          SELECT EXISTS(
            SELECT 1 FROM public.host_daily_live_rewards AS previous_reward
            WHERE previous_reward.user_id = me
              AND previous_reward.reward_date = v_stream.reward_progress_date
              AND previous_reward.rewarded_at IS NOT NULL
          ) INTO v_previous_date_rewarded;
        END IF;
        IF v_previous_date_rewarded THEN
          v_seconds := GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (
              v_now - GREATEST(v_stream.reward_last_heartbeat_at, v_day_start)
            )))::BIGINT
          );
        ELSE
          v_seconds := v_stream.reward_continuous_seconds + v_delta_seconds;
        END IF;
      ELSIF v_delta_seconds = 0 THEN
        -- Duplicate/concurrent immediate pings preserve valid progress.
        v_seconds := v_stream.reward_continuous_seconds;
      ELSE
        v_seconds := v_stream.reward_continuous_seconds + v_delta_seconds;
      END IF;
    END IF;
  END IF;

  UPDATE public.live_streams
     SET last_heartbeat_at = v_now,
         peak_viewers = GREATEST(COALESCE(peak_viewers, 0), GREATEST(COALESCE(p_viewer_count, 0), 0)),
         current_viewers = CASE
           WHEN p_current_viewers IS NULL THEN current_viewers
           ELSE GREATEST(p_current_viewers, 0)
         END,
         reward_continuous_seconds = CASE WHEN v_stream_type = 'video' THEN v_seconds ELSE 0 END,
         reward_last_heartbeat_at = CASE WHEN v_stream_type = 'video' THEN v_now ELSE NULL END,
         reward_progress_date = CASE WHEN v_stream_type = 'video' THEN v_reward_date ELSE NULL END
   WHERE id = p_stream_id;

  IF v_stream_type <> 'video' THEN
    RETURN json_build_object(
      'success', TRUE, 'live_type', COALESCE(NULLIF(v_stream_type, ''), 'audio'),
      'reward_date', v_reward_date, 'eligible_seconds', 0,
      'rewarded_now', FALSE, 'eligible', FALSE
    );
  END IF;

  SELECT value INTO v_cfg FROM public.system_settings WHERE key = 'host_hour_reward';
  v_enabled := COALESCE((v_cfg->>'enabled')::BOOLEAN, TRUE);
  v_beans := GREATEST(0, COALESCE((v_cfg->>'beans')::BIGINT, 5000));

  INSERT INTO public.host_daily_live_rewards(
    user_id, reward_date, eligible_seconds, source_stream_id, updated_at
  ) VALUES (me, v_reward_date, v_seconds, p_stream_id, v_now)
  ON CONFLICT (user_id, reward_date) DO UPDATE
  SET eligible_seconds = CASE
        WHEN public.host_daily_live_rewards.rewarded_at IS NOT NULL
          THEN public.host_daily_live_rewards.eligible_seconds
        ELSE EXCLUDED.eligible_seconds
      END,
      source_stream_id = CASE
        WHEN public.host_daily_live_rewards.rewarded_at IS NOT NULL
          THEN public.host_daily_live_rewards.source_stream_id
        ELSE EXCLUDED.source_stream_id
      END,
      updated_at = v_now;

  -- Fixed boundary: configuration cannot lower the required hour.
  IF v_enabled AND v_beans > 0 AND v_seconds >= 3600 THEN
    UPDATE public.host_daily_live_rewards
       SET reward_beans = v_beans, rewarded_at = v_now,
           eligible_seconds = v_seconds, source_stream_id = p_stream_id,
           updated_at = v_now
     WHERE user_id = me AND reward_date = v_reward_date
       AND rewarded_at IS NULL;

    IF FOUND THEN
      v_new_balance := public.grant_reward(
        me, v_beans, 'bean', 'live_hour_reward',
        jsonb_build_object(
          'stream_id', p_stream_id, 'reward_date', v_reward_date,
          'live_type', 'video', 'continuous_seconds', v_seconds,
          'timezone', 'Asia/Dhaka'
        )
      );
      INSERT INTO public.notifications(user_id, type, title, body, payload)
      VALUES (
        me, 'task_reward', 'Daily video reward',
        '+' || v_beans || ' beans added to your wallet',
        jsonb_build_object(
          'reward', v_beans, 'currency', 'bean', 'new_balance', v_new_balance,
          'stream_id', p_stream_id, 'reward_date', v_reward_date,
          'live_type', 'video', 'continuous_seconds', v_seconds,
          'continuous', TRUE
        )
      );
      v_awarded := TRUE;
    END IF;
  END IF;

  RETURN json_build_object(
    'success', TRUE, 'live_type', 'video', 'reward_date', v_reward_date,
    'eligible_seconds', v_seconds, 'rewarded_now', v_awarded, 'eligible', TRUE
  );
END $$;

REVOKE EXECUTE ON FUNCTION public.live_stream_heartbeat(UUID, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.live_stream_heartbeat(UUID, INT, INT) TO authenticated;

-- Defense in depth: accidental catalogue re-enabling cannot reopen a claim.
CREATE OR REPLACE FUNCTION public.claim_task_reward(p_task_id TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  v_today DATE := (NOW() AT TIME ZONE 'UTC')::DATE;
  v_task public.tasks%ROWTYPE;
  v_progress public.user_task_progress%ROWTYPE;
  v_balance BIGINT;
  v_is_forbidden_live_reward BOOLEAN;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', FALSE, 'message', 'Not authenticated');
  END IF;
  SELECT * INTO v_task FROM public.tasks WHERE id = p_task_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', FALSE, 'message', 'Task not found');
  END IF;

  v_is_forbidden_live_reward :=
       (LOWER(COALESCE(v_task.audience, '')) = 'host' AND LOWER(COALESCE(v_task.action, '')) = 'live')
    OR LOWER(COALESCE(v_task.action, '')) IN ('audio', 'audio_live', 'live_audio')
    OR LOWER(COALESCE(v_task.id, '')) LIKE '%audio_live%'
    OR LOWER(COALESCE(v_task.title, '')) LIKE '%audio live%'
    OR LOWER(COALESCE(v_task.description, '')) LIKE '%audio live%';

  IF v_is_forbidden_live_reward THEN
    RETURN json_build_object(
      'success', FALSE,
      'message', 'Audio live and live-duration task rewards are disabled'
    );
  END IF;
  IF NOT COALESCE(v_task.is_active, FALSE) THEN
    RETURN json_build_object('success', FALSE, 'message', 'Task not found');
  END IF;

  SELECT * INTO v_progress
    FROM public.user_task_progress
   WHERE user_id = me AND task_id = p_task_id AND progress_date = v_today
   FOR UPDATE;

  IF NOT FOUND OR v_progress.count < v_task.target THEN
    RETURN json_build_object('success', FALSE, 'message', 'Not yet completed');
  END IF;
  IF v_progress.claimed_at IS NOT NULL THEN
    RETURN json_build_object('success', FALSE, 'message', 'Already claimed');
  END IF;

  v_balance := public.grant_reward(
    me, v_task.reward, v_task.reward_currency, 'task_reward',
    jsonb_build_object('task_id', p_task_id, 'date', v_today)
  );
  UPDATE public.user_task_progress
     SET claimed_at = NOW(), reward_paid = v_task.reward, updated_at = NOW()
   WHERE user_id = me AND task_id = p_task_id AND progress_date = v_today;

  RETURN json_build_object(
    'success', TRUE, 'reward', v_task.reward,
    'currency', v_task.reward_currency, 'new_balance', v_balance
  );
END $$;

REVOKE EXECUTE ON FUNCTION public.claim_task_reward(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_task_reward(TEXT) TO authenticated;
