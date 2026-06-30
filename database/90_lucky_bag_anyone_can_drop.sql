-- =====================================================================
-- 90_lucky_bag_anyone_can_drop.sql
-- =====================================================================
-- Lucky Bag was already an "anyone authenticated can call" RPC at the
-- DB level, but the original create_lucky_bag(prize, winners) signature
-- forced room_host_id = caller. That meant a viewer-dropped bag was
-- silently mis-attributed to the viewer's "own room," which broke
-- per-room history queries and made the analytics view of a hot room
-- look like a bunch of empty solo rooms by random viewers.
--
-- This migration switches the RPC to require the actual broadcasting
-- room owner (p_room_host_id) so the bag is recorded against the room
-- the viewer is watching. host_id keeps tracking the dropper (used by
-- claim_lucky_bag to block self-claims).
--
-- Behavioural changes:
--   • Anyone with enough diamonds can drop a bag in any live room.
--   • The dropper is recorded as host_id (cannot claim their own bag).
--   • The room owner is recorded as room_host_id (can claim a viewer-
--     dropped bag, since claim_lucky_bag only excludes host_id = me).
--
-- Idempotent: re-runnable. DROPs the old 2-arg variant so callers are
-- forced to pass the room context.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Drop the old signature so no code path can silently keep using it.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_lucky_bag(bigint, int);

-- ---------------------------------------------------------------------
-- 2. New signature — explicit room_host_id parameter.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_lucky_bag(
  prize_diamonds  bigint,
  winner_count    int,
  p_room_host_id  uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me      uuid := auth.uid();
  per     bigint;
  bag_id  uuid;
  v_ttl   int;
BEGIN
  IF me              IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_room_host_id  IS NULL THEN RAISE EXCEPTION 'Room host id required'; END IF;
  IF prize_diamonds  <= 0    THEN RAISE EXCEPTION 'Prize must be positive'; END IF;
  IF winner_count    NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Winner count must be 1..100';
  END IF;
  IF prize_diamonds  < winner_count THEN
    RAISE EXCEPTION 'Prize too small to split';
  END IF;

  -- Confirm the room owner exists (cheap sanity check — no FK widening
  -- needed, the lucky_bags row already FK's room_host_id to profiles).
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_room_host_id) THEN
    RAISE EXCEPTION 'Unknown room host';
  END IF;

  per := prize_diamonds / winner_count;

  -- Atomically deduct the prize from the dropper's diamonds.
  UPDATE public.profiles
     SET diamonds = diamonds - prize_diamonds
   WHERE id = me AND diamonds >= prize_diamonds;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient diamonds';
  END IF;

  v_ttl := public.get_setting_int('lucky_bag_ttl_seconds', 60);

  INSERT INTO public.lucky_bags
    (host_id, room_host_id, prize_diamonds, winner_count, per_winner, expires_at)
  VALUES
    (me, p_room_host_id, prize_diamonds, winner_count, per,
     NOW() + (v_ttl || ' seconds')::interval)
  RETURNING id INTO bag_id;

  RETURN bag_id;
END $$;

GRANT EXECUTE ON FUNCTION public.create_lucky_bag(bigint, int, uuid) TO authenticated;
