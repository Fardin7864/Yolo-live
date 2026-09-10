-- Supabase hosted databases do not permit migration roles to ALTER DATABASE
-- custom settings. Generate the key inside a locked table instead. Only the
-- security-definer seed function can read it.
CREATE TABLE IF NOT EXISTS public.crash_internal_secrets (
  secret_name TEXT PRIMARY KEY,
  secret_value TEXT NOT NULL CHECK(length(secret_value)>=32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO public.crash_internal_secrets(secret_name,secret_value)
VALUES('seed_encryption_key',encode(extensions.gen_random_bytes(48),'base64'))
ON CONFLICT(secret_name) DO NOTHING;
ALTER TABLE public.crash_internal_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crash_internal_secrets FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.crash_seed_key() RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE key_value TEXT:=current_setting('app.settings.crash_seed_key',TRUE);
BEGIN
  IF length(COALESCE(key_value,''))<32 THEN SELECT secret_value INTO key_value FROM public.crash_internal_secrets WHERE secret_name='seed_encryption_key'; END IF;
  IF length(COALESCE(key_value,''))<32 THEN RAISE EXCEPTION 'Crash seed encryption key is not configured'; END IF;
  RETURN key_value;
END $$;
REVOKE ALL ON FUNCTION public.crash_seed_key() FROM PUBLIC,anon,authenticated,service_role;

-- Replace only the readiness checks in the already-deployed functions. Using
-- pg_get_functiondef preserves their complete validated bodies and signatures.
DO $$
DECLARE
  function_name TEXT;
  original_definition TEXT;
  updated_definition TEXT;
BEGIN
  FOREACH function_name IN ARRAY ARRAY[
    'public.crash_service_readiness(text,text)',
    'public.admin_update_crash_config(jsonb)',
    'public.admin_crash_control(text,uuid,text,text)'
  ] LOOP
    SELECT pg_get_functiondef(function_name::regprocedure) INTO original_definition;
    updated_definition:=replace(
      original_definition,
      'length(COALESCE(current_setting(''app.settings.crash_seed_key'', TRUE), ''''))',
      'length(public.crash_seed_key())'
    );
    -- pg_get_functiondef may normalize away the space after the comma.
    updated_definition:=replace(
      updated_definition,
      'length(COALESCE(current_setting(''app.settings.crash_seed_key'',TRUE),''''))',
      'length(public.crash_seed_key())'
    );
    IF updated_definition=original_definition THEN RAISE EXCEPTION 'Crash seed readiness expression not found in %',function_name; END IF;
    EXECUTE updated_definition;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.crash_service_readiness(TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.crash_service_readiness(TEXT,TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.admin_update_crash_config(JSONB) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.admin_crash_control(TEXT,UUID,TEXT,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_update_crash_config(JSONB),public.admin_crash_control(TEXT,UUID,TEXT,TEXT) TO authenticated;
NOTIFY pgrst,'reload schema';
