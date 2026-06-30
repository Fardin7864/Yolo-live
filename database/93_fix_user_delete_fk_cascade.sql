-- =====================================================================
-- 93_fix_user_delete_fk_cascade.sql
-- =====================================================================
-- Fixes the Supabase Auth "Failed to delete user: Database error
-- deleting user" message that appears when a super admin tries to
-- delete a user from the Authentication dashboard.
--
-- Root cause: `auth.users → profiles` already cascades, but several
-- tables hold FK references to `profiles.id` without an ON DELETE
-- clause. The PostgreSQL default (`NO ACTION`) blocks the parent
-- delete whenever a child row exists. Concretely: a user who has
-- ever reviewed a report, confirmed a top-up, paid out an agency,
-- been the related party of a gift transaction, or logged any admin
-- action can no longer be deleted because those rows still point at
-- their profile id.
--
-- Strategy: every blocking FK is rewritten with `ON DELETE SET NULL`
-- so the historical record is preserved (action / payload / target
-- still readable) but the personal reference is cleared. For the
-- three columns that were also `NOT NULL` (admin_audit_log.admin_id,
-- agency_stock_requests.requested_by, reseller_stock_requests
-- .requested_by) we also drop the NOT NULL so SET NULL is legal.
--
-- This is a one-way migration: once SET NULL is in place, deleting a
-- user no longer cascades data; the rows simply lose their "who"
-- column. That's the correct trade-off for an audit-shaped system.
--
-- Idempotent: every constraint is dropped IF EXISTS then re-added.
-- Re-runnable safely.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helper macro pattern: DROP CONSTRAINT IF EXISTS, then ADD with
-- SET NULL. Constraint names follow Postgres's default
-- `<table>_<column>_fkey` convention; any schema where someone
-- renamed a constraint will harmlessly skip the drop (the ADD will
-- then fail loudly, which is the right behaviour — better than
-- silently leaving a blocking FK in place).
-- ---------------------------------------------------------------------

-- 1. agency_payouts.paid_by (admin/super_admin who released the payout)
ALTER TABLE public.agency_payouts DROP CONSTRAINT IF EXISTS agency_payouts_paid_by_fkey;
ALTER TABLE public.agency_payouts
  ADD CONSTRAINT agency_payouts_paid_by_fkey
  FOREIGN KEY (paid_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 2. topup_requests.confirmed_by (reseller/agency owner/admin who confirmed)
ALTER TABLE public.topup_requests DROP CONSTRAINT IF EXISTS topup_requests_confirmed_by_fkey;
ALTER TABLE public.topup_requests
  ADD CONSTRAINT topup_requests_confirmed_by_fkey
  FOREIGN KEY (confirmed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 3. transactions.related_user_id (gift recipient, transfer counterparty, etc.)
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_related_user_id_fkey;
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_related_user_id_fkey
  FOREIGN KEY (related_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 4. user_reports.reviewed_by (admin who triaged the report)
ALTER TABLE public.user_reports DROP CONSTRAINT IF EXISTS user_reports_reviewed_by_fkey;
ALTER TABLE public.user_reports
  ADD CONSTRAINT user_reports_reviewed_by_fkey
  FOREIGN KEY (reviewed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 5. admin_audit_log.admin_id (NOT NULL → must drop NOT NULL first)
ALTER TABLE public.admin_audit_log ALTER COLUMN admin_id DROP NOT NULL;
ALTER TABLE public.admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_admin_id_fkey;
ALTER TABLE public.admin_audit_log
  ADD CONSTRAINT admin_audit_log_admin_id_fkey
  FOREIGN KEY (admin_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 6. reseller_applications.reviewed_by
ALTER TABLE public.reseller_applications DROP CONSTRAINT IF EXISTS reseller_applications_reviewed_by_fkey;
ALTER TABLE public.reseller_applications
  ADD CONSTRAINT reseller_applications_reviewed_by_fkey
  FOREIGN KEY (reviewed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 7. agency_applications.reviewed_by
ALTER TABLE public.agency_applications DROP CONSTRAINT IF EXISTS agency_applications_reviewed_by_fkey;
ALTER TABLE public.agency_applications
  ADD CONSTRAINT agency_applications_reviewed_by_fkey
  FOREIGN KEY (reviewed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 8. agency_stock_requests.requested_by (NOT NULL → drop NOT NULL first)
ALTER TABLE public.agency_stock_requests ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE public.agency_stock_requests DROP CONSTRAINT IF EXISTS agency_stock_requests_requested_by_fkey;
ALTER TABLE public.agency_stock_requests
  ADD CONSTRAINT agency_stock_requests_requested_by_fkey
  FOREIGN KEY (requested_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 9. agency_stock_requests.fulfilled_by
ALTER TABLE public.agency_stock_requests DROP CONSTRAINT IF EXISTS agency_stock_requests_fulfilled_by_fkey;
ALTER TABLE public.agency_stock_requests
  ADD CONSTRAINT agency_stock_requests_fulfilled_by_fkey
  FOREIGN KEY (fulfilled_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 10. resellers.user_id (link back to the owning profile)
ALTER TABLE public.resellers DROP CONSTRAINT IF EXISTS resellers_user_id_fkey;
ALTER TABLE public.resellers
  ADD CONSTRAINT resellers_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 11. reseller_stock_requests.requested_by (NOT NULL → drop first)
ALTER TABLE public.reseller_stock_requests ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE public.reseller_stock_requests DROP CONSTRAINT IF EXISTS reseller_stock_requests_requested_by_fkey;
ALTER TABLE public.reseller_stock_requests
  ADD CONSTRAINT reseller_stock_requests_requested_by_fkey
  FOREIGN KEY (requested_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 12. reseller_stock_requests.fulfilled_by
ALTER TABLE public.reseller_stock_requests DROP CONSTRAINT IF EXISTS reseller_stock_requests_fulfilled_by_fkey;
ALTER TABLE public.reseller_stock_requests
  ADD CONSTRAINT reseller_stock_requests_fulfilled_by_fkey
  FOREIGN KEY (fulfilled_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 13. system_settings.updated_by
ALTER TABLE public.system_settings DROP CONSTRAINT IF EXISTS system_settings_updated_by_fkey;
ALTER TABLE public.system_settings
  ADD CONSTRAINT system_settings_updated_by_fkey
  FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 14. music_tracks.created_by
ALTER TABLE public.music_tracks DROP CONSTRAINT IF EXISTS music_tracks_created_by_fkey;
ALTER TABLE public.music_tracks
  ADD CONSTRAINT music_tracks_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 15. error_logs.reviewed_by (added by migration 59)
ALTER TABLE public.error_logs DROP CONSTRAINT IF EXISTS error_logs_reviewed_by_fkey;
ALTER TABLE public.error_logs
  ADD CONSTRAINT error_logs_reviewed_by_fkey
  FOREIGN KEY (reviewed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;
