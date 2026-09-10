-- Give a host five minutes to return after the app is minimized or killed.
-- All server-side stale checks use the same window so viewers, Home and the
-- cleanup job cannot disagree about whether the room is still recoverable.

CREATE OR REPLACE FUNCTION public.report_dead_stream(p_stream_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  v_row public.live_streams%ROWTYPE;
  v_stale BOOLEAN;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  SELECT * INTO v_row FROM public.live_streams WHERE id = p_stream_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', true, 'ended', false, 'message', 'Stream not found');
  END IF;
  IF v_row.status <> 'live' THEN
    RETURN json_build_object('success', true, 'ended', false, 'message', 'Already ended');
  END IF;

  v_stale := COALESCE(v_row.last_heartbeat_at, v_row.started_at, NOW())
    < (NOW() - INTERVAL '5 minutes');

  IF NOT v_stale THEN
    RETURN json_build_object(
      'success', false,
      'ended', false,
      'message', 'The host still has time to return to this minimized live.'
    );
  END IF;

  UPDATE public.live_streams
  SET status = 'ended',
      ended_at = COALESCE(ended_at, NOW()),
      current_viewers = 0
  WHERE id = p_stream_id AND status = 'live';

  RETURN json_build_object('success', true, 'ended', true);
END
$$;

CREATE OR REPLACE FUNCTION public.cleanup_stale_live_streams()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count INT;
BEGIN
  UPDATE public.live_streams
  SET status = 'ended',
      ended_at = COALESCE(ended_at, last_heartbeat_at, NOW()),
      current_viewers = 0
  WHERE status = 'live'
    AND COALESCE(last_heartbeat_at, started_at, NOW()) < NOW() - INTERVAL '5 minutes';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN json_build_object('success', true, 'cleaned', v_count);
END
$$;

CREATE OR REPLACE FUNCTION public.get_active_live_feed(
  p_tag TEXT DEFAULT NULL,
  p_type TEXT DEFAULT NULL,
  p_country TEXT DEFAULT NULL,
  p_offset INT DEFAULT 0,
  p_limit INT DEFAULT 20
) RETURNS TABLE(
  stream_id UUID,broadcaster_id UUID,type TEXT,title TEXT,tag TEXT,
  cover_url TEXT,current_viewers INT,total_gifts BIGINT,started_at TIMESTAMPTZ,
  full_name TEXT,avatar_url TEXT,country TEXT,vip_type TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=public
AS $$
  SELECT l.id,l.broadcaster_id,l.type,l.title,l.tag,l.cover_url,
         COALESCE(l.current_viewers,0),COALESCE(l.total_gifts,0)::BIGINT,
         l.started_at,p.full_name,p.avatar_url,p.country,p.vip_type
  FROM public.live_streams l
  JOIN public.profiles p ON p.id=l.broadcaster_id
  WHERE l.status='live'
    AND NOT COALESCE(p.is_banned,FALSE)
    AND COALESCE(l.last_heartbeat_at,l.started_at)>NOW()-INTERVAL '5 minutes'
    AND (p_tag IS NULL OR l.tag=p_tag)
    AND (p_type IS NULL OR l.type=p_type)
    AND (p_country IS NULL OR p.country=p_country)
  ORDER BY l.current_viewers DESC,l.total_gifts DESC,l.started_at DESC
  OFFSET GREATEST(COALESCE(p_offset,0),0)
  LIMIT LEAST(GREATEST(COALESCE(p_limit,20),1),50);
$$;

GRANT EXECUTE ON FUNCTION public.report_dead_stream(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_live_streams() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_active_live_feed(TEXT,TEXT,TEXT,INT,INT) TO authenticated, service_role;
