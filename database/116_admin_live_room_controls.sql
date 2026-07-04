-- =====================================================================
-- 116_admin_live_room_controls.sql
-- =====================================================================
-- Admin dashboard controls for active live rooms.
--
-- Fixes the older admin_end_live_stream RPC to use the real
-- live_streams.broadcaster_id column, zeroes current_viewers when a live
-- is force-ended, and adds admin-owned room block/unblock entry points.
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
  me               uuid := auth.uid();
  v_broadcaster_id uuid;
  v_status         text;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF NOT public.is_admin(me) THEN
    RETURN json_build_object('success', false, 'message', 'Admin only');
  END IF;

  SELECT broadcaster_id, status
    INTO v_broadcaster_id, v_status
    FROM public.live_streams
   WHERE id = p_stream_id
   FOR UPDATE;

  IF v_broadcaster_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Stream not found');
  END IF;
  IF v_status <> 'live' THEN
    RETURN json_build_object('success', true, 'message', 'Already ended');
  END IF;

  UPDATE public.live_streams
     SET status          = 'ended',
         ended_at        = COALESCE(ended_at, NOW()),
         current_viewers = 0
   WHERE id = p_stream_id;

  INSERT INTO public.admin_audit_log
    (admin_id, action, target_type, target_id, payload)
  VALUES (
    me, 'admin_end_live_stream', 'live_stream', p_stream_id,
    jsonb_build_object('broadcaster_id', v_broadcaster_id, 'reason', p_reason)
  );

  RETURN json_build_object('success', true);
END $$;

GRANT EXECUTE ON FUNCTION public.admin_end_live_stream(UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_room_block_user(
  p_room_host UUID,
  p_target    UUID,
  p_reason    TEXT DEFAULT NULL
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
  IF p_room_host IS NULL OR p_target IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Missing room host or target');
  END IF;
  IF p_room_host = p_target THEN
    RETURN json_build_object('success', false, 'message', 'Use end live or ban host for the broadcaster');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_room_host) THEN
    RETURN json_build_object('success', false, 'message', 'Room host not found');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_target) THEN
    RETURN json_build_object('success', false, 'message', 'Target user not found');
  END IF;

  INSERT INTO public.room_blocks (host_id, blocked_id, reason)
  VALUES (p_room_host, p_target, COALESCE(p_reason, 'Blocked by admin'))
  ON CONFLICT (host_id, blocked_id)
  DO UPDATE SET
    reason     = EXCLUDED.reason,
    created_at = NOW();

  INSERT INTO public.admin_audit_log
    (admin_id, action, target_type, target_id, payload)
  VALUES (
    me, 'admin_room_block_user', 'profile', p_target,
    jsonb_build_object('room_host', p_room_host, 'reason', p_reason)
  );

  RETURN json_build_object('success', true);
END $$;

GRANT EXECUTE ON FUNCTION public.admin_room_block_user(UUID, UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_room_unblock_user(
  p_room_host UUID,
  p_target    UUID,
  p_reason    TEXT DEFAULT NULL
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

  DELETE FROM public.room_blocks
   WHERE host_id = p_room_host
     AND blocked_id = p_target;

  INSERT INTO public.admin_audit_log
    (admin_id, action, target_type, target_id, payload)
  VALUES (
    me, 'admin_room_unblock_user', 'profile', p_target,
    jsonb_build_object('room_host', p_room_host, 'reason', p_reason)
  );

  RETURN json_build_object('success', true);
END $$;

GRANT EXECUTE ON FUNCTION public.admin_room_unblock_user(UUID, UUID, TEXT) TO authenticated;
