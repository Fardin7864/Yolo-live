-- =====================================================================
-- 41_user_reports_moderation.sql
-- =====================================================================
-- Adds admin-side moderation for user_reports — the table exists and
-- accepts inserts from the live-room "Report" flow, but there was no
-- UPDATE policy and no resolve RPC, so admins couldn't actually do
-- anything with the queue from the panel.
--
-- This migration:
--   1. UPDATE policy for admins (no-op for users + reporters).
--   2. resolve_user_report(id, action, notes) — single entry point that
--      sets status, audits, and optionally bans the reported user in
--      one transaction. action ∈ {'dismiss','review','action_taken'}.
--   3. Realtime publication so the admin panel shows new reports
--      instantly without polling.
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. UPDATE policy for admins
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS reports_admin_update ON public.user_reports;
CREATE POLICY reports_admin_update ON public.user_reports
  FOR UPDATE
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------
-- 2. Resolve RPC — one entry-point for the moderation actions the
--    admin panel exposes.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_user_report(
  p_report_id UUID,
  p_action    TEXT,           -- 'dismiss' | 'review' | 'action_taken'
  p_notes     TEXT DEFAULT NULL,
  p_ban_user  BOOLEAN DEFAULT FALSE
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me              uuid := auth.uid();
  v_reported_id   uuid;
  v_new_status    text;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF NOT public.is_admin(me) THEN
    RETURN json_build_object('success', false, 'message', 'Admin only');
  END IF;

  v_new_status := CASE p_action
                    WHEN 'dismiss'       THEN 'dismissed'
                    WHEN 'review'        THEN 'reviewed'
                    WHEN 'action_taken'  THEN 'action_taken'
                    ELSE NULL
                  END;
  IF v_new_status IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Invalid action');
  END IF;

  SELECT reported_user_id INTO v_reported_id
    FROM public.user_reports
    WHERE id = p_report_id
    FOR UPDATE;

  IF v_reported_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Report not found');
  END IF;

  UPDATE public.user_reports
     SET status      = v_new_status,
         reviewed_by = me,
         reviewed_at = NOW(),
         note        = CASE WHEN p_notes IS NULL OR length(trim(p_notes)) = 0
                            THEN note
                            ELSE COALESCE(note || E'\n--- admin --- ', '') || p_notes
                       END
   WHERE id = p_report_id;

  -- Optional: ban the reported user as part of the same action.
  IF p_ban_user THEN
    UPDATE public.profiles SET is_banned = TRUE WHERE id = v_reported_id;
  END IF;

  INSERT INTO public.admin_audit_log
    (admin_id, action, target_type, target_id, payload)
  VALUES (
    me,
    'resolve_user_report',
    'user_report',
    p_report_id,
    jsonb_build_object(
      'new_status',  v_new_status,
      'banned_user', p_ban_user,
      'reported_id', v_reported_id
    )
  );

  RETURN json_build_object('success', true, 'new_status', v_new_status);
END $$;

GRANT EXECUTE ON FUNCTION public.resolve_user_report(UUID, TEXT, TEXT, BOOLEAN) TO authenticated;

-- ---------------------------------------------------------------------
-- 3. Realtime publication
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='user_reports'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_reports;
  END IF;
END $$;