-- =====================================================================
-- 23_room_gifter_ranking.sql — Top gifters for the current live room
-- =====================================================================
-- Aggregates `gifts_log` to compute the top contributors for a host's
-- *currently active* live (since started_at of the latest live_streams
-- row in status='live'). Falls back to last 24h if no active live row.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.room_gifter_ranking(room_host uuid, max_n int DEFAULT 10)
RETURNS TABLE (
  sender_id     uuid,
  sender_name   text,
  sender_avatar text,
  vip_type      text,
  total_diamonds bigint,
  gift_count    bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  session_start timestamptz;
BEGIN
  -- Try to find the active live session's start time. If none, take last
  -- 24 hours so the screen still shows something meaningful.
  SELECT started_at INTO session_start
    FROM public.live_streams
    WHERE broadcaster_id = room_host AND status = 'live'
    ORDER BY started_at DESC
    LIMIT 1;
  IF session_start IS NULL THEN
    session_start := now() - interval '24 hours';
  END IF;

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
    AND g.created_at >= session_start
  GROUP BY g.sender_id, p.full_name, p.avatar_url, p.vip_type
  ORDER BY total_diamonds DESC
  LIMIT max_n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.room_gifter_ranking(uuid, int) TO authenticated;