-- =====================================================================
-- 97_fix_cascade_trigger_perms.sql — the REAL real fix
-- =====================================================================
-- After migrations 93..96 we proved every FK is healthy AND
-- supabase_auth_admin has DELETE on every public table. The "permission
-- denied for table moments_posts" log line STILL showed up.
--
-- Discovered via MCP function-source inspection: there are TWO triggers
-- on `moments_comments` doing the same job, and ditto on `moments_likes`:
--
--   ✓ moments_comments_sync (SECURITY DEFINER — runs as owner)
--   ✗ bump_moments_comments  (no SECURITY DEFINER — runs as caller)
--
-- During a user-delete cascade, `auth.users` -> profiles -> moments_*
-- fires CASCADE DELETE on moments_comments and moments_likes. Both
-- triggers then fire. The SECURITY DEFINER one updates moments_posts
-- cleanly. The other one runs AS supabase_auth_admin and tries
-- UPDATE public.moments_posts SET comments_count = ... — and dies with
-- "permission denied for table moments_posts" because mig 96 only
-- granted SELECT/DELETE, not UPDATE. The whole cascade rolls back.
--
-- Fix:
--   1. Drop the duplicate, non-SECURITY-DEFINER triggers. The
--      SECURITY DEFINER sync triggers already maintain the counts.
--   2. Belt-and-braces: grant UPDATE on all public tables to
--      supabase_auth_admin so any other dormant trigger doing the
--      same thing won't bite us next.
-- =====================================================================

-- Step 1: drop the duplicate non-SECURITY-DEFINER triggers.
DROP TRIGGER IF EXISTS trg_moments_comments ON public.moments_comments;
DROP TRIGGER IF EXISTS trg_moments_likes    ON public.moments_likes;

-- Step 2: optional defensive UPDATE grant for supabase_auth_admin. Any
-- future cascade-triggered function that updates an unrelated public
-- table won't block user-delete this way.
GRANT UPDATE ON ALL TABLES IN SCHEMA public TO supabase_auth_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT UPDATE ON TABLES TO supabase_auth_admin;

-- Verify both fixes are in place.
DO $$
DECLARE
  v_trg_count int;
  v_grant_count int;
BEGIN
  SELECT count(*) INTO v_trg_count
    FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
   WHERE NOT t.tgisinternal
     AND n.nspname = 'public'
     AND t.tgname IN ('trg_moments_comments', 'trg_moments_likes');

  SELECT count(*) INTO v_grant_count
    FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND has_table_privilege('supabase_auth_admin', c.oid, 'UPDATE');

  RAISE NOTICE '97: duplicate triggers remaining (should be 0): %', v_trg_count;
  RAISE NOTICE '97: tables where supabase_auth_admin has UPDATE: %', v_grant_count;
END $$;
