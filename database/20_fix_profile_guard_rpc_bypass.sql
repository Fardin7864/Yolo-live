-- =====================================================================
-- FIX: profiles column-guard trigger was blocking trusted server-side RPCs
--
-- Migration 13 added `protect_profile_columns` to stop the mobile client
-- from editing diamonds/beans/role/etc. directly. But the trigger only
-- bypassed for is_admin(auth.uid()) — it did NOT exempt the trusted
-- SECURITY DEFINER RPCs that legitimately move currency:
--   send_gift, convert_beans_to_diamonds, the game payout functions,
--   topup approval, agency settlement, etc.
--
-- Result: a normal user sending a gift hit
--   42501 "You cannot change diamonds directly"
-- because send_gift's `UPDATE profiles SET diamonds = ...` fired the trigger
-- and the caller (the gifting user) is not an admin.
--
-- Fix: a direct UPDATE from the app runs under role `authenticated` (or
-- `anon`). A SECURITY DEFINER RPC runs under its owner (`postgres` /
-- `supabase_admin`), and `service_role` is the backend key. So: only
-- enforce the column lock when current_user is a client role; trust
-- everything else. The trigger function must be SECURITY INVOKER for
-- current_user to reflect the real caller (a SECURITY DEFINER trigger
-- would always report its own owner).
--
-- Idempotent. Run in Supabase SQL Editor.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.protect_profile_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER          -- IMPORTANT: invoker, so current_user = real caller
SET search_path = public
AS $$
BEGIN
  -- Trusted server-side paths bypass: SECURITY DEFINER RPCs run as the
  -- function owner (postgres / supabase_admin) and the backend uses
  -- service_role. Only direct client updates arrive as authenticated/anon.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- Admins editing their own row directly still bypass.
  IF public.is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  -- A direct client self-update may only touch safe columns
  -- (full_name, avatar_url, bio, gender). Everything below stays locked.
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

-- Trigger definition itself is unchanged; recreate to be safe / idempotent.
DROP TRIGGER IF EXISTS profiles_protect_columns ON public.profiles;
CREATE TRIGGER profiles_protect_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_columns();

-- =====================================================================
-- DONE. After running this:
--   - send_gift / game / topup / agency RPCs can move diamonds & beans again
--   - direct client edits to diamonds/beans/role/etc. are still rejected (42501)
--   - safe self-edits (full_name, avatar_url, bio, gender) still work
-- =====================================================================