-- =====================================================================
-- FIX: profiles.status must be TEXT (not user_status enum)
-- Error seen: "operator does not exist: text <> user_status"
-- when admin tries to update a user's diamonds/status via
-- admin_update_user RPC.
--
-- Same pattern as 07_fix_role_enum.sql — the original 03_force_text_columns
-- migration silently swallowed the conversion failure on this column.
-- This one fails LOUDLY if anything goes wrong. Idempotent.
-- Run in Supabase SQL Editor.
-- =====================================================================

-- 1. Drop CHECK constraint if any
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_status_check;

-- 2. Drop the column default (an enum-typed DEFAULT blocks ALTER TYPE)
ALTER TABLE public.profiles ALTER COLUMN status DROP DEFAULT;

-- 3. Convert column to TEXT (preserves existing values)
ALTER TABLE public.profiles
  ALTER COLUMN status TYPE TEXT USING status::TEXT;

-- 4. Restore default
ALTER TABLE public.profiles ALTER COLUMN status SET DEFAULT 'active';

-- 5. Re-add CHECK constraint with the full status list
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_status_check
  CHECK (status IN ('active', 'suspended', 'banned', 'inactive'));

-- 6. Sanity check
DO $$
DECLARE v_type TEXT;
BEGIN
  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='profiles' AND column_name='status';
  RAISE NOTICE 'profiles.status is now: %', v_type;
  IF v_type <> 'text' THEN
    RAISE EXCEPTION 'profiles.status is still %, expected text', v_type;
  END IF;
END $$;

-- 7. Drop the now-unused enum type if nothing else references it
DO $$ BEGIN
  DROP TYPE IF EXISTS public.user_status;
  RAISE NOTICE 'Dropped user_status enum type.';
EXCEPTION WHEN dependent_objects_still_exist THEN
  RAISE NOTICE 'user_status enum still used elsewhere — leaving it.';
END $$;

-- =====================================================================
-- DONE. Retry the admin update — the comparison will now work.
-- =====================================================================