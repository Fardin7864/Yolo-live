-- =====================================================================
-- 86_host_stats_monthly.sql
-- =====================================================================
-- Adds a "month" block to the host-stats RPC so the profile dashboard
-- can show how many lives a host has done over the whole month
-- (sessions + minutes + gifts + diamonds), not just today/week/all-time.
--
-- Definition of "month": last 30 days, rolling from NOW(). This matches
-- how the existing "week" block is computed (rolling 7 days), so a host
-- looking at this number at any point in the calendar sees the same
-- meaning regardless of the date.
--
-- WHY: hosts were confused by the "Sessions" tile in /main/host-stats:
-- they expected it to show how many times they went live in the whole
-- month, but with the Today tab selected it showed today's count. With
-- this migration the client adds a Month tab that returns the rolling
-- 30-day numbers — same shape as the other three tabs.
--
-- Idempotent. Preserves mig 75 verbatim aside from the new fields.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.get_host_stats(p_host_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me              UUID := auth.uid();
  v_is_admin      BOOLEAN;
  v_is_self       BOOLEAN;
  v_is_my_host    BOOLEAN;
  v_result        JSON;
BEGIN
  IF p_host_id IS NULL THEN
    RETURN json_build_object('error', 'host_id required');
  END IF;

  v_is_self := (me = p_host_id);

  SELECT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = me AND role IN ('admin', 'super_admin')
  ) INTO v_is_admin;

  SELECT EXISTS (
    SELECT 1
      FROM public.agency_members am
      JOIN public.agencies a ON a.id = am.agency_id
     WHERE am.host_id = p_host_id
       AND am.status  = 'active'
       AND a.owner_id = me
  ) INTO v_is_my_host;

  IF NOT (v_is_self OR v_is_admin OR v_is_my_host) THEN
    RETURN json_build_object('error', 'forbidden');
  END IF;

  WITH sessions AS (
    SELECT
      id, type, title, started_at, ended_at, status,
      COALESCE(peak_viewers, 0)   AS peak_viewers,
      COALESCE(total_gifts, 0)    AS total_gifts,
      COALESCE(total_earnings, 0) AS total_earnings,
      GREATEST(
        EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at)) / 60,
        0
      )::NUMERIC AS minutes
    FROM public.live_streams
    WHERE broadcaster_id = p_host_id
      AND started_at IS NOT NULL
  ),
  agg AS (
    SELECT
      COUNT(*)                                                              AS total_sessions,
      COALESCE(SUM(minutes), 0)::BIGINT                                     AS total_minutes,
      COALESCE(SUM(total_gifts), 0)::BIGINT                                 AS total_gifts,
      COALESCE(SUM(total_earnings), 0)::BIGINT                              AS total_diamonds,

      COUNT(*) FILTER (WHERE started_at >= CURRENT_DATE)                    AS today_sessions,
      COALESCE(SUM(minutes)        FILTER (WHERE started_at >= CURRENT_DATE), 0)::BIGINT AS today_minutes,
      COALESCE(SUM(total_gifts)    FILTER (WHERE started_at >= CURRENT_DATE), 0)::BIGINT AS today_gifts,
      COALESCE(SUM(total_earnings) FILTER (WHERE started_at >= CURRENT_DATE), 0)::BIGINT AS today_diamonds,

      COUNT(*) FILTER (WHERE started_at >= NOW() - INTERVAL '7 days')                    AS week_sessions,
      COALESCE(SUM(minutes)        FILTER (WHERE started_at >= NOW() - INTERVAL '7 days'), 0)::BIGINT AS week_minutes,
      COALESCE(SUM(total_gifts)    FILTER (WHERE started_at >= NOW() - INTERVAL '7 days'), 0)::BIGINT AS week_gifts,
      COALESCE(SUM(total_earnings) FILTER (WHERE started_at >= NOW() - INTERVAL '7 days'), 0)::BIGINT AS week_diamonds,

      -- NEW: rolling 30-day "month" window.
      COUNT(*) FILTER (WHERE started_at >= NOW() - INTERVAL '30 days')                    AS month_sessions,
      COALESCE(SUM(minutes)        FILTER (WHERE started_at >= NOW() - INTERVAL '30 days'), 0)::BIGINT AS month_minutes,
      COALESCE(SUM(total_gifts)    FILTER (WHERE started_at >= NOW() - INTERVAL '30 days'), 0)::BIGINT AS month_gifts,
      COALESCE(SUM(total_earnings) FILTER (WHERE started_at >= NOW() - INTERVAL '30 days'), 0)::BIGINT AS month_diamonds
    FROM sessions
  ),
  recent AS (
    SELECT json_agg(row_to_json(r)) AS rows
    FROM (
      SELECT
        id, type, title, started_at, ended_at, status,
        ROUND(minutes)::INT AS minutes,
        peak_viewers, total_gifts, total_earnings
      FROM sessions
      ORDER BY started_at DESC
      LIMIT 10
    ) r
  )
  SELECT json_build_object(
    'today',    json_build_object(
                  'sessions', agg.today_sessions,
                  'minutes',  agg.today_minutes,
                  'gifts',    agg.today_gifts,
                  'diamonds', agg.today_diamonds
                ),
    'week',     json_build_object(
                  'sessions', agg.week_sessions,
                  'minutes',  agg.week_minutes,
                  'gifts',    agg.week_gifts,
                  'diamonds', agg.week_diamonds
                ),
    'month',    json_build_object(
                  'sessions', agg.month_sessions,
                  'minutes',  agg.month_minutes,
                  'gifts',    agg.month_gifts,
                  'diamonds', agg.month_diamonds
                ),
    'all_time', json_build_object(
                  'sessions', agg.total_sessions,
                  'minutes',  agg.total_minutes,
                  'gifts',    agg.total_gifts,
                  'diamonds', agg.total_diamonds
                ),
    'recent_sessions', COALESCE(recent.rows, '[]'::JSON)
  )
  INTO v_result
  FROM agg, recent;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_host_stats(UUID) TO authenticated;


-- =====================================================================
-- DONE
-- =====================================================================
