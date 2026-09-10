-- Finance dashboard RPCs, 2-minute stale-live timeout, and hard video-only
-- daily live reward repair.

-- ---------------------------------------------------------------------
-- Host reward heartbeat: cumulative Asia/Dhaka daily reward, VIDEO ONLY.
-- This intentionally overwrites older heartbeat versions that paid per
-- stream or accidentally allowed audio rows to progress.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.live_stream_heartbeat(
  p_stream_id UUID,
  p_viewer_count INT DEFAULT NULL,
  p_current_viewers INT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  v_host UUID;
  v_type TEXT;
  v_date DATE := (NOW() AT TIME ZONE 'Asia/Dhaka')::DATE;
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  v_seconds BIGINT := 0;
  v_cfg JSONB;
  v_enabled BOOLEAN;
  v_beans BIGINT;
  v_minutes INT;
  v_award BOOLEAN := FALSE;
BEGIN
  SELECT broadcaster_id, COALESCE(type, 'video')
    INTO v_host, v_type
    FROM public.live_streams
   WHERE id = p_stream_id;

  IF v_host IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Stream not found');
  END IF;
  IF v_host <> me THEN
    RETURN json_build_object('success', false, 'message', 'Not your stream');
  END IF;

  UPDATE public.live_streams
     SET last_heartbeat_at = NOW(),
         peak_viewers = GREATEST(COALESCE(peak_viewers, 0), COALESCE(p_viewer_count, 0)),
         current_viewers = COALESCE(p_current_viewers, current_viewers)
   WHERE id = p_stream_id
     AND status = 'live';

  SELECT value INTO v_cfg FROM public.system_settings WHERE key = 'host_hour_reward';
  v_enabled := COALESCE((v_cfg->>'enabled')::BOOLEAN, TRUE);
  v_beans := COALESCE((v_cfg->>'beans')::BIGINT, 6000);
  v_minutes := COALESCE((v_cfg->>'minutes')::INT, 60);

  IF v_type = 'video' THEN
    v_start := (v_date::TIMESTAMP AT TIME ZONE 'Asia/Dhaka');
    v_end := ((v_date + 1)::TIMESTAMP AT TIME ZONE 'Asia/Dhaka');

    SELECT COALESCE(SUM(GREATEST(
      0,
      EXTRACT(EPOCH FROM (LEAST(COALESCE(ended_at, NOW()), v_end) - GREATEST(started_at, v_start)))
    )), 0)::BIGINT
      INTO v_seconds
      FROM public.live_streams
     WHERE broadcaster_id = me
       AND type = 'video'
       AND started_at < v_end
       AND COALESCE(ended_at, NOW()) > v_start;

    INSERT INTO public.host_daily_live_rewards(user_id, reward_date, eligible_seconds)
    VALUES (me, v_date, v_seconds)
    ON CONFLICT(user_id, reward_date)
    DO UPDATE SET eligible_seconds = EXCLUDED.eligible_seconds, updated_at = NOW();

    IF v_enabled AND v_seconds >= v_minutes * 60 THEN
      UPDATE public.host_daily_live_rewards
         SET reward_beans = v_beans,
             rewarded_at = NOW(),
             updated_at = NOW()
       WHERE user_id = me
         AND reward_date = v_date
         AND rewarded_at IS NULL;

      IF FOUND THEN
        UPDATE public.profiles SET beans = COALESCE(beans, 0) + v_beans WHERE id = me;
        v_award := TRUE;
        INSERT INTO public.transactions(user_id, type, currency, amount, status, notes)
        VALUES (me, 'live_hour_reward', 'bean', v_beans, 'completed', 'Daily cumulative video live reward');
        INSERT INTO public.notifications(user_id, type, title, body, payload)
        VALUES (
          me,
          'task_reward',
          'Daily live reward',
          '+' || v_beans || ' beans added to your wallet',
          jsonb_build_object('reward', v_beans, 'eligible_seconds', v_seconds, 'reward_date', v_date, 'live_type', 'video')
        );
      END IF;
    END IF;
  END IF;

  RETURN json_build_object(
    'success', true,
    'eligible_seconds', v_seconds,
    'rewarded_now', v_award,
    'reward_date', v_date,
    'live_type', v_type
  );
END $$;

GRANT EXECUTE ON FUNCTION public.live_stream_heartbeat(UUID, INT, INT) TO authenticated;

-- ---------------------------------------------------------------------
-- Host app-kill/minimized timeout: 2 minutes.
-- ---------------------------------------------------------------------
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

  v_stale := COALESCE(v_row.last_heartbeat_at, v_row.started_at, NOW()) < (NOW() - INTERVAL '2 minutes');
  IF NOT v_stale THEN
    RETURN json_build_object('success', false, 'ended', false, 'message', 'The host still has time to return to this minimized live.');
  END IF;

  UPDATE public.live_streams
     SET status = 'ended',
         ended_at = COALESCE(ended_at, NOW()),
         current_viewers = 0
   WHERE id = p_stream_id
     AND status = 'live';

  RETURN json_build_object('success', true, 'ended', true);
END $$;

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
     AND COALESCE(last_heartbeat_at, started_at, NOW()) < NOW() - INTERVAL '2 minutes';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN json_build_object('success', true, 'cleaned', v_count);
END $$;

CREATE OR REPLACE FUNCTION public.get_active_live_feed(
  p_tag TEXT DEFAULT NULL,
  p_type TEXT DEFAULT NULL,
  p_country TEXT DEFAULT NULL,
  p_offset INT DEFAULT 0,
  p_limit INT DEFAULT 20
) RETURNS TABLE(
  stream_id UUID,
  broadcaster_id UUID,
  type TEXT,
  title TEXT,
  tag TEXT,
  cover_url TEXT,
  current_viewers INT,
  total_gifts BIGINT,
  started_at TIMESTAMPTZ,
  full_name TEXT,
  avatar_url TEXT,
  country TEXT,
  vip_type TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.id,
         l.broadcaster_id,
         l.type,
         l.title,
         l.tag,
         l.cover_url,
         COALESCE(l.current_viewers, 0),
         COALESCE(l.total_gifts, 0)::BIGINT,
         l.started_at,
         p.full_name,
         p.avatar_url,
         p.country,
         p.vip_type
    FROM public.live_streams l
    JOIN public.profiles p ON p.id = l.broadcaster_id
   WHERE l.status = 'live'
     AND NOT COALESCE(p.is_banned, FALSE)
     AND COALESCE(l.last_heartbeat_at, l.started_at) > NOW() - INTERVAL '2 minutes'
     AND (p_tag IS NULL OR l.tag = p_tag)
     AND (p_type IS NULL OR l.type = p_type)
     AND (p_country IS NULL OR p.country = p_country)
   ORDER BY l.current_viewers DESC, l.total_gifts DESC, l.started_at DESC
   OFFSET GREATEST(COALESCE(p_offset, 0), 0)
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
$$;

GRANT EXECUTE ON FUNCTION public.report_dead_stream(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_live_streams() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_active_live_feed(TEXT, TEXT, TEXT, INT, INT) TO authenticated, anon, service_role;

-- ---------------------------------------------------------------------
-- Finance dashboard interfaces.
-- Earnings count positive host bean credits only: gifts received and the
-- video-only live-hour reward.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_finance_agency_summary(
  p_start TIMESTAMPTZ DEFAULT NULL,
  p_end TIMESTAMPTZ DEFAULT NULL
) RETURNS TABLE(
  agency_id UUID,
  agency_name TEXT,
  agency_code TEXT,
  agency_status TEXT,
  owner_id UUID,
  owner_name TEXT,
  owner_display_id BIGINT,
  total_hosts BIGINT,
  total_beans_earned BIGINT,
  total_transactions BIGINT,
  last_earning_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH active_hosts AS (
    SELECT agency_id, host_id
      FROM public.agency_members
     WHERE status = 'active'
  ),
  earnings AS (
    SELECT ah.agency_id,
           COUNT(t.id)::BIGINT AS total_transactions,
           COALESCE(SUM(t.amount), 0)::BIGINT AS total_beans_earned,
           MAX(t.created_at) AS last_earning_at
      FROM active_hosts ah
      JOIN public.transactions t ON t.user_id = ah.host_id
     WHERE t.status = 'completed'
       AND t.currency = 'bean'
       AND t.amount > 0
       AND t.type IN ('gift_received', 'live_hour_reward')
       AND (p_start IS NULL OR t.created_at >= p_start)
       AND (p_end IS NULL OR t.created_at <= p_end)
     GROUP BY ah.agency_id
  ),
  host_counts AS (
    SELECT agency_id, COUNT(*)::BIGINT AS total_hosts
      FROM active_hosts
     GROUP BY agency_id
  )
  SELECT a.id,
         a.name,
         a.code,
         a.status,
         a.owner_id,
         owner.full_name,
         owner.display_id,
         COALESCE(hc.total_hosts, 0),
         COALESCE(e.total_beans_earned, 0),
         COALESCE(e.total_transactions, 0),
         e.last_earning_at
    FROM public.agencies a
    LEFT JOIN public.profiles owner ON owner.id = a.owner_id
    LEFT JOIN host_counts hc ON hc.agency_id = a.id
    LEFT JOIN earnings e ON e.agency_id = a.id
   WHERE public.is_live_staff(auth.uid())
   ORDER BY COALESCE(e.total_beans_earned, 0) DESC, a.created_at DESC;
$$;

CREATE OR REPLACE FUNCTION public.admin_finance_agency_detail(
  p_agency_id UUID,
  p_start TIMESTAMPTZ DEFAULT NULL,
  p_end TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF NOT public.is_live_staff(auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Admin access required');
  END IF;

  WITH active_hosts AS (
    SELECT am.agency_id, am.host_id, am.joined_at
      FROM public.agency_members am
     WHERE am.agency_id = p_agency_id
       AND am.status = 'active'
  ),
  host_earnings AS (
    SELECT ah.host_id,
           COUNT(t.id)::BIGINT AS transaction_count,
           COALESCE(SUM(t.amount), 0)::BIGINT AS beans_earned
      FROM active_hosts ah
      LEFT JOIN public.transactions t
        ON t.user_id = ah.host_id
       AND t.status = 'completed'
       AND t.currency = 'bean'
       AND t.amount > 0
       AND t.type IN ('gift_received', 'live_hour_reward')
       AND (p_start IS NULL OR t.created_at >= p_start)
       AND (p_end IS NULL OR t.created_at <= p_end)
     GROUP BY ah.host_id
  ),
  agency_summary AS (
    SELECT * FROM public.admin_finance_agency_summary(p_start, p_end)
     WHERE agency_id = p_agency_id
  )
  SELECT jsonb_build_object(
    'success', true,
    'agency', (SELECT to_jsonb(agency_summary.*) FROM agency_summary LIMIT 1),
    'hosts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'host_id', p.id,
        'display_id', p.display_id,
        'full_name', p.full_name,
        'avatar_url', p.avatar_url,
        'joined_at', ah.joined_at,
        'beans_earned', COALESCE(he.beans_earned, 0),
        'transaction_count', COALESCE(he.transaction_count, 0)
      ) ORDER BY COALESCE(he.beans_earned, 0) DESC, p.full_name)
      FROM active_hosts ah
      JOIN public.profiles p ON p.id = ah.host_id
      LEFT JOIN host_earnings he ON he.host_id = ah.host_id
    ), '[]'::JSONB),
    'transactions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', t.id,
        'host_id', p.id,
        'host_name', p.full_name,
        'host_display_id', p.display_id,
        'type', t.type,
        'amount', t.amount,
        'currency', t.currency,
        'notes', t.notes,
        'created_at', t.created_at
      ) ORDER BY t.created_at DESC)
      FROM active_hosts ah
      JOIN public.transactions t ON t.user_id = ah.host_id
      JOIN public.profiles p ON p.id = ah.host_id
      WHERE t.status = 'completed'
        AND t.currency = 'bean'
        AND t.amount > 0
        AND t.type IN ('gift_received', 'live_hour_reward')
        AND (p_start IS NULL OR t.created_at >= p_start)
        AND (p_end IS NULL OR t.created_at <= p_end)
    ), '[]'::JSONB)
  ) INTO v_result;

  RETURN v_result;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_finance_agency_summary(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_finance_agency_detail(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

NOTIFY pgrst, 'reload schema';
