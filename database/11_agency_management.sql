-- =====================================================================
-- PHASE 5: Agency management improvements
--   * Super admin can promote ANY user to agency owner by display_id
--     (replaces the "apply" flow — no more agency_applications)
--   * Agency owner can release a host from their agency
--   * Agency owner can reject a pending join request
--   * Agency owner can rename their agency (code stays locked)
--
-- Run in Supabase SQL Editor. Idempotent.
-- =====================================================================

-- =====================================================================
-- 1. PROMOTE USER TO AGENCY OWNER (super admin only)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.promote_to_agency_owner(
  p_admin_id      UUID,
  p_user_id       UUID,
  p_proposed_code TEXT,
  p_proposed_name TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user      public.profiles%ROWTYPE;
  v_agency_id UUID;
  v_name      TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND role IN ('admin','super_admin')) THEN
    RETURN json_build_object('success', false, 'message', 'Not an admin');
  END IF;

  SELECT * INTO v_user FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'User not found');
  END IF;

  IF EXISTS (SELECT 1 FROM public.agencies WHERE owner_id = p_user_id) THEN
    RETURN json_build_object('success', false, 'message', 'User already owns an agency');
  END IF;

  IF LENGTH(COALESCE(p_proposed_code, '')) < 3 THEN
    RETURN json_build_object('success', false, 'message', 'Agency code must be at least 3 characters');
  END IF;

  IF EXISTS (SELECT 1 FROM public.agencies WHERE code = UPPER(p_proposed_code)) THEN
    RETURN json_build_object('success', false, 'message', 'That agency code is already taken');
  END IF;

  v_name := COALESCE(NULLIF(TRIM(p_proposed_name), ''), v_user.full_name || '''s Agency');

  INSERT INTO public.agencies (name, code, owner_id, status, payout_rate, host_conversion_rate)
  VALUES (v_name, UPPER(p_proposed_code), p_user_id, 'verified', 1150, 0.50)
  RETURNING id INTO v_agency_id;

  UPDATE public.profiles SET role = 'agency_owner' WHERE id = p_user_id;

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (p_admin_id, 'promote_agency_owner', 'profile', p_user_id,
          jsonb_build_object('agency_id', v_agency_id, 'code', UPPER(p_proposed_code), 'name', v_name));

  RETURN json_build_object('success', true, 'agency_id', v_agency_id, 'name', v_name);
END $$;

-- =====================================================================
-- 2. AGENCY OWNER: rename their agency
-- =====================================================================
CREATE OR REPLACE FUNCTION public.update_agency_name(
  p_agency_id UUID,
  p_owner_id  UUID,
  p_new_name  TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF LENGTH(TRIM(COALESCE(p_new_name, ''))) < 3 THEN
    RETURN json_build_object('success', false, 'message', 'Name must be at least 3 characters');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.agencies WHERE id = p_agency_id AND owner_id = p_owner_id) THEN
    RETURN json_build_object('success', false, 'message', 'You do not own this agency');
  END IF;

  UPDATE public.agencies SET name = TRIM(p_new_name) WHERE id = p_agency_id;

  RETURN json_build_object('success', true);
END $$;

-- =====================================================================
-- 3. AGENCY OWNER: release a host from the agency
-- =====================================================================
CREATE OR REPLACE FUNCTION public.release_agency_member(
  p_agency_id UUID,
  p_owner_id  UUID,
  p_host_id   UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_member_status TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.agencies WHERE id = p_agency_id AND owner_id = p_owner_id) THEN
    RETURN json_build_object('success', false, 'message', 'You do not own this agency');
  END IF;

  SELECT status INTO v_member_status
  FROM public.agency_members
  WHERE agency_id = p_agency_id AND host_id = p_host_id;

  IF v_member_status IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Host is not in this agency');
  END IF;

  -- Mark member as released (history-preserving)
  UPDATE public.agency_members
     SET status = 'released'
   WHERE agency_id = p_agency_id AND host_id = p_host_id;

  -- Clear host's agency binding so they show as solo
  UPDATE public.profiles
     SET agency_id = NULL
   WHERE id = p_host_id AND agency_id = p_agency_id;

  -- Update member_count on agency
  UPDATE public.agencies
     SET member_count = GREATEST(0, COALESCE(member_count, 0) - 1)
   WHERE id = p_agency_id;

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (p_owner_id, 'release_host', 'profile', p_host_id,
          jsonb_build_object('agency_id', p_agency_id));

  RETURN json_build_object('success', true);
END $$;

-- =====================================================================
-- 4. AGENCY OWNER: reject a pending join request
-- =====================================================================
CREATE OR REPLACE FUNCTION public.reject_agency_join(
  p_agency_id UUID,
  p_owner_id  UUID,
  p_host_id   UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.agencies WHERE id = p_agency_id AND owner_id = p_owner_id) THEN
    RETURN json_build_object('success', false, 'message', 'You do not own this agency');
  END IF;

  DELETE FROM public.agency_members
   WHERE agency_id = p_agency_id AND host_id = p_host_id AND status = 'pending';

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'No pending request for this host');
  END IF;

  -- Clear any agency_id binding that was set optimistically
  UPDATE public.profiles SET agency_id = NULL WHERE id = p_host_id AND agency_id = p_agency_id;

  RETURN json_build_object('success', true);
END $$;

-- =====================================================================
-- DONE
-- =====================================================================