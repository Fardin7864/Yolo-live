-- =====================================================================
-- 95_force_fix_user_delete_all_schemas.sql
-- =====================================================================
-- Migrations 93 + 94 only scanned the `public` schema. The user reports
-- that some user deletes now succeed but others still fail with the
-- same "Database error deleting user" message — typical signature of a
-- storage.objects.owner foreign key blocking the delete whenever the
-- user has uploaded any file (avatar, gift asset, audio template, etc.)
-- that lives in Supabase Storage.
--
-- This migration scans EVERY schema (public, storage, auth helpers,
-- anything else) for FK constraints that ultimately reference either
-- public.profiles(id) OR auth.users(id), and rewrites them to
-- ON DELETE SET NULL (or CASCADE if SET NULL is impossible).
--
-- Special case: storage.objects.owner is a Supabase-managed column.
-- It defaults to NO ACTION on some projects, which is what blocks the
-- delete. We handle it explicitly with CASCADE (deleting the user
-- removes their uploaded files) — files preserved would be orphaned
-- anyway, so CASCADE is the cleaner semantic.
--
-- Re-runnable. Emits RAISE NOTICE for every constraint touched so the
-- Supabase SQL Editor output shows exactly what changed.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Step 1: Fix storage.objects.owner explicitly.
--
-- The constraint name varies by Supabase version. We look it up by
-- table+column and rewrite to CASCADE so a user delete also cleans
-- up their uploads. If the column doesn't exist (very old Supabase)
-- the lookup returns nothing and the block is a no-op.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_constraint text;
BEGIN
  SELECT tc.constraint_name INTO v_constraint
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.constraint_schema = kcu.constraint_schema
   WHERE tc.constraint_type = 'FOREIGN KEY'
     AND tc.table_schema = 'storage'
     AND tc.table_name   = 'objects'
     AND kcu.column_name = 'owner'
   LIMIT 1;

  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE storage.objects DROP CONSTRAINT %I', v_constraint);
    EXECUTE format(
      'ALTER TABLE storage.objects ADD CONSTRAINT %I FOREIGN KEY (owner) REFERENCES auth.users(id) ON DELETE CASCADE',
      v_constraint
    );
    RAISE NOTICE 'FIXED storage.objects.owner constraint % -> CASCADE', v_constraint;
  ELSE
    RAISE NOTICE 'SKIP storage.objects.owner — no FK constraint found';
  END IF;
END
$$;


-- ---------------------------------------------------------------------
-- Step 2: Universal sweep — every schema, every FK to profiles(id)
-- or auth.users(id). Convert to SET NULL where possible, CASCADE
-- otherwise.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_row record;
  v_is_nullable text;
  v_count_set_null int := 0;
  v_count_cascade  int := 0;
  v_count_skip     int := 0;
