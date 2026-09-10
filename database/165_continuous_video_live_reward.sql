-- Require one uninterrupted 60-minute VIDEO session for the daily host reward.
-- Progress resets at Asia/Dhaka midnight and whenever heartbeats have a gap
-- longer than 50 seconds. Audio streams never accrue eligible time.

ALTER TABLE public.live_streams
  ADD COLUMN IF NOT EXISTS reward_continuous_seconds BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reward_last_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reward_progress_date DATE;

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
  v_now TIMESTAMPTZ := NOW();
  v_date DATE := (NOW() AT TIME ZONE 'Asia/Dhaka')::DATE;
  v_delta_seconds BIGINT := 0;
  v_seconds BIGINT := 0;
  v_cfg JSONB;
  v_enabled BOOLEAN;
  v_beans BIGINT;
  v_minutes INT;
  v_award BOOLEAN := FALSE;
BEGIN
  SELECT *
    INTO v_stream
    FROM public.live_streams
   WHERE id = p_stream_id
     AND status = 'live'
   FOR UPDATE;

  IF v_stream.id IS NULL THEN
    RETURN json_build_object('success', FALSE, 'message', 'Stream is not live');
  END IF;
  IF v_stream.broadcaster_id <> me THEN
    RETURN json_build_object('success', FALSE, 'message', 'Not your stream');
  END IF;

  IF COALESCE(v_stream.type, 'video') = 'video' THEN
    IF v_stream.reward_progress_date IS DISTINCT FROM v_date THEN
      v_seconds := 0;
    ELSIF v_stream.reward_last_heartbeat_at IS NOT NULL THEN
      v_delta_seconds := GREATEST(0, EXTRACT(EPOCH FROM (v_now - v_stream.reward_last_heartbeat_at))::BIGINT);
      IF v_delta_seconds BETWEEN 1 AND 50 THEN
        v_seconds := v_stream.reward_continuous_seconds + v_delta_seconds;
      ELSE
        -- Backgrounding, disconnecting, or ending/restarting breaks continuity.
        v_seconds := 0;
      END IF;
    ELSE
      v_seconds := 0;
    END IF;
  END IF;

  UPDATE public.live_streams
     SET last_heartbeat_at = v_now,
         peak_viewers = GREATEST(COALESCE(peak_viewers, 0), COALESCE(p_viewer_count, 0)),
         current_viewers = COALESCE(p_current_viewers, current_viewers),
         reward_continuous_seconds = CASE WHEN COALESCE(v_stream.type, 'video') = 'video' THEN v_seconds ELSE 0 END,
         reward_last_heartbeat_at = CASE WHEN COALESCE(v_stream.type, 'video') = 'video' THEN v_now ELSE NULL END,
         reward_progress_date = CASE WHEN COALESCE(v_stream.type, 'video') = 'video' THEN v_date ELSE NULL END
   WHERE id = p_stream_id;

  IF COALESCE(v_stream.type, 'video') <> 'video' THEN
    RETURN json_build_object(
      'success', TRUE,
      'live_type', COALESCE(v_stream.type, 'audio'),
      'reward_date', v_date,
      'eligible_seconds', 0,
      'rewarded_now', FALSE
    );
  END IF;

  SELECT value INTO v_cfg FROM public.system_settings WHERE key = 'host_hour_reward';
  v_enabled := COALESCE((v_cfg->>'enabled')::BOOLEAN, TRUE);
  v_beans := GREATEST(0, COALESCE((v_cfg->>'beans')::BIGINT, 6000));
  v_minutes := GREATEST(1, COALESCE((v_cfg->>'minutes')::INT, 60));

  INSERT INTO public.host_daily_live_rewards(user_id, reward_date, eligible_seconds)
  VALUES (me, v_date, v_seconds)
  ON CONFLICT (user_id, reward_date)
  DO UPDATE SET
    eligible_seconds = CASE
      WHEN host_daily_live_rewards.rewarded_at IS NULL THEN EXCLUDED.eligible_seconds
      ELSE host_daily_live_rewards.eligible_seconds
    END,
    updated_at = v_now;

  IF v_enabled AND v_seconds >= v_minutes * 60 THEN
    UPDATE public.host_daily_live_rewards
       SET reward_beans = v_beans,
           rewarded_at = v_now,
           updated_at = v_now
     WHERE user_id = me
       AND reward_date = v_date
       AND rewarded_at IS NULL;

    IF FOUND THEN
      UPDATE public.profiles
         SET beans = COALESCE(beans, 0) + v_beans
       WHERE id = me;

      INSERT INTO public.transactions(user_id, type, currency, amount, status, notes)
      VALUES (
        me, 'live_hour_reward', 'bean', v_beans, 'completed',
        'Daily continuous video live reward (Asia/Dhaka ' || v_date || ')'
      );

      INSERT INTO public.notifications(user_id, type, title, body, payload)
      VALUES (
        me, 'task_reward', 'Daily live reward',
        '+' || v_beans || ' beans added to your wallet',
        jsonb_build_object(
          'reward', v_beans,
          'eligible_seconds', v_seconds,
          'reward_date', v_date,
          'live_type', 'video',
          'continuous', TRUE
        )
      );
      v_award := TRUE;
    END IF;
  END IF;

  RETURN json_build_object(
    'success', TRUE,
    'live_type', 'video',
    'reward_date', v_date,
    'eligible_seconds', v_seconds,
    'rewarded_now', v_award
  );
END $$;

GRANT EXECUTE ON FUNCTION public.live_stream_heartbeat(UUID, INT, INT) TO authenticated;

