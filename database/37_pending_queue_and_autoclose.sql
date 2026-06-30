-- =====================================================================
-- 37_pending_queue_and_autoclose.sql
-- =====================================================================
-- Closes the "phantom pending topup_requests" gap.
--
-- THE GAP — a user could:
--   1. Open the wallet, tap a top-up amount, tap WhatsApp on a reseller
--      / agency  → a `topup_requests` row was created (status=pending).
--   2. The reseller / agency owner then used the DIRECT TRANSFER button
--      in their own dashboard (reseller_direct_transfer /
--      agency_direct_transfer), which deducts stock and credits the
--      user immediately.
--   3. The original pending request was never closed. Over time the
--      admin panel filled with orphan rows.
--
-- THIS MIGRATION:
--   1. Adds auto-cancel logic to both direct-transfer RPCs: when a
--      direct transfer succeeds, any matching pending / contacted
--      topup_requests from the same user to the same reseller / agency
--      created in the last 24 hours is auto-cancelled with a clear
--      note. Safety net for resellers who don't use the new queue UI.
--
--   2. Adds reseller_pending_topups() and agency_pending_topups() — RPCs
--      the dashboards call to render the new "Pending Requests" queue.
--      They also serve as the click-target for one-tap fulfilment.
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1a. RESELLER DIRECT TRANSFER — now auto-closes matching pendings
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
  v_closed_count      int;
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

  UPDATE public.resellers SET diamond_stock = diamond_stock - p_amount WHERE id = v_reseller.id;
  UPDATE public.profiles  SET diamonds      = diamonds      + p_amount WHERE id = v_target_id;

  INSERT INTO public.transactions
    (user_id, related_user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
  VALUES
    (v_target_id, me, 'topup',           'diamond',  p_amount, 'reseller', v_reseller.id, 'completed', COALESCE(p_notes, 'Direct reseller transfer')),
    (me, v_target_id, 'reseller_payout', 'diamond', -p_amount, 'reseller', v_reseller.id, 'completed', COALESCE(p_notes, 'Direct sale to user'));

  -- AUTO-CLOSE matching pending requests so admin panel stays clean.
  -- "Matching" = same user, same reseller, still open, recent.
  WITH closed AS (
    UPDATE public.topup_requests
       SET status = 'cancelled',
           notes  = COALESCE(notes, '') || ' [auto-closed: direct transfer]'
     WHERE user_id     = v_target_id
       AND reseller_id = v_reseller.id
       AND status      IN ('pending', 'contacted')
       AND created_at  > NOW() - INTERVAL '24 hours'
     RETURNING 1
  )
  SELECT count(*) INTO v_closed_count FROM closed;

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
    'remaining_stock', v_reseller.diamond_stock - p_amount,
    'auto_closed',     v_closed_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reseller_direct_transfer(BIGINT, BIGINT, TEXT) TO authenticated;

-- ---------------------------------------------------------------------
-- 1b. AGENCY DIRECT TRANSFER — same auto-close behaviour
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
  me             uuid := auth.uid();
  v_agency       public.agencies%ROWTYPE;
  v_target_id    uuid;
  v_target_name  text;
  v_sender_name  text;
  v_closed_count int;
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

  WITH closed AS (
    UPDATE public.topup_requests
       SET status = 'cancelled',
           notes  = COALESCE(notes, '') || ' [auto-closed: direct transfer]'
     WHERE user_id    = v_target_id
       AND agency_id  = v_agency.id
       AND status     IN ('pending', 'contacted')
       AND created_at > NOW() - INTERVAL '24 hours'
     RETURNING 1
  )
  SELECT count(*) INTO v_closed_count FROM closed;

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
    'remaining_stock', v_agency.diamond_balance - p_amount,
    'auto_closed',     v_closed_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.agency_direct_transfer(BIGINT, BIGINT, TEXT) TO authenticated;

-- ---------------------------------------------------------------------
-- 2a. Pending queue for a reseller
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reseller_pending_topups()
RETURNS TABLE (
  id              uuid,
  user_id         uuid,
  user_name       text,
  user_display_id bigint,
  user_avatar     text,
  amount          bigint,
  bdt_value       numeric,
  status          text,
  created_at      timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
  v_reseller_id uuid;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT id INTO v_reseller_id FROM public.resellers WHERE user_id = me;
  IF v_reseller_id IS NULL THEN
    RAISE EXCEPTION 'Not a reseller';
  END IF;

  RETURN QUERY
  SELECT
    tr.id,
    tr.user_id,
    p.full_name,
    p.display_id,
    p.avatar_url,
    tr.package_amount,
    tr.bdt_value,
    tr.status,
    tr.created_at
  FROM public.topup_requests tr
  JOIN public.profiles p ON p.id = tr.user_id
  WHERE tr.reseller_id = v_reseller_id
    AND tr.status IN ('pending', 'contacted')
  ORDER BY tr.created_at DESC
  LIMIT 100;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reseller_pending_topups() TO authenticated;

-- ---------------------------------------------------------------------
-- 2b. Pending queue for an agency owner
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agency_pending_topups()
RETURNS TABLE (
  id              uuid,
  user_id         uuid,
  user_name       text,
  user_display_id bigint,
  user_avatar     text,
  amount          bigint,
  bdt_value       numeric,
  status          text,
  created_at      timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
  v_agency_id uuid;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT id INTO v_agency_id FROM public.agencies WHERE owner_id = me;
  IF v_agency_id IS NULL THEN
    RAISE EXCEPTION 'Not an agency owner';
  END IF;

  RETURN QUERY
  SELECT
    tr.id,
    tr.user_id,
    p.full_name,
    p.display_id,
    p.avatar_url,
    tr.package_amount,
    tr.bdt_value,
    tr.status,
    tr.created_at
  FROM public.topup_requests tr
  JOIN public.profiles p ON p.id = tr.user_id
  WHERE tr.agency_id = v_agency_id
    AND tr.status IN ('pending', 'contacted')
  ORDER BY tr.created_at DESC
  LIMIT 100;
END;
$$;

GRANT EXECUTE ON FUNCTION public.agency_pending_topups() TO authenticated;

-- ---------------------------------------------------------------------
-- 3. Allow resellers + agency owners to call cancel_topup_request
--    on their own pending requests (decline button). The function
--    already enforces ownership via the status check; we just need to
--    relax the admin-only guard for self-decline.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_topup_request(
  p_request_id uuid,
  p_admin_id   uuid DEFAULT NULL,
  p_reason     text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me        uuid := auth.uid();
  v_status  text;
  v_reseller_id uuid;
  v_agency_id   uuid;
  v_allowed     boolean := false;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  SELECT status, reseller_id, agency_id
    INTO v_status, v_reseller_id, v_agency_id
    FROM public.topup_requests
    WHERE id = p_request_id
    FOR UPDATE;

  IF v_status IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Request not found');
  END IF;
  IF v_status = 'confirmed' THEN
    RETURN json_build_object('success', false, 'message', 'Already confirmed — cannot cancel');
  END IF;
  IF v_status = 'cancelled' THEN
    RETURN json_build_object('success', true, 'message', 'Already cancelled');
  END IF;

  -- Allow admin/super_admin, OR the reseller that owns the request,
  -- OR the agency owner that owns the request.
  IF public.is_admin(me) THEN
    v_allowed := true;
  ELSIF v_reseller_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.resellers WHERE id = v_reseller_id AND user_id = me
  ) THEN
    v_allowed := true;
  ELSIF v_agency_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.agencies WHERE id = v_agency_id AND owner_id = me
  ) THEN
    v_allowed := true;
  END IF;

  IF NOT v_allowed THEN
    RETURN json_build_object('success', false, 'message', 'Not authorized');
  END IF;

  UPDATE public.topup_requests
     SET status = 'cancelled',
         notes  = COALESCE(p_reason, notes)
   WHERE id = p_request_id;

  RETURN json_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_topup_request(uuid, uuid, text) TO authenticated;