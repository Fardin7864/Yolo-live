-- Repair live Supabase runtime errors after the Green Live expansion.
--
-- Symptoms fixed:
--   1. Agency approval can still fail with "UPDATE requires a WHERE clause"
--      when the live project kept an older unsafe function body.
--   2. Splash/banner uploads can fail with Storage RLS when the dashboard
--      account is an admin/super_admin profile but lacks a per-module row.
--
-- This migration is idempotent and safe to re-run.

BEGIN;

CREATE OR REPLACE FUNCTION public.dashboard_can_manage_module(
  p_uid UUID,
  p_module_key TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.has_admin_permission(p_uid, p_module_key, 'manage'), FALSE)
    OR EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = p_uid
        AND p.role IN ('super_admin', 'admin')
    )
    OR EXISTS (
      SELECT 1
      FROM public.admin_accounts a
      WHERE a.profile_id = p_uid
        AND a.is_active
        AND a.role IN ('super_admin', 'admin')
    );
$$;

GRANT EXECUTE ON FUNCTION public.dashboard_can_manage_module(UUID, TEXT) TO authenticated;

-- Keep bucket setup away from ON CONFLICT DO UPDATE so projects with
-- safe-update enforcement do not reject the migration itself.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('splashes', 'splashes', TRUE, 5 * 1024 * 1024,
    ARRAY['image/png','image/jpeg','image/webp','application/json','text/json']),
  ('banners', 'banners', TRUE, 2 * 1024 * 1024,
    ARRAY['image/png','image/jpeg','image/webp'])
ON CONFLICT (id) DO NOTHING;

UPDATE storage.buckets
SET public = TRUE,
    file_size_limit = 5 * 1024 * 1024,
    allowed_mime_types = ARRAY['image/png','image/jpeg','image/webp','application/json','text/json']
WHERE id = 'splashes';

UPDATE storage.buckets
SET public = TRUE,
    file_size_limit = 2 * 1024 * 1024,
    allowed_mime_types = ARRAY['image/png','image/jpeg','image/webp']
WHERE id = 'banners';

ALTER TABLE public.app_splashes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS app_splashes_read ON public.app_splashes;
DROP POLICY IF EXISTS app_splashes_admin_write ON public.app_splashes;
CREATE POLICY app_splashes_read ON public.app_splashes
  FOR SELECT USING (TRUE);
CREATE POLICY app_splashes_admin_write ON public.app_splashes
  FOR ALL TO authenticated
  USING (public.dashboard_can_manage_module(auth.uid(), 'splash'))
  WITH CHECK (public.dashboard_can_manage_module(auth.uid(), 'splash'));

ALTER TABLE public.home_banners ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS home_banners_read ON public.home_banners;
DROP POLICY IF EXISTS home_banners_admin_write ON public.home_banners;
CREATE POLICY home_banners_read ON public.home_banners
  FOR SELECT USING (TRUE);
CREATE POLICY home_banners_admin_write ON public.home_banners
  FOR ALL TO authenticated
  USING (public.dashboard_can_manage_module(auth.uid(), 'banners'))
  WITH CHECK (public.dashboard_can_manage_module(auth.uid(), 'banners'));

DROP POLICY IF EXISTS splashes_public_read ON storage.objects;
DROP POLICY IF EXISTS splashes_admin_insert ON storage.objects;
DROP POLICY IF EXISTS splashes_admin_update ON storage.objects;
DROP POLICY IF EXISTS splashes_admin_delete ON storage.objects;
DROP POLICY IF EXISTS splashes_rbac_public_read ON storage.objects;
DROP POLICY IF EXISTS splashes_rbac_insert ON storage.objects;
DROP POLICY IF EXISTS splashes_rbac_update ON storage.objects;
DROP POLICY IF EXISTS splashes_rbac_delete ON storage.objects;
DROP POLICY IF EXISTS splashes_dashboard_public_read ON storage.objects;
DROP POLICY IF EXISTS splashes_dashboard_insert ON storage.objects;
DROP POLICY IF EXISTS splashes_dashboard_update ON storage.objects;
DROP POLICY IF EXISTS splashes_dashboard_delete ON storage.objects;

