-- Home ranking: total platform live minutes per host.
-- The calculation includes an active stream through NOW() and excludes banned
-- profiles. It is exposed only through a bounded SECURITY DEFINER RPC so the
-- mobile client does not need direct access to every historical stream row.

CREATE INDEX IF NOT EXISTS live_streams_broadcaster_started_ended_idx
  ON public.live_streams (broadcaster_id, started_at, ended_at);

CREATE OR REPLACE FUNCTION public.get_home_host_live_minutes(p_limit INT DEFAULT 20)
RETURNS TABLE(
  profile_id UUID,
  full_name TEXT,
  avatar_url TEXT,
  display_id BIGINT,
  vip_type TEXT,
  live_minutes BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    profile_row.id,
    profile_row.full_name,
    profile_row.avatar_url,
    profile_row.display_id::BIGINT,
    profile_row.vip_type,
    ROUND(SUM(GREATEST(EXTRACT(EPOCH FROM (COALESCE(stream_row.ended_at, NOW()) - stream_row.started_at)) / 60, 0)))::BIGINT
  FROM public.profiles AS profile_row
  JOIN public.live_streams AS stream_row
    ON stream_row.broadcaster_id = profile_row.id
  WHERE stream_row.started_at IS NOT NULL
    AND NOT COALESCE(profile_row.is_banned, FALSE)
  GROUP BY profile_row.id, profile_row.full_name, profile_row.avatar_url,
    profile_row.display_id, profile_row.vip_type
  ORDER BY
    ROUND(SUM(GREATEST(EXTRACT(EPOCH FROM (COALESCE(stream_row.ended_at, NOW()) - stream_row.started_at)) / 60, 0))) DESC,
    profile_row.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
$$;

REVOKE ALL ON FUNCTION public.get_home_host_live_minutes(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_home_host_live_minutes(INT) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
