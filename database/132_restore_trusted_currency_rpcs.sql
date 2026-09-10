-- Restore trusted currency mutations after migration 130 replaced the
-- profile guard with a SECURITY DEFINER trigger. A SECURITY DEFINER trigger
-- cannot distinguish direct authenticated writes from legitimate
-- SECURITY DEFINER RPCs such as send_gift, purchases, and game bets.
--
-- Keep the trigger SECURITY INVOKER: direct PostgREST writes run as
-- authenticated/anon and remain locked, while trusted RPCs execute their
-- UPDATE as the function owner and bypass the client-only column guard.

CREATE OR REPLACE FUNCTION public.protect_profile_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  trusted_level_update BOOLEAN :=
    COALESCE(current_setting('green_live.level_recalc', TRUE), '0') = '1';
BEGIN
  -- Trusted SECURITY DEFINER RPCs and service-role operations may mutate
  -- protected columns. Their individual functions perform authorization,
  -- balance checks, row locks, and audit/ledger writes.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- Only super admins may directly edit protected profile fields.
  IF public.is_super_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF NEW.diamonds IS DISTINCT FROM OLD.diamonds THEN
    RAISE EXCEPTION 'You cannot change diamonds directly' USING ERRCODE = '42501';
  END IF;
  IF NEW.beans IS DISTINCT FROM OLD.beans THEN
    RAISE EXCEPTION 'You cannot change beans directly' USING ERRCODE = '42501';
  END IF;
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'You cannot change your role' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'You cannot change your account status' USING ERRCODE = '42501';
  END IF;
  IF NEW.is_banned IS DISTINCT FROM OLD.is_banned THEN
    RAISE EXCEPTION 'You cannot change ban status' USING ERRCODE = '42501';
  END IF;
  IF NEW.display_id IS DISTINCT FROM OLD.display_id THEN
    RAISE EXCEPTION 'You cannot change your display ID' USING ERRCODE = '42501';
  END IF;
  IF NEW.agency_id IS DISTINCT FROM OLD.agency_id THEN
    RAISE EXCEPTION 'Use an approved agency RPC to change agency' USING ERRCODE = '42501';
  END IF;
  IF NEW.vip_type IS DISTINCT FROM OLD.vip_type THEN
    RAISE EXCEPTION 'You cannot change VIP type' USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'You cannot change your id' USING ERRCODE = '42501';
  END IF;
  IF NEW.phone_number IS DISTINCT FROM OLD.phone_number THEN
    RAISE EXCEPTION 'You cannot change your phone number directly' USING ERRCODE = '42501';
  END IF;
  IF NOT trusted_level_update AND NEW.level IS DISTINCT FROM OLD.level THEN
    RAISE EXCEPTION 'Your level is calculated from sent gifts' USING ERRCODE = '42501';
  END IF;
  IF NOT trusted_level_update
     AND NEW.lifetime_diamonds_spent IS DISTINCT FROM OLD.lifetime_diamonds_spent THEN
    RAISE EXCEPTION 'Gift progress cannot be changed directly' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS profiles_protect_columns ON public.profiles;
CREATE TRIGGER profiles_protect_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_columns();

