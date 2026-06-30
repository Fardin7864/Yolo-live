-- =====================================================================
-- 46_admin_end_live.sql
-- =====================================================================
-- Admin-side moderation entry-points for active live rooms:
--
--   * admin_end_live_stream(stream_id, reason)
--       Forces a stream to end without needing the host's cooperation.
--       Marks the row 'ended', stamps ended_at, optionally writes a
--       moderation reason. Audited.
--
-- Idempotent: re-runnable.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.admin_end_live_stream(
  p_stream_id UUID,
  p_reason    TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me        uuid := auth.uid();
  v_host_id uuid;
  v_status  text;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF NOT public.is_admin(me) THEN
    RETURN json_build_object('success', false, 'message', 'Admin only');
  END IF;

  SELECT host_id, status INTO v_host_id, v_status
    FROM public.live_streams
    WHERE id = p_stream_id
    FOR UPDATE;

  IF v_host_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Stream not found');
  END IF;
  IF v_status = 'ended' THEN
    RETURN json_build_object('success', true, 'message', 'Already ended');
  END IF;

  UPDATE public.live_streams
     SET status   = 'ended',
         ended_at = NOW()
   WHERE id = p_stream_id;

  INSERT INTO public.admin_audit_log
    (admin_id, action, target_type, target_id, payload)
  VALUES (
    me, 'admin_end_live_stream', 'live_stream', p_stream_id,
    jsonb_build_object('host_id', v_host_id, 'reason', p_reason)
  );

  RETURN json_build_object('success', true);
END $$;

GRANT EXECUTE ON FUNCTION public.admin_end_live_stream(UUID, TEXT) TO authenticated;