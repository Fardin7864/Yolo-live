-- =====================================================================
-- PHASE 1 + 2 + 3: Applications, Stock Requests, TopUp refactor
-- Run this in Supabase SQL Editor. Idempotent — safe to re-run.
-- =====================================================================


-- =====================================================================
-- SECTION 1: NEW TABLES
-- =====================================================================

-- 1.1 RESELLER APPLICATIONS
CREATE TABLE IF NOT EXISTS public.reseller_applications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  business_name   TEXT NOT NULL,
  contact_link    TEXT NOT NULL,
  payment_methods TEXT,                              -- e.g. "Bkash, Nagad, Bank"
  nid_number      TEXT,
  notes           TEXT,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by     UUID REFERENCES public.profiles(id),
  reviewed_at     TIMESTAMPTZ,
  review_notes    TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reseller_apps_status ON public.reseller_applications(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reseller_apps_user   ON public.reseller_applications(user_id);

-- 1.2 AGENCY APPLICATIONS
CREATE TABLE IF NOT EXISTS public.agency_applications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  proposed_name   TEXT NOT NULL,
  proposed_code   TEXT NOT NULL,
  contact_link    TEXT NOT NULL,
  nid_number      TEXT,
  notes           TEXT,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by     UUID REFERENCES public.profiles(id),
  reviewed_at     TIMESTAMPTZ,
  review_notes    TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agency_apps_status ON public.agency_applications(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agency_apps_user   ON public.agency_applications(user_id);

-- 1.3 AGENCY STOCK REQUESTS (agency owner asks super admin for bulk diamonds)
CREATE TABLE IF NOT EXISTS public.agency_stock_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id       UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  requested_by    UUID NOT NULL REFERENCES public.profiles(id),
  diamond_amount  BIGINT NOT NULL CHECK (diamond_amount > 0),
  bdt_value       NUMERIC(12,2),                    -- negotiated wholesale price
  notes           TEXT,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'contacted', 'fulfilled', 'cancelled')),
  fulfilled_by    UUID REFERENCES public.profiles(id),
  fulfilled_at    TIMESTAMPTZ,
  review_notes    TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stock_req_status ON public.agency_stock_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_req_agency ON public.agency_stock_requests(agency_id);

-- 1.4 RESELLERS — link to profile (so we can find the underlying user)
ALTER TABLE IF EXISTS public.resellers ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.profiles(id);
CREATE INDEX IF NOT EXISTS idx_resellers_user ON public.resellers(user_id);

-- 1.5 TOPUP REQUESTS — allow agency-based topups
ALTER TABLE IF EXISTS public.topup_requests ALTER COLUMN reseller_id DROP NOT NULL;
ALTER TABLE IF EXISTS public.topup_requests ADD COLUMN IF NOT EXISTS agency_id UUID REFERENCES public.agencies(id);
CREATE INDEX IF NOT EXISTS idx_topup_agency ON public.topup_requests(agency_id, status, created_at DESC);

