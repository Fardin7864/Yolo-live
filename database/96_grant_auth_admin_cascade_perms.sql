-- =====================================================================
-- 96_grant_auth_admin_cascade_perms.sql — the actual user-delete fix
-- =====================================================================
-- Migrations 93/94/95 chased a phantom: every public-schema FK to
-- profiles/auth.users was already SET NULL or CASCADE. The real
-- blocker — surfaced via MCP-backed log inspection — was a table-
-- privilege gap, not a constraint problem:
--
--   ERROR: permission denied for table moments_posts
--
-- Supabase Auth deletes a user with the `supabase_auth_admin` role.
-- When `DELETE FROM auth.users` cascades into public.* tables, the
-- cascade DELETEs run as that same role. The default Supabase ACL on
-- public tables grants r/w/d to postgres, anon, authenticated, and
-- service_role — but NOT to supabase_auth_admin. So the cascade hits
-- the first public.* table in the dependency graph (moments_posts in
-- this project) and aborts with a generic "Database error deleting
-- user" message in the Auth dashboard.
--
-- Fix: grant DELETE + SELECT + REFERENCES on every public table to
-- supabase_auth_admin so the cascade can sweep through, plus set the
-- same as the default for any tables added later.
--
-- Why not GRANT ALL? Auth-admin only needs to read row identities and
-- delete them during cascade. Insert / update on app tables would be
-- a foot-gun (auth admin should not be silently mutating game state).
-- =====================================================================

-- Existing tables — one-time grant.
GRANT SELECT, DELETE, REFERENCES ON ALL TABLES IN SCHEMA public TO supabase_auth_admin;

-- Sequences too — some cascade paths re-read identity columns.
GRANT SELECT, USAGE ON ALL SEQUENCES IN SCHEMA public TO supabase_auth_admin;

-- Future tables — defaults so a new table added next month doesn't
-- silently break user-delete again.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, DELETE, REFERENCES ON TABLES TO supabase_auth_admin;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, USAGE ON SEQUENCES TO supabase_auth_admin;

-- Sanity: emit a notice with the count of tables that now have the
-- right grants. After running, the SQL editor output will confirm
-- the privilege is in place.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND has_table_privilege('supabase_auth_admin', c.oid, 'DELETE');
  RAISE NOTICE 'supabase_auth_admin now has DELETE on % public tables', v_count;
END $$;
