-- =====================================================================
-- PHASE 4: Reseller becomes a real in-app actor
--   * Resellers get diamond_stock (like agencies)
--   * Resellers can request bulk stock from super admin
--   * Resellers see incoming topup_requests in mobile app
--   * Reseller-confirm deducts from THEIR stock (no more free diamonds)
--   * Admin panel can block / unblock / set-busy a reseller
-- Idempotent. Run in Supabase SQL Editor.
-- =====================================================================


-- =====================================================================
-- SECTION 1: SCHEMA CHANGES
-- =====================================================================

-- 1.1 Resellers get stock + lifetime sales counter
ALTER TABLE public.resellers
  ADD COLUMN IF NOT EXISTS diamond_stock BIGINT DEFAULT 0 CHECK (diamond_stock >= 0);

ALTER TABLE public.resellers
  ADD COLUMN IF NOT EXISTS total_sold BIGINT DEFAULT 0;

-- 1.2 Reseller stock requests
CREATE TABLE IF NOT EXISTS public.reseller_stock_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id     UUID NOT NULL REFERENCES public.resellers(id) ON DELETE CASCADE,
  requested_by    UUID NOT NULL REFERENCES public.profiles(id),
  diamond_amount  BIGINT NOT NULL CHECK (diamond_amount > 0),
  bdt_value       NUMERIC(12,2),
  notes           TEXT,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'contacted', 'fulfilled', 'cancelled')),
  fulfilled_by    UUID REFERENCES public.profiles(id),
  fulfilled_at    TIMESTAMPTZ,
  review_notes    TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rstockreq_status   ON public.reseller_stock_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rstockreq_reseller ON public.reseller_stock_requests(reseller_id);


-- =====================================================================
-- SECTION 2: RPC FUNCTIONS
-- =====================================================================

-- 2.1 Reseller asks super admin for bulk diamonds
CREATE OR REPLACE FUNCTION public.request_reseller_stock(
  p_user_id        UUID,
  p_diamond_amount BIGINT,
  p_bdt_value      NUMERIC DEFAULT NULL,
  p_notes          TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reseller_id UUID;
  v_req_id      UUID;
BEGIN
  SELECT id INTO v_reseller_id
  FROM public.resellers
  WHERE user_id = p_user_id AND status <> 'inactive';

  IF v_reseller_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'You are not an active reseller.');
  END IF;

  INSERT INTO public.reseller_stock_requests
    (reseller_id, requested_by, diamond_amount, bdt_value, notes)
  VALUES (v_reseller_id, p_user_id, p_diamond_amount, p_bdt_value, p_notes)
  RETURNING id INTO v_req_id;

  RETURN json_build_object('success', true, 'request_id', v_req_id);
END $$;

