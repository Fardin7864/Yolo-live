-- =====================================================================
-- 25_lucky_bags.sql — Host-dropped diamond giveaways ("lucky bags")
-- =====================================================================
-- The host pays a prize pool from their own diamonds, picks how many
-- winners can grab it, and a bag drops into the room. The first N
-- viewers to claim each get prize / N diamonds. Race-safe via row locks.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.lucky_bags (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    room_host_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    prize_diamonds    bigint NOT NULL CHECK (prize_diamonds > 0),
    winner_count      int    NOT NULL CHECK (winner_count BETWEEN 1 AND 100),
    per_winner        bigint NOT NULL CHECK (per_winner > 0),
    status            text   NOT NULL DEFAULT 'open', -- open | closed
    claimed_count     int    NOT NULL DEFAULT 0,
    created_at        timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz NOT NULL DEFAULT now() + interval '60 seconds'
);

CREATE INDEX IF NOT EXISTS lucky_bags_room_idx ON public.lucky_bags (room_host_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.lucky_bag_claims (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bag_id      uuid NOT NULL REFERENCES public.lucky_bags(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    amount      bigint NOT NULL,
    claimed_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (bag_id, user_id)
);

ALTER TABLE public.lucky_bags        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lucky_bag_claims  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lucky_bags_read   ON public.lucky_bags;
CREATE POLICY lucky_bags_read   ON public.lucky_bags   FOR SELECT USING (true);

DROP POLICY IF EXISTS lucky_bags_block_write ON public.lucky_bags;
CREATE POLICY lucky_bags_block_write ON public.lucky_bags FOR ALL USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS lucky_claims_read   ON public.lucky_bag_claims;
CREATE POLICY lucky_claims_read   ON public.lucky_bag_claims FOR SELECT USING (true);

DROP POLICY IF EXISTS lucky_claims_block_write ON public.lucky_bag_claims;
CREATE POLICY lucky_claims_block_write ON public.lucky_bag_claims FOR ALL USING (false) WITH CHECK (false);

-- =====================================================================
-- RPC: create_lucky_bag — host pays prize, opens bag in their own room.
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
  me uuid := auth.uid();
  per bigint;
  bag_id uuid;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF prize_diamonds <= 0 THEN RAISE EXCEPTION 'Prize must be positive'; END IF;
  IF winner_count NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Winner count must be 1..100'; END IF;
  IF prize_diamonds < winner_count THEN RAISE EXCEPTION 'Prize too small to split'; END IF;

  per := prize_diamonds / winner_count;

  -- Deduct prize from host's diamonds atomically.
  UPDATE public.profiles
     SET diamonds = diamonds - prize_diamonds
   WHERE id = me AND diamonds >= prize_diamonds;
  IF NOT FOUND THEN RAISE EXCEPTION 'Insufficient diamonds'; END IF;

  INSERT INTO public.lucky_bags (host_id, room_host_id, prize_diamonds, winner_count, per_winner)
    VALUES (me, me, prize_diamonds, winner_count, per)
    RETURNING id INTO bag_id;

  RETURN bag_id;
END;
$$;

-- =====================================================================
-- RPC: claim_lucky_bag — first N viewers each win per_winner diamonds.
-- Returns the amount won (0 if too late / already claimed).
-- =====================================================================
CREATE OR REPLACE FUNCTION public.claim_lucky_bag(bag uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
  rec public.lucky_bags%ROWTYPE;
  prize bigint := 0;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  -- Lock the bag row to prevent races on the claimed_count update.
  SELECT * INTO rec FROM public.lucky_bags WHERE id = bag FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bag not found'; END IF;

  IF rec.host_id = me THEN
    RAISE EXCEPTION 'Host cannot claim their own bag';
  END IF;
  IF rec.status <> 'open' OR rec.expires_at < now() THEN
    UPDATE public.lucky_bags SET status = 'closed' WHERE id = bag AND status = 'open';
    RETURN 0;
  END IF;
  IF rec.claimed_count >= rec.winner_count THEN
    UPDATE public.lucky_bags SET status = 'closed' WHERE id = bag AND status = 'open';
    RETURN 0;
  END IF;

  -- Has this user already claimed?
  IF EXISTS (SELECT 1 FROM public.lucky_bag_claims WHERE bag_id = bag AND user_id = me) THEN
    RETURN 0;
  END IF;

  prize := rec.per_winner;
  INSERT INTO public.lucky_bag_claims (bag_id, user_id, amount) VALUES (bag, me, prize);

  UPDATE public.lucky_bags
     SET claimed_count = claimed_count + 1,
         status = CASE WHEN claimed_count + 1 >= winner_count THEN 'closed' ELSE status END
   WHERE id = bag;

  -- Pay the winner.
  UPDATE public.profiles SET diamonds = diamonds + prize WHERE id = me;

  RETURN prize;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_lucky_bag(bigint, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_lucky_bag(uuid)         TO authenticated;