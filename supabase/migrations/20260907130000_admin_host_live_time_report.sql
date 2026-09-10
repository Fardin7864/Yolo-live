-- Per-host Audio vs Video live time for the Super Admin dashboard.
--
-- get_host_stats answers this for one host at a time, which is fine for a detail
-- view but cannot drive a list. This aggregates every host in one pass over the
-- Dhaka-day slices, so the admin panel can rank and compare hosts directly.
--
-- Video live days counts distinct Dhaka days on which the host ran at least one
-- video session; valid_video_days applies the platform's existing >= 35 minute
-- rule, so both readings are available without inventing a third definition.

CREATE OR REPLACE FUNCTION public.admin_host_live_time_report(
  p_start TIMESTAMPTZ DEFAULT NULL,
  p_end   TIMESTAMPTZ DEFAULT NULL,
  p_limit INTEGER DEFAULT 200
)
RETURNS TABLE (
  host_id UUID,
  host_name TEXT,
  host_display_id BIGINT,
  agency_name TEXT,
  video_minutes BIGINT,
  audio_minutes BIGINT,
  video_days BIGINT,
  valid_video_days BIGINT,
  sessions BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me UUID := auth.uid();
  v_start TIMESTAMPTZ := COALESCE(p_start, DATE_TRUNC('month', NOW() AT TIME ZONE 'Asia/Dhaka')::TIMESTAMPTZ);
  v_end   TIMESTAMPTZ := COALESCE(p_end, NOW());
BEGIN
  IF NOT public.is_admin(me) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  WITH sessions AS (
    SELECT s.id, s.broadcaster_id,
           LOWER(BTRIM(COALESCE(s.type, ''))) AS type,
           GREATEST(s.started_at, v_start) AS win_start,
           LEAST(COALESCE(s.ended_at, NOW()), v_end) AS win_end
      FROM public.live_streams s
     WHERE s.started_at IS NOT NULL
       AND s.started_at < v_end
       AND COALESCE(s.ended_at, NOW()) > v_start
  ), slices AS (
    SELECT sess.broadcaster_id, sess.type, sess.id,
           day_slice.day_date,
           GREATEST(sess.win_start, day_slice.day_start) AS slice_start,
           LEAST(sess.win_end, day_slice.day_end) AS slice_end
      FROM sessions sess
      CROSS JOIN LATERAL (
        SELECT g::DATE AS day_date,
               (g::DATE::TIMESTAMP AT TIME ZONE 'Asia/Dhaka') AS day_start,
               ((g::DATE + 1)::TIMESTAMP AT TIME ZONE 'Asia/Dhaka') AS day_end
          FROM GENERATE_SERIES(
            (sess.win_start AT TIME ZONE 'Asia/Dhaka')::DATE,
            ((sess.win_end - INTERVAL '1 microsecond') AT TIME ZONE 'Asia/Dhaka')::DATE,
            INTERVAL '1 day'
          ) AS g
      ) AS day_slice
     WHERE sess.win_end > sess.win_start
  ), per_day AS (
    SELECT broadcaster_id, day_date,
           COALESCE(SUM(EXTRACT(EPOCH FROM (slice_end - slice_start)) / 60)
                    FILTER (WHERE type = 'video'), 0) AS video_min,
           COALESCE(SUM(EXTRACT(EPOCH FROM (slice_end - slice_start)) / 60)
                    FILTER (WHERE type <> 'video'), 0) AS audio_min,
           COUNT(DISTINCT id) AS session_count
      FROM slices
     WHERE slice_end > slice_start
     GROUP BY broadcaster_id, day_date
  ), totals AS (
    SELECT broadcaster_id,
           ROUND(SUM(video_min))::BIGINT AS video_minutes,
           ROUND(SUM(audio_min))::BIGINT AS audio_minutes,
           COUNT(*) FILTER (WHERE video_min > 0)::BIGINT AS video_days,
           COUNT(*) FILTER (WHERE video_min >= 35)::BIGINT AS valid_video_days,
           SUM(session_count)::BIGINT AS sessions
      FROM per_day
     GROUP BY broadcaster_id
  )
  SELECT t.broadcaster_id,
         p.full_name::TEXT,
         p.display_id::BIGINT,
         a.name::TEXT,
         t.video_minutes, t.audio_minutes,
         t.video_days, t.valid_video_days, t.sessions
    FROM totals t
    JOIN public.profiles p ON p.id = t.broadcaster_id
    LEFT JOIN public.agency_members m
      ON m.host_id = t.broadcaster_id AND m.status IN ('active', 'leave_pending')
    LEFT JOIN public.agencies a ON a.id = m.agency_id
   ORDER BY t.video_minutes DESC, t.audio_minutes DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_host_live_time_report(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_host_live_time_report(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) TO authenticated, service_role;
