-- =====================================================================
-- 30_top_broadcasters_rpc.sql — Global top broadcasters in the last 24h
-- =====================================================================
-- Replaces the dummy `leaderboard` constant on the explore screen with
-- a real aggregate over `gifts_log`. Top broadcasters are ranked by the
-- total diamonds they received from gifts in the trailing 24 hours.
--
-- The RPC takes a `limit_n` so the same function can power both the
-- "Daily Top 3" widget and a "View All Top 20" sheet.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.get_top_broadcasters_24h(limit_n int DEFAULT 20)
RETURNS TABLE (
  broadcaster_id   uuid,
  full_name        text,
  avatar_url       text,
  display_id       bigint,
  vip_type         text,
  total_diamonds   bigint,
  gift_count       bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    g.receiver_id                AS broadcaster_id,
    p.full_name,
    p.avatar_url,
    p.display_id,
    p.vip_type,
    SUM(g.diamond_cost)::bigint  AS total_diamonds,
    COUNT(*)::bigint             AS gift_count
  FROM public.gifts_log g
  JOIN public.profiles p ON p.id = g.receiver_id
  WHERE g.created_at >= now() - interval '24 hours'
    AND COALESCE(p.is_banned, false) = false
  GROUP BY g.receiver_id, p.full_name, p.avatar_url, p.display_id, p.vip_type
  ORDER BY total_diamonds DESC
  LIMIT GREATEST(1, LEAST(limit_n, 50));
$$;

GRANT EXECUTE ON FUNCTION public.get_top_broadcasters_24h(int) TO authenticated;
