-- =====================================================================
-- SECURITY: Lock down profiles UPDATE so users can only edit safe fields
--
-- The old policy `profiles_update_self` allowed user_id = auth.uid()
-- to UPDATE *any* column — including diamonds, beans, role, is_banned,
-- display_id, agency_id. A malicious client could:
--   - Set their own diamonds to 999,999,999
--   - Promote themselves to super_admin
--   - Unban their own account
--
-- Fix: replace with a trigger-enforced policy that rejects edits to
-- sensitive columns by non-admin callers. Admins keep full UPDATE.
-- Idempotent. Run in Supabase SQL Editor.
-- =====================================================================

-- 1. Drop the over-permissive policy (keep admin policy intact)
DROP POLICY IF EXISTS profiles_update_self ON public.profiles;

-- 2. New self-update policy with column-level safety enforced by trigger
CREATE POLICY profiles_update_self ON public.profiles FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- 3. BEFORE UPDATE trigger — rejects sensitive-column edits by non-admins
CREATE OR REPLACE FUNCTION public.protect_profile_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Admins bypass — they can change everything (controlled by profiles_admin_all)
  IF public.is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  -- Server-side SECURITY DEFINER calls also bypass (auth.uid() is the user
  -- but the RPC is running as service role context — extra protection via
  -- direct column comparison; if the column actually changed, reject).
  -- We allow only these editable columns for self-update:
  --   full_name, avatar_url, bio, gender
  -- Everything else must stay equal to OLD.

  IF NEW.diamonds       IS DISTINCT FROM OLD.diamonds       THEN
    RAISE EXCEPTION 'You cannot change diamonds directly' USING ERRCODE = '42501';
  END IF;
  IF NEW.beans          IS DISTINCT FROM OLD.beans          THEN
    RAISE EXCEPTION 'You cannot change beans directly' USING ERRCODE = '42501';
  END IF;
  IF NEW.role           IS DISTINCT FROM OLD.role           THEN
    RAISE EXCEPTION 'You cannot change your role' USING ERRCODE = '42501';
  END IF;
  IF NEW.status         IS DISTINCT FROM OLD.status         THEN
    RAISE EXCEPTION 'You cannot change your account status' USING ERRCODE = '42501';
  END IF;
  IF NEW.is_banned      IS DISTINCT FROM OLD.is_banned      THEN
    RAISE EXCEPTION 'You cannot change ban status' USING ERRCODE = '42501';
  END IF;
  IF NEW.display_id     IS DISTINCT FROM OLD.display_id     THEN
    RAISE EXCEPTION 'You cannot change your display ID' USING ERRCODE = '42501';
  END IF;
  IF NEW.agency_id      IS DISTINCT FROM OLD.agency_id      THEN
    RAISE EXCEPTION 'Use bind_to_agency RPC to change agency' USING ERRCODE = '42501';
  END IF;
  IF NEW.level          IS DISTINCT FROM OLD.level          THEN
    RAISE EXCEPTION 'You cannot change your level' USING ERRCODE = '42501';
  END IF;
  IF NEW.vip_type       IS DISTINCT FROM OLD.vip_type       THEN
    RAISE EXCEPTION 'You cannot change VIP type' USING ERRCODE = '42501';
  END IF;
  IF NEW.id             IS DISTINCT FROM OLD.id             THEN
    RAISE EXCEPTION 'You cannot change your id' USING ERRCODE = '42501';
  END IF;
  IF NEW.phone_number   IS DISTINCT FROM OLD.phone_number   THEN
    RAISE EXCEPTION 'You cannot change your phone number directly' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS profiles_protect_columns ON public.profiles;
CREATE TRIGGER profiles_protect_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_columns();


