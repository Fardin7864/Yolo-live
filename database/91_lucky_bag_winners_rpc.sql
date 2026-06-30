-- =====================================================================
-- 91_lucky_bag_winners_rpc.sql
-- =====================================================================
-- Adds get_lucky_bag_winners() so the mobile client can show "who
-- grabbed beans from this bag" in a ranked list when a viewer taps
-- a Lucky Bag. Without an RPC we'd need a join across lucky_bag_claims
-- and profiles, and profiles' SELECT RLS limits cross-user reads — so
-- a SECURITY DEFINER function is the clean path.
--
-- Returns rows in claim order (= rank), with profile name and avatar
-- + the amount each winner received and the timestamp they claimed.
-- The client uses the rank to render "You won X 💎, #3 of 10" and
-- shows the full list as a ranked board.
--
-- Idempotent: re-runnable.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.get_lucky_bag_winners(p_bag_id uuid)
RETURNS TABLE (
  rank        int,
  user_id     uuid,
  full_name   text,
  avatar_url  text,
  amount      bigint,
  claimed_at  timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    -- ROW_NUMBER over claimed_at gives a stable 1-based rank that
    -- matches the order they tapped in. Ties (same millisecond) are
    -- broken by id so the list is deterministic across re-fetches.
    ROW_NUMBER() OVER (ORDER BY c.claimed_at ASC, c.id ASC)::int AS rank,
    c.user_id,
    COALESCE(p.full_name, 'User')::text  AS full_name,
    p.avatar_url::text                   AS avatar_url,
    c.amount,
    c.claimed_at
  FROM public.lucky_bag_claims c
  LEFT JOIN public.profiles p ON p.id = c.user_id
  WHERE c.bag_id = p_bag_id
  ORDER BY rank;
$$;

GRANT EXECUTE ON FUNCTION public.get_lucky_bag_winners(uuid) TO authenticated;
