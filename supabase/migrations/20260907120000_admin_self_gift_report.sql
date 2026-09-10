-- Separate self-gift reporting for the admin panel.
--
-- Self-gifts are logged in gifts_log alongside normal gifts (so they still show
-- in the live feed and gift history) but are excluded from every ranking and
-- earnings aggregation. Monitoring them therefore needs its own read, carrying
-- the audit fields: host, gift name, diamond value, timestamp and live session.

CREATE OR REPLACE FUNCTION public.admin_self_gift_report(
  p_start TIMESTAMPTZ DEFAULT NULL,
  p_end   TIMESTAMPTZ DEFAULT NULL,
  p_limit INTEGER DEFAULT 200
)
RETURNS TABLE (
  gift_log_id UUID,
  host_id UUID,
  host_name TEXT,
  host_display_id BIGINT,
  gift_id TEXT,
  gift_name TEXT,
  gift_count INTEGER,
  diamond_cost BIGINT,
  bean_value BIGINT,
  room_id UUID,
  stream_type TEXT,
  stream_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me UUID := auth.uid();
  v_start TIMESTAMPTZ := COALESCE(p_start, NOW() - INTERVAL '30 days');
  v_end   TIMESTAMPTZ := COALESCE(p_end, NOW());
BEGIN
  IF NOT public.is_admin(me) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT g.id,
         g.sender_id,
         p.full_name::TEXT,
         p.display_id::BIGINT,
         g.gift_id,
         g.gift_name,
         g.count,
         g.diamond_cost,
         g.bean_value,
         g.room_id,
         s.type::TEXT,
         s.started_at,
         g.created_at
    FROM public.gifts_log g
    LEFT JOIN public.profiles p ON p.id = g.sender_id
    LEFT JOIN public.live_streams s ON s.id = g.room_id
   WHERE g.is_self_gift
     AND g.created_at >= v_start
     AND g.created_at <= v_end
   ORDER BY g.created_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_self_gift_summary(
  p_start TIMESTAMPTZ DEFAULT NULL,
  p_end   TIMESTAMPTZ DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me UUID := auth.uid();
  v_start TIMESTAMPTZ := COALESCE(p_start, NOW() - INTERVAL '30 days');
  v_end   TIMESTAMPTZ := COALESCE(p_end, NOW());
  v_result JSON;
BEGIN
  IF NOT public.is_admin(me) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT json_build_object(
    'hosts', COUNT(DISTINCT sender_id),
    'gifts', COALESCE(SUM("count"), 0),
    'diamonds', COALESCE(SUM(diamond_cost), 0),
    'beans', COALESCE(SUM(bean_value), 0)
  ) INTO v_result
  FROM public.gifts_log
  WHERE is_self_gift AND created_at >= v_start AND created_at <= v_end;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_self_gift_report(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_self_gift_summary(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_self_gift_report(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_self_gift_summary(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;