CREATE POLICY splashes_dashboard_public_read ON storage.objects
  FOR SELECT USING (bucket_id = 'splashes');
CREATE POLICY splashes_dashboard_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'splashes'
    AND public.dashboard_can_manage_module(auth.uid(), 'splash')
  );
CREATE POLICY splashes_dashboard_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'splashes'
    AND public.dashboard_can_manage_module(auth.uid(), 'splash')
  )
  WITH CHECK (
    bucket_id = 'splashes'
    AND public.dashboard_can_manage_module(auth.uid(), 'splash')
  );
CREATE POLICY splashes_dashboard_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'splashes'
    AND public.dashboard_can_manage_module(auth.uid(), 'splash')
  );

DROP POLICY IF EXISTS banners_public_read ON storage.objects;
DROP POLICY IF EXISTS banners_admin_insert ON storage.objects;
DROP POLICY IF EXISTS banners_admin_update ON storage.objects;
DROP POLICY IF EXISTS banners_admin_delete ON storage.objects;
DROP POLICY IF EXISTS banners_rbac_public_read ON storage.objects;
DROP POLICY IF EXISTS banners_rbac_insert ON storage.objects;
DROP POLICY IF EXISTS banners_rbac_update ON storage.objects;
DROP POLICY IF EXISTS banners_rbac_delete ON storage.objects;
DROP POLICY IF EXISTS banners_dashboard_public_read ON storage.objects;
DROP POLICY IF EXISTS banners_dashboard_insert ON storage.objects;
DROP POLICY IF EXISTS banners_dashboard_update ON storage.objects;
DROP POLICY IF EXISTS banners_dashboard_delete ON storage.objects;

CREATE POLICY banners_dashboard_public_read ON storage.objects
  FOR SELECT USING (bucket_id = 'banners');
CREATE POLICY banners_dashboard_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'banners'
    AND public.dashboard_can_manage_module(auth.uid(), 'banners')
  );
CREATE POLICY banners_dashboard_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'banners'
    AND public.dashboard_can_manage_module(auth.uid(), 'banners')
  )
  WITH CHECK (
    bucket_id = 'banners'
    AND public.dashboard_can_manage_module(auth.uid(), 'banners')
  );
CREATE POLICY banners_dashboard_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'banners'
    AND public.dashboard_can_manage_module(auth.uid(), 'banners')
  );

