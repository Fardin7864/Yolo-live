-- Daily host video-live reward reset, using Bangladesh calendar days.
--
-- A single live may continue across midnight. Each heartbeat calculates only
-- the portion of every VIDEO live that belongs to the current Asia/Dhaka day,
-- so 00:00 starts a fresh 0/60 minute progress record and the host can earn
-- again after one new hour. The primary key makes each daily credit idempotent.

INSERT INTO public.system_settings(key, value)
VALUES ('host_hour_reward', jsonb_build_object('enabled', TRUE, 'beans', 6000, 'minutes', 60))
ON CONFLICT (key) DO UPDATE
  SET value = jsonb_set(COALESCE(system_settings.value, '{}'::jsonb), '{enabled}', 'true'::jsonb, TRUE);

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
  v_host UUID;
  v_type TEXT;
  v_date DATE := (NOW() AT TIME ZONE 'Asia/Dhaka')::DATE;
  v_day_start TIMESTAMPTZ := ((NOW() AT TIME ZONE 'Asia/Dhaka')::DATE::TIMESTAMP AT TIME ZONE 'Asia/Dhaka');
  v_day_end TIMESTAMPTZ := (((NOW() AT TIME ZONE 'Asia/Dhaka')::DATE + 1)::TIMESTAMP AT TIME ZONE 'Asia/Dhaka');
  v_seconds BIGINT := 0;
  v_cfg JSONB;
  v_enabled BOOLEAN;
  v_beans BIGINT;
  v_minutes INT;
  v_award BOOLEAN := FALSE;
BEGIN
  SELECT broadcaster_id, COALESCE(type, 'video')
    INTO v_host, v_type
    FROM public.live_streams
   WHERE id = p_stream_id
     AND status = 'live'
   FOR UPDATE;

  IF v_host IS NULL THEN
    RETURN json_build_object('success', FALSE, 'message', 'Stream is not live');
  END IF;
  IF v_host <> me THEN
    RETURN json_build_object('success', FALSE, 'message', 'Not your stream');
  END IF;

  UPDATE public.live_streams
     SET last_heartbeat_at = NOW(),
         peak_viewers = GREATEST(COALESCE(peak_viewers, 0), COALESCE(p_viewer_count, 0)),
         current_viewers = COALESCE(p_current_viewers, current_viewers)
   WHERE id = p_stream_id;

  SELECT value INTO v_cfg FROM public.system_settings WHERE key = 'host_hour_reward';
  v_enabled := COALESCE((v_cfg->>'enabled')::BOOLEAN, TRUE);
  v_beans := GREATEST(0, COALESCE((v_cfg->>'beans')::BIGINT, 6000));
  v_minutes := GREATEST(1, COALESCE((v_cfg->>'minutes')::INT, 60));

  -- Audio lives never create daily-video progress or a reward.
  IF v_type <> 'video' THEN
    RETURN json_build_object('success', TRUE, 'live_type', v_type, 'reward_date', v_date,
      'eligible_seconds', 0, 'rewarded_now', FALSE);
  END IF;

  -- Clip every session to the current Bangladesh day. A session beginning
  -- before midnight contributes only seconds after today's 00:00 boundary.
  SELECT COALESCE(SUM(GREATEST(
    0,
    EXTRACT(EPOCH FROM (
      LEAST(COALESCE(ended_at, NOW()), v_day_end)
      - GREATEST(started_at, v_day_start)
    ))
  )), 0)::BIGINT
    INTO v_seconds
    FROM public.live_streams
   WHERE broadcaster_id = me
     AND type = 'video'
     AND started_at < v_day_end
     AND COALESCE(ended_at, NOW()) > v_day_start;

  -- There is one independent record per Bangladesh calendar day. The new
  -- date automatically starts unlocked at 0 seconds just after midnight.
  INSERT INTO public.host_daily_live_rewards(user_id, reward_date, eligible_seconds)
  VALUES (me, v_date, v_seconds)
  ON CONFLICT (user_id, reward_date)
  DO UPDATE SET eligible_seconds = EXCLUDED.eligible_seconds, updated_at = NOW();

  IF v_enabled AND v_seconds >= v_minutes * 60 THEN
    UPDATE public.host_daily_live_rewards
       SET reward_beans = v_beans,
           rewarded_at = NOW(),
           updated_at = NOW()
     WHERE user_id = me
       AND reward_date = v_date
       AND rewarded_at IS NULL;

    IF FOUND THEN
      UPDATE public.profiles
         SET beans = COALESCE(beans, 0) + v_beans
       WHERE id = me;

      INSERT INTO public.transactions(user_id, type, currency, amount, status, notes)
      VALUES (me, 'live_hour_reward', 'bean', v_beans, 'completed',
        'Daily cumulative video live reward (Asia/Dhaka)');

      INSERT INTO public.notifications(user_id, type, title, body, payload)
      VALUES (me, 'task_reward', 'Daily live reward',
        '+' || v_beans || ' beans added to your wallet',
        jsonb_build_object('reward', v_beans, 'eligible_seconds', v_seconds,
          'reward_date', v_date, 'live_type', 'video'));
      v_award := TRUE;
    END IF;
  END IF;

  RETURN json_build_object('success', TRUE, 'live_type', 'video', 'reward_date', v_date,
    'eligible_seconds', v_seconds, 'rewarded_now', v_award);
END $$;

GRANT EXECUTE ON FUNCTION public.live_stream_heartbeat(UUID, INT, INT) TO authenticated;
