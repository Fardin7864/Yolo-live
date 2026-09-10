-- Return typed claim outcomes instead of exposing expected game states as
-- Postgres errors. Claims remain serialized and restricted to the exact live.

CREATE OR REPLACE FUNCTION public.claim_lucky_bag_v2(
  p_bag_id UUID,
  p_stream_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me UUID := auth.uid();
  bag_row public.lucky_bags%ROWTYPE;
  balance_after BIGINT;
BEGIN
  IF me IS NULL THEN
    RETURN jsonb_build_object('success', false, 'status', 'NOT_AUTHENTICATED', 'amount', 0);
  END IF;
  IF p_bag_id IS NULL OR p_stream_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'status', 'INVALID_REQUEST', 'amount', 0);
  END IF;

  SELECT * INTO bag_row
    FROM public.lucky_bags
   WHERE id = p_bag_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'status', 'NOT_FOUND', 'amount', 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.lucky_bag_global_announcements AS announcement
      JOIN public.live_streams AS stream_row ON stream_row.id = announcement.stream_id
     WHERE announcement.bag_id = p_bag_id
       AND announcement.stream_id = p_stream_id
       AND announcement.room_host_id = bag_row.room_host_id
       AND stream_row.broadcaster_id = bag_row.room_host_id
       AND stream_row.status = 'live'
  ) THEN
    RETURN jsonb_build_object('success', false, 'status', 'WRONG_LIVE', 'amount', 0);
  END IF;

  IF bag_row.host_id = me THEN
    RETURN jsonb_build_object('success', false, 'status', 'OWNER', 'amount', 0);
  END IF;
  IF bag_row.status <> 'open' OR bag_row.expires_at <= NOW() THEN
    UPDATE public.lucky_bags SET status = 'closed'
     WHERE id = p_bag_id AND status = 'open';
    RETURN jsonb_build_object('success', false, 'status', 'EXPIRED', 'amount', 0);
  END IF;
  IF bag_row.claimed_count >= bag_row.winner_count THEN
    UPDATE public.lucky_bags SET status = 'closed'
     WHERE id = p_bag_id AND status = 'open';
    RETURN jsonb_build_object('success', false, 'status', 'EMPTY', 'amount', 0);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.lucky_bag_claims
     WHERE bag_id = p_bag_id AND user_id = me
  ) THEN
    SELECT diamonds INTO balance_after FROM public.profiles WHERE id = me;
    RETURN jsonb_build_object(
      'success', false, 'status', 'ALREADY_CLAIMED', 'amount', 0,
      'balance', COALESCE(balance_after, 0)
    );
  END IF;

  INSERT INTO public.lucky_bag_claims(bag_id, user_id, amount)
  VALUES (p_bag_id, me, bag_row.per_winner);

  UPDATE public.lucky_bags
     SET claimed_count = claimed_count + 1,
         status = CASE
           WHEN claimed_count + 1 >= winner_count THEN 'closed'
           ELSE status
         END
   WHERE id = p_bag_id;

  UPDATE public.profiles
     SET diamonds = diamonds + bag_row.per_winner,
         updated_at = NOW()
   WHERE id = me
   RETURNING diamonds INTO balance_after;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Authenticated profile not found';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'status', 'CLAIMED',
    'amount', bag_row.per_winner,
    'balance', balance_after,
    'claimed_count', bag_row.claimed_count + 1,
    'winner_count', bag_row.winner_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_lucky_bag_v2(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_lucky_bag_v2(UUID, UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.claim_lucky_bag_v2(UUID, UUID) IS
  'Claims a room-scoped Lucky Bag and returns a typed outcome plus authoritative balance.';

NOTIFY pgrst, 'reload schema';
