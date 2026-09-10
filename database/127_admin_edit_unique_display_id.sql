-- Let admins edit a user's public display ID while preserving uniqueness.
-- The unique index is the final concurrency-safe guard; the RPC also returns
-- a field-specific result so the dashboard can render the error inline.

CREATE UNIQUE INDEX IF NOT EXISTS profiles_display_id_unique_idx
  ON public.profiles (display_id)
  WHERE display_id IS NOT NULL;

DROP FUNCTION IF EXISTS public.admin_update_user(
  UUID, UUID, TEXT, BIGINT, BIGINT, TEXT, TEXT, BOOLEAN
);

CREATE OR REPLACE FUNCTION public.admin_update_user(
  p_admin_id   UUID,
  p_user_id    UUID,
  p_full_name  TEXT DEFAULT NULL,
  p_diamonds   BIGINT DEFAULT NULL,
  p_beans      BIGINT DEFAULT NULL,
  p_role       TEXT DEFAULT NULL,
  p_status     TEXT DEFAULT NULL,
  p_is_banned  BOOLEAN DEFAULT NULL,
  p_display_id BIGINT DEFAULT NULL
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
  IF auth.uid() IS NULL OR auth.uid() <> p_admin_id OR NOT public.is_admin(auth.uid()) THEN
    RETURN json_build_object('success', false, 'message', 'Not an admin');
  END IF;

  v_is_super := public.is_super_admin(auth.uid());

  SELECT * INTO v_old FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'User not found');
  END IF;

  IF p_display_id IS NOT NULL THEN
    IF p_display_id < 1 OR p_display_id > 9007199254740991 THEN
      RETURN json_build_object(
        'success', false,
        'field', 'display_id',
        'code', 'invalid_display_id',
        'message', 'User ID must be a positive number with at most 16 digits'
      );
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE display_id = p_display_id AND id <> p_user_id
    ) THEN
      RETURN json_build_object(
        'success', false,
        'field', 'display_id',
        'code', 'duplicate_display_id',
        'message', 'This User ID is already in use'
      );
    END IF;
  END IF;

  -- Managers may edit ordinary profile fields, but money and privilege
  -- changes remain super-admin-only.
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

  IF p_display_id IS NOT NULL AND p_display_id <> v_old.display_id THEN
    BEGIN
      UPDATE public.profiles SET display_id = p_display_id WHERE id = p_user_id;
    EXCEPTION WHEN unique_violation THEN
      RETURN json_build_object(
        'success', false,
        'field', 'display_id',
        'code', 'duplicate_display_id',
        'message', 'This User ID is already in use'
      );
    END;
    v_changes := v_changes || jsonb_build_object(
      'display_id', jsonb_build_array(v_old.display_id, p_display_id)
    );
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
    VALUES (auth.uid(), 'admin_update_user', 'profile', p_user_id, v_changes);
  END IF;

  RETURN json_build_object('success', true, 'changes', v_changes);
END $$;

REVOKE ALL ON FUNCTION public.admin_update_user(
  UUID, UUID, TEXT, BIGINT, BIGINT, TEXT, TEXT, BOOLEAN, BIGINT
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_update_user(
  UUID, UUID, TEXT, BIGINT, BIGINT, TEXT, TEXT, BOOLEAN, BIGINT
) TO authenticated;

NOTIFY pgrst, 'reload schema';
