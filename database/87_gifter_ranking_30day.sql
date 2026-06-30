-- =====================================================================
-- 87_gifter_ranking_30day.sql
-- =====================================================================
-- Changes the trophy-icon "Top Gifters" leaderboard in the broadcast
-- room from PER-LIVE-SESSION to ROLLING 30 DAYS per host.
--
-- BEFORE (migration 23):
--   Aggregation window = the host's currently-active live session's
--   started_at, or last 24 hours as fallback. Result: when a host
--   ended their live and restarted, the leaderboard dropped to zero
--   and every viewer had to re-prove themselves to climb back on.
--   Loyal regulars hated it.
--
-- AFTER (this migration):
--   Aggregation window = rolling 30 days from NOW(), regardless of
--   whether the host is currently live or how many times they've
--   restarted. A viewer who tipped 50k last week stays at the top
--   even if today's stream has zero gifts so far. After 30 days the
--   contribution falls off the window naturally — no manual reset.
--
-- The output column shape is UNCHANGED — same `sender_id`,
-- `sender_name`, `sender_avatar`, `vip_type`, `total_diamonds`,
-- `gift_count`. The mobile client (`app/broadcast/[id].js`'s
-- `refreshGifterRanking`) keeps working without an APK rebuild.
--
-- Index strategy: the existing `idx_gifts_log_receiver` (created in
-- `yolo_schema.sql` line 162) on `(receiver_id, created_at DESC)`
-- already serves this query — the filter is
-- `WHERE receiver_id = ? AND created_at >= ?`, exactly what the index
-- covers. No new index needed.
--
-- Idempotent.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.room_gifter_ranking(room_host uuid, max_n int DEFAULT 10)
RETURNS TABLE (
  sender_id      uuid,
  sender_name    text,
  sender_avatar  text,
  vip_type       text,
  total_diamonds bigint,
  gift_count     bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    g.sender_id,
    p.full_name   AS sender_name,
    p.avatar_url  AS sender_avatar,
    p.vip_type    AS vip_type,
    SUM(g.diamond_cost)::bigint AS total_diamonds,
    COUNT(*)::bigint            AS gift_count
  FROM public.gifts_log g
  LEFT JOIN public.profiles p ON p.id = g.sender_id
  WHERE g.receiver_id = room_host
    -- 30-day rolling window. Was the current live session's started_at
    -- (mig 23). Loyal regulars stay visible across re-streams.
    AND g.created_at >= NOW() - INTERVAL '30 days'
  GROUP BY g.sender_id, p.full_name, p.avatar_url, p.vip_type
  ORDER BY total_diamonds DESC
  LIMIT max_n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.room_gifter_ranking(uuid, int) TO authenticated;


-- =====================================================================
-- DONE
-- =====================================================================