BEGIN
  FOR v_row IN
    SELECT
      tc.constraint_name,
      tc.constraint_schema,
      tc.table_schema,
      tc.table_name,
      kcu.column_name,
      rc.delete_rule,
      ccu.table_schema AS ref_schema,
      ccu.table_name   AS ref_table,
      ccu.column_name  AS ref_column
    FROM information_schema.referential_constraints rc
    JOIN information_schema.table_constraints tc
      ON rc.constraint_name   = tc.constraint_name
     AND rc.constraint_schema = tc.constraint_schema
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name   = kcu.constraint_name
     AND tc.constraint_schema = kcu.constraint_schema
    JOIN information_schema.constraint_column_usage ccu
      ON rc.unique_constraint_name   = ccu.constraint_name
     AND rc.unique_constraint_schema = ccu.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      -- Match any FK pointing at profiles.id OR auth.users.id
      AND (
        (ccu.table_schema = 'public' AND ccu.table_name = 'profiles' AND ccu.column_name = 'id')
        OR
        (ccu.table_schema = 'auth'   AND ccu.table_name = 'users'    AND ccu.column_name = 'id')
      )
      -- Don't touch the profiles -> auth.users link itself (already CASCADE)
      AND NOT (tc.table_schema = 'public' AND tc.table_name = 'profiles')
      -- Skip Supabase's own internal auth metadata tables — they manage
      -- their own cascade rules.
      AND tc.table_schema NOT IN ('auth')
  LOOP
    -- Already healthy? Skip.
    IF v_row.delete_rule IN ('SET NULL', 'CASCADE') THEN
      v_count_skip := v_count_skip + 1;
      RAISE NOTICE 'SKIP  %.%.% (%) — already %',
        v_row.table_schema, v_row.table_name, v_row.column_name,
        v_row.constraint_name, v_row.delete_rule;
      CONTINUE;
    END IF;

    -- Check nullability so we know whether SET NULL is legal.
    SELECT is_nullable INTO v_is_nullable
      FROM information_schema.columns
     WHERE table_schema = v_row.table_schema
       AND table_name   = v_row.table_name
       AND column_name  = v_row.column_name;

    IF v_is_nullable = 'NO' THEN
      -- For storage and any other system-managed schema, CASCADE
      -- is the safer rewrite (we don't want to flip NOT NULL on a
      -- column whose semantics we don't fully own). For public,
      -- drop NOT NULL and SET NULL to preserve audit history.
      IF v_row.table_schema = 'public' THEN
        EXECUTE format(
          'ALTER TABLE %I.%I ALTER COLUMN %I DROP NOT NULL',
          v_row.table_schema, v_row.table_name, v_row.column_name
        );
        EXECUTE format(
          'ALTER TABLE %I.%I DROP CONSTRAINT %I',
          v_row.table_schema, v_row.table_name, v_row.constraint_name
        );
        EXECUTE format(
          'ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I.%I(%I) ON DELETE SET NULL',
          v_row.table_schema, v_row.table_name, v_row.constraint_name,
          v_row.column_name,
          v_row.ref_schema, v_row.ref_table, v_row.ref_column
        );
        v_count_set_null := v_count_set_null + 1;
        RAISE NOTICE 'FIXED (NULLIFIED+SET NULL)  %.%.% (%) — was %',
          v_row.table_schema, v_row.table_name, v_row.column_name,
          v_row.constraint_name, v_row.delete_rule;
      ELSE
        EXECUTE format(
          'ALTER TABLE %I.%I DROP CONSTRAINT %I',
          v_row.table_schema, v_row.table_name, v_row.constraint_name
        );
        EXECUTE format(
          'ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I.%I(%I) ON DELETE CASCADE',
          v_row.table_schema, v_row.table_name, v_row.constraint_name,
          v_row.column_name,
          v_row.ref_schema, v_row.ref_table, v_row.ref_column
        );
        v_count_cascade := v_count_cascade + 1;
        RAISE NOTICE 'FIXED (CASCADE)  %.%.% (%) — was %',
          v_row.table_schema, v_row.table_name, v_row.column_name,
          v_row.constraint_name, v_row.delete_rule;
      END IF;
    ELSE
      EXECUTE format(
        'ALTER TABLE %I.%I DROP CONSTRAINT %I',
        v_row.table_schema, v_row.table_name, v_row.constraint_name
      );
      EXECUTE format(
        'ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I.%I(%I) ON DELETE SET NULL',
        v_row.table_schema, v_row.table_name, v_row.constraint_name,
        v_row.column_name,
        v_row.ref_schema, v_row.ref_table, v_row.ref_column
      );
      v_count_set_null := v_count_set_null + 1;
      RAISE NOTICE 'FIXED (SET NULL)  %.%.% (%) — was %',
        v_row.table_schema, v_row.table_name, v_row.column_name,
        v_row.constraint_name, v_row.delete_rule;
    END IF;
  END LOOP;

  RAISE NOTICE '====================================================';
  RAISE NOTICE '95: % SET NULL, % CASCADE, % already healthy',
    v_count_set_null, v_count_cascade, v_count_skip;
  RAISE NOTICE '====================================================';
END
$$;


-- =====================================================================
-- Diagnostic queries — uncomment and run if user-delete STILL fails.
-- =====================================================================

-- 1. Remaining un-cascaded FKs across ALL schemas pointing at profiles
--    or auth.users. After running 95 this must return ZERO rows for
--    user-delete to work without further intervention.
--
-- SELECT
--   tc.table_schema, tc.table_name, kcu.column_name,
--   rc.delete_rule, tc.constraint_name,
--   ccu.table_schema AS ref_schema, ccu.table_name AS ref_table
--   FROM information_schema.referential_constraints rc
--   JOIN information_schema.table_constraints tc
--     ON rc.constraint_name = tc.constraint_name
--    AND rc.constraint_schema = tc.constraint_schema
--   JOIN information_schema.key_column_usage kcu
--     ON tc.constraint_name = kcu.constraint_name
--    AND tc.constraint_schema = kcu.constraint_schema
--   JOIN information_schema.constraint_column_usage ccu
--     ON rc.unique_constraint_name   = ccu.constraint_name
--    AND rc.unique_constraint_schema = ccu.constraint_schema
--  WHERE tc.constraint_type = 'FOREIGN KEY'
--    AND rc.delete_rule NOT IN ('SET NULL', 'CASCADE')
--    AND tc.table_schema NOT IN ('auth')
--    AND (
--      (ccu.table_schema = 'public' AND ccu.table_name = 'profiles' AND ccu.column_name = 'id')
--      OR
--      (ccu.table_schema = 'auth'   AND ccu.table_name = 'users'    AND ccu.column_name = 'id')
--    )
--    AND NOT (tc.table_schema = 'public' AND tc.table_name = 'profiles');

-- 2. Surface the EXACT blocker for a specific failing user.
--    Replace <USER_UUID> with the actual user id from the failing
--    Supabase Auth dashboard call.
--
-- BEGIN;
-- DELETE FROM auth.users WHERE id = '<USER_UUID>';
-- ROLLBACK;
--
-- The error message will name the exact constraint that's blocking,
-- which the Auth dashboard hides behind its generic message.

-- 3. List ALL triggers on profiles and on auth.users — if mig 95
--    succeeds but delete still fails, a trigger may be throwing.
--
-- SELECT trigger_name, event_object_schema, event_object_table,
--        event_manipulation, action_timing
--   FROM information_schema.triggers
--  WHERE (event_object_schema = 'public' AND event_object_table = 'profiles')
--     OR (event_object_schema = 'auth'   AND event_object_table = 'users');
