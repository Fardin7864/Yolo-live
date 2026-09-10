CREATE TABLE IF NOT EXISTS public.live_room_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id UUID NOT NULL REFERENCES public.live_streams(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  client_event_id TEXT NOT NULL CHECK (char_length(client_event_id) BETWEEN 1 AND 160),
  event_type TEXT NOT NULL CHECK (event_type IN ('chat', 'entrance', 'guest_join', 'system')),
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (stream_id, client_event_id),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (octet_length(payload::TEXT) <= 8192)
);

CREATE INDEX IF NOT EXISTS live_room_events_stream_created_idx
  ON public.live_room_events (stream_id, created_at DESC);

ALTER TABLE public.live_room_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.live_room_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.append_live_room_event(
  p_stream_id UUID,
  p_client_event_id TEXT,
  p_event_type TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  me UUID := auth.uid();
  v_host_id UUID;
  v_event public.live_room_events%ROWTYPE;
  v_payload JSONB := COALESCE(p_payload, '{}'::JSONB);
BEGIN
  IF me IS NULL THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Not authenticated');
  END IF;
  IF p_event_type NOT IN ('chat', 'entrance', 'guest_join', 'system') THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Invalid live event type');
  END IF;
  IF p_client_event_id IS NULL OR char_length(p_client_event_id) NOT BETWEEN 1 AND 160 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Invalid live event id');
  END IF;
  IF jsonb_typeof(v_payload) <> 'object' OR octet_length(v_payload::TEXT) > 8192 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Invalid live event payload');
  END IF;

  SELECT broadcaster_id INTO v_host_id
  FROM public.live_streams
  WHERE id = p_stream_id AND status = 'live';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Live stream is not running');
  END IF;
  IF p_event_type IN ('guest_join', 'system') AND me IS DISTINCT FROM v_host_id THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Only the host can publish this event');
  END IF;

  v_payload := v_payload || jsonb_build_object('id', p_client_event_id, 'userId', me);
  INSERT INTO public.live_room_events(stream_id, actor_id, client_event_id, event_type, payload)
  VALUES (p_stream_id, me, p_client_event_id, p_event_type, v_payload)
  ON CONFLICT (stream_id, client_event_id) DO UPDATE
    SET client_event_id = EXCLUDED.client_event_id
  RETURNING * INTO v_event;

  RETURN jsonb_build_object(
    'success', TRUE,
    'id', v_event.id,
    'client_event_id', v_event.client_event_id,
    'created_at', v_event.created_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_live_room_event_history(
  p_stream_id UUID,
  p_limit INTEGER DEFAULT 50
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  me UUID := auth.uid();
  v_events JSONB;
BEGIN
  IF me IS NULL THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Not authenticated');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.live_streams
    WHERE id = p_stream_id AND status = 'live'
  ) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Live stream is not running');
  END IF;

  SELECT COALESCE(jsonb_agg(event_row.event ORDER BY event_row.created_at DESC), '[]'::JSONB)
  INTO v_events
  FROM (
    SELECT event.payload || jsonb_build_object(
      'id', event.client_event_id,
      'createdAt', event.created_at,
      'eventType', event.event_type
    ) AS event,
    event.created_at
    FROM public.live_room_events AS event
    WHERE event.stream_id = p_stream_id
    ORDER BY event.created_at DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 100))
  ) AS event_row;

  RETURN jsonb_build_object('success', TRUE, 'events', v_events);
END;
$function$;

REVOKE ALL ON FUNCTION public.append_live_room_event(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_live_room_event_history(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.append_live_room_event(UUID, TEXT, TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_live_room_event_history(UUID, INTEGER) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
