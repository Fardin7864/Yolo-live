-- =====================================================================
-- 98_admin_delete_user_rpc.sql — clean user-delete RPC for super admin
-- =====================================================================
-- Goal: a super_admin in the admin panel (or anyone with the postgres
-- service-role key) can call ONE function to fully delete a user.
-- Migrations 93..97 made the cascade chain healthy enough that
-- `DELETE FROM auth.users WHERE id=...` actually works now, but a
-- dedicated RPC gives us:
--
--   * Authorisation: only super_admin can invoke it
--   * Audit logging: every delete is recorded in admin_audit_log
--   * Cannot-delete-self guard so an admin can't accidentally nuke
--     their own account from the admin panel
--   * Cannot-delete-the-last-super-admin guard so we don't lock
--     ourselves out of the panel
--
-- The actual data removal still happens through the FK cascade chain
-- — auth.users -> profiles -> all referencing tables. The SECURITY
-- DEFINER mode runs the function as the function's OWNER (postgres),
-- which has full permissions and bypasses the auth-admin pitfalls
-- migrations 96/97 had to chase.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.admin_delete_user(p_user_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_caller       uuid := auth.uid();
  v_caller_role  text;
  v_target_email text;
  v_target_name  text;
  v_target_role  text;
  v_remaining_super_admins int;
BEGIN
  IF v_caller IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  SELECT role INTO v_caller_role FROM public.profiles WHERE id = v_caller;
  IF v_caller_role IS DISTINCT FROM 'super_admin' THEN
    RETURN json_build_object('success', false, 'message', 'Only super admins can delete users');
  END IF;

  IF p_user_id = v_caller THEN
    RETURN json_build_object('success', false, 'message', 'You cannot delete your own account');
  END IF;

  SELECT u.email, p.full_name, p.role
    INTO v_target_email, v_target_name, v_target_role
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.id = u.id
   WHERE u.id = p_user_id;

  IF v_target_email IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'User not found');
  END IF;

  -- Don't lock the org out by deleting the last super_admin.
  IF v_target_role = 'super_admin' THEN
    SELECT count(*) INTO v_remaining_super_admins
      FROM public.profiles
     WHERE role = 'super_admin' AND id <> p_user_id;
    IF v_remaining_super_admins = 0 THEN
      RETURN json_build_object('success', false, 'message',
        'Refusing to delete the last super admin');
    END IF;
  END IF;

  -- Audit log BEFORE the cascade fires (the audit row's admin_id
  -- references profiles and would also cascade-clear if we logged
  -- AFTER, since the caller might also be the target — though
  -- self-delete is blocked above).
  INSERT INTO public.admin_audit_log
    (admin_id, action, target_type, target_id, payload)
  VALUES
    (v_caller, 'delete_user', 'auth.users', p_user_id,
     jsonb_build_object(
       'target_email', v_target_email,
       'target_name',  v_target_name,
       'target_role',  v_target_role
     ));

  -- The actual deletion. FK cascades handle profiles + everything below.
  DELETE FROM auth.users WHERE id = p_user_id;

  RETURN json_build_object(
    'success', true,
    'deleted_id',    p_user_id,
    'deleted_email', v_target_email,
    'deleted_name',  v_target_name
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object(
      'success', false,
      'message', SQLERRM,
      'sqlstate', SQLSTATE
    );
END;
$$;

-- Only authenticated callers can invoke; the function itself enforces
-- the super_admin check internally.
REVOKE ALL ON FUNCTION public.admin_delete_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid) TO authenticated;
