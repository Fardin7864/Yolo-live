-- =====================================================================
-- 47_lucky_bag_remainder_refund.sql
-- =====================================================================
-- Closes the integer-division leak in create_lucky_bag.
--
-- Before:
--   per := prize_diamonds / winner_count;   -- integer division
--   The remainder (prize_diamonds mod winner_count) was just lost into
--   the void. E.g. a 100💎 bag for 3 winners gave each 33, total paid
--   99, host paid 100 → 1 diamond evaporated. Same for 500/3, 1000/7
--   etc. The user-side audit called this "1–2 diamonds lost per
--   multi-winner bag" — cosmetic but unfair to the host.
--
-- After:
--   We still deduct the FULL prize_diamonds (so the prize pool the host
--   advertised is what gets distributed), but we credit back the
--   remainder immediately so the host's net spend equals
--   per_winner * winner_count. The bag still costs the host
--   prize_diamonds → (remainder), which equals the actual prize that
--   will be paid out. Honest accounting both ways.
--
-- Idempotent: re-runnable. Drop-in replacement.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.create_lucky_bag(
  prize_diamonds bigint,
  winner_count   int
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me        uuid := auth.uid();
  per       bigint;
  remainder bigint;
  bag_id    uuid;
  v_ttl     int;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF prize_diamonds <= 0 THEN RAISE EXCEPTION 'Prize must be positive'; END IF;
  IF winner_count NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Winner count must be 1..100'; END IF;
  IF prize_diamonds < winner_count THEN RAISE EXCEPTION 'Prize too small to split'; END IF;

  per       := prize_diamonds / winner_count;
  remainder := prize_diamonds - (per * winner_count);

  -- Deduct the full advertised prize…
  UPDATE public.profiles
     SET diamonds = diamonds - prize_diamonds
   WHERE id = me AND diamonds >= prize_diamonds;
  IF NOT FOUND THEN RAISE EXCEPTION 'Insufficient diamonds'; END IF;

  -- …then immediately refund the integer-division remainder so the host
  -- isn't charged for diamonds nobody will receive.
  IF remainder > 0 THEN
    UPDATE public.profiles
       SET diamonds = diamonds + remainder
     WHERE id = me;
  END IF;

  v_ttl := public.get_setting_int('lucky_bag_ttl_seconds', 60);

  INSERT INTO public.lucky_bags
    (host_id, room_host_id, prize_diamonds, winner_count, per_winner, expires_at)
  VALUES
    (me, me, per * winner_count, winner_count, per, NOW() + (v_ttl || ' seconds')::interval)
  RETURNING id INTO bag_id;

  RETURN bag_id;
END $$;