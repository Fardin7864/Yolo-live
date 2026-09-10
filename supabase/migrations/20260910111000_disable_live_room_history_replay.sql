-- A viewer's activity feed starts at the moment they join the room.
-- Keep aggregate gift totals reconnect-safe, but never replay earlier chat,
-- entrance, guest-join, or gift rows to a newly connected client.

DROP FUNCTION IF EXISTS public.append_live_room_event(UUID, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.get_live_room_event_history(UUID, INTEGER);
DROP TABLE IF EXISTS public.live_room_events;

CREATE OR REPLACE FUNCTION public.get_live_gift_state(p_stream_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_stream public.live_streams%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Not authenticated');
  END IF;

  SELECT * INTO v_stream
    FROM public.live_streams
   WHERE id = p_stream_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Live stream not found');
  END IF;

  RETURN jsonb_build_object(
    'success', TRUE,
    'stream_id', v_stream.id,
    'stream_type', v_stream.type,
    'total_gifts', COALESCE(v_stream.total_gifts, 0),
    'total_earnings', COALESCE(v_stream.total_earnings, 0),
    'recent_gifts', '[]'::JSONB
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_live_gift_state(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_live_gift_state(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_live_gift_state(UUID) IS
  'Returns reconnect-safe live gift totals without replaying pre-join gift activity.';

NOTIFY pgrst, 'reload schema';
