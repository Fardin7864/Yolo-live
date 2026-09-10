-- Global Lucky Bags + authoritative/reconnect-safe gift state.
-- Intentionally not coupled to any UI or unrelated agency migration.

CREATE TABLE IF NOT EXISTS public.lucky_bag_global_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bag_id UUID NOT NULL UNIQUE REFERENCES public.lucky_bags(id) ON DELETE CASCADE,
  stream_id UUID NOT NULL REFERENCES public.live_streams(id) ON DELETE CASCADE,
  room_host_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  dropper_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  prize_diamonds BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS lucky_bag_global_active_idx
  ON public.lucky_bag_global_announcements(expires_at DESC);
ALTER TABLE public.lucky_bag_global_announcements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lucky_bag_global_read ON public.lucky_bag_global_announcements;
CREATE POLICY lucky_bag_global_read ON public.lucky_bag_global_announcements
  FOR SELECT TO authenticated USING (expires_at > NOW());
GRANT SELECT ON public.lucky_bag_global_announcements TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.lucky_bag_global_announcements FROM anon, authenticated;

-- A committed request UUID makes a network retry return the original result
-- instead of charging the sender and crediting recipients a second time.
CREATE TABLE IF NOT EXISTS public.gift_batch_requests (
  sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sender_id, request_id)
);
ALTER TABLE public.gift_batch_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gift_batch_requests FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_lucky_bag(
  prize_diamonds BIGINT,
  winner_count INT,
  p_room_host_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me UUID := auth.uid();
  per_winner BIGINT;
  remainder BIGINT;
  distributable_prize BIGINT;
  bag_id UUID;
  ttl_seconds INT;
  stream_id UUID;
  bag_expires TIMESTAMPTZ;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF prize_diamonds <> ALL(ARRAY[5000,10000,50000,100000]::BIGINT[]) THEN
    RAISE EXCEPTION 'Invalid Lucky Bag amount';
  END IF;
  IF winner_count NOT BETWEEN 1 AND 100 OR prize_diamonds < winner_count THEN
    RAISE EXCEPTION 'Invalid winner count';
  END IF;

  SELECT live_row.id INTO stream_id
  FROM public.live_streams AS live_row
  WHERE live_row.broadcaster_id = p_room_host_id AND live_row.status = 'live'
  ORDER BY live_row.started_at DESC LIMIT 1;
  IF stream_id IS NULL THEN RAISE EXCEPTION 'The target live is no longer running'; END IF;

  per_winner := prize_diamonds / winner_count;
  remainder := prize_diamonds - (per_winner * winner_count);
  distributable_prize := per_winner * winner_count;

  UPDATE public.profiles
  SET diamonds = diamonds - prize_diamonds, updated_at = NOW()
  WHERE id = me AND diamonds >= prize_diamonds;
  IF NOT FOUND THEN RAISE EXCEPTION 'Insufficient diamonds'; END IF;

  -- Integer division must not destroy currency. Refund the undistributable
  -- remainder and persist/announce only the amount claimants can receive.
  IF remainder > 0 THEN
    UPDATE public.profiles
    SET diamonds = diamonds + remainder, updated_at = NOW()
    WHERE id = me;
  END IF;

  ttl_seconds := public.get_setting_int('lucky_bag_ttl_seconds', 60);
  bag_expires := NOW() + MAKE_INTERVAL(secs => ttl_seconds);
  INSERT INTO public.lucky_bags(
    host_id, room_host_id, prize_diamonds, winner_count, per_winner, expires_at
  ) VALUES (
    me, p_room_host_id, distributable_prize, winner_count, per_winner, bag_expires
  ) RETURNING id INTO bag_id;

  -- This persisted row is the global fan-out source. room_host_id is only
  -- attribution; clients intentionally do not filter visibility by room.
  INSERT INTO public.lucky_bag_global_announcements(
    bag_id, stream_id, room_host_id, dropper_id, prize_diamonds, expires_at
  ) VALUES (
    bag_id, stream_id, p_room_host_id, me, distributable_prize, bag_expires
  );
  RETURN bag_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.send_gift_batch(
  p_recipients JSONB,
  p_gift_id TEXT,
  p_diamond_cost BIGINT,
  p_room_id UUID,
  p_gift_name TEXT,
  p_count INT,
  p_request_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me UUID := auth.uid();
  v_unit_cost BIGINT;
  v_bean_value BIGINT;
  v_name TEXT;
  v_active BOOLEAN;
  v_required_vip TEXT;
  v_sender_vip TEXT;
  v_vip_expires TIMESTAMPTZ;
  v_recipient_count INT;
  v_total_cost BIGINT;
  v_total_beans BIGINT;
  v_sender_balance BIGINT;
  v_balance_after BIGINT;
  v_host_earnings_delta BIGINT := 0;
  v_stream_total_gifts BIGINT;
  v_stream_total_earnings BIGINT;
  v_room_host_id UUID;
  v_gift_logs JSONB := '[]'::JSONB;
  v_response JSONB;
BEGIN
  IF me IS NULL THEN RETURN jsonb_build_object('success', FALSE, 'message', 'Not authenticated'); END IF;
  IF p_request_id IS NULL THEN RETURN jsonb_build_object('success', FALSE, 'message', 'Gift request id is required'); END IF;

  -- Serialize equal request IDs even when two retries arrive concurrently.
  PERFORM pg_advisory_xact_lock(hashtextextended(me::TEXT || ':' || p_request_id::TEXT, 0));
  SELECT request_row.response INTO v_response
  FROM public.gift_batch_requests AS request_row
  WHERE request_row.sender_id = me AND request_row.request_id = p_request_id;
  IF FOUND THEN RETURN v_response; END IF;

  IF p_count IS NULL OR p_count < 1 OR p_count > 1000 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Invalid gift quantity');
  END IF;
  IF jsonb_typeof(p_recipients) <> 'array' THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Recipients must be a JSON array');
  END IF;

  CREATE TEMP TABLE batch_recipients(user_id UUID PRIMARY KEY, delivery_order INT NOT NULL) ON COMMIT DROP;
  BEGIN
    INSERT INTO batch_recipients(user_id, delivery_order)
    SELECT value::UUID, ordinality::INT
    FROM jsonb_array_elements_text(p_recipients) WITH ORDINALITY AS recipient(value, ordinality);
  EXCEPTION
    WHEN unique_violation THEN RETURN jsonb_build_object('success', FALSE, 'message', 'Duplicate recipients are not allowed');
    WHEN invalid_text_representation THEN RETURN jsonb_build_object('success', FALSE, 'message', 'Invalid recipient id');
  END;

  SELECT COUNT(*) INTO v_recipient_count FROM batch_recipients;
  IF v_recipient_count < 1 OR v_recipient_count > 20 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Choose 1 to 20 recipients');
  END IF;
  IF EXISTS(SELECT 1 FROM batch_recipients WHERE user_id = me) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'You cannot gift yourself');
  END IF;
  IF EXISTS(
    SELECT 1 FROM batch_recipients AS recipient
    LEFT JOIN public.profiles AS profile_row ON profile_row.id = recipient.user_id
    WHERE profile_row.id IS NULL OR COALESCE(profile_row.is_banned, FALSE)
  ) THEN RETURN jsonb_build_object('success', FALSE, 'message', 'A recipient is unavailable'); END IF;

  IF p_room_id IS NOT NULL THEN
    SELECT stream_row.broadcaster_id INTO v_room_host_id
    FROM public.live_streams AS stream_row
    WHERE stream_row.id = p_room_id AND stream_row.status = 'live'
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', FALSE, 'message', 'The target live is no longer running');
    END IF;
  END IF;

  SELECT gift_row.diamond_cost, COALESCE(gift_row.bean_value, gift_row.diamond_cost / 2),
    gift_row.name, COALESCE(gift_row.is_active, TRUE), gift_row.required_vip_type
  INTO v_unit_cost, v_bean_value, v_name, v_active, v_required_vip
  FROM public.gifts AS gift_row WHERE gift_row.id = p_gift_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', FALSE, 'message', 'Gift is not in the active catalog');
  ELSIF NOT v_active THEN RETURN jsonb_build_object('success', FALSE, 'message', 'This gift is unavailable'); END IF;
  IF v_unit_cost IS NULL OR v_unit_cost <= 0 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Invalid gift price');
  END IF;

  IF v_required_vip IS NOT NULL THEN
    SELECT profile_row.vip_type, profile_row.vip_expires_at INTO v_sender_vip, v_vip_expires
    FROM public.profiles AS profile_row WHERE profile_row.id = me;
    IF v_vip_expires IS NULL OR v_vip_expires <= NOW()
      OR (v_required_vip = 'VIP' AND v_sender_vip NOT IN ('VIP','SVIP','VVIP'))
      OR (v_required_vip = 'SVIP' AND v_sender_vip NOT IN ('SVIP','VVIP'))
      OR (v_required_vip = 'VVIP' AND v_sender_vip <> 'VVIP')
    THEN RETURN jsonb_build_object('success', FALSE, 'message', v_required_vip || ' membership is required'); END IF;
  END IF;

  v_total_cost := v_unit_cost * p_count * v_recipient_count;
  v_total_beans := v_bean_value * p_count;
  SELECT profile_row.diamonds INTO v_sender_balance
  FROM public.profiles AS profile_row
  WHERE profile_row.id = me AND NOT COALESCE(profile_row.is_banned, FALSE) FOR UPDATE;
  IF NOT FOUND OR COALESCE(v_sender_balance, 0) < v_total_cost THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Insufficient diamonds');
  END IF;

  UPDATE public.profiles SET diamonds = diamonds - v_total_cost, updated_at = NOW()
  WHERE id = me RETURNING diamonds INTO v_balance_after;
  UPDATE public.profiles AS profile_row
  SET beans = COALESCE(profile_row.beans, 0) + v_total_beans, updated_at = NOW()
  FROM batch_recipients AS recipient WHERE profile_row.id = recipient.user_id;

  WITH inserted_gifts AS (
    INSERT INTO public.gifts_log(
      sender_id, receiver_id, gift_id, gift_name, diamond_cost, bean_value, count, room_id
    ) SELECT me, recipient.user_id, p_gift_id, v_name,
      v_unit_cost * p_count, v_total_beans, p_count, p_room_id
    FROM batch_recipients AS recipient ORDER BY recipient.delivery_order
    RETURNING id, receiver_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'receiver_id', receiver_id)), '[]'::JSONB)
  INTO v_gift_logs FROM inserted_gifts;

  INSERT INTO public.transactions(user_id, related_user_id, type, currency, amount, status, notes)
  VALUES(me, NULL, 'gift_sent', 'diamond', -v_total_cost, 'completed',
    'Atomic batch gift to ' || v_recipient_count || ' recipients');
  INSERT INTO public.transactions(user_id, related_user_id, type, currency, amount, status, notes)
  SELECT recipient.user_id, me, 'gift_received', 'bean', v_total_beans, 'completed', 'Atomic batch gift'
  FROM batch_recipients AS recipient ORDER BY recipient.delivery_order;

  IF p_room_id IS NOT NULL THEN
    SELECT CASE WHEN EXISTS(
      SELECT 1 FROM batch_recipients AS recipient
      WHERE recipient.user_id = v_room_host_id
    ) THEN v_unit_cost * p_count ELSE 0 END
    INTO v_host_earnings_delta;

    IF v_host_earnings_delta > 0 THEN
      UPDATE public.live_streams AS live_row SET
        total_gifts = COALESCE(live_row.total_gifts, 0) + p_count,
        total_earnings = COALESCE(live_row.total_earnings, 0) + v_host_earnings_delta
      WHERE live_row.id = p_room_id
        AND live_row.status = 'live'
        AND live_row.broadcaster_id = v_room_host_id
      RETURNING live_row.total_gifts, live_row.total_earnings
      INTO v_stream_total_gifts, v_stream_total_earnings;
    ELSE
      SELECT live_row.total_gifts, live_row.total_earnings
      INTO v_stream_total_gifts, v_stream_total_earnings
      FROM public.live_streams AS live_row WHERE live_row.id = p_room_id;
    END IF;
  END IF;

  v_response := jsonb_build_object(
    'success', TRUE, 'delivery_mode', 'atomic_batch',
    'request_id', p_request_id,
    'recipient_count', v_recipient_count, 'diamonds_spent', v_total_cost,
    'diamond_balance', v_balance_after, 'beans_per_recipient', v_total_beans,
    'host_earnings_delta', v_host_earnings_delta,
    'stream_total_gifts', v_stream_total_gifts,
    'stream_total_earnings', v_stream_total_earnings,
    'gift_logs', v_gift_logs
  );
  INSERT INTO public.gift_batch_requests(sender_id, request_id, response)
  VALUES (me, p_request_id, v_response);
  RETURN v_response;
