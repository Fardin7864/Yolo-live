-- =====================================================================
-- 24_room_guardians.sql — Top 3 guardians per host (auto-promoted)
-- =====================================================================
-- Anyone in the top 3 gift contributors to a host over the last 7 days
-- is automatically that host's "guardian." Guardians get a crown badge
-- shown next to their name in chat and the viewer list of that host's
-- live room. Recomputed on demand — no stored guardian state needed.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.room_get_guardians(host_id uuid)
RETURNS TABLE (
  guardian_id   uuid,
  rank          int,
  total_diamonds bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    sender_id        AS guardian_id,
    ROW_NUMBER() OVER (ORDER BY total DESC)::int AS rank,
    total            AS total_diamonds
  FROM (
    SELECT sender_id, SUM(diamond_cost)::bigint AS total
      FROM public.gifts_log
      WHERE receiver_id = host_id
        AND created_at >= now() - interval '7 days'
        AND sender_id IS DISTINCT FROM host_id
      GROUP BY sender_id
      ORDER BY total DESC
      LIMIT 3
  ) t;
$$;

GRANT EXECUTE ON FUNCTION public.room_get_guardians(uuid) TO authenticated;