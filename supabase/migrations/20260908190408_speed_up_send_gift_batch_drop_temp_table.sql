-- Make sending a gift cheaper.
--
-- send_gift_batch created a TEMP TABLE on every single call. Each gift therefore
-- wrote rows into pg_class / pg_attribute / pg_type, which bloats the system
-- catalogs, keeps autovacuum busy on them, and costs far more than the handful
-- of recipient ids it was holding (1-20). Under contention that per-call catalog
-- work is a real part of why gifts crept past the 8s statement_timeout that the
-- `authenticated` role enforces, producing "canceling statement due to statement
-- timeout".
--
-- The recipient list now lives in a UUID[] and is expanded with
-- unnest(...) WITH ORDINALITY where the old code joined the temp table. Delivery
-- order, duplicate rejection, the 1-20 bound and every self-gift rule are
-- unchanged; this is purely mechanical.
--
-- Side benefit: the temp table was ON COMMIT DROP, so two gifts in one
-- transaction failed with 'relation "batch_recipients" already exists'. That
-- limitation is gone.

CREATE OR REPLACE FUNCTION public.send_gift_batch(
  p_recipients jsonb,
  p_gift_id text,
  p_diamond_cost bigint,
  p_room_id uuid,
  p_gift_name text,
  p_count integer,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  me UUID := auth.uid();
  v_recipients UUID[];
  v_unit_cost BIGINT;
  v_bean_value BIGINT;
  v_name TEXT;
  v_active BOOLEAN;
  v_required_vip TEXT;
  v_sender_vip TEXT;
  v_vip_expires TIMESTAMPTZ;
  v_recipient_count INT;
  v_valid_count INT;
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
  v_has_self BOOLEAN := FALSE;
  v_self_counts BOOLEAN := FALSE;
  v_self_cost BIGINT := 0;
  v_cfg RECORD;
  v_today RECORD;
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

  BEGIN
    SELECT ARRAY(
      SELECT element::UUID
      FROM jsonb_array_elements_text(p_recipients) AS parsed(element)
    ) INTO v_recipients;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RETURN jsonb_build_object('success', FALSE, 'message', 'Invalid recipient id');
  END;

  v_recipient_count := COALESCE(array_length(v_recipients, 1), 0);
  IF v_recipient_count <> (SELECT COUNT(DISTINCT one) FROM unnest(v_recipients) AS one) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Duplicate recipients are not allowed');
  END IF;
  IF v_recipient_count < 1 OR v_recipient_count > 20 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Choose 1 to 20 recipients');
  END IF;

  -- The sender may appear exactly once, and only as a self-gift.
  v_has_self := me = ANY(v_recipients);
  IF v_has_self THEN
    SELECT * INTO v_cfg FROM public.self_gift_config();
    IF NOT v_cfg.enabled THEN
      RETURN jsonb_build_object('success', FALSE, 'message', 'Self-gifting is currently turned off');
    END IF;
    v_self_counts := v_cfg.count_toward_earnings;
  END IF;

  -- One indexed pass over the primary key replaces the old anti-join.
  SELECT COUNT(*) INTO v_valid_count
  FROM public.profiles AS profile_row
  WHERE profile_row.id = ANY(v_recipients)
    AND NOT COALESCE(profile_row.is_banned, FALSE);
  IF v_valid_count <> v_recipient_count THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'A recipient is unavailable');
  END IF;

  IF p_room_id IS NOT NULL THEN
    SELECT stream_row.broadcaster_id INTO v_room_host_id
    FROM public.live_streams AS stream_row
    WHERE stream_row.id = p_room_id AND stream_row.status = 'live'
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', FALSE, 'message', 'The target live is no longer running');
    END IF;
  END IF;

  -- Self-gifts are only legitimate inside the host's own running live.
  IF v_has_self AND (p_room_id IS NULL OR v_room_host_id IS DISTINCT FROM me) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'You can only gift yourself during your own live');
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

  -- Only the sender's own row counts against the Dhaka-day self-gift ceilings.
  -- This MUST stay nested inside "IF v_has_self": PL/pgSQL does not short-circuit
  -- AND, so testing v_cfg fields in the same condition as v_has_self dereferences
  -- an unassigned record on every ordinary gift and aborts it with
  -- 'record "v_cfg" is not assigned yet'.
  IF v_has_self THEN
   IF v_cfg.daily_diamond_limit > 0 OR v_cfg.daily_count_limit > 0 THEN
    v_self_cost := v_unit_cost * p_count;
    SELECT * INTO v_today FROM public.self_gift_today(me);
    IF v_cfg.daily_diamond_limit > 0
       AND v_today.diamonds_spent + v_self_cost > v_cfg.daily_diamond_limit THEN
      RETURN jsonb_build_object(
        'success', FALSE,
        'message', 'Daily self-gift limit reached. Try again tomorrow.',
        'limit_reached', TRUE,
        'daily_diamond_limit', v_cfg.daily_diamond_limit,
        'diamonds_spent_today', v_today.diamonds_spent
      );
    END IF;
    IF v_cfg.daily_count_limit > 0
       AND v_today.gift_count + p_count > v_cfg.daily_count_limit THEN
      RETURN jsonb_build_object(
        'success', FALSE,
        'message', 'Daily self-gift limit reached. Try again tomorrow.',
        'limit_reached', TRUE,
        'daily_count_limit', v_cfg.daily_count_limit,
        'gift_count_today', v_today.gift_count
      );
    END IF;
   END IF;
  END IF;

  SELECT profile_row.diamonds INTO v_sender_balance
  FROM public.profiles AS profile_row
  WHERE profile_row.id = me AND NOT COALESCE(profile_row.is_banned, FALSE) FOR UPDATE;
  IF NOT FOUND OR COALESCE(v_sender_balance, 0) < v_total_cost THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Insufficient diamonds');
  END IF;

  UPDATE public.profiles SET diamonds = diamonds - v_total_cost, updated_at = NOW()
  WHERE id = me RETURNING diamonds INTO v_balance_after;

  -- Beans land for every recipient. The sender's own share is additionally
  -- parked as non-withdrawable unless Super Admin lets self-gifts earn.
  UPDATE public.profiles AS profile_row
  SET beans = COALESCE(profile_row.beans, 0) + v_total_beans,
      non_withdrawable_beans = COALESCE(profile_row.non_withdrawable_beans, 0)
        + CASE WHEN profile_row.id = me AND NOT v_self_counts THEN v_total_beans ELSE 0 END,
      updated_at = NOW()
  WHERE profile_row.id = ANY(v_recipients);

  WITH inserted_gifts AS (
    INSERT INTO public.gifts_log(
      sender_id, receiver_id, gift_id, gift_name, diamond_cost, bean_value, count, room_id, is_self_gift
    ) SELECT me, recipient.user_id, p_gift_id, v_name,
      v_unit_cost * p_count, v_total_beans, p_count, p_room_id,
      recipient.user_id = me
    FROM unnest(v_recipients) WITH ORDINALITY AS recipient(user_id, delivery_order)
    ORDER BY recipient.delivery_order
    RETURNING id, receiver_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'receiver_id', receiver_id)), '[]'::JSONB)
  INTO v_gift_logs FROM inserted_gifts;

  INSERT INTO public.transactions(user_id, related_user_id, type, currency, amount, status, notes)
  VALUES(me, NULL, CASE WHEN v_has_self AND v_recipient_count = 1 THEN 'self_gift_sent' ELSE 'gift_sent' END,
    'diamond', -v_total_cost, 'completed',
    'Atomic batch gift to ' || v_recipient_count || ' recipients');
  INSERT INTO public.transactions(user_id, related_user_id, type, currency, amount, status, notes)
  SELECT recipient.user_id, me,
    CASE WHEN recipient.user_id = me THEN 'self_gift_received' ELSE 'gift_received' END,
    'bean', v_total_beans, 'completed',
    CASE WHEN recipient.user_id = me THEN 'Self gift: ' || v_name ELSE 'Atomic batch gift' END
  FROM unnest(v_recipients) WITH ORDINALITY AS recipient(user_id, delivery_order)
  ORDER BY recipient.delivery_order;

  IF p_room_id IS NOT NULL THEN
    -- A self-gift must not inflate the room's earnings unless Super Admin
    -- has said self-gifts count, matching the bean-locking rule above.
    SELECT CASE
             WHEN v_room_host_id = ANY(v_recipients)
              AND (v_room_host_id IS DISTINCT FROM me OR v_self_counts)
             THEN v_unit_cost * p_count ELSE 0
           END
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
    'self_gift', v_has_self,
    'gift_logs', v_gift_logs
  );
  INSERT INTO public.gift_batch_requests(sender_id, request_id, response)
  VALUES (me, p_request_id, v_response);
  RETURN v_response;
END;
$function$;

REVOKE ALL ON FUNCTION public.send_gift_batch(jsonb, text, bigint, uuid, text, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_gift_batch(jsonb, text, bigint, uuid, text, integer, uuid) TO authenticated, service_role;
