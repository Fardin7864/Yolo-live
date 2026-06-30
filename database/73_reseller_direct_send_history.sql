-- =====================================================================
-- 73_reseller_direct_send_history.sql
-- =====================================================================
-- Two related fixes for the reseller / agency-owner History tab:
--
--   1. Adds a `source` column to topup_requests so the UI can tell apart
--      "direct send to a user" rows from "user-requested topup" rows.
--      Both end up in the same table after migration 33, but the
--      reseller's History view was lumping them together in one
--      undifferentiated list and the operator couldn't tell which
--      transactions were direct outbound sends vs incoming requests
--      they confirmed.
--
--   2. Re-applies the direct-transfer RPCs (reseller + agency) so that
--      they tag the inserted row with source='direct'. This migration
--      is also a safety net for any deployment where migration 33 was
--      not yet run — the CREATE OR REPLACE means we end up with the
--      latest version regardless of prior history.
--
-- Idempotent: re-runnable. Existing rows default to source='request'
-- (the historical majority). The UI then shows the right badge based on
-- the new column for everything created from this migration forward;
-- historical direct sends will display as 'request' (acceptable
-- regression — they're still visible).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. SCHEMA — `source` column on topup_requests
-- ---------------------------------------------------------------------
ALTER TABLE public.topup_requests
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'request';

DO $$ BEGIN
  ALTER TABLE public.topup_requests DROP CONSTRAINT IF EXISTS topup_requests_source_kind_check;
  ALTER TABLE public.topup_requests ADD CONSTRAINT topup_requests_source_kind_check
    CHECK (source IN ('request', 'direct'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_topup_source_reseller
  ON public.topup_requests(reseller_id, source, created_at DESC)
  WHERE reseller_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_topup_source_agency
  ON public.topup_requests(agency_id, source, created_at DESC)
  WHERE agency_id IS NOT NULL;


-- ---------------------------------------------------------------------
-- 2. RESELLER DIRECT TRANSFER — tagged source='direct'
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

  SELECT COALESCE((value #>> '{}')::numeric, 1000)
    INTO v_bdt_rate
    FROM public.system_settings
    WHERE key = 'bulk_diamond_bdt_per_1000';
  v_bdt_value := ROUND((p_amount::numeric / 1000.0) * COALESCE(v_bdt_rate, 1000), 2);

  UPDATE public.resellers SET diamond_stock = diamond_stock - p_amount WHERE id = v_reseller.id;
  UPDATE public.profiles  SET diamonds      = diamonds      + p_amount WHERE id = v_target_id;

  INSERT INTO public.topup_requests (
    user_id, reseller_id, package_amount, bdt_value,
    status, notes, confirmed_by, confirmed_at, source
  )
  VALUES (
    v_target_id, v_reseller.id, p_amount, v_bdt_value,
    'confirmed', COALESCE(p_notes, 'Direct send (off-app payment)'), me, NOW(), 'direct'
  )
  RETURNING id INTO v_topup_id;

  INSERT INTO public.transactions
    (user_id, related_user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
  VALUES
    (v_target_id, me, 'topup',           'diamond',  p_amount, 'topup_request', v_topup_id, 'completed', COALESCE(p_notes, 'Direct reseller transfer')),
    (me, v_target_id, 'reseller_payout', 'diamond', -p_amount, 'topup_request', v_topup_id, 'completed', COALESCE(p_notes, 'Direct sale to user'));

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
-- 3. AGENCY OWNER DIRECT TRANSFER — tagged source='direct'
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
    status, notes, confirmed_by, confirmed_at, source
  )
  VALUES (
    v_target_id, v_agency.id, p_amount, v_bdt_value,
    'confirmed', COALESCE(p_notes, 'Direct send (off-app payment)'), me, NOW(), 'direct'
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
-- 4. BACKFILL HEURISTIC — flag historical direct sends so old rows also
--    show the right badge in the UI. We can recognise an old direct
--    send by the marker the previous version of the RPC inserted:
--    notes='Direct send (off-app payment)' OR a matching reseller_payout
--    transaction (negative side of the direct-send pair).
-- ---------------------------------------------------------------------
UPDATE public.topup_requests t
   SET source = 'direct'
 WHERE source = 'request'
   AND (
     t.notes = 'Direct send (off-app payment)'
     OR EXISTS (
       SELECT 1 FROM public.transactions tx
        WHERE tx.related_entity_type = 'topup_request'
          AND tx.related_entity_id   = t.id
          AND tx.type IN ('reseller_payout', 'agency_payout')
     )
   );


-- =====================================================================
-- DONE — restart admin panel + mobile app
-- =====================================================================
