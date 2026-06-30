-- =====================================================================
-- 49_send_gift_no_self.sql
-- =====================================================================
-- Hardens send_gift against self-gifting. The original RPC validated
-- sender, recipient and balance independently but never compared the
-- two ids, so:
--
--   * A host opening their own gift picker (recipient defaults to the
--     broadcaster, i.e. themselves) would silently credit half the cost
--     back as beans — effectively a free diamond → bean conversion.
--   * A viewer seated as a co-host could tap their own tile and gift
--     it without leaving the room.
--
-- This migration adds the missing check. The bean half-credit and the
-- diamond debit cancel for the same person, so a self-gift is the
-- definition of a wash trade and we reject it server-side rather than
-- relying on UI to police it.
--
-- Idempotent: re-runnable. Same function signature; only the body
-- changes (new check + existing behaviour).
-- =====================================================================

CREATE OR REPLACE FUNCTION public.send_gift(
  p_sender_id     UUID,
  p_recipient_id  UUID,
  p_gift_id       TEXT,
  p_diamond_cost  BIGINT,
  p_room_id       UUID DEFAULT NULL,
  p_gift_name     TEXT DEFAULT NULL,
  p_count         INT  DEFAULT 1
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sender_balance BIGINT;
  v_bean_value     BIGINT;
  v_total_cost     BIGINT;
  v_total_beans    BIGINT;
  v_catalog        public.gifts%ROWTYPE;
  v_unit_cost      BIGINT;
  v_sender_vip     TEXT;
  v_vip_expires    TIMESTAMPTZ;
BEGIN
  IF p_sender_id IS NULL OR p_recipient_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Invalid sender or recipient');
  END IF;
  -- NEW: hard refusal of self-gifting. Anywhere the UI lets the host or
  -- a seated guest end up as their own recipient, the RPC stops it.
  IF p_sender_id = p_recipient_id THEN
    RETURN json_build_object('success', false, 'message', 'You cannot send a gift to yourself');
  END IF;
  IF p_count IS NULL OR p_count <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'Count must be positive');
  END IF;

  -- Catalog lookup. Authoritative when present; advisory fallback otherwise.
  SELECT * INTO v_catalog FROM public.gifts WHERE id = p_gift_id;

  IF v_catalog.id IS NOT NULL THEN
    IF NOT v_catalog.is_active THEN
      RETURN json_build_object('success', false, 'message', 'Gift is disabled');
    END IF;

    -- VIP gating
    IF v_catalog.required_vip_type IS NOT NULL THEN
      SELECT vip_type, vip_expires_at INTO v_sender_vip, v_vip_expires
        FROM public.profiles WHERE id = p_sender_id;
      IF v_sender_vip IS NULL
         OR v_vip_expires IS NULL
         OR v_vip_expires < NOW()
         OR (
           v_catalog.required_vip_type = 'VVIP' AND v_sender_vip NOT IN ('VVIP')
         ) OR (
           v_catalog.required_vip_type = 'SVIP' AND v_sender_vip NOT IN ('SVIP','VVIP')
         ) OR (
           v_catalog.required_vip_type = 'VIP'  AND v_sender_vip NOT IN ('VIP','SVIP','VVIP')
         )
      THEN
        RETURN json_build_object('success', false, 'message',
          v_catalog.required_vip_type || ' tier required to send this gift');
      END IF;
    END IF;

    v_unit_cost  := v_catalog.diamond_cost;
    v_bean_value := COALESCE(v_catalog.bean_value, v_catalog.diamond_cost / 2);
  ELSE
    v_unit_cost  := p_diamond_cost;
    v_bean_value := p_diamond_cost / 2;
  END IF;

  v_total_cost  := v_unit_cost  * p_count;
  v_total_beans := v_bean_value * p_count;

  SELECT diamonds INTO v_sender_balance
    FROM public.profiles WHERE id = p_sender_id FOR UPDATE;
  IF v_sender_balance IS NULL OR v_sender_balance < v_total_cost THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient diamonds');
  END IF;

  UPDATE public.profiles SET diamonds = diamonds - v_total_cost WHERE id = p_sender_id;
  UPDATE public.profiles SET beans    = beans    + v_total_beans WHERE id = p_recipient_id;

  INSERT INTO public.gifts_log
    (sender_id, receiver_id, gift_id, gift_name, diamond_cost, bean_value, count, room_id)
  VALUES
    (p_sender_id, p_recipient_id, p_gift_id,
     COALESCE(v_catalog.name, p_gift_name, p_gift_id),
     v_total_cost, v_total_beans, p_count, p_room_id);

  INSERT INTO public.transactions
    (user_id, related_user_id, type, currency, amount, related_entity_type, related_entity_id, status)
  VALUES
    (p_sender_id, p_recipient_id, 'gift_sent',     'diamond', -v_total_cost,
     'gift', NULL, 'completed'),
    (p_recipient_id, p_sender_id, 'gift_received', 'bean',     v_total_beans,
     'gift', NULL, 'completed');

  IF p_room_id IS NOT NULL THEN
    UPDATE public.live_streams
       SET total_gifts    = COALESCE(total_gifts, 0)    + p_count,
           total_earnings = COALESCE(total_earnings, 0) + v_total_beans
     WHERE id = p_room_id;
  END IF;

  RETURN json_build_object(
    'success',         true,
    'diamonds_spent',  v_total_cost,
    'beans_earned',    v_total_beans,
    'count',           p_count
  );
END $$;

GRANT EXECUTE ON FUNCTION public.send_gift(UUID, UUID, TEXT, BIGINT, UUID, TEXT, INT) TO authenticated;