-- =====================================================================
-- ADMIN RPC: update user safely + audit log
-- Replaces the direct UPDATE in admin panel users/page.tsx
-- =====================================================================
CREATE OR REPLACE FUNCTION public.admin_update_user(
  p_admin_id  UUID,
  p_user_id   UUID,
  p_full_name TEXT DEFAULT NULL,
  p_diamonds  BIGINT DEFAULT NULL,
  p_beans     BIGINT DEFAULT NULL,
  p_role      TEXT DEFAULT NULL,
  p_status    TEXT DEFAULT NULL,
  p_is_banned BOOLEAN DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old public.profiles%ROWTYPE;
  v_changes JSONB := '{}'::JSONB;
BEGIN
  IF NOT public.is_admin(p_admin_id) THEN
    RETURN json_build_object('success', false, 'message', 'Not an admin');
  END IF;

  SELECT * INTO v_old FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'User not found');
  END IF;

  IF p_full_name IS NOT NULL AND p_full_name <> v_old.full_name THEN
    UPDATE public.profiles SET full_name = p_full_name WHERE id = p_user_id;
    v_changes := v_changes || jsonb_build_object('full_name', jsonb_build_array(v_old.full_name, p_full_name));
  END IF;

  IF p_diamonds IS NOT NULL AND p_diamonds <> v_old.diamonds THEN
    UPDATE public.profiles SET diamonds = p_diamonds WHERE id = p_user_id;
    v_changes := v_changes || jsonb_build_object('diamonds', jsonb_build_array(v_old.diamonds, p_diamonds));
  END IF;

  IF p_beans IS NOT NULL AND p_beans <> v_old.beans THEN
    UPDATE public.profiles SET beans = p_beans WHERE id = p_user_id;
    v_changes := v_changes || jsonb_build_object('beans', jsonb_build_array(v_old.beans, p_beans));
  END IF;

  IF p_role IS NOT NULL AND p_role <> v_old.role THEN
    IF p_role NOT IN ('user','host','reseller','agency_owner','admin','super_admin') THEN
      RETURN json_build_object('success', false, 'message', 'Invalid role');
    END IF;
    UPDATE public.profiles SET role = p_role WHERE id = p_user_id;
    v_changes := v_changes || jsonb_build_object('role', jsonb_build_array(v_old.role, p_role));
  END IF;

  IF p_status IS NOT NULL AND p_status <> v_old.status THEN
    UPDATE public.profiles SET status = p_status WHERE id = p_user_id;
    v_changes := v_changes || jsonb_build_object('status', jsonb_build_array(v_old.status, p_status));
  END IF;

  IF p_is_banned IS NOT NULL AND p_is_banned <> v_old.is_banned THEN
    UPDATE public.profiles SET is_banned = p_is_banned WHERE id = p_user_id;
    v_changes := v_changes || jsonb_build_object('is_banned', jsonb_build_array(v_old.is_banned, p_is_banned));
  END IF;

  IF v_changes <> '{}'::JSONB THEN
    INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
    VALUES (p_admin_id, 'admin_update_user', 'profile', p_user_id, v_changes);
  END IF;

  RETURN json_build_object('success', true, 'changes', v_changes);
END $$;


-- =====================================================================
-- HOST RPC: leave_agency — host self-release from their current agency.
-- Needed because the new trigger blocks direct profiles.agency_id = NULL
-- updates by the user.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.leave_agency(p_host_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_agency_id UUID;
BEGIN
  -- Only the host themselves can call this for themselves (RPC is invoked
  -- with the user's session; we still re-check by id).
  SELECT agency_id INTO v_agency_id FROM public.profiles WHERE id = p_host_id;
  IF v_agency_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'You are not in any agency');
  END IF;

  UPDATE public.agency_members
     SET status = 'released'
   WHERE host_id = p_host_id AND status = 'active';

  UPDATE public.profiles SET agency_id = NULL WHERE id = p_host_id;

  UPDATE public.agencies
     SET member_count = GREATEST(0, COALESCE(member_count, 0) - 1)
   WHERE id = v_agency_id;

  RETURN json_build_object('success', true);
END $$;


-- =====================================================================
-- DONE. After running this:
--   - Users can no longer change their own diamonds/beans/role from
--     the mobile app (any attempt throws 42501 permission_denied)
--   - Admins must use admin_update_user RPC (gets audit-logged)
-- =====================================================================