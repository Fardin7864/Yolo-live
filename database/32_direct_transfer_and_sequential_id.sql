-- =====================================================================
-- 32_direct_transfer_and_sequential_id.sql
-- =====================================================================
-- Two unrelated production-cleanups bundled here because both are tiny:
--
--   1. Replace the 9-digit random display_id with a sequential counter
--      starting at 202701. Existing legacy random IDs are untouched —
--      the new range (6 digits) does not collide with the old (9 digits),
--      and a safety loop in the trigger handles any edge case.
--
--   2. Two new SECURITY DEFINER RPCs that let an active reseller or an
--      agency owner *push* diamonds from their stock to any user by
--      `display_id`. Same atomic deduct + credit + transaction log as
--      the existing topup-request flow, but without the user having to
--      open a request first — useful for over-the-counter / WhatsApp sales.
--      Each transfer also drops a notification on the recipient so they
--      see the diamonds arrive instantly.
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. SEQUENTIAL DISPLAY_ID — starting at 202701
-- ---------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.display_id_seq
  START WITH 202701
  INCREMENT BY 1
  MINVALUE 202701
  NO CYCLE;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_display_id BIGINT;
BEGIN
  -- Sequential 6+-digit IDs from public.display_id_seq, skipping any
  -- value that legacy random IDs may already occupy.
  LOOP
    new_display_id := nextval('public.display_id_seq');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.profiles WHERE display_id = new_display_id);
  END LOOP;

  INSERT INTO public.profiles (id, display_id, full_name, phone_number, avatar_url)
  VALUES (
    NEW.id,
    new_display_id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', 'New User'),
    NEW.raw_user_meta_data->>'phone',
    'https://api.dicebear.com/7.x/avataaars/svg?seed=' || NEW.id::TEXT
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- 2a. RESELLER DIRECT TRANSFER
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reseller_direct_transfer(
  p_user_display_id BIGINT,
  p_amount          BIGINT,
  p_notes           TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me                  uuid := auth.uid();
  v_reseller          public.resellers%ROWTYPE;
  v_target_id         uuid;
  v_target_name       text;
  v_sender_name       text;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'Amount must be positive');
  END IF;
  IF p_user_display_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Recipient ID required');
  END IF;

  SELECT * INTO v_reseller
    FROM public.resellers
    WHERE user_id = me AND status <> 'inactive'
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'You are not an active reseller');
  END IF;

  IF v_reseller.diamond_stock < p_amount THEN
    RETURN json_build_object('success', false, 'message',
      'Insufficient stock: have ' || v_reseller.diamond_stock || ', need ' || p_amount);
  END IF;

  SELECT id, full_name INTO v_target_id, v_target_name
    FROM public.profiles
    WHERE display_id = p_user_display_id;
  IF v_target_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'No user found with that ID');
  END IF;
  IF v_target_id = me THEN
    RETURN json_build_object('success', false, 'message', 'Cannot transfer to yourself');
  END IF;

  -- Atomic: deduct reseller stock, credit recipient profile.
  UPDATE public.resellers SET diamond_stock = diamond_stock - p_amount WHERE id = v_reseller.id;
  UPDATE public.profiles  SET diamonds      = diamonds      + p_amount WHERE id = v_target_id;

  -- Audit trail.
  INSERT INTO public.transactions
    (user_id, related_user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
  VALUES
    (v_target_id, me, 'topup',           'diamond',  p_amount, 'reseller', v_reseller.id, 'completed', COALESCE(p_notes, 'Direct reseller transfer')),
    (me, v_target_id, 'reseller_payout', 'diamond', -p_amount, 'reseller', v_reseller.id, 'completed', COALESCE(p_notes, 'Direct sale to user'));

  -- Notify the recipient (topup_confirmed = wallet icon in the notif screen).
  SELECT full_name INTO v_sender_name FROM public.profiles WHERE id = me;
  INSERT INTO public.notifications (user_id, type, title, body, payload)
  VALUES (
    v_target_id,
    'topup_confirmed',
    'Diamonds received',
    'You received ' || p_amount || ' diamonds from ' || COALESCE(v_sender_name, 'your reseller') || '.',
    jsonb_build_object('amount', p_amount, 'source', 'reseller', 'sender_id', me)
  );

  RETURN json_build_object(
    'success',         true,
    'recipient_name',  v_target_name,
    'amount',          p_amount,
    'remaining_stock', v_reseller.diamond_stock - p_amount
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reseller_direct_transfer(BIGINT, BIGINT, TEXT) TO authenticated;

-- ---------------------------------------------------------------------
-- 2b. AGENCY OWNER DIRECT TRANSFER
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agency_direct_transfer(
  p_user_display_id BIGINT,
  p_amount          BIGINT,
  p_notes           TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me            uuid := auth.uid();
  v_agency      public.agencies%ROWTYPE;
  v_target_id   uuid;
  v_target_name text;
  v_sender_name text;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'Amount must be positive');
  END IF;
  IF p_user_display_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Recipient ID required');
  END IF;

  SELECT * INTO v_agency
    FROM public.agencies
    WHERE owner_id = me AND status <> 'suspended'
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'You do not own an active agency');
  END IF;

  IF v_agency.diamond_balance < p_amount THEN
    RETURN json_build_object('success', false, 'message',
      'Insufficient stock: have ' || v_agency.diamond_balance || ', need ' || p_amount);
  END IF;

  SELECT id, full_name INTO v_target_id, v_target_name
    FROM public.profiles
    WHERE display_id = p_user_display_id;
  IF v_target_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'No user found with that ID');
  END IF;
  IF v_target_id = me THEN
    RETURN json_build_object('success', false, 'message', 'Cannot transfer to yourself');
  END IF;

  UPDATE public.agencies SET diamond_balance = diamond_balance - p_amount WHERE id = v_agency.id;
  UPDATE public.profiles SET diamonds        = diamonds        + p_amount WHERE id = v_target_id;

  INSERT INTO public.transactions
    (user_id, related_user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
  VALUES
    (v_target_id, me, 'topup',        'diamond',  p_amount, 'agency', v_agency.id, 'completed', COALESCE(p_notes, 'Direct agency transfer')),
    (me, v_target_id, 'agency_payout','diamond', -p_amount, 'agency', v_agency.id, 'completed', COALESCE(p_notes, 'Direct sale to user'));

  SELECT full_name INTO v_sender_name FROM public.profiles WHERE id = me;
  INSERT INTO public.notifications (user_id, type, title, body, payload)
  VALUES (
    v_target_id,
    'topup_confirmed',
    'Diamonds received',
    'You received ' || p_amount || ' diamonds from ' || COALESCE(v_sender_name, 'your agency') || '.',
    jsonb_build_object('amount', p_amount, 'source', 'agency', 'sender_id', me)
  );

  RETURN json_build_object(
    'success',         true,
    'recipient_name',  v_target_name,
    'amount',          p_amount,
    'remaining_stock', v_agency.diamond_balance - p_amount
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.agency_direct_transfer(BIGINT, BIGINT, TEXT) TO authenticated;