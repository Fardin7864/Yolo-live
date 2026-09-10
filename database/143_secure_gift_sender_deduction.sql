-- =====================================================================
-- 143_secure_gift_sender_deduction.sql
-- =====================================================================
-- Gift spending must be authoritative on the database. The sender is
-- authenticated, their profile row is locked, diamonds are debited first,
-- then the receiver's beans and ledgers are written in the same transaction.
-- This prevents a client, old APK, reconnect, or simultaneous taps from
-- creating a gift without paying for it.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.send_gift(
  p_sender_id     UUID,
  p_recipient_id  UUID,
  p_gift_id       TEXT,
  p_diamond_cost  BIGINT,
  p_room_id       UUID DEFAULT NULL,
  p_gift_name     TEXT DEFAULT NULL,
  p_count         INT DEFAULT 1
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sender_balance BIGINT;
  v_balance_after  BIGINT;
  v_unit_cost      BIGINT;
  v_bean_value     BIGINT;
  v_total_cost     BIGINT;
  v_total_beans    BIGINT;
  v_gift_name      TEXT;
  v_is_active      BOOLEAN;
  v_required_vip   TEXT;
  v_sender_vip     TEXT;
  v_vip_expires    TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS DISTINCT FROM p_sender_id THEN
    RETURN json_build_object('success', FALSE, 'message', 'You may only spend your own diamonds');
  END IF;
  IF p_sender_id IS NULL OR p_recipient_id IS NULL OR p_sender_id = p_recipient_id THEN
    RETURN json_build_object('success', FALSE, 'message', 'Choose another valid gift recipient');
  END IF;
  IF p_count IS NULL OR p_count < 1 OR p_count > 1000 THEN
    RETURN json_build_object('success', FALSE, 'message', 'Invalid gift quantity');
  END IF;

  SELECT diamond_cost, COALESCE(bean_value, diamond_cost / 2), name, is_active, required_vip_type
    INTO v_unit_cost, v_bean_value, v_gift_name, v_is_active, v_required_vip
  FROM public.gifts
  WHERE id = p_gift_id;

  -- Old catalog rows are supported during rollout, but their unit price is
  -- still validated. The mobile app sends a unit price, never a total.
  IF NOT FOUND THEN
    v_unit_cost := p_diamond_cost;
    v_bean_value := p_diamond_cost / 2;
    v_gift_name := COALESCE(NULLIF(BTRIM(p_gift_name), ''), p_gift_id);
  ELSIF NOT COALESCE(v_is_active, TRUE) THEN
    RETURN json_build_object('success', FALSE, 'message', 'This gift is unavailable');
  END IF;

  IF v_unit_cost IS NULL OR v_unit_cost <= 0 THEN
    RETURN json_build_object('success', FALSE, 'message', 'Invalid gift price');
  END IF;

  IF v_required_vip IS NOT NULL THEN
    SELECT vip_type, vip_expires_at INTO v_sender_vip, v_vip_expires
    FROM public.profiles WHERE id = p_sender_id;
    IF v_vip_expires IS NULL OR v_vip_expires <= NOW()
       OR (v_required_vip = 'VIP'  AND v_sender_vip NOT IN ('VIP', 'SVIP', 'VVIP'))
       OR (v_required_vip = 'SVIP' AND v_sender_vip NOT IN ('SVIP', 'VVIP'))
       OR (v_required_vip = 'VVIP' AND v_sender_vip <> 'VVIP') THEN
      RETURN json_build_object('success', FALSE, 'message', v_required_vip || ' membership is required');
    END IF;
  END IF;

  v_total_cost := v_unit_cost * p_count;
  v_total_beans := v_bean_value * p_count;

  -- Lock the exact sender row. Concurrent gifts serialize here, so the same
  -- diamonds can never fund two transactions.
  SELECT diamonds INTO v_sender_balance
  FROM public.profiles
  WHERE id = p_sender_id AND NOT COALESCE(is_banned, FALSE)
  FOR UPDATE;
  IF NOT FOUND OR COALESCE(v_sender_balance, 0) < v_total_cost THEN
    RETURN json_build_object('success', FALSE, 'message', 'Insufficient diamonds');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_recipient_id AND NOT COALESCE(is_banned, FALSE)) THEN
    RETURN json_build_object('success', FALSE, 'message', 'Gift recipient is unavailable');
  END IF;

  UPDATE public.profiles
  SET diamonds = diamonds - v_total_cost,
      updated_at = NOW()
  WHERE id = p_sender_id
  RETURNING diamonds INTO v_balance_after;

  UPDATE public.profiles
  SET beans = COALESCE(beans, 0) + v_total_beans,
      updated_at = NOW()
  WHERE id = p_recipient_id;

  INSERT INTO public.gifts_log
    (sender_id, receiver_id, gift_id, gift_name, diamond_cost, bean_value, count, room_id)
  VALUES
    (p_sender_id, p_recipient_id, p_gift_id, v_gift_name, v_total_cost, v_total_beans, p_count, p_room_id);

  INSERT INTO public.transactions
    (user_id, related_user_id, type, currency, amount, related_entity_type, related_entity_id, status)
  VALUES
    (p_sender_id, p_recipient_id, 'gift_sent', 'diamond', -v_total_cost, 'gift', NULL, 'completed'),
    (p_recipient_id, p_sender_id, 'gift_received', 'bean', v_total_beans, 'gift', NULL, 'completed');

  IF p_room_id IS NOT NULL THEN
    UPDATE public.live_streams
    SET total_gifts = COALESCE(total_gifts, 0) + p_count,
        total_earnings = COALESCE(total_earnings, 0) + v_total_beans
    WHERE id = p_room_id;
  END IF;

  RETURN json_build_object(
    'success', TRUE,
    'diamonds_spent', v_total_cost,
    'diamond_balance', v_balance_after,
    'beans_earned', v_total_beans,
    'count', p_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.send_gift(UUID, UUID, TEXT, BIGINT, UUID, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_gift(UUID, UUID, TEXT, BIGINT, UUID, TEXT, INT) TO authenticated;
