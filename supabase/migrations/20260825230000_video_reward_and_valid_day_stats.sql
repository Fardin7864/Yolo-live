-- Enforce the final host activity policy at the database boundary.
-- Reward: exactly 5,000 beans after one uninterrupted video hour, once per
-- Asia/Dhaka calendar day. Statistics: video minutes only, with a valid day
-- requiring at least 35 video minutes in that Dhaka day.

INSERT INTO public.system_settings(key, value)
VALUES ('host_hour_reward', jsonb_build_object('enabled', TRUE, 'beans', 5000, 'minutes', 60))
ON CONFLICT (key) DO UPDATE
SET value = COALESCE(public.system_settings.value, '{}'::JSONB)
  || jsonb_build_object('beans', 5000, 'minutes', 60);

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
  v_beans CONSTANT BIGINT := 5000;
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
        -- A missing heartbeat breaks continuity instead of crediting offline time.
        v_seconds := 0;
      ELSIF v_stream.reward_progress_date IS DISTINCT FROM v_reward_date THEN
        IF v_stream.reward_progress_date IS NOT NULL THEN
          SELECT EXISTS(
            SELECT 1
              FROM public.host_daily_live_rewards AS previous_reward
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
          -- An uninterrupted attempt may cross midnight if the prior day did
          -- not already receive a reward.
          v_seconds := v_stream.reward_continuous_seconds + v_delta_seconds;
        END IF;
      ELSIF v_delta_seconds = 0 THEN
        v_seconds := v_stream.reward_continuous_seconds;
      ELSE
        v_seconds := v_stream.reward_continuous_seconds + v_delta_seconds;
      END IF;
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
         reward_continuous_seconds = CASE WHEN v_stream_type = 'video' THEN v_seconds ELSE 0 END,
         reward_last_heartbeat_at = CASE WHEN v_stream_type = 'video' THEN v_now ELSE NULL END,
         reward_progress_date = CASE WHEN v_stream_type = 'video' THEN v_reward_date ELSE NULL END
   WHERE id = p_stream_id;

  IF v_stream_type <> 'video' THEN
    RETURN json_build_object(
      'success', TRUE,
      'live_type', COALESCE(NULLIF(v_stream_type, ''), 'audio'),
      'reward_date', v_reward_date,
      'eligible_seconds', 0,
      'rewarded_now', FALSE,
      'eligible', FALSE
    );
  END IF;

  SELECT value INTO v_cfg
    FROM public.system_settings
   WHERE key = 'host_hour_reward';
  v_enabled := COALESCE((v_cfg->>'enabled')::BOOLEAN, TRUE);

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

  IF v_enabled AND v_seconds >= 3600 THEN
    UPDATE public.host_daily_live_rewards
       SET reward_beans = v_beans,
           rewarded_at = v_now,
           eligible_seconds = v_seconds,
           source_stream_id = p_stream_id,
           updated_at = v_now
     WHERE user_id = me
       AND reward_date = v_reward_date
       AND rewarded_at IS NULL;

    IF FOUND THEN
      v_new_balance := public.grant_reward(
        me,
        v_beans,
        'bean',
        'live_hour_reward',
        jsonb_build_object(
          'stream_id', p_stream_id,
          'reward_date', v_reward_date,
          'live_type', 'video',
          'continuous_seconds', v_seconds,
          'timezone', 'Asia/Dhaka'
        )
      );
      INSERT INTO public.notifications(user_id, type, title, body, payload)
      VALUES (
        me,
        'task_reward',
        'Daily video reward',
        '+5000 beans added to your wallet',
        jsonb_build_object(
          'reward', v_beans,
          'currency', 'bean',
          'new_balance', v_new_balance,
          'stream_id', p_stream_id,
          'reward_date', v_reward_date,
          'live_type', 'video',
          'continuous_seconds', v_seconds,
          'continuous', TRUE
        )
      );
      v_awarded := TRUE;
    END IF;
  END IF;

  RETURN json_build_object(
    'success', TRUE,
    'live_type', 'video',
    'reward_date', v_reward_date,
    'eligible_seconds', v_seconds,
    'rewarded_now', v_awarded,
    'eligible', TRUE
  );
END $$;

REVOKE EXECUTE ON FUNCTION public.live_stream_heartbeat(UUID, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.live_stream_heartbeat(UUID, INT, INT) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_host_stats(p_host_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  v_result JSON;
BEGIN
  IF p_host_id IS NULL THEN
    RETURN json_build_object('error', 'host_id required');
  END IF;
  IF NOT (
    me = p_host_id
    OR public.is_live_staff(me)
    OR EXISTS (
      SELECT 1
        FROM public.agency_members AS member_row
        JOIN public.agencies AS agency_row ON agency_row.id = member_row.agency_id
       WHERE member_row.host_id = p_host_id
         AND member_row.status IN ('active', 'leave_pending')
         AND agency_row.owner_id = me
    )
  ) THEN
    RETURN json_build_object('error', 'forbidden');
  END IF;

  WITH session_rows AS (
    SELECT stream_row.id,
      LOWER(BTRIM(COALESCE(stream_row.type, ''))) AS type,
      stream_row.title,
      stream_row.started_at,
      stream_row.ended_at,
      stream_row.status,
      (stream_row.started_at AT TIME ZONE 'Asia/Dhaka')::DATE AS live_date,
      COALESCE(stream_row.peak_viewers, 0) AS peak_viewers,
      COALESCE(stream_row.total_gifts, 0) AS total_gifts,
      COALESCE(stream_row.total_earnings, 0) AS total_earnings,
      GREATEST(
        EXTRACT(EPOCH FROM (COALESCE(stream_row.ended_at, NOW()) - stream_row.started_at)) / 60,
        0
      )::NUMERIC AS minutes
    FROM public.live_streams AS stream_row
    WHERE stream_row.broadcaster_id = p_host_id
      AND stream_row.started_at IS NOT NULL
  ), video_day_minutes AS (
    SELECT day_slice.day_date,
      SUM(GREATEST(EXTRACT(EPOCH FROM (
        LEAST(COALESCE(session_row.ended_at, NOW()), day_slice.day_end)
        - GREATEST(session_row.started_at, day_slice.day_start)
      )) / 60, 0)) AS video_minutes
    FROM session_rows AS session_row
    CROSS JOIN LATERAL (
      SELECT generated_day::DATE AS day_date,
        (generated_day::DATE::TIMESTAMP AT TIME ZONE 'Asia/Dhaka') AS day_start,
        ((generated_day::DATE + 1)::TIMESTAMP AT TIME ZONE 'Asia/Dhaka') AS day_end
      FROM GENERATE_SERIES(
        (session_row.started_at AT TIME ZONE 'Asia/Dhaka')::DATE,
        ((COALESCE(session_row.ended_at, NOW()) - INTERVAL '1 microsecond') AT TIME ZONE 'Asia/Dhaka')::DATE,
        INTERVAL '1 day'
      ) AS generated_day
    ) AS day_slice
    WHERE session_row.type = 'video'
    GROUP BY day_slice.day_date
  ), video_days AS (
    SELECT daily_video.day_date AS live_date
    FROM video_day_minutes AS daily_video
    WHERE daily_video.video_minutes >= 35
  ), aggregate_row AS (
    SELECT
      (SELECT COUNT(*) FROM video_days)::BIGINT AS total_live_days,
      COALESCE(SUM(session_row.minutes) FILTER (WHERE session_row.type = 'video'), 0)::BIGINT AS total_minutes,
      COALESCE(SUM(session_row.total_gifts), 0)::BIGINT AS total_gifts,
      COALESCE(SUM(session_row.total_earnings), 0)::BIGINT AS total_diamonds,
      (SELECT COUNT(*) FROM video_days AS valid_day
        WHERE valid_day.live_date = (NOW() AT TIME ZONE 'Asia/Dhaka')::DATE)::BIGINT AS today_live_days,
      COALESCE(SUM(session_row.minutes) FILTER (
        WHERE session_row.type = 'video'
          AND session_row.live_date = (NOW() AT TIME ZONE 'Asia/Dhaka')::DATE
      ), 0)::BIGINT AS today_minutes,
      COALESCE(SUM(session_row.total_gifts) FILTER (
        WHERE session_row.live_date = (NOW() AT TIME ZONE 'Asia/Dhaka')::DATE
      ), 0)::BIGINT AS today_gifts,
      COALESCE(SUM(session_row.total_earnings) FILTER (
        WHERE session_row.live_date = (NOW() AT TIME ZONE 'Asia/Dhaka')::DATE
      ), 0)::BIGINT AS today_diamonds,
      (SELECT COUNT(*) FROM video_days AS valid_day
        WHERE valid_day.live_date >= (NOW() AT TIME ZONE 'Asia/Dhaka')::DATE - 6)::BIGINT AS week_live_days,
      COALESCE(SUM(session_row.minutes) FILTER (
        WHERE session_row.type = 'video'
          AND session_row.live_date >= (NOW() AT TIME ZONE 'Asia/Dhaka')::DATE - 6
      ), 0)::BIGINT AS week_minutes,
      COALESCE(SUM(session_row.total_gifts) FILTER (
        WHERE session_row.live_date >= (NOW() AT TIME ZONE 'Asia/Dhaka')::DATE - 6
      ), 0)::BIGINT AS week_gifts,
      COALESCE(SUM(session_row.total_earnings) FILTER (
        WHERE session_row.live_date >= (NOW() AT TIME ZONE 'Asia/Dhaka')::DATE - 6
      ), 0)::BIGINT AS week_diamonds,
      (SELECT COUNT(*) FROM video_days AS valid_day
        WHERE valid_day.live_date >= (NOW() AT TIME ZONE 'Asia/Dhaka')::DATE - 29)::BIGINT AS month_live_days,
      COALESCE(SUM(session_row.minutes) FILTER (
        WHERE session_row.type = 'video'
          AND session_row.live_date >= (NOW() AT TIME ZONE 'Asia/Dhaka')::DATE - 29
      ), 0)::BIGINT AS month_minutes,
      COALESCE(SUM(session_row.total_gifts) FILTER (
        WHERE session_row.live_date >= (NOW() AT TIME ZONE 'Asia/Dhaka')::DATE - 29
      ), 0)::BIGINT AS month_gifts,
      COALESCE(SUM(session_row.total_earnings) FILTER (
        WHERE session_row.live_date >= (NOW() AT TIME ZONE 'Asia/Dhaka')::DATE - 29
      ), 0)::BIGINT AS month_diamonds
    FROM session_rows AS session_row
  ), recent_rows AS (
    SELECT json_agg(row_to_json(recent_row)) AS rows
    FROM (
      SELECT session_row.id,
        session_row.type,
        session_row.title,
        session_row.started_at,
        session_row.ended_at,
        session_row.status,
        ROUND(session_row.minutes)::INT AS minutes,
        session_row.peak_viewers,
        session_row.total_gifts,
        session_row.total_earnings,
        session_row.type = 'video' AS counts_toward_live_time
      FROM session_rows AS session_row
      ORDER BY session_row.started_at DESC
      LIMIT 10
    ) AS recent_row
  )
  SELECT json_build_object(
    'today', json_build_object('sessions', aggregate_row.today_live_days, 'minutes', aggregate_row.today_minutes, 'gifts', aggregate_row.today_gifts, 'diamonds', aggregate_row.today_diamonds),
    'week', json_build_object('sessions', aggregate_row.week_live_days, 'minutes', aggregate_row.week_minutes, 'gifts', aggregate_row.week_gifts, 'diamonds', aggregate_row.week_diamonds),
    'month', json_build_object('sessions', aggregate_row.month_live_days, 'minutes', aggregate_row.month_minutes, 'gifts', aggregate_row.month_gifts, 'diamonds', aggregate_row.month_diamonds),
    'all_time', json_build_object('sessions', aggregate_row.total_live_days, 'minutes', aggregate_row.total_minutes, 'gifts', aggregate_row.total_gifts, 'diamonds', aggregate_row.total_diamonds),
    'recent_sessions', COALESCE(recent_rows.rows, '[]'::JSON),
    'valid_live_day_minutes', 35,
    'valid_live_type', 'video'
  ) INTO v_result
  FROM aggregate_row, recent_rows;

  RETURN v_result;
END $$;

GRANT EXECUTE ON FUNCTION public.get_host_stats(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.agency_host_period_report(
  p_agency_id UUID,
  p_start TIMESTAMPTZ,
  p_end TIMESTAMPTZ
)
RETURNS TABLE(
  host_id UUID,
  host_name TEXT,
  host_display_id BIGINT,
  report_day DATE,
  income BIGINT,
  live_minutes BIGINT,
  live_sessions BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.agencies AS agency_row
     WHERE agency_row.id = p_agency_id
       AND agency_row.owner_id = auth.uid()
  ) AND NOT public.is_live_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  WITH member_rows AS (
    SELECT member_row.host_id AS member_host_id,
      member_row.joined_at,
      member_row.released_at
    FROM public.agency_members AS member_row
    WHERE member_row.agency_id = p_agency_id
      AND member_row.status IN ('active', 'leave_pending', 'released')
  ), earning_rows AS (
    SELECT member_row.member_host_id,
      (tx_row.created_at AT TIME ZONE 'Asia/Dhaka')::DATE AS earning_date,
      SUM(tx_row.amount)::BIGINT AS earned
    FROM member_rows AS member_row
    JOIN public.transactions AS tx_row ON tx_row.user_id = member_row.member_host_id
    WHERE tx_row.status = 'completed'
      AND tx_row.currency = 'bean'
      AND tx_row.amount > 0
      AND tx_row.type IN ('gift_received', 'live_hour_reward')
      AND tx_row.created_at >= p_start
      AND tx_row.created_at < p_end
      AND tx_row.created_at >= member_row.joined_at
      AND (member_row.released_at IS NULL OR tx_row.created_at < member_row.released_at)
    GROUP BY member_row.member_host_id, (tx_row.created_at AT TIME ZONE 'Asia/Dhaka')::DATE
  ), video_intervals AS (
    SELECT member_row.member_host_id,
      stream_row.id AS stream_id,
      GREATEST(stream_row.started_at, p_start, member_row.joined_at) AS interval_start,
      LEAST(
        COALESCE(stream_row.ended_at, NOW()),
        p_end,
        COALESCE(member_row.released_at, 'infinity'::TIMESTAMPTZ)
      ) AS interval_end
    FROM member_rows AS member_row
    JOIN public.live_streams AS stream_row
      ON stream_row.broadcaster_id = member_row.member_host_id
    WHERE LOWER(BTRIM(COALESCE(stream_row.type, ''))) = 'video'
      AND stream_row.started_at < LEAST(p_end, COALESCE(member_row.released_at, 'infinity'::TIMESTAMPTZ))
      AND COALESCE(stream_row.ended_at, NOW()) > GREATEST(p_start, member_row.joined_at)
  ), video_day_slices AS (
    SELECT video_interval.member_host_id,
      video_interval.stream_id,
      day_slice.day_date,
      GREATEST(video_interval.interval_start, day_slice.day_start) AS slice_start,
      LEAST(video_interval.interval_end, day_slice.day_end) AS slice_end
    FROM video_intervals AS video_interval
    CROSS JOIN LATERAL (
      SELECT generated_day::DATE AS day_date,
        (generated_day::DATE::TIMESTAMP AT TIME ZONE 'Asia/Dhaka') AS day_start,
        ((generated_day::DATE + 1)::TIMESTAMP AT TIME ZONE 'Asia/Dhaka') AS day_end
      FROM GENERATE_SERIES(
        (video_interval.interval_start AT TIME ZONE 'Asia/Dhaka')::DATE,
        ((video_interval.interval_end - INTERVAL '1 microsecond') AT TIME ZONE 'Asia/Dhaka')::DATE,
        INTERVAL '1 day'
      ) AS generated_day
    ) AS day_slice
    WHERE day_slice.day_end > video_interval.interval_start
      AND day_slice.day_start < video_interval.interval_end
  ), video_rows AS (
    SELECT video_slice.member_host_id,
      video_slice.day_date AS live_date,
      ROUND(SUM(EXTRACT(EPOCH FROM (video_slice.slice_end - video_slice.slice_start)) / 60))::BIGINT AS minutes
    FROM video_day_slices AS video_slice
    WHERE video_slice.slice_end > video_slice.slice_start
    GROUP BY video_slice.member_host_id, video_slice.day_date
  ), report_keys AS (
    SELECT earning_row.member_host_id, earning_row.earning_date AS report_date
    FROM earning_rows AS earning_row
    UNION
    SELECT video_row.member_host_id, video_row.live_date
    FROM video_rows AS video_row
  )
  SELECT profile_row.id,
    profile_row.full_name,
    profile_row.display_id,
    report_key.report_date,
    COALESCE(earning_row.earned, 0),
    COALESCE(video_row.minutes, 0),
    CASE WHEN COALESCE(video_row.minutes, 0) >= 35 THEN 1 ELSE 0 END::BIGINT
  FROM report_keys AS report_key
  JOIN public.profiles AS profile_row ON profile_row.id = report_key.member_host_id
  LEFT JOIN earning_rows AS earning_row
    ON earning_row.member_host_id = report_key.member_host_id
   AND earning_row.earning_date = report_key.report_date
  LEFT JOIN video_rows AS video_row
    ON video_row.member_host_id = report_key.member_host_id
   AND video_row.live_date = report_key.report_date
  ORDER BY report_key.report_date DESC, profile_row.full_name;
END $$;

GRANT EXECUTE ON FUNCTION public.agency_host_period_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