-- Enforce exactly one of (reseller_id, agency_id) is set
DO $$ BEGIN
  ALTER TABLE public.topup_requests DROP CONSTRAINT IF EXISTS topup_requests_source_check;
  ALTER TABLE public.topup_requests ADD CONSTRAINT topup_requests_source_check
    CHECK (
      (reseller_id IS NOT NULL AND agency_id IS NULL)
      OR (reseller_id IS NULL AND agency_id IS NOT NULL)
    );
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- 1.6 Update profiles role to include 'reseller'
DO $$ BEGIN
  ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
    CHECK (role IN ('user', 'host', 'reseller', 'agency_owner', 'admin', 'super_admin'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;


-- =====================================================================
-- SECTION 2: RPC FUNCTIONS
-- =====================================================================

-- 2.1 APPLY AS RESELLER
CREATE OR REPLACE FUNCTION public.apply_reseller(
  p_user_id         UUID,
  p_business_name   TEXT,
  p_contact_link    TEXT,
  p_payment_methods TEXT DEFAULT NULL,
  p_nid_number      TEXT DEFAULT NULL,
  p_notes           TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id UUID;
BEGIN
  -- Prevent duplicate pending applications
  IF EXISTS (SELECT 1 FROM public.reseller_applications WHERE user_id = p_user_id AND status = 'pending') THEN
    RETURN json_build_object('success', false, 'message', 'You already have a pending application.');
  END IF;

  -- Already a reseller?
  IF EXISTS (SELECT 1 FROM public.resellers WHERE user_id = p_user_id AND status <> 'inactive') THEN
    RETURN json_build_object('success', false, 'message', 'You are already a reseller.');
  END IF;

  INSERT INTO public.reseller_applications (user_id, business_name, contact_link, payment_methods, nid_number, notes)
  VALUES (p_user_id, p_business_name, p_contact_link, p_payment_methods, p_nid_number, p_notes)
  RETURNING id INTO v_id;

  RETURN json_build_object('success', true, 'application_id', v_id);
END $$;

-- 2.2 APPLY AS AGENCY OWNER
CREATE OR REPLACE FUNCTION public.apply_agency_owner(
  p_user_id        UUID,
  p_proposed_name  TEXT,
  p_proposed_code  TEXT,
  p_contact_link   TEXT,
  p_nid_number     TEXT DEFAULT NULL,
  p_notes          TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM public.agency_applications WHERE user_id = p_user_id AND status = 'pending') THEN
    RETURN json_build_object('success', false, 'message', 'You already have a pending application.');
  END IF;

  IF EXISTS (SELECT 1 FROM public.agencies WHERE owner_id = p_user_id) THEN
    RETURN json_build_object('success', false, 'message', 'You already own an agency.');
  END IF;

  IF EXISTS (SELECT 1 FROM public.agencies WHERE code = UPPER(p_proposed_code)) THEN
    RETURN json_build_object('success', false, 'message', 'This agency code is already taken. Choose another.');
  END IF;

  INSERT INTO public.agency_applications (user_id, proposed_name, proposed_code, contact_link, nid_number, notes)
  VALUES (p_user_id, p_proposed_name, UPPER(p_proposed_code), p_contact_link, p_nid_number, p_notes)
  RETURNING id INTO v_id;

  RETURN json_build_object('success', true, 'application_id', v_id);
END $$;

-- 2.3 APPROVE RESELLER APPLICATION (admin only)
CREATE OR REPLACE FUNCTION public.approve_reseller_application(
  p_application_id UUID,
  p_admin_id       UUID,
  p_review_notes   TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_app public.reseller_applications%ROWTYPE;
  v_reseller_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND role IN ('admin','super_admin')) THEN
    RETURN json_build_object('success', false, 'message', 'Not an admin');
  END IF;

  SELECT * INTO v_app FROM public.reseller_applications WHERE id = p_application_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'Application not found');
  END IF;
  IF v_app.status <> 'pending' THEN
    RETURN json_build_object('success', false, 'message', 'Already reviewed');
  END IF;

  -- Create the reseller row
  INSERT INTO public.resellers (name, avatar_url, contact_link, type, status, priority, user_id)
  SELECT v_app.business_name, p.avatar_url, v_app.contact_link, 'agency', 'active', 50, v_app.user_id
  FROM public.profiles p WHERE p.id = v_app.user_id
  RETURNING id INTO v_reseller_id;

  -- Upgrade user role
  UPDATE public.profiles SET role = 'reseller' WHERE id = v_app.user_id;

  -- Mark application
  UPDATE public.reseller_applications
     SET status = 'approved', reviewed_by = p_admin_id, reviewed_at = NOW(), review_notes = p_review_notes
   WHERE id = p_application_id;

  -- Audit log
  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (p_admin_id, 'approve_reseller', 'reseller_application', p_application_id,
          jsonb_build_object('user_id', v_app.user_id, 'reseller_id', v_reseller_id));

  RETURN json_build_object('success', true, 'reseller_id', v_reseller_id);
END $$;

-- 2.4 APPROVE AGENCY APPLICATION (admin only)
CREATE OR REPLACE FUNCTION public.approve_agency_application(
  p_application_id UUID,
  p_admin_id       UUID,
  p_review_notes   TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_app public.agency_applications%ROWTYPE;
  v_agency_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND role IN ('admin','super_admin')) THEN
    RETURN json_build_object('success', false, 'message', 'Not an admin');
  END IF;

  SELECT * INTO v_app FROM public.agency_applications WHERE id = p_application_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'Application not found');
  END IF;
  IF v_app.status <> 'pending' THEN
    RETURN json_build_object('success', false, 'message', 'Already reviewed');
  END IF;
  IF EXISTS (SELECT 1 FROM public.agencies WHERE code = v_app.proposed_code) THEN
    RETURN json_build_object('success', false, 'message', 'Agency code is now taken. Reject and ask to pick another.');
  END IF;

  INSERT INTO public.agencies (name, code, owner_id, status, payout_rate, host_conversion_rate)
  VALUES (v_app.proposed_name, v_app.proposed_code, v_app.user_id, 'verified', 1150, 0.50)
  RETURNING id INTO v_agency_id;

  UPDATE public.profiles SET role = 'agency_owner' WHERE id = v_app.user_id;

  UPDATE public.agency_applications
     SET status = 'approved', reviewed_by = p_admin_id, reviewed_at = NOW(), review_notes = p_review_notes
   WHERE id = p_application_id;

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (p_admin_id, 'approve_agency', 'agency_application', p_application_id,
          jsonb_build_object('user_id', v_app.user_id, 'agency_id', v_agency_id));

  RETURN json_build_object('success', true, 'agency_id', v_agency_id);
END $$;

-- 2.5 REJECT APPLICATION (universal — works for both types)
CREATE OR REPLACE FUNCTION public.reject_application(
  p_application_id UUID,
  p_admin_id       UUID,
  p_kind           TEXT,     -- 'reseller' or 'agency'
  p_review_notes   TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND role IN ('admin','super_admin')) THEN
    RETURN json_build_object('success', false, 'message', 'Not an admin');
  END IF;

  IF p_kind = 'reseller' THEN
    UPDATE public.reseller_applications
       SET status = 'rejected', reviewed_by = p_admin_id, reviewed_at = NOW(), review_notes = p_review_notes
     WHERE id = p_application_id AND status = 'pending';
  ELSIF p_kind = 'agency' THEN
    UPDATE public.agency_applications
       SET status = 'rejected', reviewed_by = p_admin_id, reviewed_at = NOW(), review_notes = p_review_notes
     WHERE id = p_application_id AND status = 'pending';
  ELSE
    RETURN json_build_object('success', false, 'message', 'Invalid kind');
  END IF;

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (p_admin_id, 'reject_' || p_kind, p_kind || '_application', p_application_id,
          jsonb_build_object('notes', p_review_notes));

  RETURN json_build_object('success', true);
END $$;

-- 2.6 REQUEST AGENCY STOCK (agency owner wants bulk diamonds)
CREATE OR REPLACE FUNCTION public.request_agency_stock(
  p_owner_id       UUID,
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
  v_agency_id UUID;
  v_req_id UUID;
BEGIN
  SELECT id INTO v_agency_id FROM public.agencies WHERE owner_id = p_owner_id AND status = 'verified';
  IF v_agency_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'You do not own a verified agency.');
  END IF;

  INSERT INTO public.agency_stock_requests (agency_id, requested_by, diamond_amount, bdt_value, notes)
  VALUES (v_agency_id, p_owner_id, p_diamond_amount, p_bdt_value, p_notes)
  RETURNING id INTO v_req_id;

  RETURN json_build_object('success', true, 'request_id', v_req_id);
END $$;

-- 2.7 FULFILL STOCK REQUEST (super admin sends bulk diamonds to agency)
CREATE OR REPLACE FUNCTION public.fulfill_stock_request(
  p_request_id UUID,
  p_admin_id   UUID,
  p_notes      TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_req public.agency_stock_requests%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND role IN ('admin','super_admin')) THEN
    RETURN json_build_object('success', false, 'message', 'Not an admin');
  END IF;

  SELECT * INTO v_req FROM public.agency_stock_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR v_req.status = 'fulfilled' THEN
    RETURN json_build_object('success', false, 'message', 'Invalid or already-fulfilled request');
  END IF;

  -- Credit the agency
  UPDATE public.agencies SET diamond_balance = diamond_balance + v_req.diamond_amount
    WHERE id = v_req.agency_id;

  -- Mark fulfilled
  UPDATE public.agency_stock_requests
     SET status = 'fulfilled', fulfilled_by = p_admin_id, fulfilled_at = NOW(), review_notes = p_notes
   WHERE id = p_request_id;

  -- Log transaction (agency-level)
  INSERT INTO public.transactions (user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
  VALUES (v_req.requested_by, 'agency_transfer', 'diamond', v_req.diamond_amount, 'agency_stock_request', p_request_id, 'completed',
          'Bulk stock fulfilled by super admin');

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (p_admin_id, 'fulfill_stock', 'agency_stock_request', p_request_id,
          jsonb_build_object('agency_id', v_req.agency_id, 'diamonds', v_req.diamond_amount, 'bdt', v_req.bdt_value));

  RETURN json_build_object('success', true);
END $$;

-- 2.8 CREATE AGENCY TOPUP REQUEST (user wants to buy from a specific agency)
CREATE OR REPLACE FUNCTION public.create_agency_topup_request(
  p_user_id        UUID,
  p_agency_id      UUID,
  p_package_amount BIGINT,
  p_bdt_value      NUMERIC
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.agencies WHERE id = p_agency_id AND status = 'verified') THEN
    RETURN json_build_object('success', false, 'message', 'Agency not available');
  END IF;

  INSERT INTO public.topup_requests (user_id, agency_id, package_amount, bdt_value)
  VALUES (p_user_id, p_agency_id, p_package_amount, p_bdt_value)
  RETURNING id INTO v_id;

  RETURN json_build_object('success', true, 'request_id', v_id);
END $$;

-- 2.9 UPDATED CONFIRM TOPUP — handles both reseller AND agency cases
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
  v_is_admin BOOLEAN;
  v_is_agency_owner BOOLEAN;
BEGIN
  SELECT * INTO v_request FROM public.topup_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'Request not found');
  END IF;
  IF v_request.status = 'confirmed' THEN
    RETURN json_build_object('success', false, 'message', 'Already confirmed');
  END IF;

  -- Permission: admin OR (agency-based and caller owns that agency)
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND role IN ('admin','super_admin')) INTO v_is_admin;

  v_is_agency_owner := FALSE;
  IF v_request.agency_id IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.agencies WHERE id = v_request.agency_id AND owner_id = p_admin_id) INTO v_is_agency_owner;
  END IF;

  -- Reseller-based topups also allow the underlying reseller user
  IF v_request.reseller_id IS NOT NULL AND NOT v_is_admin THEN
    IF NOT EXISTS (SELECT 1 FROM public.resellers WHERE id = v_request.reseller_id AND user_id = p_admin_id) THEN
      RETURN json_build_object('success', false, 'message', 'Not authorized');
    END IF;
  ELSIF NOT v_is_admin AND NOT v_is_agency_owner THEN
    RETURN json_build_object('success', false, 'message', 'Not authorized');
  END IF;

  -- If agency-based: deduct from agency stock
  IF v_request.agency_id IS NOT NULL THEN
    SELECT * INTO v_agency FROM public.agencies WHERE id = v_request.agency_id FOR UPDATE;
    IF v_agency.diamond_balance < v_request.package_amount THEN
      RETURN json_build_object('success', false, 'message', 'Insufficient agency stock');
    END IF;
    UPDATE public.agencies SET diamond_balance = diamond_balance - v_request.package_amount
      WHERE id = v_request.agency_id;
  END IF;

  -- Credit user
  UPDATE public.profiles SET diamonds = diamonds + v_request.package_amount WHERE id = v_request.user_id;

  UPDATE public.topup_requests
     SET status = 'confirmed', confirmed_by = p_admin_id, confirmed_at = NOW()
   WHERE id = p_request_id;

  INSERT INTO public.transactions (user_id, related_user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
  VALUES (v_request.user_id, p_admin_id, 'topup', 'diamond', v_request.package_amount, 'topup_request', p_request_id, 'completed',
          CASE WHEN v_request.agency_id IS NOT NULL THEN 'Via agency stock' ELSE 'Via reseller' END);

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (p_admin_id, 'confirm_topup', 'topup_request', p_request_id,
          jsonb_build_object('user_id', v_request.user_id, 'amount', v_request.package_amount,
                             'source', CASE WHEN v_request.agency_id IS NOT NULL THEN 'agency' ELSE 'reseller' END));

  RETURN json_build_object('success', true);
END $$;


-- =====================================================================
-- SECTION 3: ROW LEVEL SECURITY
-- =====================================================================

ALTER TABLE public.reseller_applications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agency_applications    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agency_stock_requests  ENABLE ROW LEVEL SECURITY;

-- Reseller applications
DROP POLICY IF EXISTS resapp_read ON public.reseller_applications;
CREATE POLICY resapp_read ON public.reseller_applications FOR SELECT
  USING (user_id = auth.uid() OR public.is_admin(auth.uid()));
DROP POLICY IF EXISTS resapp_insert ON public.reseller_applications;
CREATE POLICY resapp_insert ON public.reseller_applications FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Agency applications
DROP POLICY IF EXISTS agapp_read ON public.agency_applications;
CREATE POLICY agapp_read ON public.agency_applications FOR SELECT
  USING (user_id = auth.uid() OR public.is_admin(auth.uid()));
DROP POLICY IF EXISTS agapp_insert ON public.agency_applications;
CREATE POLICY agapp_insert ON public.agency_applications FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Agency stock requests
DROP POLICY IF EXISTS stockreq_read ON public.agency_stock_requests;
CREATE POLICY stockreq_read ON public.agency_stock_requests FOR SELECT
  USING (
    requested_by = auth.uid()
    OR EXISTS (SELECT 1 FROM public.agencies a WHERE a.id = agency_stock_requests.agency_id AND a.owner_id = auth.uid())
    OR public.is_admin(auth.uid())
  );
DROP POLICY IF EXISTS stockreq_insert ON public.agency_stock_requests;
CREATE POLICY stockreq_insert ON public.agency_stock_requests FOR INSERT
  WITH CHECK (requested_by = auth.uid());

-- Update topup_requests RLS to also allow agency owners and resellers
DROP POLICY IF EXISTS topup_read ON public.topup_requests;
CREATE POLICY topup_read ON public.topup_requests FOR SELECT
  USING (
    user_id = auth.uid()
    OR public.is_admin(auth.uid())
    OR EXISTS (SELECT 1 FROM public.agencies a WHERE a.id = topup_requests.agency_id AND a.owner_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.resellers r WHERE r.id = topup_requests.reseller_id AND r.user_id = auth.uid())
  );


-- =====================================================================
-- SECTION 4: REALTIME PUBLICATION
-- =====================================================================
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.reseller_applications;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.agency_applications;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.agency_stock_requests;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- =====================================================================
-- DONE — restart admin panel & mobile app
-- =====================================================================