CREATE OR REPLACE FUNCTION public.sync_profile_account_block_to_auth()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  UPDATE auth.users
  SET banned_until = CASE WHEN NEW.is_banned THEN '2099-12-31 23:59:59+00'::timestamptz ELSE NULL END,
      updated_at = now()
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_sync_account_block_to_auth ON public.profiles;
CREATE TRIGGER profiles_sync_account_block_to_auth
AFTER INSERT OR UPDATE OF is_banned ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.sync_profile_account_block_to_auth();

UPDATE auth.users u
SET banned_until = '2099-12-31 23:59:59+00'::timestamptz, updated_at = now()
FROM public.profiles p
WHERE p.id = u.id AND p.is_banned = true;
