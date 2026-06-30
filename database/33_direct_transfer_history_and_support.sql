-- =====================================================================
-- 33_direct_transfer_history_and_support.sql
-- =====================================================================
-- Three tiny additions on top of Migration 32:
--
--   1. Direct-transfer RPCs (reseller + agency) now also insert a
--      `topup_requests` row with status='confirmed' so the transaction
--      appears in the reseller/agency History tab next to the
--      request-based confirmations.
--
--   2. `get_support_admin_id()` returns the primary super-admin's user
--      id so the mobile app can pin a "Support" conversation at the top
--      of the Messages tab for resellers + agency owners.
--
--   3. `bulk_diamond_bdt_per_1000` seeded in `system_settings` so the
--      stock-request modals can auto-calculate the BDT owed without
--      hard-coding the rate in the app. Super admin can change it any
--      time from the admin panel.
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1a. RESELLER DIRECT TRANSFER — now also writes a confirmed topup_request
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
  me              uuid := auth.uid();
  v_reseller      public.resellers%ROWTYPE;
  v_target_id     uuid;
  v_target_name   text;
  v_sender_name   text;
  v_bdt_rate      numeric;
  v_bdt_value     numeric;
  v_topup_id      uuid;
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

  -- Compute BDT value for the audit row using the current bulk rate.
  SELECT COALESCE((value #>> '{}')::numeric, 1000)
    INTO v_bdt_rate
    FROM public.system_settings
    WHERE key = 'bulk_diamond_bdt_per_1000';
  v_bdt_value := ROUND((p_amount::numeric / 1000.0) * COALESCE(v_bdt_rate, 1000), 2);

  -- Atomic: stock down, recipient up.
  UPDATE public.resellers SET diamond_stock = diamond_stock - p_amount WHERE id = v_reseller.id;
  UPDATE public.profiles  SET diamonds      = diamonds      + p_amount WHERE id = v_target_id;

  -- Self-confirmed topup_request — makes the transfer show up in the
  -- reseller's History tab without changing the dashboard query.
  INSERT INTO public.topup_requests (
    user_id, reseller_id, package_amount, bdt_value,
    status, notes, confirmed_by, confirmed_at
  )
  VALUES (
    v_target_id, v_reseller.id, p_amount, v_bdt_value,
    'confirmed', COALESCE(p_notes, 'Direct send (off-app payment)'), me, NOW()
  )
  RETURNING id INTO v_topup_id;

  -- Transactions trail.
  INSERT INTO public.transactions
    (user_id, related_user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
  VALUES
    (v_target_id, me, 'topup',           'diamond',  p_amount, 'topup_request', v_topup_id, 'completed', COALESCE(p_notes, 'Direct reseller transfer')),
    (me, v_target_id, 'reseller_payout', 'diamond', -p_amount, 'topup_request', v_topup_id, 'completed', COALESCE(p_notes, 'Direct sale to user'));

  -- Recipient gets a wallet-icon notification straight away.
  SELECT full_name INTO v_sender_name FROM public.profiles WHERE id = me;
  INSERT INTO public.notifications (user_id, type, title, body, payload)
  VALUES (
    v_target_id,
    'topup_confirmed',
    'Diamonds received',
    'You received ' || p_amount || ' diamonds from ' || COALESCE(v_sender_name, 'your reseller') || '.',
    jsonb_build_object('amount', p_amount, 'source', 'reseller', 'sender_id', me, 'topup_request_id', v_topup_id)
  );

  RETURN json_build_object(
    'success',         true,
    'recipient_name',  v_target_name,
    'amount',          p_amount,
    'bdt_value',       v_bdt_value,
    'remaining_stock', v_reseller.diamond_stock - p_amount,
    'topup_request_id', v_topup_id
  );
END;
$$;

-- ---------------------------------------------------------------------
-- 1b. AGENCY OWNER DIRECT TRANSFER — same upgrade
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
  me              uuid := auth.uid();
  v_agency        public.agencies%ROWTYPE;
  v_target_id     uuid;
  v_target_name   text;
  v_sender_name   text;
  v_bdt_rate      numeric;
  v_bdt_value     numeric;
  v_topup_id      uuid;
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

  SELECT COALESCE((value #>> '{}')::numeric, 1000)
    INTO v_bdt_rate
    FROM public.system_settings
    WHERE key = 'bulk_diamond_bdt_per_1000';
  v_bdt_value := ROUND((p_amount::numeric / 1000.0) * COALESCE(v_bdt_rate, 1000), 2);

  UPDATE public.agencies SET diamond_balance = diamond_balance - p_amount WHERE id = v_agency.id;
  UPDATE public.profiles SET diamonds        = diamonds        + p_amount WHERE id = v_target_id;

  INSERT INTO public.topup_requests (
    user_id, agency_id, package_amount, bdt_value,
    status, notes, confirmed_by, confirmed_at
  )
  VALUES (
    v_target_id, v_agency.id, p_amount, v_bdt_value,
    'confirmed', COALESCE(p_notes, 'Direct send (off-app payment)'), me, NOW()
  )
  RETURNING id INTO v_topup_id;

  INSERT INTO public.transactions
    (user_id, related_user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
  VALUES
    (v_target_id, me, 'topup',        'diamond',  p_amount, 'topup_request', v_topup_id, 'completed', COALESCE(p_notes, 'Direct agency transfer')),
    (me, v_target_id, 'agency_payout','diamond', -p_amount, 'topup_request', v_topup_id, 'completed', COALESCE(p_notes, 'Direct sale to user'));

  SELECT full_name INTO v_sender_name FROM public.profiles WHERE id = me;
  INSERT INTO public.notifications (user_id, type, title, body, payload)
  VALUES (
    v_target_id,
    'topup_confirmed',
    'Diamonds received',
    'You received ' || p_amount || ' diamonds from ' || COALESCE(v_sender_name, 'your agency') || '.',
    jsonb_build_object('amount', p_amount, 'source', 'agency', 'sender_id', me, 'topup_request_id', v_topup_id)
  );

  RETURN json_build_object(
    'success',          true,
    'recipient_name',   v_target_name,
    'amount',           p_amount,
    'bdt_value',        v_bdt_value,
    'remaining_stock',  v_agency.diamond_balance - p_amount,
    'topup_request_id', v_topup_id
  );
END;
$$;

-- ---------------------------------------------------------------------
-- 2. SUPPORT ADMIN RPC — pinned "Super Admin" chat for resellers/agencies
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_support_admin_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id
    FROM public.profiles
    WHERE role = 'super_admin'
      AND COALESCE(is_banned, false) = false
    ORDER BY created_at ASC
    LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_support_admin_id() TO authenticated;

-- ---------------------------------------------------------------------
-- 3. BULK PRICING SETTING — used by reseller_direct_transfer above and
--    the mobile UI to auto-calculate BDT in the stock-request modals.
-- ---------------------------------------------------------------------
-- Value is stored as a JSONB scalar (number). Read via `(value #>> '{}')::numeric`.
INSERT INTO public.system_settings (key, value)
VALUES ('bulk_diamond_bdt_per_1000', '1000'::JSONB)
ON CONFLICT (key) DO NOTHING;