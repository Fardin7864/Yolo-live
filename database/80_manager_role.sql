-- =====================================================================
-- Migration 80 — NEW "manager" role + collapse legacy `admin` into
-- `super_admin`.
--
-- What this does:
--   1. Rewrites every existing `admin` profile to `super_admin` so the
--      panel only has two privileged tiers from now on:
--        super_admin  → full access (the human owner)
--        manager      → restricted access (helpers handling top-ups,
--                       applications, DMs, etc.)
--   2. Updates the role CHECK constraint so future inserts can only
--      use one of the canonical six roles. `admin` is REMOVED.
--   3. Adds is_super_admin(uid) and rewrites is_admin(uid) so that
--      is_admin() now returns TRUE for both manager and super_admin
--      (i.e. anyone who can sign into the admin panel).
--   4. Tightens admin_update_user so only super_admins can mutate
--      role / diamonds / beans. Managers keep the other fields.
--   5. Adds promote_to_manager / demote_from_manager RPCs.
--   6. Stamps chat_messages.sender_role on every insert so the
--      messages page can render a "Manager" badge on outbound DMs.
--   7. CRITICAL — tightens protect_profile_columns so its bypass
--      gate is now is_super_admin(), not is_admin(). Without this,
--      a manager could `UPDATE profiles SET diamonds = 999` directly
--      from supabase-js and side-step admin_update_user entirely.
--
-- Idempotent. Safe to re-run.
-- =====================================================================

-- 1) Collapse the legacy `admin` tier into `super_admin`. No-op on re-run.
UPDATE public.profiles SET role = 'super_admin' WHERE role = 'admin';

-- 2) Replace the role CHECK constraint. `admin` is intentionally absent
-- here — step 1 just emptied that bucket and we don't want anyone
-- introducing it again. `manager` is the new addition.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('user','host','reseller','agency_owner','manager','super_admin'));

-- 3a) is_super_admin — exact, used by every "this action requires
-- the actual owner" gate (money moves, role changes, etc.).
CREATE OR REPLACE FUNCTION public.is_super_admin(uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = uid AND role = 'super_admin'
  );
$$;

-- 3b) is_admin — now means "any panel user" (manager OR super_admin).
-- We keep 'admin' in the IN list as a safety net for any row that
-- somehow survives migration 1 — the constraint blocks new ones but
-- the function should still treat a leftover as privileged so the
-- panel doesn't lock the owner out.
CREATE OR REPLACE FUNCTION public.is_admin(uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = uid
       AND role IN ('manager','super_admin','admin')
  );
$$;

-- 4) admin_update_user — managers may edit full_name / phone /
-- avatar / status / is_banned. Anything that moves money or changes
-- privilege is super_admin-only.
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
  v_is_super BOOLEAN;
BEGIN
  IF NOT public.is_admin(p_admin_id) THEN
    RETURN json_build_object('success', false, 'message', 'Not an admin');
  END IF;

  v_is_super := public.is_super_admin(p_admin_id);

  SELECT * INTO v_old FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'User not found');
  END IF;

  -- Block managers from touching privileged fields before any UPDATE
  -- runs, so the audit log never has a half-applied change.
  IF NOT v_is_super THEN
    IF p_diamonds IS NOT NULL AND p_diamonds <> v_old.diamonds THEN
      RETURN json_build_object('success', false, 'message', 'Only super_admin can change diamonds');
    END IF;
    IF p_beans IS NOT NULL AND p_beans <> v_old.beans THEN
      RETURN json_build_object('success', false, 'message', 'Only super_admin can change beans');
    END IF;
    IF p_role IS NOT NULL AND p_role <> v_old.role THEN
      RETURN json_build_object('success', false, 'message', 'Only super_admin can change role');
    END IF;
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
    IF p_role NOT IN ('user','host','reseller','agency_owner','manager','super_admin') THEN
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

