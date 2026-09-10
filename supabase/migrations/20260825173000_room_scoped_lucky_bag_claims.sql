-- Lucky Bags are globally discoverable, but claimable only from the exact
-- live stream where they were dropped.

CREATE OR REPLACE FUNCTION public.claim_lucky_bag(bag UUID, p_stream_id UUID)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me UUID := auth.uid();
  rec public.lucky_bags%ROWTYPE;
  prize BIGINT := 0;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_stream_id IS NULL THEN RAISE EXCEPTION 'Live stream id is required'; END IF;

  SELECT * INTO rec
    FROM public.lucky_bags
   WHERE id = bag
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bag not found'; END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.lucky_bag_global_announcements AS announcement
      JOIN public.live_streams AS stream_row
        ON stream_row.id = announcement.stream_id
     WHERE announcement.bag_id = bag
       AND announcement.stream_id = p_stream_id
       AND announcement.room_host_id = rec.room_host_id
       AND stream_row.broadcaster_id = rec.room_host_id
       AND stream_row.status = 'live'
  ) THEN
    RAISE EXCEPTION 'This Lucky Bag is not available in this live stream';
  END IF;

  IF rec.host_id = me THEN
    RAISE EXCEPTION 'Host cannot claim their own bag';
  END IF;
  IF rec.status <> 'open' OR rec.expires_at < NOW() THEN
    UPDATE public.lucky_bags SET status = 'closed' WHERE id = bag AND status = 'open';
    RETURN 0;
  END IF;
  IF rec.claimed_count >= rec.winner_count THEN
    UPDATE public.lucky_bags SET status = 'closed' WHERE id = bag AND status = 'open';
    RETURN 0;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.lucky_bag_claims
     WHERE bag_id = bag AND user_id = me
  ) THEN
    RETURN 0;
  END IF;

  prize := rec.per_winner;
  INSERT INTO public.lucky_bag_claims(bag_id, user_id, amount)
  VALUES (bag, me, prize);

  UPDATE public.lucky_bags
     SET claimed_count = claimed_count + 1,
         status = CASE
           WHEN claimed_count + 1 >= winner_count THEN 'closed'
           ELSE status
         END
   WHERE id = bag;

  UPDATE public.profiles
     SET diamonds = diamonds + prize,
         updated_at = NOW()
   WHERE id = me;

  RETURN prize;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_lucky_bag(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_lucky_bag(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_lucky_bag(UUID, UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.claim_lucky_bag(UUID, UUID) IS
  'Claims a Lucky Bag only when p_stream_id is its active source live.';
