-- Restrict Lucky Bag creation to the product-approved denominations.
CREATE OR REPLACE FUNCTION public.create_lucky_bag(
  prize_diamonds bigint,
  winner_count int,
  p_room_host_id uuid
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
  v_ttl int;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_room_host_id IS NULL THEN RAISE EXCEPTION 'Room host id required'; END IF;
  IF prize_diamonds <> ALL (ARRAY[5000, 10000, 50000, 100000]::bigint[]) THEN
    RAISE EXCEPTION 'Invalid Lucky Bag amount';
  END IF;
  IF winner_count NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Winner count must be 1..100';
  END IF;
  IF prize_diamonds < winner_count THEN
    RAISE EXCEPTION 'Prize too small to split';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_room_host_id) THEN
    RAISE EXCEPTION 'Unknown room host';
  END IF;

  per := prize_diamonds / winner_count;
  UPDATE public.profiles
     SET diamonds = diamonds - prize_diamonds
   WHERE id = me AND diamonds >= prize_diamonds;
  IF NOT FOUND THEN RAISE EXCEPTION 'Insufficient diamonds'; END IF;

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