-- 5) Promote a normal user to manager. Super-admin only. Refuses to
-- act on existing admins/super_admins to avoid accidental demotion.
CREATE OR REPLACE FUNCTION public.promote_to_manager(
  p_target UUID,
  p_admin  UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_role TEXT;
BEGIN
  IF NOT public.is_super_admin(p_admin) THEN
    RETURN json_build_object('success', false, 'message', 'Only super_admin can promote');
  END IF;

  SELECT role INTO v_old_role FROM public.profiles WHERE id = p_target;
  IF v_old_role IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Target user not found');
  END IF;

  IF v_old_role IN ('super_admin','admin') THEN
    RETURN json_build_object('success', false, 'message', 'Target is already a super_admin');
  END IF;

  IF v_old_role = 'manager' THEN
    RETURN json_build_object('success', false, 'message', 'Target is already a manager');
  END IF;

  UPDATE public.profiles SET role = 'manager' WHERE id = p_target;

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (p_admin, 'promote_to_manager', 'profile', p_target,
          jsonb_build_object('from_role', v_old_role));

  RETURN json_build_object('success', true, 'from_role', v_old_role);
END $$;

-- 6) Demote a manager back to `user`. Super-admin only. Idempotent
-- guard: if the target isn't currently a manager we refuse, otherwise
-- a stray double-click could nuke a super_admin's role.
CREATE OR REPLACE FUNCTION public.demote_from_manager(
  p_target UUID,
  p_admin  UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_role TEXT;
BEGIN
  IF NOT public.is_super_admin(p_admin) THEN
    RETURN json_build_object('success', false, 'message', 'Only super_admin can demote');
  END IF;

  SELECT role INTO v_old_role FROM public.profiles WHERE id = p_target;
  IF v_old_role IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Target user not found');
  END IF;

  IF v_old_role <> 'manager' THEN
    RETURN json_build_object('success', false, 'message', 'Target is not a manager');
  END IF;

  UPDATE public.profiles SET role = 'user' WHERE id = p_target;

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (p_admin, 'demote_from_manager', 'profile', p_target,
          jsonb_build_object('from_role', v_old_role));

  RETURN json_build_object('success', true);
END $$;

-- 7) chat_messages.sender_role — set automatically on insert so the
-- admin messages UI can colour-tag outgoing DMs from managers.
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS sender_role TEXT;

CREATE OR REPLACE FUNCTION public.stamp_chat_sender_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sender_role IS NULL THEN
    SELECT role INTO NEW.sender_role FROM public.profiles WHERE id = NEW.sender_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS chat_messages_stamp_sender_role ON public.chat_messages;
CREATE TRIGGER chat_messages_stamp_sender_role
  BEFORE INSERT ON public.chat_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_chat_sender_role();

-- 8) CRITICAL — tighten protect_profile_columns.
--
-- Migration 20's version bypassed the column lock when
--   current_user NOT IN ('authenticated','anon')   -- trusted RPCs
--   OR is_admin(auth.uid())                        -- any admin
--
-- With is_admin() now meaning "manager or super_admin", that second
-- branch would let a signed-in manager run
--   await supabase.from('profiles').update({ diamonds: 999 }).eq('id', me)
-- directly from the admin panel browser tab and bypass admin_update_user
-- entirely. The whole point of admin_update_user was to gate currency
-- edits behind a SECURITY DEFINER function that audit-logs every change
-- and lets us enforce role-based limits (step 4 above).
--
-- Fix: replace the gate with is_super_admin(). Managers now follow the
-- same locked-column path as a normal user when they try to UPDATE
-- profiles directly; their only path to change diamonds/beans/role is
-- the RPC, which will reject them with a clear error.
CREATE OR REPLACE FUNCTION public.protect_profile_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER          -- invoker, so current_user = real caller
SET search_path = public
AS $$
BEGIN
  -- Trusted server-side paths (SECURITY DEFINER RPCs, service_role
  -- backend) still bypass unconditionally.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- Only the actual owner (super_admin) may make a direct write that
  -- touches a protected column. Managers fall through to the locks.
  IF public.is_super_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

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

-- 9) Grants — let signed-in users invoke the new RPCs. The functions
-- themselves enforce role checks.
GRANT EXECUTE ON FUNCTION public.is_super_admin(UUID)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.promote_to_manager(UUID, UUID)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.demote_from_manager(UUID, UUID)    TO authenticated;

-- =====================================================================
-- DONE.
-- After running this:
--   * Every old `admin` is now `super_admin`.
--   * The role CHECK no longer accepts `admin`.
--   * is_admin() means "panel user" (manager OR super_admin).
--   * Managers logged into the panel can edit names / ban / etc. but
--     can NOT change role, diamonds, or beans — neither via the RPC
--     nor via a direct UPDATE.
--   * promote_to_manager / demote_from_manager are super_admin-only.
--   * chat_messages.sender_role is auto-stamped on insert.
-- =====================================================================
