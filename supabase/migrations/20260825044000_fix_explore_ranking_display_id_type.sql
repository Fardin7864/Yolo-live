-- Production profiles.display_id is INTEGER while the public ranking contract
-- intentionally exposes BIGINT. Cast explicitly so RETURN QUERY matches.
CREATE OR REPLACE FUNCTION public.get_explore_ranking(
  p_kind TEXT,
  p_period TEXT DEFAULT 'daily',
  p_limit INT DEFAULT 20
)
RETURNS TABLE(
  profile_id UUID,
  full_name TEXT,
  avatar_url TEXT,
  display_id BIGINT,
  vip_type TEXT,
  total_diamonds BIGINT,
  gift_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind TEXT := LOWER(COALESCE(p_kind, ''));
  v_period TEXT := LOWER(COALESCE(p_period, ''));
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
BEGIN
  IF v_kind NOT IN ('host', 'gifter') THEN
    RAISE EXCEPTION 'p_kind must be host or gifter';
  END IF;
  IF v_period = 'daily' THEN
    v_start := ((NOW() AT TIME ZONE 'Asia/Dhaka')::DATE::TIMESTAMP AT TIME ZONE 'Asia/Dhaka');
    v_end := v_start + INTERVAL '1 day';
  ELSIF v_period = 'monthly' THEN
    v_start := (DATE_TRUNC('month', NOW() AT TIME ZONE 'Asia/Dhaka') AT TIME ZONE 'Asia/Dhaka');
    v_end := v_start + INTERVAL '1 month';
  ELSE
    RAISE EXCEPTION 'p_period must be daily or monthly';
  END IF;

  IF v_kind = 'host' THEN
    RETURN QUERY
    SELECT gift_row.receiver_id, profile_row.full_name, profile_row.avatar_url,
      profile_row.display_id::BIGINT, profile_row.vip_type,
      SUM(gift_row.diamond_cost)::BIGINT,
      SUM(GREATEST(COALESCE(gift_row.count, 1), 1))::BIGINT
    FROM public.gifts_log AS gift_row
    JOIN public.profiles AS profile_row ON profile_row.id = gift_row.receiver_id
    WHERE gift_row.created_at >= v_start AND gift_row.created_at < v_end
      AND gift_row.diamond_cost > 0
      AND NOT COALESCE(profile_row.is_banned, FALSE)
      AND EXISTS (
        SELECT 1 FROM public.live_streams AS broadcaster_stream
        WHERE broadcaster_stream.broadcaster_id = gift_row.receiver_id
      )
    GROUP BY gift_row.receiver_id, profile_row.full_name, profile_row.avatar_url,
      profile_row.display_id, profile_row.vip_type
    ORDER BY SUM(gift_row.diamond_cost) DESC, gift_row.receiver_id
    LIMIT v_limit;
  ELSE
    RETURN QUERY
    SELECT gift_row.sender_id, profile_row.full_name, profile_row.avatar_url,
      profile_row.display_id::BIGINT, profile_row.vip_type,
      SUM(gift_row.diamond_cost)::BIGINT,
      SUM(GREATEST(COALESCE(gift_row.count, 1), 1))::BIGINT
    FROM public.gifts_log AS gift_row
    JOIN public.profiles AS profile_row ON profile_row.id = gift_row.sender_id
    WHERE gift_row.created_at >= v_start AND gift_row.created_at < v_end
      AND gift_row.diamond_cost > 0
      AND NOT COALESCE(profile_row.is_banned, FALSE)
    GROUP BY gift_row.sender_id, profile_row.full_name, profile_row.avatar_url,
      profile_row.display_id, profile_row.vip_type
    ORDER BY SUM(gift_row.diamond_cost) DESC, gift_row.sender_id
    LIMIT v_limit;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.get_explore_ranking(TEXT, TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_explore_ranking(TEXT, TEXT, INT) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
