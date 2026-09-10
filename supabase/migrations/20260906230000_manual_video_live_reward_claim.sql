-- Daily video-live reward becomes a manual claim, on cumulative time.
--
-- Two changes to the rule:
--
--  1. It is no longer credited automatically. live_stream_heartbeat only tracks
--     progress; the host collects it with claim_host_live_reward().
--  2. Eligibility is now the host's *total* video-live time for the Dhaka day,
--     not a single uninterrupted 60-minute session. The old logic reset
--     reward_continuous_seconds to 0 whenever a heartbeat gap broke continuity,
--     so a host who streamed 40 + 40 minutes earned nothing.
--
-- Audio live still earns nothing here - the reward is video-live only.
--
-- Time only accrues between heartbeats less than 45s apart, so a closed app or
-- a dead connection cannot bank offline time; that guard is kept from the
-- previous implementation.

-- Track claimability separately from the accrual so the UI can show progress.
ALTER TABLE public.host_daily_live_rewards
  ADD COLUMN IF NOT EXISTS claimable_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.host_live_reward_config()
RETURNS TABLE (enabled BOOLEAN, required_seconds BIGINT, beans BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((value->>'enabled')::BOOLEAN, TRUE),
         GREATEST(60, COALESCE((value->>'minutes')::BIGINT, 60) * 60),
         GREATEST(0,  COALESCE((value->>'beans')::BIGINT, 5000))
    FROM public.system_settings
   WHERE key = 'host_hour_reward'
  UNION ALL
  SELECT TRUE, 3600, 5000
   WHERE NOT EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'host_hour_reward')
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.live_stream_heartbeat(
  p_stream_id uuid,
  p_viewer_count integer DEFAULT NULL::integer,
  p_current_viewers integer DEFAULT NULL::integer
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  me                UUID := auth.uid();
  v_stream          public.live_streams%ROWTYPE;
  v_now             TIMESTAMPTZ := clock_timestamp();
  v_reward_date     DATE := (v_now AT TIME ZONE 'Asia/Dhaka')::DATE;
  v_stream_type     TEXT;
  v_delta_seconds   BIGINT := 0;
  v_day_seconds     BIGINT := 0;
  v_cfg             RECORD;
  v_claimed         BOOLEAN := FALSE;
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

  -- Only count the gap between two close-together heartbeats. A longer gap means
  -- the host was not actually streaming, so it contributes nothing.
  IF v_stream_type = 'video'
     AND v_stream.reward_last_heartbeat_at IS NOT NULL
     AND v_stream.reward_progress_date = v_reward_date THEN
    v_delta_seconds := FLOOR(EXTRACT(EPOCH FROM (v_now - v_stream.reward_last_heartbeat_at)))::BIGINT;
    IF v_delta_seconds < 0 OR v_delta_seconds > 45 THEN
      v_delta_seconds := 0;
    END IF;
  END IF;

  UPDATE public.live_streams
     SET last_heartbeat_at = v_now,
         peak_viewers = GREATEST(
           COALESCE(peak_viewers, 0),
           GREATEST(COALESCE(p_viewer_count, 0), 0)
         ),
         current_viewers = CASE
           WHEN p_current_viewers IS NULL THEN current_viewers
           ELSE GREATEST(p_current_viewers, 0)
         END,
         reward_continuous_seconds = CASE
           WHEN v_stream_type = 'video' THEN COALESCE(reward_continuous_seconds, 0) + v_delta_seconds
           ELSE 0
         END,
         reward_last_heartbeat_at = CASE WHEN v_stream_type = 'video' THEN v_now ELSE NULL END,
         reward_progress_date = CASE WHEN v_stream_type = 'video' THEN v_reward_date ELSE NULL END
   WHERE id = p_stream_id;

  IF v_stream_type <> 'video' THEN
    RETURN json_build_object(
      'success', TRUE,
      'live_type', COALESCE(NULLIF(v_stream_type, ''), 'audio'),
      'reward_date', v_reward_date,
      'eligible_seconds', 0,
      'required_seconds', 0,
      'claimable', FALSE,
      'claimed', FALSE,
      'rewarded_now', FALSE,
      'eligible', FALSE
    );
  END IF;

  SELECT * INTO v_cfg FROM public.host_live_reward_config();

  -- Accumulate the day's video time across every session the host runs.
  INSERT INTO public.host_daily_live_rewards(
    user_id, reward_date, eligible_seconds, source_stream_id, updated_at
  ) VALUES (me, v_reward_date, v_delta_seconds, p_stream_id, v_now)
  ON CONFLICT (user_id, reward_date) DO UPDATE
  SET eligible_seconds = public.host_daily_live_rewards.eligible_seconds + EXCLUDED.eligible_seconds,
      source_stream_id = COALESCE(public.host_daily_live_rewards.source_stream_id, EXCLUDED.source_stream_id),
      updated_at = v_now
  RETURNING eligible_seconds, rewarded_at IS NOT NULL
    INTO v_day_seconds, v_claimed;

  -- Mark the moment it became collectable; the reward itself is never granted
  -- here any more.
  IF v_cfg.enabled AND v_day_seconds >= v_cfg.required_seconds THEN
    UPDATE public.host_daily_live_rewards
       SET claimable_at = COALESCE(claimable_at, v_now),
           reward_beans = CASE WHEN rewarded_at IS NULL THEN v_cfg.beans ELSE reward_beans END
     WHERE user_id = me AND reward_date = v_reward_date;
  END IF;

  RETURN json_build_object(
    'success', TRUE,
    'live_type', 'video',
    'reward_date', v_reward_date,
    'eligible_seconds', v_day_seconds,
    'required_seconds', v_cfg.required_seconds,
    'reward_beans', v_cfg.beans,
    'claimable', v_cfg.enabled AND v_day_seconds >= v_cfg.required_seconds AND NOT v_claimed,
    'claimed', v_claimed,
    'rewarded_now', FALSE,
    'eligible', TRUE
  );
END $function$;

-- Read-only status for the Host Dashboard.
CREATE OR REPLACE FUNCTION public.get_host_live_reward_status(p_reward_date DATE DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me       UUID := auth.uid();
  v_date   DATE := COALESCE(p_reward_date, (NOW() AT TIME ZONE 'Asia/Dhaka')::DATE);
  v_row    public.host_daily_live_rewards%ROWTYPE;
  v_cfg    RECORD;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', FALSE, 'message', 'Not authenticated');
  END IF;

  SELECT * INTO v_cfg FROM public.host_live_reward_config();
  SELECT * INTO v_row
    FROM public.host_daily_live_rewards
   WHERE user_id = me AND reward_date = v_date;

  RETURN json_build_object(
    'success', TRUE,
    'reward_date', v_date,
    'enabled', v_cfg.enabled,
    'eligible_seconds', COALESCE(v_row.eligible_seconds, 0),
    'required_seconds', v_cfg.required_seconds,
    'reward_beans', v_cfg.beans,
    'claimed', v_row.rewarded_at IS NOT NULL,
    'claimed_at', v_row.rewarded_at,
    'claimable', v_cfg.enabled
      AND COALESCE(v_row.eligible_seconds, 0) >= v_cfg.required_seconds
      AND v_row.rewarded_at IS NULL
  );
END;
$$;

-- The host collects the reward explicitly.
CREATE OR REPLACE FUNCTION public.claim_host_live_reward(p_reward_date DATE DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me            UUID := auth.uid();
  v_now         TIMESTAMPTZ := clock_timestamp();
  v_date        DATE := COALESCE(p_reward_date, (v_now AT TIME ZONE 'Asia/Dhaka')::DATE);
  v_row         public.host_daily_live_rewards%ROWTYPE;
  v_cfg         RECORD;
  v_new_balance BIGINT;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', FALSE, 'message', 'Not authenticated');
  END IF;

  SELECT * INTO v_cfg FROM public.host_live_reward_config();
  IF NOT v_cfg.enabled THEN
    RETURN json_build_object('success', FALSE, 'message', 'The daily live reward is currently disabled.');
  END IF;

  -- Lock the day's row so a double tap cannot pay twice.
  SELECT * INTO v_row
    FROM public.host_daily_live_rewards
   WHERE user_id = me AND reward_date = v_date
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object(
      'success', FALSE,
      'message', 'Go live on video to start earning today''s reward.',
      'eligible_seconds', 0,
      'required_seconds', v_cfg.required_seconds
    );
  END IF;

  IF v_row.rewarded_at IS NOT NULL THEN
    RETURN json_build_object(
      'success', FALSE,
      'message', 'You have already collected today''s reward.',
      'claimed', TRUE,
      'claimed_at', v_row.rewarded_at
    );
  END IF;

  IF v_row.eligible_seconds < v_cfg.required_seconds THEN
    RETURN json_build_object(
      'success', FALSE,
      'message', 'Complete ' || (v_cfg.required_seconds / 60) || ' minutes of video live to collect this reward.',
      'eligible_seconds', v_row.eligible_seconds,
      'required_seconds', v_cfg.required_seconds
    );
  END IF;

  UPDATE public.host_daily_live_rewards
     SET rewarded_at = v_now,
         reward_beans = v_cfg.beans,
         claimable_at = COALESCE(claimable_at, v_now),
         updated_at = v_now
   WHERE user_id = me AND reward_date = v_date;

  v_new_balance := public.grant_reward(
    me,
    v_cfg.beans,
    'bean',
    'live_hour_reward',
    jsonb_build_object(
      'reward_date', v_date,
      'live_type', 'video',
      'eligible_seconds', v_row.eligible_seconds,
      'claimed', TRUE,
      'timezone', 'Asia/Dhaka'
    )
  );

  INSERT INTO public.notifications(user_id, type, title, body, payload)
  VALUES (
    me,
    'task_reward',
    'Daily video reward collected',
    '+' || v_cfg.beans || ' beans added to your wallet',
    jsonb_build_object(
      'reward', v_cfg.beans,
      'currency', 'bean',
      'new_balance', v_new_balance,
      'reward_date', v_date,
      'live_type', 'video',
      'eligible_seconds', v_row.eligible_seconds
    )
  );

  RETURN json_build_object(
    'success', TRUE,
    'reward_beans', v_cfg.beans,
    'new_balance', v_new_balance,
    'reward_date', v_date,
    'eligible_seconds', v_row.eligible_seconds,
    'claimed', TRUE
  );
END;
$$;

REVOKE ALL ON FUNCTION public.host_live_reward_config() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.claim_host_live_reward(DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_host_live_reward_status(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.host_live_reward_config() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_host_live_reward(DATE) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_host_live_reward_status(DATE) TO authenticated, service_role;

COMMENT ON FUNCTION public.claim_host_live_reward(DATE) IS
  'Host collects the daily video-live reward once cumulative video time for the Dhaka day meets the configured minimum.';
