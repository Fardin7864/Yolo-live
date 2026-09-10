-- Make the Host Dashboard "Month" tab use the current Asia/Dhaka
-- calendar month instead of a rolling 30-day window. This keeps monthly
-- stats aligned with the Anubis month-end settlement.

CREATE OR REPLACE FUNCTION public.get_host_stats(p_host_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  v_result JSON;
  v_today DATE := (NOW() AT TIME ZONE 'Asia/Dhaka')::DATE;
  v_month_start DATE := DATE_TRUNC('month', NOW() AT TIME ZONE 'Asia/Dhaka')::DATE;
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
  ), aggregate_row AS (
    SELECT
      (SELECT COUNT(*) FROM video_day_minutes WHERE video_minutes >= 35)::BIGINT AS total_live_days,
      COALESCE((SELECT SUM(video_minutes) FROM video_day_minutes), 0)::BIGINT AS total_minutes,
      COALESCE(SUM(session_row.total_gifts), 0)::BIGINT AS total_gifts,
      COALESCE(SUM(session_row.total_earnings), 0)::BIGINT AS total_diamonds,
      (SELECT COUNT(*) FROM video_day_minutes
        WHERE day_date = v_today
          AND video_minutes >= 35)::BIGINT AS today_live_days,
      COALESCE((SELECT SUM(video_minutes) FROM video_day_minutes
        WHERE day_date = v_today), 0)::BIGINT AS today_minutes,
      COALESCE(SUM(session_row.total_gifts) FILTER (
        WHERE session_row.live_date = v_today
      ), 0)::BIGINT AS today_gifts,
      COALESCE(SUM(session_row.total_earnings) FILTER (
        WHERE session_row.live_date = v_today
      ), 0)::BIGINT AS today_diamonds,
      (SELECT COUNT(*) FROM video_day_minutes
        WHERE day_date >= v_today - 6
          AND video_minutes >= 35)::BIGINT AS week_live_days,
      COALESCE((SELECT SUM(video_minutes) FROM video_day_minutes
        WHERE day_date >= v_today - 6), 0)::BIGINT AS week_minutes,
      COALESCE(SUM(session_row.total_gifts) FILTER (
        WHERE session_row.live_date >= v_today - 6
      ), 0)::BIGINT AS week_gifts,
      COALESCE(SUM(session_row.total_earnings) FILTER (
        WHERE session_row.live_date >= v_today - 6
      ), 0)::BIGINT AS week_diamonds,
      (SELECT COUNT(*) FROM video_day_minutes
        WHERE day_date >= v_month_start
          AND video_minutes >= 35)::BIGINT AS month_live_days,
      COALESCE((SELECT SUM(video_minutes) FROM video_day_minutes
        WHERE day_date >= v_month_start), 0)::BIGINT AS month_minutes,
      COALESCE(SUM(session_row.total_gifts) FILTER (
        WHERE session_row.live_date >= v_month_start
      ), 0)::BIGINT AS month_gifts,
      COALESCE(SUM(session_row.total_earnings) FILTER (
        WHERE session_row.live_date >= v_month_start
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
NOTIFY pgrst, 'reload schema';
