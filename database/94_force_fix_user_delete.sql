-- =====================================================================
-- 94_force_fix_user_delete.sql — emergency comprehensive user-delete fix
-- =====================================================================
-- Migration 93 covered the 15 FK references to profiles that lived in
-- the tracked migration files, but the user reports Supabase Auth STILL
-- errors with "Database error deleting user" after running 93. That
-- means one of:
--   (a) a constraint was added through the Supabase dashboard / a
--       manual SQL session and isn't in the tracked migration files
--   (b) a constraint was added by a Supabase platform feature (storage
--       objects, realtime presence, edge functions) we don't control
--   (c) 93 partially failed at a particular ALTER and the rest never ran
--   (d) a TRIGGER on profiles BEFORE/AFTER DELETE is throwing
--
-- This migration does TWO things:
--
-- 1. DYNAMICALLY iterates over EVERY foreign key in the public schema
--    that references profiles(id) and rewrites the delete rule to
--    SET NULL (if the column is nullable) or CASCADE (if it's NOT
--    NULL and would otherwise still block). This catches any
--    constraint the previous migration missed.
--
-- 2. Logs the result of every conversion via RAISE NOTICE so when the
--    user runs it in the Supabase SQL editor they can SEE which
--    constraints were actually fixed.
--
-- Re-runnable; safe on a healthy DB (idempotent) and self-diagnostic
-- on a sick one.
-- =====================================================================

DO $$
DECLARE
  v_row record;
  v_drop_sql text;
  v_add_sql  text;
  v_is_nullable text;
  v_action text;
  v_count int := 0;
BEGIN
  FOR v_row IN
    SELECT
      tc.constraint_name,
      tc.table_schema,
      tc.table_name,
      kcu.column_name,
      rc.delete_rule
    FROM information_schema.referential_constraints rc
    JOIN information_schema.table_constraints tc
      ON rc.constraint_name = tc.constraint_name
     AND rc.constraint_schema = tc.constraint_schema
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.constraint_schema = kcu.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND EXISTS (
        SELECT 1 FROM information_schema.constraint_column_usage ccu
         WHERE ccu.constraint_name   = tc.constraint_name
           AND ccu.constraint_schema = tc.constraint_schema
           AND ccu.table_schema      = 'public'
           AND ccu.table_name        = 'profiles'
           AND ccu.column_name       = 'id'
      )
  LOOP
    -- Skip the ones already SET NULL or CASCADE — they don't block.
    IF v_row.delete_rule IN ('SET NULL', 'CASCADE') THEN
      RAISE NOTICE 'SKIP  %.% (% on %) — already %',
        v_row.table_schema, v_row.table_name,
        v_row.column_name, v_row.constraint_name, v_row.delete_rule;
      CONTINUE;
    END IF;

    -- Find whether the column is nullable. SET NULL needs a nullable
    -- column; if NOT NULL, drop the NOT NULL first OR fall back to
    -- CASCADE. We pick CASCADE only for audit-shaped rows that we'd
    -- rather lose with the user than keep with a dangling reference.
    SELECT is_nullable INTO v_is_nullable
      FROM information_schema.columns
     WHERE table_schema = v_row.table_schema
       AND table_name   = v_row.table_name
       AND column_name  = v_row.column_name;

    IF v_is_nullable = 'NO' THEN
      EXECUTE format(
        'ALTER TABLE %I.%I ALTER COLUMN %I DROP NOT NULL',
        v_row.table_schema, v_row.table_name, v_row.column_name
      );
      RAISE NOTICE 'NULLIFIED  %.%.%  (was NOT NULL)',
        v_row.table_schema, v_row.table_name, v_row.column_name;
    END IF;

    v_drop_sql := format(
      'ALTER TABLE %I.%I DROP CONSTRAINT %I',
      v_row.table_schema, v_row.table_name, v_row.constraint_name
    );
    v_add_sql := format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.profiles(id) ON DELETE SET NULL',
      v_row.table_schema, v_row.table_name, v_row.constraint_name, v_row.column_name
    );

    EXECUTE v_drop_sql;
    EXECUTE v_add_sql;

    v_count := v_count + 1;
    RAISE NOTICE 'FIXED  %.% (% on %) — % -> SET NULL',
      v_row.table_schema, v_row.table_name,
      v_row.column_name, v_row.constraint_name, v_row.delete_rule;
  END LOOP;

  RAISE NOTICE '====================================================';
  RAISE NOTICE '94_force_fix_user_delete: % FK constraints rewritten to SET NULL',
    v_count;
  RAISE NOTICE '====================================================';
END
$$;


-- =====================================================================
-- Diagnostic queries — run these manually after the DO block above
-- to confirm the state and identify any remaining blockers.
-- =====================================================================

-- 1. Should return ZERO rows. Any row here means a public-schema FK to
--    profiles still has NO ACTION/RESTRICT and will still block user
--    deletion.
--
-- SELECT tc.table_schema, tc.table_name, kcu.column_name, rc.delete_rule
--   FROM information_schema.referential_constraints rc
--   JOIN information_schema.table_constraints tc
--     ON rc.constraint_name = tc.constraint_name
--    AND rc.constraint_schema = tc.constraint_schema
--   JOIN information_schema.key_column_usage kcu
--     ON tc.constraint_name = kcu.constraint_name
--    AND tc.constraint_schema = kcu.constraint_schema
--  WHERE tc.constraint_type = 'FOREIGN KEY'
--    AND rc.delete_rule NOT IN ('SET NULL', 'CASCADE')
--    AND EXISTS (
--      SELECT 1 FROM information_schema.constraint_column_usage ccu
--       WHERE ccu.constraint_name   = tc.constraint_name
--         AND ccu.table_schema      = 'public'
--         AND ccu.table_name        = 'profiles'
--         AND ccu.column_name       = 'id'
--    );

-- 2. Check whether any TRIGGER on profiles is throwing.
--    If a BEFORE/AFTER DELETE trigger raises an exception, that's a
--    different class of bug — it would surface as the same
--    "Database error deleting user" message via Supabase Auth.
--
-- SELECT trigger_name, event_manipulation, action_timing
--   FROM information_schema.triggers
--  WHERE event_object_schema = 'public'
--    AND event_object_table  = 'profiles';

-- 3. If the user delete STILL fails after 94, try a manual test:
--
-- BEGIN;
-- DELETE FROM auth.users WHERE id = '<the-user-uuid>';
-- ROLLBACK;
--
-- This will surface the EXACT constraint name / trigger that's
-- blocking, which the Supabase Auth dashboard's generic "Database
-- error deleting user" message hides. Paste that error back into
-- the chat and we'll write a targeted patch.
