-- =====================================================================
-- FIX: profiles.role must be TEXT (not user_role enum)
-- Error seen: "invalid input value for enum user_role: 'reseller'"
-- Reason: column was still a PostgreSQL ENUM that didn't include
-- 'reseller', 'agency_owner', etc. Previous migration's EXCEPTION
-- block silently swallowed the failure.
--
-- This file fails LOUDLY if anything goes wrong, so you can see it.
-- Run in Supabase SQL Editor.
-- =====================================================================

-- 1. Drop CHECK constraint if any (we'll re-add at the end)
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;

-- 2. Drop the column default (a DEFAULT typed as user_role blocks ALTER TYPE)
ALTER TABLE public.profiles ALTER COLUMN role DROP DEFAULT;

-- 3. Convert column to TEXT (preserves existing values as strings)
ALTER TABLE public.profiles
  ALTER COLUMN role TYPE TEXT USING role::TEXT;

-- 4. Restore default
ALTER TABLE public.profiles ALTER COLUMN role SET DEFAULT 'user';

-- 5. Re-add CHECK constraint with the full role list
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('user', 'host', 'reseller', 'agency_owner', 'admin', 'super_admin'));

-- 6. Sanity check: print the current type of profiles.role
DO $$
DECLARE
  v_type TEXT;
BEGIN
  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'role';
  RAISE NOTICE 'profiles.role is now: %', v_type;
  IF v_type <> 'text' THEN
    RAISE EXCEPTION 'profiles.role is still %, expected text', v_type;
  END IF;
END $$;

-- 7. Optional: drop the now-unused enum type if nothing else uses it
DO $$ BEGIN
  DROP TYPE IF EXISTS public.user_role;
  RAISE NOTICE 'Dropped user_role enum type.';
EXCEPTION WHEN dependent_objects_still_exist THEN
  RAISE NOTICE 'user_role enum still used elsewhere — leaving it.';
END $$;

-- =====================================================================
-- DONE. Now retry the approve-reseller action from the admin panel.
-- =====================================================================