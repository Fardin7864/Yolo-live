-- Live eligibility follow-up.
--
-- Agency membership is mandatory only for a plain `user`. Agency owners
-- (including legacy owner records whose profile role was not promoted) and
-- every elevated/non-user role may start audio or video live. Authentication
-- and the banned-account check remain authoritative in this RPC so an old or
-- modified APK cannot bypass them.

CREATE OR REPLACE FUNCTION public.start_live_stream(
  p_broadcaster_id UUID,
  p_type TEXT,
  p_title TEXT,
  p_tag TEXT,
  p_cover_url TEXT
) RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  me UUID := auth.uid();
  v_id UUID;
  v_profile public.profiles%ROWTYPE;
BEGIN
  IF me IS NULL OR me <> p_broadcaster_id THEN
    RETURN json_build_object(
      'success', false,
      'code', 'not_authenticated',
      'message', 'Authentication required'
    );
  END IF;

  SELECT * INTO v_profile
  FROM public.profiles
  WHERE id = me;

  IF NOT FOUND OR COALESCE(v_profile.is_banned, FALSE) THEN
    RETURN json_build_object(
      'success', false,
      'code', 'account_blocked',
      'message', 'This account cannot start live'
    );
  END IF;

  IF COALESCE(LOWER(NULLIF(BTRIM(v_profile.role), '')), 'user') = 'user'
    AND NOT EXISTS (
      SELECT 1
      FROM public.agencies owned
      WHERE owned.owner_id = me
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.agency_members am
      JOIN public.agencies a ON a.id = am.agency_id
      WHERE am.host_id = me
        AND am.status = 'active'
        AND a.status = 'verified'
    )
  THEN
    RETURN json_build_object(
      'success', false,
      'code', 'agency_required',
      'message', 'Join an approved agency before starting live'
    );
  END IF;

  UPDATE public.live_streams
  SET status = 'ended',
      ended_at = COALESCE(ended_at, NOW()),
      current_viewers = 0
  WHERE broadcaster_id = me
    AND status = 'live';

  INSERT INTO public.live_streams(broadcaster_id, type, title, tag, cover_url)
  VALUES (
    me,
    CASE WHEN p_type = 'audio' THEN 'audio' ELSE 'video' END,
    NULLIF(BTRIM(p_title), ''),
    NULLIF(BTRIM(p_tag), ''),
    p_cover_url
  )
  RETURNING id INTO v_id;

  RETURN json_build_object('success', true, 'stream_id', v_id);
END
$$;

GRANT EXECUTE ON FUNCTION public.start_live_stream(UUID, TEXT, TEXT, TEXT, TEXT)
  TO authenticated, service_role;
