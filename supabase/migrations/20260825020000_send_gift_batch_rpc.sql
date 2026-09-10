-- Atomic multi-recipient gifting used by the live-room gift drawer.
-- This focused migration intentionally excludes the unrelated pending
-- live/agency hardening migration that originally contained this RPC.

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
BEGIN
  IF me IS NULL THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Not authenticated');
  END IF;
  IF p_count IS NULL OR p_count < 1 OR p_count > 1000 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Invalid gift quantity');
  END IF;
  IF jsonb_typeof(p_recipients) <> 'array' THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Recipients must be a JSON array');
  END IF;

  CREATE TEMP TABLE batch_recipients(
    user_id UUID PRIMARY KEY,
    delivery_order INT NOT NULL
  ) ON COMMIT DROP;

  BEGIN
    INSERT INTO batch_recipients(user_id, delivery_order)
    SELECT value::UUID, ordinality::INT
    FROM jsonb_array_elements_text(p_recipients)
      WITH ORDINALITY AS recipient(value, ordinality);
  EXCEPTION
    WHEN unique_violation THEN
      RETURN jsonb_build_object('success', FALSE, 'message', 'Duplicate recipients are not allowed');
    WHEN invalid_text_representation THEN
      RETURN jsonb_build_object('success', FALSE, 'message', 'Invalid recipient id');
  END;

  SELECT COUNT(*) INTO v_recipient_count FROM batch_recipients;
  IF v_recipient_count < 1 OR v_recipient_count > 20 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Choose 1 to 20 recipients');
  END IF;
  IF EXISTS (SELECT 1 FROM batch_recipients WHERE user_id = me) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'You cannot gift yourself');
  END IF;
  IF EXISTS (
    SELECT 1
    FROM batch_recipients AS recipient
    LEFT JOIN public.profiles AS profile_row ON profile_row.id = recipient.user_id
    WHERE profile_row.id IS NULL OR COALESCE(profile_row.is_banned, FALSE)
  ) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'A recipient is unavailable');
  END IF;

  SELECT
    gift_row.diamond_cost,
    COALESCE(gift_row.bean_value, gift_row.diamond_cost / 2),
    gift_row.name,
    COALESCE(gift_row.is_active, TRUE),
    gift_row.required_vip_type
  INTO v_unit_cost, v_bean_value, v_name, v_active, v_required_vip
  FROM public.gifts AS gift_row
  WHERE gift_row.id = p_gift_id;

  -- Keep old catalog entries working during rollout, but never trust a
  -- client price when the authoritative catalog row exists.
  IF NOT FOUND THEN
    v_unit_cost := p_diamond_cost;
    v_bean_value := p_diamond_cost / 2;
    v_name := COALESCE(NULLIF(BTRIM(p_gift_name), ''), p_gift_id);
  ELSIF NOT v_active THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'This gift is unavailable');
  END IF;
  IF v_unit_cost IS NULL OR v_unit_cost <= 0 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Invalid gift price');
  END IF;

  IF v_required_vip IS NOT NULL THEN
    SELECT profile_row.vip_type, profile_row.vip_expires_at
    INTO v_sender_vip, v_vip_expires
    FROM public.profiles AS profile_row
    WHERE profile_row.id = me;
    IF v_vip_expires IS NULL OR v_vip_expires <= NOW()
      OR (v_required_vip = 'VIP' AND v_sender_vip NOT IN ('VIP', 'SVIP', 'VVIP'))
      OR (v_required_vip = 'SVIP' AND v_sender_vip NOT IN ('SVIP', 'VVIP'))
      OR (v_required_vip = 'VVIP' AND v_sender_vip <> 'VVIP')
    THEN
      RETURN jsonb_build_object('success', FALSE, 'message', v_required_vip || ' membership is required');
    END IF;
  END IF;

  v_total_cost := v_unit_cost * p_count * v_recipient_count;
  v_total_beans := v_bean_value * p_count;

  SELECT profile_row.diamonds INTO v_sender_balance
  FROM public.profiles AS profile_row
  WHERE profile_row.id = me AND NOT COALESCE(profile_row.is_banned, FALSE)
  FOR UPDATE;
  IF NOT FOUND OR COALESCE(v_sender_balance, 0) < v_total_cost THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Insufficient diamonds');
  END IF;

  UPDATE public.profiles
  SET diamonds = diamonds - v_total_cost, updated_at = NOW()
  WHERE id = me
  RETURNING diamonds INTO v_balance_after;

  UPDATE public.profiles AS profile_row
  SET beans = COALESCE(profile_row.beans, 0) + v_total_beans, updated_at = NOW()
  FROM batch_recipients AS recipient
  WHERE profile_row.id = recipient.user_id;

  INSERT INTO public.gifts_log(
    sender_id, receiver_id, gift_id, gift_name,
    diamond_cost, bean_value, count, room_id
  )
  SELECT
    me, recipient.user_id, p_gift_id, v_name,
    v_unit_cost * p_count, v_total_beans, p_count, p_room_id
  FROM batch_recipients AS recipient
  ORDER BY recipient.delivery_order;

  INSERT INTO public.transactions(
    user_id, related_user_id, type, currency, amount, status, notes
  ) VALUES (
    me, NULL, 'gift_sent', 'diamond', -v_total_cost, 'completed',
    'Atomic batch gift to ' || v_recipient_count || ' recipients'
  );

  INSERT INTO public.transactions(
    user_id, related_user_id, type, currency, amount, status, notes
  )
  SELECT
    recipient.user_id, me, 'gift_received', 'bean', v_total_beans,
    'completed', 'Atomic batch gift'
  FROM batch_recipients AS recipient
  ORDER BY recipient.delivery_order;

  IF p_room_id IS NOT NULL THEN
    UPDATE public.live_streams AS stream_row
    SET
      total_gifts = COALESCE(stream_row.total_gifts, 0) + p_count,
      total_earnings = COALESCE(stream_row.total_earnings, 0) + v_total_beans
    WHERE stream_row.id = p_room_id
      AND EXISTS (
        SELECT 1 FROM batch_recipients AS recipient
        WHERE recipient.user_id = stream_row.broadcaster_id
      );
  END IF;

  RETURN jsonb_build_object(
    'success', TRUE,
    'delivery_mode', 'atomic_batch',
    'recipient_count', v_recipient_count,
    'diamonds_spent', v_total_cost,
    'diamond_balance', v_balance_after,
    'beans_per_recipient', v_total_beans
  );
END;
$$;

REVOKE ALL ON FUNCTION public.send_gift_batch(JSONB, TEXT, BIGINT, UUID, TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_gift_batch(JSONB, TEXT, BIGINT, UUID, TEXT, INT) TO authenticated;
NOTIFY pgrst, 'reload schema';
