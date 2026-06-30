-- =====================================================================
-- 22_user_reports.sql — User reports submission RPC
-- =====================================================================
-- The `user_reports` TABLE already exists in the base schema (see
-- yolo_schema.sql section 2.18) with this shape:
--   id, reporter_id, reported_user_id, room_id, reason, evidence_url,
--   status ('pending'|'reviewed'|'action_taken'|'dismissed'),
--   reviewed_by, reviewed_at, created_at
--
-- This migration only adds:
--   • a `note` column (free-text detail from the reporter)
--   • the `submit_user_report` RPC used by the live-room Report flow
-- and leaves the table + indexes + RLS policies from the base schema
-- untouched.
-- =====================================================================

ALTER TABLE public.user_reports
  ADD COLUMN IF NOT EXISTS note text;

-- =====================================================================
-- RPC: submit_user_report(target, reason, note, room_host)
-- Parameter names mirror what the client calls (see app/broadcast/[id].js).
-- Internally we map them onto the existing column names.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.submit_user_report(
    target     uuid,
    reason     text,
    note       text DEFAULT NULL,
    room_host  uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
  new_id uuid;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF target IS NULL THEN
    RAISE EXCEPTION 'Target required';
  END IF;
  IF target = me THEN
    RAISE EXCEPTION 'Cannot report yourself';
  END IF;
  IF reason IS NULL OR length(reason) = 0 THEN
    RAISE EXCEPTION 'Reason required';
  END IF;

  -- One pending report per (reporter, target) at a time to avoid spam.
  IF EXISTS (
    SELECT 1 FROM public.user_reports
      WHERE reporter_id = me AND reported_user_id = target AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'You already have a pending report against this user';
  END IF;

  INSERT INTO public.user_reports (reporter_id, reported_user_id, room_id, reason, note)
    VALUES (me, target, room_host, reason, note)
    RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_user_report(uuid, text, text, uuid) TO authenticated;