CREATE OR REPLACE FUNCTION public.admin_assign_agency_host(
  p_user_id UUID,
  p_agency_id UUID,
  p_request_id UUID DEFAULT NULL,
  p_review_note TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  v_name TEXT;
BEGIN
  IF NOT public.is_live_staff(me) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Admin access required');
  END IF;

  SELECT name INTO v_name
  FROM public.agencies
  WHERE id = p_agency_id
    AND status = 'verified'
  FOR UPDATE;

  IF v_name IS NULL THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Verified agency not found');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_user_id
      AND NOT COALESCE(is_banned, FALSE)
  ) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Eligible user not found');
  END IF;

  UPDATE public.agency_members
  SET status = 'released',
      released_at = NOW()
  WHERE host_id = p_user_id
    AND status IN ('active', 'pending', 'leave_pending');

  INSERT INTO public.agency_members(agency_id, host_id, status, joined_at, released_at)
  VALUES (p_agency_id, p_user_id, 'active', NOW(), NULL)
  ON CONFLICT(agency_id, host_id) DO UPDATE
  SET status = 'active',
      joined_at = NOW(),
      released_at = NULL;

  UPDATE public.profiles
  SET agency_id = p_agency_id,
      role = CASE WHEN role = 'user' THEN 'host' ELSE role END,
      updated_at = NOW()
  WHERE id = p_user_id;

  UPDATE public.agency_join_requests
  SET status = 'rejected',
      reviewed_by = me,
      reviewed_at = NOW(),
      updated_at = NOW(),
      review_note = 'Assigned to another agency'
  WHERE user_id = p_user_id
    AND status = 'pending'
    AND (p_request_id IS NULL OR id <> p_request_id);

  IF p_request_id IS NOT NULL THEN
    UPDATE public.agency_join_requests
    SET status = 'approved',
        agency_id = p_agency_id,
        reviewed_by = me,
        reviewed_at = NOW(),
        updated_at = NOW(),
        review_note = NULLIF(BTRIM(p_review_note), '')
    WHERE id = p_request_id
      AND user_id = p_user_id
      AND status = 'pending';
  END IF;

  UPDATE public.agencies a
  SET member_count = (
    SELECT COUNT(*)
    FROM public.agency_members m
    WHERE m.agency_id = a.id
      AND m.status = 'active'
  )
  WHERE a.id = p_agency_id
     OR EXISTS (
       SELECT 1
       FROM public.agency_members affected
       WHERE affected.agency_id = a.id
         AND affected.host_id = p_user_id
     );

  INSERT INTO public.notifications(user_id, type, title, body, payload)
  VALUES (
    p_user_id,
    'agency_approved',
    'Agency approved',
    'You are now a host in ' || v_name,
    jsonb_build_object('agency_id', p_agency_id)
  );

  INSERT INTO public.admin_audit_log(admin_id, action, target_type, target_id, payload)
  VALUES (
    me,
    'assign_agency_host',
    'profile',
    p_user_id,
    jsonb_build_object('agency_id', p_agency_id, 'request_id', p_request_id, 'note', p_review_note)
  );

  RETURN jsonb_build_object('success', TRUE, 'agency_id', p_agency_id, 'agency_name', v_name);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_review_agency_request(
  p_request_id UUID,
  p_approve BOOLEAN,
  p_agency_id UUID DEFAULT NULL,
  p_review_note TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  r public.agency_join_requests%ROWTYPE;
BEGIN
  IF NOT public.is_live_staff(me) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Admin access required');
  END IF;

  SELECT * INTO r
  FROM public.agency_join_requests
  WHERE id = p_request_id
    AND status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Pending request not found');
  END IF;

  IF p_approve THEN
    RETURN public.admin_assign_agency_host(
      r.user_id,
      COALESCE(p_agency_id, r.agency_id),
      r.id,
      p_review_note
    );
  END IF;

  UPDATE public.agency_join_requests
  SET status = 'rejected',
      reviewed_by = me,
      reviewed_at = NOW(),
      updated_at = NOW(),
      review_note = NULLIF(BTRIM(p_review_note), '')
  WHERE id = r.id;

  INSERT INTO public.notifications(user_id, type, title, body, payload)
  VALUES (
    r.user_id,
    'agency_rejected',
    'Agency application reviewed',
    COALESCE(NULLIF(BTRIM(p_review_note), ''), 'Your agency application was not approved'),
    jsonb_build_object('request_id', r.id)
  );

  INSERT INTO public.admin_audit_log(admin_id, action, target_type, target_id, payload)
  VALUES (
    me,
    'reject_agency_request',
    'profile',
    r.user_id,
    jsonb_build_object('request_id', r.id, 'note', p_review_note)
  );

  RETURN jsonb_build_object('success', TRUE, 'status', 'rejected');
END;
$$;

CREATE OR REPLACE FUNCTION public.owner_review_agency_request(
  p_request_id UUID,
  p_approve BOOLEAN,
  p_review_note TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  r public.agency_join_requests%ROWTYPE;
  v_agency public.agencies%ROWTYPE;
BEGIN
  IF me IS NULL THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Authentication required');
  END IF;

  SELECT * INTO r
  FROM public.agency_join_requests
  WHERE id = p_request_id
    AND status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Pending request not found');
  END IF;

  SELECT * INTO v_agency
  FROM public.agencies
  WHERE id = r.agency_id
    AND owner_id = me
    AND status = 'verified'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Only the verified agency owner can review this request');
  END IF;

  IF NOT p_approve THEN
    UPDATE public.agency_join_requests
    SET status = 'rejected',
        reviewed_by = me,
        reviewed_at = NOW(),
        updated_at = NOW(),
        review_note = NULLIF(BTRIM(p_review_note), '')
    WHERE id = r.id;

    INSERT INTO public.notifications(user_id, type, title, body, payload)
    VALUES (
      r.user_id,
      'agency_rejected',
      'Agency request rejected',
      COALESCE(NULLIF(BTRIM(p_review_note), ''), v_agency.name || ' did not accept your join request'),
      jsonb_build_object('request_id', r.id, 'agency_id', r.agency_id)
    );

    INSERT INTO public.admin_audit_log(admin_id, action, target_type, target_id, payload)
    VALUES (
      me,
      'agency_owner_reject_request',
      'profile',
      r.user_id,
      jsonb_build_object('request_id', r.id, 'agency_id', r.agency_id, 'note', p_review_note)
    );

    RETURN jsonb_build_object('success', TRUE, 'status', 'rejected');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = r.user_id
      AND COALESCE(is_banned, FALSE)
  ) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'This user cannot be added');
  END IF;

  UPDATE public.agency_members
  SET status = 'released',
      released_at = NOW()
  WHERE host_id = r.user_id
    AND status IN ('active', 'pending', 'leave_pending');

  INSERT INTO public.agency_members(agency_id, host_id, status, joined_at, released_at)
  VALUES (r.agency_id, r.user_id, 'active', NOW(), NULL)
  ON CONFLICT(agency_id, host_id) DO UPDATE
  SET status = 'active',
      joined_at = NOW(),
      released_at = NULL;

  UPDATE public.profiles
  SET agency_id = r.agency_id,
      role = CASE WHEN role = 'user' THEN 'host' ELSE role END,
      updated_at = NOW()
  WHERE id = r.user_id;

  UPDATE public.agency_join_requests
  SET status = 'approved',
      reviewed_by = me,
      reviewed_at = NOW(),
      updated_at = NOW(),
      review_note = NULLIF(BTRIM(p_review_note), '')
  WHERE id = r.id;

  UPDATE public.agency_join_requests
  SET status = 'rejected',
      reviewed_by = me,
      reviewed_at = NOW(),
      updated_at = NOW(),
      review_note = 'Joined another agency'
  WHERE user_id = r.user_id
    AND status = 'pending'
    AND id <> r.id;

  UPDATE public.agencies a
  SET member_count = (
    SELECT COUNT(*)
    FROM public.agency_members m
    WHERE m.agency_id = a.id
      AND m.status = 'active'
  )
  WHERE a.id = r.agency_id
     OR EXISTS (
       SELECT 1
       FROM public.agency_members affected
       WHERE affected.agency_id = a.id
         AND affected.host_id = r.user_id
     );

  INSERT INTO public.notifications(user_id, type, title, body, payload)
  VALUES (
    r.user_id,
    'agency_approved',
    'Agency request accepted',
    'You are now a host in ' || v_agency.name,
    jsonb_build_object('request_id', r.id, 'agency_id', r.agency_id)
  );

  INSERT INTO public.admin_audit_log(admin_id, action, target_type, target_id, payload)
  VALUES (
    me,
    'agency_owner_approve_request',
    'profile',
    r.user_id,
    jsonb_build_object('request_id', r.id, 'agency_id', r.agency_id, 'note', p_review_note)
  );

  RETURN jsonb_build_object(
    'success', TRUE,
    'status', 'approved',
    'agency_id', r.agency_id,
    'agency_name', v_agency.name
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_assign_agency_host(UUID, UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_review_agency_request(UUID, BOOLEAN, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.owner_review_agency_request(UUID, BOOLEAN, TEXT) TO authenticated;

COMMIT;
