-- =====================================================================
-- 99_celebrity_hosts_rpc.sql — top-5% earner host ids for "CELEBRITY" badge
-- =====================================================================
-- Powers the gold "CELEBRITY" badge that lights up the top-right corner
-- of a live card on the home grid. The badge appears on hosts who
-- received gifts in the top 5% of all earners over the last 30 days —
-- so it's an automatic recognition signal that adjusts as the leader-
-- board shifts, no admin tagging required.
--
-- Returns a UUID array (possibly empty) of profile ids that qualify.
-- The home screen fetches this once on mount, builds a Set, and passes
-- isCelebrity={set.has(broadcasterId)} to each card.
--
-- The PERCENT_RANK window function is correct here: it gives each
-- earner a normalised rank in [0..1] where 1.0 is the top earner.
-- pct >= 0.95 picks up everyone in the top 5% slice. A receiver with
-- zero monthly earnings is excluded because they don't appear in the
-- CTE at all (no gifts_log rows in the window).
--
-- Idempotent. STABLE (read-only). No auth restriction — celebrity
-- status is intentionally public information.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.get_celebrity_host_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
AS $$
  WITH ranked AS (
    SELECT
      receiver_id,
      SUM(diamond_cost * GREATEST(count, 1)) AS earned,
      PERCENT_RANK() OVER (ORDER BY SUM(diamond_cost * GREATEST(count, 1))) AS pct
    FROM public.gifts_log
    WHERE created_at >= NOW() - INTERVAL '30 days'
      AND receiver_id IS NOT NULL
    GROUP BY receiver_id
  )
  SELECT COALESCE(ARRAY_AGG(receiver_id), ARRAY[]::uuid[])
  FROM ranked
  WHERE pct >= 0.95;
$$;

GRANT EXECUTE ON FUNCTION public.get_celebrity_host_ids() TO authenticated, anon;