-- 2.2 Super admin fulfills bulk stock to reseller
CREATE OR REPLACE FUNCTION public.fulfill_reseller_stock_request(
  p_request_id UUID,
  p_admin_id   UUID,
  p_notes      TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_req public.reseller_stock_requests%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND role IN ('admin','super_admin')) THEN
    RETURN json_build_object('success', false, 'message', 'Not an admin');
  END IF;

  SELECT * INTO v_req FROM public.reseller_stock_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR v_req.status = 'fulfilled' THEN
    RETURN json_build_object('success', false, 'message', 'Invalid or already-fulfilled request');
  END IF;

  UPDATE public.resellers
     SET diamond_stock = diamond_stock + v_req.diamond_amount
   WHERE id = v_req.reseller_id;

  UPDATE public.reseller_stock_requests
     SET status = 'fulfilled', fulfilled_by = p_admin_id, fulfilled_at = NOW(), review_notes = p_notes
   WHERE id = p_request_id;

  INSERT INTO public.transactions
    (user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
  VALUES (v_req.requested_by, 'reseller_stock', 'diamond', v_req.diamond_amount,
          'reseller_stock_request', p_request_id, 'completed',
          'Bulk stock fulfilled by super admin');

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (p_admin_id, 'fulfill_reseller_stock', 'reseller_stock_request', p_request_id,
          jsonb_build_object('reseller_id', v_req.reseller_id,
                             'diamonds',   v_req.diamond_amount,
                             'bdt',        v_req.bdt_value));

  RETURN json_build_object('success', true);
END $$;

-- 2.3 Admin sets reseller status (active / busy / inactive)
CREATE OR REPLACE FUNCTION public.set_reseller_status(
  p_reseller_id UUID,
  p_admin_id    UUID,
  p_status      TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_user UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND role IN ('admin','super_admin')) THEN
    RETURN json_build_object('success', false, 'message', 'Not an admin');
  END IF;
  IF p_status NOT IN ('active','busy','inactive') THEN
    RETURN json_build_object('success', false, 'message', 'Invalid status');
  END IF;

  UPDATE public.resellers SET status = p_status WHERE id = p_reseller_id
  RETURNING user_id INTO v_user;

  -- If we deactivate a reseller, drop their role back to user (if they were 'reseller')
  IF p_status = 'inactive' AND v_user IS NOT NULL THEN
    UPDATE public.profiles SET role = 'user'
      WHERE id = v_user AND role = 'reseller';
  ELSIF p_status = 'active' AND v_user IS NOT NULL THEN
    -- Restore reseller role on unblock (but don't downgrade admins)
    UPDATE public.profiles SET role = 'reseller'
      WHERE id = v_user AND role IN ('user');
  END IF;

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (p_admin_id, 'set_reseller_status', 'reseller', p_reseller_id,
          jsonb_build_object('status', p_status));

  RETURN json_build_object('success', true);
END $$;

-- 2.4 REPLACE confirm_topup_request: deduct from reseller stock too
CREATE OR REPLACE FUNCTION public.confirm_topup_request(
  p_request_id UUID,
  p_admin_id   UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request public.topup_requests%ROWTYPE;
  v_agency  public.agencies%ROWTYPE;
  v_reseller public.resellers%ROWTYPE;
  v_is_admin BOOLEAN;
  v_is_agency_owner BOOLEAN;
  v_is_reseller BOOLEAN;
BEGIN
  SELECT * INTO v_request FROM public.topup_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'Request not found');
  END IF;
  IF v_request.status = 'confirmed' THEN
    RETURN json_build_object('success', false, 'message', 'Already confirmed');
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND role IN ('admin','super_admin'))
    INTO v_is_admin;

  v_is_agency_owner := FALSE;
  v_is_reseller := FALSE;

  IF v_request.agency_id IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.agencies WHERE id = v_request.agency_id AND owner_id = p_admin_id)
      INTO v_is_agency_owner;
  END IF;

  IF v_request.reseller_id IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.resellers WHERE id = v_request.reseller_id AND user_id = p_admin_id)
      INTO v_is_reseller;
  END IF;

  IF NOT (v_is_admin OR v_is_agency_owner OR v_is_reseller) THEN
    RETURN json_build_object('success', false, 'message', 'Not authorized');
  END IF;

  -- Agency-based: deduct from agency stock
  IF v_request.agency_id IS NOT NULL THEN
    SELECT * INTO v_agency FROM public.agencies WHERE id = v_request.agency_id FOR UPDATE;
    IF v_agency.diamond_balance < v_request.package_amount THEN
      RETURN json_build_object('success', false, 'message', 'Insufficient agency stock');
    END IF;
    UPDATE public.agencies SET diamond_balance = diamond_balance - v_request.package_amount
      WHERE id = v_request.agency_id;
  END IF;

  -- Reseller-based: deduct from reseller stock (NEW — was missing before)
  -- Super admin override: if admin confirms a reseller order and stock is short,
  -- allow it but don't go below 0. Reseller confirms only if they have stock.
  IF v_request.reseller_id IS NOT NULL THEN
    SELECT * INTO v_reseller FROM public.resellers WHERE id = v_request.reseller_id FOR UPDATE;

    IF v_reseller.diamond_stock < v_request.package_amount THEN
      IF v_is_admin THEN
        -- Admin override: just credit user, log a warning in audit
        INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
        VALUES (p_admin_id, 'override_low_stock', 'reseller', v_reseller.id,
                jsonb_build_object('request_id', p_request_id,
                                   'shortfall', v_request.package_amount - v_reseller.diamond_stock));
      ELSE
        RETURN json_build_object('success', false, 'message', 'Insufficient reseller stock. Request bulk diamonds first.');
      END IF;
    ELSE
      UPDATE public.resellers
         SET diamond_stock = diamond_stock - v_request.package_amount,
             total_sold    = total_sold + v_request.package_amount
       WHERE id = v_request.reseller_id;
    END IF;
  END IF;

  -- Credit user
  UPDATE public.profiles SET diamonds = diamonds + v_request.package_amount
    WHERE id = v_request.user_id;

  UPDATE public.topup_requests
     SET status = 'confirmed', confirmed_by = p_admin_id, confirmed_at = NOW()
   WHERE id = p_request_id;

  INSERT INTO public.transactions
    (user_id, related_user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
  VALUES (v_request.user_id, p_admin_id, 'topup', 'diamond', v_request.package_amount,
          'topup_request', p_request_id, 'completed',
          CASE WHEN v_request.agency_id IS NOT NULL THEN 'Via agency stock' ELSE 'Via reseller' END);

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (p_admin_id, 'confirm_topup', 'topup_request', p_request_id,
          jsonb_build_object('user_id', v_request.user_id,
                             'amount', v_request.package_amount,
                             'source', CASE WHEN v_request.agency_id IS NOT NULL THEN 'agency' ELSE 'reseller' END));

  RETURN json_build_object('success', true);
END $$;


-- =====================================================================
-- SECTION 3: ROW LEVEL SECURITY
-- =====================================================================

ALTER TABLE public.reseller_stock_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rstockreq_read ON public.reseller_stock_requests;
CREATE POLICY rstockreq_read ON public.reseller_stock_requests FOR SELECT
  USING (
    requested_by = auth.uid()
    OR EXISTS (SELECT 1 FROM public.resellers r WHERE r.id = reseller_stock_requests.reseller_id AND r.user_id = auth.uid())
    OR public.is_admin(auth.uid())
  );

DROP POLICY IF EXISTS rstockreq_insert ON public.reseller_stock_requests;
CREATE POLICY rstockreq_insert ON public.reseller_stock_requests FOR INSERT
  WITH CHECK (requested_by = auth.uid());


-- =====================================================================
-- SECTION 4: REALTIME PUBLICATION
-- =====================================================================
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.reseller_stock_requests;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- =====================================================================
-- DONE — proceed to mobile app reseller dashboard + admin panel
-- =====================================================================