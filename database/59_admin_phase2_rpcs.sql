-- =====================================================================
-- 59_admin_phase2_rpcs.sql
-- =====================================================================
-- Phase 2 admin tooling — three orphan controls finally get a way for
-- super_admin to act on them:
--
--   1. error_logs triage. Adds reviewed_by + reviewed_at columns so
--      the admin /error-logs page can mark crashes as "looked at" and
--      filter the queue down. Plus mark_error_log_reviewed() RPC.
--
--   2. admin_restore_account(p_user_id). Reverses a soft-deleted
--      profile (is_deleted/is_banned=true) back to active. PII that
--      delete_my_account already anonymised stays anonymised — the
--      user has to fill their name/avatar/phone in again when they
--      log back in — but the account is no longer locked and the
--      historical data (transactions, gifts, levels) is intact.
--
--   3. admin_set_user_notification_prefs(p_user_id, p_push, p_dm).
--      Support-team override so an admin can flip a stuck user's
--      preference without asking them to do it. Audit-logged.
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. error_logs triage columns
-- ---------------------------------------------------------------------
ALTER TABLE public.error_logs
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_note TEXT;

CREATE INDEX IF NOT EXISTS idx_error_logs_unreviewed
  ON public.error_logs (created_at DESC)
  WHERE reviewed_at IS NULL;

-- Admins write triage state through the RPC so we have a single
-- audit-shaped path; the table is otherwise still write-locked at the
-- RLS level.
DROP POLICY IF EXISTS error_logs_admin_update ON public.error_logs;
CREATE POLICY error_logs_admin_update ON public.error_logs
  FOR UPDATE
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

CREATE OR REPLACE FUNCTION public.mark_error_log_reviewed(
  p_log_id UUID,
  p_note   TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF NOT public.is_admin(me) THEN
    RETURN json_build_object('success', false, 'message', 'Admin only');
  END IF;
  UPDATE public.error_logs
     SET reviewed_by = me,
         reviewed_at = NOW(),
         review_note = COALESCE(p_note, review_note)
   WHERE id = p_log_id;
  RETURN json_build_object('success', true);
END $$;

GRANT EXECUTE ON FUNCTION public.mark_error_log_reviewed(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------
-- 2. admin_restore_account
--
-- Lifts the soft-delete + ban set by delete_my_account so the user can
-- log back in. We DO NOT re-create the PII (full_name, phone, avatar)
-- — that's irrecoverable. The user will see "Deleted User" until they
-- re-fill their own profile.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_restore_account(
  p_user_id UUID,
  p_reason  TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF NOT public.is_admin(me) THEN
    RETURN json_build_object('success', false, 'message', 'Admin only');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id AND is_deleted = TRUE) THEN
    RETURN json_build_object('success', false, 'message', 'Account is not in a deleted state');
  END IF;

  UPDATE public.profiles
     SET is_deleted = FALSE,
         is_banned  = FALSE,
         deleted_at = NULL,
         push_notifications_enabled = TRUE,
         dm_notifications_enabled   = TRUE
   WHERE id = p_user_id;

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (me, 'admin_restore_account', 'profile', p_user_id,
          jsonb_build_object('reason', p_reason));

  RETURN json_build_object('success', true);
END $$;

GRANT EXECUTE ON FUNCTION public.admin_restore_account(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------
-- 3. admin_set_user_notification_prefs
--
-- Override for support. p_push / p_dm can each be NULL to leave the
-- existing value alone, so the admin can flip just one toggle.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_user_notification_prefs(
  p_user_id UUID,
  p_push    BOOLEAN DEFAULT NULL,
  p_dm      BOOLEAN DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF NOT public.is_admin(me) THEN
    RETURN json_build_object('success', false, 'message', 'Admin only');
  END IF;
  IF p_push IS NULL AND p_dm IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Nothing to change');
  END IF;

  UPDATE public.profiles
     SET push_notifications_enabled = COALESCE(p_push, push_notifications_enabled),
         dm_notifications_enabled   = COALESCE(p_dm,   dm_notifications_enabled)
   WHERE id = p_user_id;

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (me, 'admin_set_notif_prefs', 'profile', p_user_id,
          jsonb_build_object('push', p_push, 'dm', p_dm));

  RETURN json_build_object('success', true);
END $$;

GRANT EXECUTE ON FUNCTION public.admin_set_user_notification_prefs(uuid, boolean, boolean) TO authenticated;
