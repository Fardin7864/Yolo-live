-- =====================================================================
-- 114_video_live_reward_and_live_day_stats.sql
-- =====================================================================
-- Product updates:
--   1. Video live 1-hour reward is now 6,000 beans.
--   2. Audio live receives no live-duration reward.
--   3. Host dashboard "sessions" count should mean live days, not raw
--      live_stream rows. If a host starts six lives in one day, it
--      counts as one day.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Heartbeat reward: 6,000 beans, video streams only.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.live_stream_heartbeat(
  p_stream_id        UUID,
  p_viewer_count     INT DEFAULT NULL,
  p_current_viewers  INT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcaster  UUID;
  v_started_at   TIMESTAMPTZ;
  v_type         TEXT;
  v_credited     BOOLEAN;
  v_elapsed_sec  BIGINT;
  v_new_bal      BIGINT;
BEGIN
  SELECT broadcaster_id, started_at, COALESCE(type, 'video'), COALESCE(hour_reward_credited, FALSE)
    INTO v_broadcaster, v_started_at, v_type, v_credited
    FROM public.live_streams
   WHERE id = p_stream_id;

  IF v_broadcaster IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Stream not found');
  END IF;
  IF v_broadcaster <> auth.uid() THEN
    RETURN json_build_object('success', false, 'message', 'Not your stream');
  END IF;

  UPDATE public.live_streams
     SET last_heartbeat_at = NOW(),
         peak_viewers      = GREATEST(COALESCE(peak_viewers, 0), COALESCE(p_viewer_count, 0)),
         current_viewers   = COALESCE(p_current_viewers, current_viewers)
   WHERE id = p_stream_id AND status = 'live';

  v_elapsed_sec := EXTRACT(EPOCH FROM (NOW() - v_started_at))::BIGINT;

  IF v_type = 'video' AND NOT v_credited AND v_elapsed_sec >= 3600 THEN
    UPDATE public.live_streams
       SET hour_reward_credited = TRUE
     WHERE id = p_stream_id
       AND hour_reward_credited = FALSE;

    IF FOUND THEN
      v_new_bal := public.grant_reward(
        v_broadcaster, 6000, 'bean', 'live_hour_reward',
        jsonb_build_object('stream_id', p_stream_id, 'hours', 1, 'type', v_type)
      );

      BEGIN
        INSERT INTO public.notifications (user_id, type, title, body, payload)
        VALUES (
          v_broadcaster,
          'task_reward',
          '1 Hour Live!',
          '+6,000 beans added to your wallet',
          jsonb_build_object(
            'reward',      6000,
            'currency',    'bean',
            'new_balance', v_new_bal,
            'stream_id',   p_stream_id
          )
        );
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;
  END IF;

  RETURN json_build_object('success', true);
END $$;

GRANT EXECUTE ON FUNCTION public.live_stream_heartbeat(UUID, INT, INT) TO authenticated;


-- ---------------------------------------------------------------------
-- 2. Host stats: expose distinct live-day counts in the existing
--    `sessions` JSON field so the mobile app keeps working.
-- ---------------------------------------------------------------------
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
      started_at::date AS live_date,
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
      COUNT(DISTINCT live_date)                                             AS total_live_days,
      COALESCE(SUM(minutes), 0)::BIGINT                                     AS total_minutes,
      COALESCE(SUM(total_gifts), 0)::BIGINT                                 AS total_gifts,
      COALESCE(SUM(total_earnings), 0)::BIGINT                              AS total_diamonds,

      COUNT(DISTINCT live_date) FILTER (WHERE live_date >= CURRENT_DATE)    AS today_live_days,
      COALESCE(SUM(minutes)        FILTER (WHERE started_at >= CURRENT_DATE), 0)::BIGINT AS today_minutes,
      COALESCE(SUM(total_gifts)    FILTER (WHERE started_at >= CURRENT_DATE), 0)::BIGINT AS today_gifts,
      COALESCE(SUM(total_earnings) FILTER (WHERE started_at >= CURRENT_DATE), 0)::BIGINT AS today_diamonds,

      COUNT(DISTINCT live_date) FILTER (WHERE started_at >= NOW() - INTERVAL '7 days') AS week_live_days,
      COALESCE(SUM(minutes)        FILTER (WHERE started_at >= NOW() - INTERVAL '7 days'), 0)::BIGINT AS week_minutes,
      COALESCE(SUM(total_gifts)    FILTER (WHERE started_at >= NOW() - INTERVAL '7 days'), 0)::BIGINT AS week_gifts,
      COALESCE(SUM(total_earnings) FILTER (WHERE started_at >= NOW() - INTERVAL '7 days'), 0)::BIGINT AS week_diamonds,

      COUNT(DISTINCT live_date) FILTER (WHERE started_at >= NOW() - INTERVAL '30 days') AS month_live_days,
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
                  'sessions', agg.today_live_days,
                  'minutes',  agg.today_minutes,
                  'gifts',    agg.today_gifts,
                  'diamonds', agg.today_diamonds
                ),
    'week',     json_build_object(
                  'sessions', agg.week_live_days,
                  'minutes',  agg.week_minutes,
                  'gifts',    agg.week_gifts,
                  'diamonds', agg.week_diamonds
                ),
    'month',    json_build_object(
                  'sessions', agg.month_live_days,
                  'minutes',  agg.month_minutes,
                  'gifts',    agg.month_gifts,
                  'diamonds', agg.month_diamonds
                ),
    'all_time', json_build_object(
                  'sessions', agg.total_live_days,
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
