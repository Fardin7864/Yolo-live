-- Emergency app-server gate. PostgREST invokes this function before every
-- table, view, and RPC request. Service-role traffic and active dashboard
-- administrators remain available so the switch can always be reversed.

INSERT INTO public.system_settings (key, value)
VALUES ('app_server_connected', 'true'::JSONB)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.admin_set_app_server_connected(
  p_admin_id UUID,
  p_connected BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_admin_id IS NULL OR NOT public.is_super_admin(p_admin_id) THEN
    RAISE EXCEPTION 'Super admin access required';
  END IF;

  INSERT INTO public.system_settings (key, value, updated_at, updated_by)
  VALUES ('app_server_connected', to_jsonb(p_connected), NOW(), p_admin_id)
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        updated_at = EXCLUDED.updated_at,
        updated_by = EXCLUDED.updated_by;

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (
    p_admin_id,
    CASE WHEN p_connected THEN 'connect_app_server' ELSE 'disconnect_app_server' END,
    'system_settings',
    NULL,
    jsonb_build_object('key', 'app_server_connected', 'connected', p_connected)
  );

  RETURN jsonb_build_object(
    'connected', p_connected,
    'updated_at', NOW(),
    'updated_by', p_admin_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_set_app_server_connected(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_app_server_connected(UUID, BOOLEAN) TO service_role;

CREATE OR REPLACE FUNCTION public.enforce_app_server_connection()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_claims JSONB := COALESCE(
    NULLIF(current_setting('request.jwt.claims', TRUE), ''),
    '{}'
  )::JSONB;
  v_role TEXT := COALESCE(v_claims->>'role', 'anon');
  v_user_id UUID;
  v_connected BOOLEAN := TRUE;
BEGIN
  -- Server-side admin APIs use the service role and must stay available.
  IF v_role = 'service_role' THEN
    RETURN;
  END IF;

  SELECT CASE WHEN value = 'false'::JSONB THEN FALSE ELSE TRUE END
    INTO v_connected
    FROM public.system_settings
   WHERE key = 'app_server_connected';

  IF COALESCE(v_connected, TRUE) THEN
    RETURN;
  END IF;

  BEGIN
    v_user_id := NULLIF(v_claims->>'sub', '')::UUID;
  EXCEPTION WHEN invalid_text_representation THEN
    v_user_id := NULL;
  END;

  -- Active dashboard staff retain direct Supabase access. Normal mobile-app
  -- identities and anonymous clients are rejected before query execution.
  IF v_user_id IS NOT NULL AND public.is_admin(v_user_id) THEN
    RETURN;
  END IF;

  RAISE SQLSTATE 'PT503'
    USING MESSAGE = 'APP_SERVER_DISCONNECTED',
          DETAIL = 'The application server is temporarily disconnected by an administrator.';
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_app_server_connection() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_app_server_connection() TO anon, authenticated, service_role;

ALTER ROLE authenticator SET pgrst.db_pre_request = 'public.enforce_app_server_connection';
NOTIFY pgrst, 'reload config';

COMMENT ON FUNCTION public.enforce_app_server_connection() IS
  'Emergency PostgREST gate: blocks app table/RPC traffic while preserving active admin and service-role access.';

COMMENT ON FUNCTION public.admin_set_app_server_connected(UUID, BOOLEAN) IS
  'Atomically changes the emergency app-server gate and records the super-admin action.';
