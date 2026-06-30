-- =====================================================================
-- 74_apply_role_guards.sql
-- =====================================================================
-- Mutual-exclusion guard between two earning roles a user can hold:
--
--   - Agency Host    (bound under an agency, paid in BDT by owner)
--   - Reseller       (sells diamonds to other users)
--
-- Product rule: a single account can hold only ONE of these at a time.
-- Mixing the two creates messy accounting (whose diamonds were these?)
-- and the operator wanted them strictly separate.
--
-- This migration updates two RPCs so they reject the conflicting case
-- with a clear message. The mobile UI (app/main/apply/reseller.js and
-- app/main/agency-host-view.js) also shows pre-emptive banners so the
-- user understands BEFORE they fill out the form. The DB guard is the
-- source of truth — UI banners are just UX.
--
-- Idempotent: re-runnable.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. apply_reseller — also reject if applicant is an active agency host
-- ---------------------------------------------------------------------
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
  IF EXISTS (SELECT 1 FROM public.reseller_applications WHERE user_id = p_user_id AND status = 'pending') THEN
    RETURN json_build_object('success', false, 'message', 'You already have a pending application.');
  END IF;

  IF EXISTS (SELECT 1 FROM public.resellers WHERE user_id = p_user_id AND status <> 'inactive') THEN
    RETURN json_build_object('success', false, 'message', 'You are already a reseller.');
  END IF;

  -- New rule: a user actively bound to an agency as a host cannot
  -- simultaneously be a reseller. They must leave the agency first.
  IF EXISTS (
    SELECT 1
      FROM public.agency_members
     WHERE host_id = p_user_id
       AND status IN ('active', 'pending')
  ) THEN
    RETURN json_build_object(
      'success', false,
      'message', 'You are bound to an agency as a host. Leave your agency first, then apply as a reseller.'
    );
  END IF;

  INSERT INTO public.reseller_applications (user_id, business_name, contact_link, payment_methods, nid_number, notes)
  VALUES (p_user_id, p_business_name, p_contact_link, p_payment_methods, p_nid_number, p_notes)
  RETURNING id INTO v_id;

  RETURN json_build_object('success', true, 'application_id', v_id);
END $$;


-- ---------------------------------------------------------------------
-- 2. bind_to_agency — also reject if applicant is an active reseller
-- ---------------------------------------------------------------------
-- Original (yolo_schema.sql §4.7) had no role check; it just upserted
-- the agency_members row. We add the reseller check here while keeping
-- the existing release-then-bind behaviour intact.
CREATE OR REPLACE FUNCTION public.bind_to_agency(
  p_host_id     UUID,
  p_agency_code TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_agency public.agencies%ROWTYPE;
BEGIN
  -- New rule: a reseller cannot also be an agency-bound host. The
  -- account either sells diamonds (reseller) or earns from the agency
  -- payout pool (host), never both.
  IF EXISTS (
    SELECT 1
      FROM public.resellers
     WHERE user_id = p_host_id
       AND status <> 'inactive'
  ) THEN
    RETURN json_build_object(
      'success', false,
      'message', 'You are an active reseller. Resellers cannot also join an agency as a host.'
    );
  END IF;

  -- Owners of an agency cannot also be a member host of another one.
  IF EXISTS (
    SELECT 1
      FROM public.agencies
     WHERE owner_id = p_host_id
       AND status <> 'suspended'
  ) THEN
    RETURN json_build_object(
      'success', false,
      'message', 'You own an agency. Agency owners cannot also join another agency as a host.'
    );
  END IF;

  SELECT * INTO v_agency FROM public.agencies WHERE code = p_agency_code AND status = 'verified';
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'Invalid or unverified agency code');
  END IF;

  UPDATE public.agency_members SET status = 'released', released_at = NOW()
    WHERE host_id = p_host_id AND status = 'active';

  INSERT INTO public.agency_members (agency_id, host_id, status) VALUES (v_agency.id, p_host_id, 'pending')
  ON CONFLICT (agency_id, host_id) DO UPDATE SET status = 'pending', released_at = NULL;

  RETURN json_build_object('success', true, 'agency_id', v_agency.id, 'agency_name', v_agency.name);
END $$;


-- =====================================================================
-- DONE
-- =====================================================================
