-- =====================================================================
-- 75_host_stats_rpc.sql
-- =====================================================================
-- Powers the new host-stats dashboard (`app/main/host-stats.js`).
-- A host wants to see "how am I doing": minutes I've been live, gifts
-- I've received, diamonds I've earned, count of sessions — broken down
-- into Today / Last-7-days / All-time, plus the most recent 10 sessions.
--
-- All data already lives on `live_streams`:
--   - started_at / ended_at  →  derived live minutes per session
--   - total_gifts            →  gift count
--   - total_earnings         →  diamond earnings
--   - peak_viewers           →  per-session peak (shown in the row list)
--
-- We expose ONE RPC that returns everything in one round-trip so the
-- screen doesn't fire 4 parallel queries on every refresh.
--
-- Access:
--   - host themselves (auth.uid() = p_host_id)
--   - admins / super_admins
--   - the agency owner whose agency this host is bound under
-- This matches the privacy expectation: stats are private to the host
-- and the people directly responsible for the host's earnings.
--
-- Idempotent: re-runnable.
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

  -- Agency owner of the host? Owners can see their hosts' stats.
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

  -- One pass over live_streams; FILTER lets us compute today / week /
  -- all-time off the same scan.
  WITH sessions AS (
    SELECT
      id, type, title, started_at, ended_at, status,
      COALESCE(peak_viewers, 0)   AS peak_viewers,
      COALESCE(total_gifts, 0)    AS total_gifts,
      COALESCE(total_earnings, 0) AS total_earnings,
      -- For a still-live session we use NOW() as the right edge so the
      -- "minutes today" counter actually moves while the host streams.
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
      COALESCE(SUM(total_earnings) FILTER (WHERE started_at >= NOW() - INTERVAL '7 days'), 0)::BIGINT AS week_diamonds
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