END;
$$;

-- Compatibility for installed clients that do not send a request UUID yet.
-- New clients should call the seven-argument overload and reuse one UUID for
-- every retry of the same user action.
CREATE OR REPLACE FUNCTION public.send_gift_batch(
  p_recipients JSONB,
  p_gift_id TEXT,
  p_diamond_cost BIGINT,
  p_room_id UUID DEFAULT NULL,
  p_gift_name TEXT DEFAULT NULL,
  p_count INT DEFAULT 1
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN public.send_gift_batch(
    p_recipients, p_gift_id, p_diamond_cost, p_room_id, p_gift_name,
    p_count, gen_random_uuid()
  );
END;
$$;

-- One reconnect-safe snapshot for both audio and video clients.
CREATE OR REPLACE FUNCTION public.get_live_gift_state(p_stream_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_stream public.live_streams%ROWTYPE;
  v_history JSONB;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('success', FALSE, 'message', 'Not authenticated'); END IF;
  SELECT * INTO v_stream FROM public.live_streams WHERE id = p_stream_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', FALSE, 'message', 'Live stream not found'); END IF;

  SELECT COALESCE(jsonb_agg(history.item ORDER BY history.created_at DESC), '[]'::JSONB)
  INTO v_history
  FROM (
    SELECT jsonb_build_object(
      'id', gift_row.id,
      'sender_id', gift_row.sender_id,
      'sender_name', COALESCE(sender.full_name, 'Someone'),
      'sender_avatar', sender.avatar_url,
      'receiver_id', gift_row.receiver_id,
      'receiver_name', COALESCE(receiver.full_name, 'Host'),
      'gift_id', gift_row.gift_id,
      'gift_name', COALESCE(gift_row.gift_name, 'Gift'),
      'count', COALESCE(gift_row.count, 1),
      'diamond_cost', gift_row.diamond_cost,
      'bean_value', gift_row.bean_value,
      'created_at', gift_row.created_at
    ) AS item, gift_row.created_at
    FROM public.gifts_log AS gift_row
    LEFT JOIN public.profiles AS sender ON sender.id = gift_row.sender_id
    LEFT JOIN public.profiles AS receiver ON receiver.id = gift_row.receiver_id
    WHERE gift_row.room_id = p_stream_id
    ORDER BY gift_row.created_at DESC
    LIMIT 50
  ) AS history;

  RETURN jsonb_build_object(
    'success', TRUE,
    'stream_id', v_stream.id,
    'stream_type', v_stream.type,
    'total_gifts', COALESCE(v_stream.total_gifts, 0),
    'total_earnings', COALESCE(v_stream.total_earnings, 0),
    'recent_gifts', v_history
  );
END;
$$;

-- gifts_log.diamond_cost already stores the full quantity-adjusted value.
-- Multiplying by count again made audio seat amounts grow by count squared.
CREATE OR REPLACE FUNCTION public.get_room_seat_earnings(p_host_id UUID)
RETURNS TABLE(receiver_id UUID, diamonds_received BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_stream_id UUID;
BEGIN
  IF auth.uid() IS NULL OR p_host_id IS NULL THEN RETURN; END IF;
  SELECT id INTO v_stream_id FROM public.live_streams
  WHERE broadcaster_id = p_host_id AND status = 'live'
  ORDER BY started_at DESC LIMIT 1;
  IF v_stream_id IS NULL THEN
    SELECT id INTO v_stream_id FROM public.live_streams
    WHERE broadcaster_id = p_host_id ORDER BY started_at DESC LIMIT 1;
  END IF;
  IF v_stream_id IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT gift_row.receiver_id, COALESCE(SUM(gift_row.diamond_cost), 0)::BIGINT
  FROM public.gifts_log AS gift_row
  WHERE gift_row.room_id = v_stream_id
  GROUP BY gift_row.receiver_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_lucky_bag(BIGINT, INT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_lucky_bag(BIGINT, INT, UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.send_gift_batch(JSONB, TEXT, BIGINT, UUID, TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_gift_batch(JSONB, TEXT, BIGINT, UUID, TEXT, INT) TO authenticated;
REVOKE ALL ON FUNCTION public.send_gift_batch(JSONB, TEXT, BIGINT, UUID, TEXT, INT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_gift_batch(JSONB, TEXT, BIGINT, UUID, TEXT, INT, UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.get_live_gift_state(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_live_gift_state(UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.get_room_seat_earnings(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_room_seat_earnings(UUID) TO authenticated;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.lucky_bag_global_announcements;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
NOTIFY pgrst, 'reload schema';
