-- Final backend rules for live rewards/rankings, agency membership,
-- Anubis monthly settlement, Lucky Bag discovery, and batched gifting.

-- -------------------------------------------------------------------
-- Video live reward: exactly 5,000 beans after one continuous hour,
-- once per Asia/Dhaka calendar day. The installed heartbeat function
-- reads this setting and already refuses audio streams.
-- -------------------------------------------------------------------
INSERT INTO public.system_settings(key, value)
VALUES ('host_hour_reward', jsonb_build_object('enabled', TRUE, 'beans', 5000, 'minutes', 60))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO public.system_settings(key, value)
VALUES ('lucky_bag_ttl_seconds', '75'::JSONB)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

UPDATE public.tasks SET is_active=FALSE,updated_at=NOW()
WHERE id IN ('host_live_30','host_live_60','host_live_120');

-- Host dashboard: a live day is valid only when that day's VIDEO time
-- reaches 35 minutes. Audio time and short video sessions remain visible
-- in minutes/recent sessions, but never increase the day counter.
CREATE OR REPLACE FUNCTION public.get_host_stats(p_host_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid(); v_result JSON;
BEGIN
  IF p_host_id IS NULL THEN RETURN json_build_object('error','host_id required'); END IF;
  IF NOT (
    me=p_host_id
    OR public.is_live_staff(me)
    OR EXISTS (
      SELECT 1 FROM public.agency_members AS member_row
      JOIN public.agencies AS agency_row ON agency_row.id=member_row.agency_id
      WHERE member_row.host_id=p_host_id AND member_row.status IN ('active','leave_pending')
        AND agency_row.owner_id=me
    )
  ) THEN RETURN json_build_object('error','forbidden'); END IF;

  WITH session_rows AS (
    SELECT stream_row.id,stream_row.type,stream_row.title,stream_row.started_at,
      stream_row.ended_at,stream_row.status,
      (stream_row.started_at AT TIME ZONE 'Asia/Dhaka')::DATE AS live_date,
      COALESCE(stream_row.peak_viewers,0) AS peak_viewers,
      COALESCE(stream_row.total_gifts,0) AS total_gifts,
      COALESCE(stream_row.total_earnings,0) AS total_earnings,
      GREATEST(EXTRACT(EPOCH FROM (COALESCE(stream_row.ended_at,NOW())-stream_row.started_at))/60,0)::NUMERIC AS minutes
    FROM public.live_streams AS stream_row
    WHERE stream_row.broadcaster_id=p_host_id AND stream_row.started_at IS NOT NULL
  ), video_day_minutes AS (
    SELECT day_slice.day_date,
      SUM(GREATEST(EXTRACT(EPOCH FROM (
        LEAST(COALESCE(session_row.ended_at,NOW()),day_slice.day_end)
        - GREATEST(session_row.started_at,day_slice.day_start)
      ))/60,0)) AS video_minutes
    FROM session_rows AS session_row
    CROSS JOIN LATERAL (
      SELECT generated_day::DATE AS day_date,
        (generated_day::DATE::TIMESTAMP AT TIME ZONE 'Asia/Dhaka') AS day_start,
        ((generated_day::DATE+1)::TIMESTAMP AT TIME ZONE 'Asia/Dhaka') AS day_end
      FROM GENERATE_SERIES(
        (session_row.started_at AT TIME ZONE 'Asia/Dhaka')::DATE,
        ((COALESCE(session_row.ended_at,NOW())-INTERVAL '1 microsecond') AT TIME ZONE 'Asia/Dhaka')::DATE,
        INTERVAL '1 day'
      ) AS generated_day
    ) AS day_slice
    WHERE session_row.type='video'
    GROUP BY day_slice.day_date
  ), video_days AS (
    SELECT daily_video.day_date AS live_date,daily_video.video_minutes
    FROM video_day_minutes AS daily_video WHERE daily_video.video_minutes>=35
  ), aggregate_row AS (
    SELECT
      (SELECT COUNT(*) FROM video_days)::BIGINT AS total_live_days,
      COALESCE(SUM(session_row.minutes),0)::BIGINT AS total_minutes,
      COALESCE(SUM(session_row.total_gifts),0)::BIGINT AS total_gifts,
      COALESCE(SUM(session_row.total_earnings),0)::BIGINT AS total_diamonds,
      (SELECT COUNT(*) FROM video_days AS valid_day WHERE valid_day.live_date=(NOW() AT TIME ZONE 'Asia/Dhaka')::DATE)::BIGINT AS today_live_days,
      COALESCE(SUM(session_row.minutes) FILTER (WHERE session_row.live_date=(NOW() AT TIME ZONE 'Asia/Dhaka')::DATE),0)::BIGINT AS today_minutes,
      COALESCE(SUM(session_row.total_gifts) FILTER (WHERE session_row.live_date=(NOW() AT TIME ZONE 'Asia/Dhaka')::DATE),0)::BIGINT AS today_gifts,
      COALESCE(SUM(session_row.total_earnings) FILTER (WHERE session_row.live_date=(NOW() AT TIME ZONE 'Asia/Dhaka')::DATE),0)::BIGINT AS today_diamonds,
      (SELECT COUNT(*) FROM video_days AS valid_day WHERE valid_day.live_date>=(NOW() AT TIME ZONE 'Asia/Dhaka')::DATE-6)::BIGINT AS week_live_days,
      COALESCE(SUM(session_row.minutes) FILTER (WHERE session_row.live_date>=(NOW() AT TIME ZONE 'Asia/Dhaka')::DATE-6),0)::BIGINT AS week_minutes,
      COALESCE(SUM(session_row.total_gifts) FILTER (WHERE session_row.live_date>=(NOW() AT TIME ZONE 'Asia/Dhaka')::DATE-6),0)::BIGINT AS week_gifts,
      COALESCE(SUM(session_row.total_earnings) FILTER (WHERE session_row.live_date>=(NOW() AT TIME ZONE 'Asia/Dhaka')::DATE-6),0)::BIGINT AS week_diamonds,
      (SELECT COUNT(*) FROM video_days AS valid_day WHERE valid_day.live_date>=(NOW() AT TIME ZONE 'Asia/Dhaka')::DATE-29)::BIGINT AS month_live_days,
      COALESCE(SUM(session_row.minutes) FILTER (WHERE session_row.live_date>=(NOW() AT TIME ZONE 'Asia/Dhaka')::DATE-29),0)::BIGINT AS month_minutes,
      COALESCE(SUM(session_row.total_gifts) FILTER (WHERE session_row.live_date>=(NOW() AT TIME ZONE 'Asia/Dhaka')::DATE-29),0)::BIGINT AS month_gifts,
      COALESCE(SUM(session_row.total_earnings) FILTER (WHERE session_row.live_date>=(NOW() AT TIME ZONE 'Asia/Dhaka')::DATE-29),0)::BIGINT AS month_diamonds
    FROM session_rows AS session_row
  ), recent_rows AS (
    SELECT json_agg(row_to_json(recent_row)) AS rows FROM (
      SELECT session_row.id,session_row.type,session_row.title,session_row.started_at,
        session_row.ended_at,session_row.status,ROUND(session_row.minutes)::INT AS minutes,
        session_row.peak_viewers,session_row.total_gifts,session_row.total_earnings
      FROM session_rows AS session_row ORDER BY session_row.started_at DESC LIMIT 10
    ) AS recent_row
  )
  SELECT json_build_object(
    'today',json_build_object('sessions',aggregate_row.today_live_days,'minutes',aggregate_row.today_minutes,'gifts',aggregate_row.today_gifts,'diamonds',aggregate_row.today_diamonds),
    'week',json_build_object('sessions',aggregate_row.week_live_days,'minutes',aggregate_row.week_minutes,'gifts',aggregate_row.week_gifts,'diamonds',aggregate_row.week_diamonds),
    'month',json_build_object('sessions',aggregate_row.month_live_days,'minutes',aggregate_row.month_minutes,'gifts',aggregate_row.month_gifts,'diamonds',aggregate_row.month_diamonds),
    'all_time',json_build_object('sessions',aggregate_row.total_live_days,'minutes',aggregate_row.total_minutes,'gifts',aggregate_row.total_gifts,'diamonds',aggregate_row.total_diamonds),
    'recent_sessions',COALESCE(recent_rows.rows,'[]'::JSON),
    'valid_live_day_minutes',35,'valid_live_type','video'
  ) INTO v_result FROM aggregate_row,recent_rows;
  RETURN v_result;
END $$;

-- Global leaderboard. Gifts count for the receiver regardless of whose
-- room they were in, so a seated host's earnings are not lost.
CREATE INDEX IF NOT EXISTS gifts_log_sender_created_idx ON public.gifts_log(sender_id,created_at DESC);
CREATE INDEX IF NOT EXISTS gifts_log_receiver_created_idx ON public.gifts_log(receiver_id,created_at DESC);

CREATE OR REPLACE FUNCTION public.get_top_gifters(period_key TEXT, limit_n INT DEFAULT 20)
RETURNS TABLE(sender_id UUID,full_name TEXT,avatar_url TEXT,total_diamonds BIGINT,gift_count BIGINT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_start TIMESTAMPTZ;
BEGIN
  IF LOWER(COALESCE(period_key,''))='daily' THEN
    v_start:=((NOW() AT TIME ZONE 'Asia/Dhaka')::DATE::TIMESTAMP AT TIME ZONE 'Asia/Dhaka');
  ELSIF LOWER(COALESCE(period_key,''))='monthly' THEN
    v_start:=(DATE_TRUNC('month',NOW() AT TIME ZONE 'Asia/Dhaka') AT TIME ZONE 'Asia/Dhaka');
  ELSE
    RAISE EXCEPTION 'period_key must be daily or monthly';
  END IF;
  RETURN QUERY SELECT gift_row.sender_id,profile_row.full_name,profile_row.avatar_url,
    SUM(gift_row.diamond_cost)::BIGINT,SUM(COALESCE(gift_row.count,1))::BIGINT
  FROM public.gifts_log AS gift_row
  JOIN public.profiles AS profile_row ON profile_row.id=gift_row.sender_id
  WHERE gift_row.created_at>=v_start AND NOT COALESCE(profile_row.is_banned,FALSE)
  GROUP BY gift_row.sender_id,profile_row.full_name,profile_row.avatar_url
  ORDER BY SUM(gift_row.diamond_cost) DESC,gift_row.sender_id
  LIMIT LEAST(GREATEST(COALESCE(limit_n,20),1),100);
END $$;

CREATE OR REPLACE FUNCTION public.get_top_broadcasters_daily(limit_n INT DEFAULT 20)
RETURNS TABLE(broadcaster_id UUID,full_name TEXT,avatar_url TEXT,display_id BIGINT,vip_type TEXT,total_diamonds BIGINT,gift_count BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT gift_row.receiver_id,profile_row.full_name,profile_row.avatar_url,profile_row.display_id,profile_row.vip_type,
    SUM(gift_row.diamond_cost)::BIGINT,SUM(COALESCE(gift_row.count,1))::BIGINT
  FROM public.gifts_log AS gift_row JOIN public.profiles AS profile_row ON profile_row.id=gift_row.receiver_id
  WHERE gift_row.created_at>=((NOW() AT TIME ZONE 'Asia/Dhaka')::DATE::TIMESTAMP AT TIME ZONE 'Asia/Dhaka')
    AND NOT COALESCE(profile_row.is_banned,FALSE)
  GROUP BY gift_row.receiver_id,profile_row.full_name,profile_row.avatar_url,profile_row.display_id,profile_row.vip_type
  ORDER BY SUM(gift_row.diamond_cost) DESC,gift_row.receiver_id
  LIMIT LEAST(GREATEST(COALESCE(limit_n,20),1),100)
$$;

-- -------------------------------------------------------------------
-- Agency report/search and release rules.
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agency_host_period_report(p_agency_id UUID,p_start TIMESTAMPTZ,p_end TIMESTAMPTZ)
RETURNS TABLE(host_id UUID,host_name TEXT,host_display_id BIGINT,report_day DATE,income BIGINT,live_minutes BIGINT,live_sessions BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
#variable_conflict use_column
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.agencies AS agency_row WHERE agency_row.id=p_agency_id AND agency_row.owner_id=auth.uid())
     AND NOT public.is_live_staff(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN QUERY
  WITH member_rows AS (
    SELECT member_row.host_id AS member_host_id,member_row.joined_at,member_row.released_at
    FROM public.agency_members AS member_row
    WHERE member_row.agency_id=p_agency_id AND member_row.status IN ('active','leave_pending','released')
  ), earning_rows AS (
    SELECT member_row.member_host_id,(tx_row.created_at AT TIME ZONE 'Asia/Dhaka')::DATE AS earning_date,SUM(tx_row.amount)::BIGINT AS earned
    FROM member_rows AS member_row JOIN public.transactions AS tx_row ON tx_row.user_id=member_row.member_host_id
    WHERE tx_row.status='completed' AND tx_row.currency='bean' AND tx_row.amount>0
      AND tx_row.type IN ('gift_received','live_hour_reward') AND tx_row.created_at>=p_start AND tx_row.created_at<p_end
      AND tx_row.created_at>=member_row.joined_at AND (member_row.released_at IS NULL OR tx_row.created_at<member_row.released_at)
    GROUP BY member_row.member_host_id,(tx_row.created_at AT TIME ZONE 'Asia/Dhaka')::DATE
  ), live_intervals AS (
    SELECT member_row.member_host_id,stream_row.id AS stream_id,
      GREATEST(stream_row.started_at,p_start,member_row.joined_at) AS interval_start,
      LEAST(COALESCE(stream_row.ended_at,NOW()),p_end,COALESCE(member_row.released_at,'infinity'::TIMESTAMPTZ)) AS interval_end
    FROM member_rows AS member_row JOIN public.live_streams AS stream_row ON stream_row.broadcaster_id=member_row.member_host_id
    WHERE stream_row.started_at<LEAST(p_end,COALESCE(member_row.released_at,'infinity'::TIMESTAMPTZ))
      AND COALESCE(stream_row.ended_at,NOW())>GREATEST(p_start,member_row.joined_at)
  ), live_day_slices AS (
    SELECT live_interval.member_host_id,live_interval.stream_id,day_slice.day_date,
      GREATEST(live_interval.interval_start,day_slice.day_start) AS slice_start,
      LEAST(live_interval.interval_end,day_slice.day_end) AS slice_end
    FROM live_intervals AS live_interval
    CROSS JOIN LATERAL (
      SELECT generated_day::DATE AS day_date,
        (generated_day::DATE::TIMESTAMP AT TIME ZONE 'Asia/Dhaka') AS day_start,
        ((generated_day::DATE+1)::TIMESTAMP AT TIME ZONE 'Asia/Dhaka') AS day_end
      FROM GENERATE_SERIES(
        (live_interval.interval_start AT TIME ZONE 'Asia/Dhaka')::DATE,
        ((live_interval.interval_end-INTERVAL '1 microsecond') AT TIME ZONE 'Asia/Dhaka')::DATE,
        INTERVAL '1 day'
      ) AS generated_day
    ) AS day_slice
    WHERE day_slice.day_end>live_interval.interval_start AND day_slice.day_start<live_interval.interval_end
  ), live_rows AS (
    SELECT live_slice.member_host_id,live_slice.day_date AS live_date,
      COUNT(DISTINCT live_slice.stream_id)::BIGINT AS sessions,
      ROUND(SUM(EXTRACT(EPOCH FROM (live_slice.slice_end-live_slice.slice_start))/60))::BIGINT AS minutes
    FROM live_day_slices AS live_slice
    WHERE live_slice.slice_end>live_slice.slice_start
    GROUP BY live_slice.member_host_id,live_slice.day_date
  ), report_keys AS (
    SELECT earning_row.member_host_id,earning_row.earning_date AS report_date FROM earning_rows AS earning_row
    UNION SELECT live_row.member_host_id,live_row.live_date FROM live_rows AS live_row
  )
  SELECT profile_row.id,profile_row.full_name,profile_row.display_id,report_key.report_date,
    COALESCE(earning_row.earned,0),COALESCE(live_row.minutes,0),COALESCE(live_row.sessions,0)
  FROM report_keys AS report_key JOIN public.profiles AS profile_row ON profile_row.id=report_key.member_host_id
  LEFT JOIN earning_rows AS earning_row ON earning_row.member_host_id=report_key.member_host_id AND earning_row.earning_date=report_key.report_date
  LEFT JOIN live_rows AS live_row ON live_row.member_host_id=report_key.member_host_id AND live_row.live_date=report_key.report_date
  ORDER BY report_key.report_date DESC,profile_row.full_name;
END $$;

CREATE OR REPLACE FUNCTION public.search_agencies_by_code(p_code TEXT,p_limit INT DEFAULT 20)
RETURNS TABLE(agency_id UUID,agency_name TEXT,agency_code TEXT,owner_id UUID,member_count INT,status TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT agency_row.id,agency_row.name,agency_row.code,agency_row.owner_id,COALESCE(agency_row.member_count,0),agency_row.status
  FROM public.agencies AS agency_row
  WHERE REGEXP_REPLACE(LOWER(COALESCE(agency_row.code,'')),'[^a-z0-9]','','g')
        =REGEXP_REPLACE(LOWER(COALESCE(p_code,'')),'[^a-z0-9]','','g')
    AND agency_row.status='verified'
  ORDER BY CASE WHEN LOWER(agency_row.code)=LOWER(BTRIM(p_code)) THEN 0 ELSE 1 END,agency_row.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit,20),1),50)
$$;

-- Host self-action only opens a request. Owner or super admin completes it
-- and the requested self-leave incurs the fixed 50k diamond penalty.
CREATE OR REPLACE FUNCTION public.approve_leave_request(p_host_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid(); v_agency_id UUID; v_diamonds BIGINT; v_penalty CONSTANT BIGINT:=50000; v_role TEXT;
BEGIN
  SELECT member_row.agency_id INTO v_agency_id FROM public.agency_members AS member_row
  WHERE member_row.host_id=p_host_id AND member_row.status='leave_pending' FOR UPDATE;
  IF v_agency_id IS NULL THEN RETURN json_build_object('success',FALSE,'message','No pending leave request'); END IF;
  SELECT profile_row.role INTO v_role FROM public.profiles AS profile_row WHERE profile_row.id=me;
  IF NOT EXISTS(SELECT 1 FROM public.agencies AS agency_row WHERE agency_row.id=v_agency_id AND agency_row.owner_id=me)
     AND COALESCE(v_role,'')<>'super_admin' THEN RETURN json_build_object('success',FALSE,'message','Agency owner or super admin required'); END IF;
  SELECT profile_row.diamonds INTO v_diamonds FROM public.profiles AS profile_row WHERE profile_row.id=p_host_id FOR UPDATE;
  IF COALESCE(v_diamonds,0)<v_penalty THEN RETURN json_build_object('success',FALSE,'message','Host needs 50,000 diamonds for the leave penalty'); END IF;
  UPDATE public.profiles SET diamonds=diamonds-v_penalty,agency_id=NULL WHERE id=p_host_id;
  UPDATE public.agency_members SET status='released',released_at=NOW() WHERE host_id=p_host_id AND agency_id=v_agency_id;
  UPDATE public.agencies SET member_count=(SELECT COUNT(*) FROM public.agency_members AS active_member WHERE active_member.agency_id=v_agency_id AND active_member.status='active') WHERE id=v_agency_id;
  INSERT INTO public.transactions(user_id,type,currency,amount,balance_after,status,notes)
  VALUES(p_host_id,'agency_leave_penalty','diamond',-v_penalty,v_diamonds-v_penalty,'completed','Approved self-requested agency leave penalty');
  RETURN json_build_object('success',TRUE,'penalty',v_penalty,'balance_after',v_diamonds-v_penalty);
END $$;

CREATE OR REPLACE FUNCTION public.release_agency_member(p_agency_id UUID,p_owner_id UUID,p_host_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid(); v_role TEXT;
BEGIN
  SELECT profile_row.role INTO v_role FROM public.profiles AS profile_row WHERE profile_row.id=me;
  IF me IS NULL OR NOT (
    (me=p_owner_id AND EXISTS(SELECT 1 FROM public.agencies AS agency_row WHERE agency_row.id=p_agency_id AND agency_row.owner_id=me))
    OR COALESCE(v_role,'')='super_admin'
  ) THEN RETURN json_build_object('success',FALSE,'message','Agency owner or super admin required'); END IF;
  UPDATE public.agency_members SET status='released',released_at=NOW()
  WHERE agency_id=p_agency_id AND host_id=p_host_id AND status IN ('active','pending','leave_pending');
  IF NOT FOUND THEN RETURN json_build_object('success',FALSE,'message','Active agency member not found'); END IF;
  UPDATE public.profiles SET agency_id=NULL WHERE id=p_host_id AND agency_id=p_agency_id;
  UPDATE public.agencies SET member_count=(SELECT COUNT(*) FROM public.agency_members AS active_member WHERE active_member.agency_id=p_agency_id AND active_member.status='active') WHERE id=p_agency_id;
  RETURN json_build_object('success',TRUE,'penalty',0);
END $$;

-- -------------------------------------------------------------------
-- Monthly Anubis ID settlement and auditable ledger.
-- -------------------------------------------------------------------
UPDATE public.bins_holder_accounts SET name='Anubis ID' WHERE display_id=990001;

CREATE TABLE IF NOT EXISTS public.anubis_monthly_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_month DATE NOT NULL,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  holder_id UUID NOT NULL REFERENCES public.bins_holder_accounts(id) ON DELETE RESTRICT,
  role_at_settlement TEXT NOT NULL,
  earned_beans BIGINT NOT NULL DEFAULT 0,
  deposited_beans BIGINT NOT NULL DEFAULT 0,
  balance_before BIGINT NOT NULL DEFAULT 0,
  balance_after BIGINT NOT NULL DEFAULT 0,
  settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(period_month,user_id)
);
CREATE INDEX IF NOT EXISTS anubis_ledger_period_idx ON public.anubis_monthly_ledger(period_month DESC,deposited_beans DESC);
ALTER TABLE public.anubis_monthly_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS anubis_staff_read ON public.anubis_monthly_ledger;
CREATE POLICY anubis_staff_read ON public.anubis_monthly_ledger FOR SELECT TO authenticated USING(public.is_live_staff(auth.uid()));
REVOKE INSERT,UPDATE,DELETE ON public.anubis_monthly_ledger FROM anon,authenticated;
GRANT SELECT ON public.anubis_monthly_ledger TO authenticated;

CREATE OR REPLACE FUNCTION public.run_anubis_monthly_settlement(p_period_month DATE DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_month DATE:=COALESCE(DATE_TRUNC('month',p_period_month)::DATE,(DATE_TRUNC('month',NOW() AT TIME ZONE 'Asia/Dhaka')-INTERVAL '1 month')::DATE);
  v_start TIMESTAMPTZ; v_end TIMESTAMPTZ; v_holder UUID; v_total BIGINT:=0; v_count INT:=0;
  settlement RECORD; v_deposit BIGINT; v_balance_before BIGINT;
BEGIN
  IF v_month>=(DATE_TRUNC('month',NOW() AT TIME ZONE 'Asia/Dhaka'))::DATE THEN
    RAISE EXCEPTION 'Only completed months can be settled';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('anubis_monthly_settlement',0)) THEN
    RETURN jsonb_build_object('success',FALSE,'message','Settlement is already running','period_month',v_month);
  END IF;
  v_start:=(v_month::TIMESTAMP AT TIME ZONE 'Asia/Dhaka'); v_end:=((v_month+INTERVAL '1 month')::TIMESTAMP AT TIME ZONE 'Asia/Dhaka');
  SELECT holder_row.id INTO v_holder FROM public.bins_holder_accounts AS holder_row WHERE holder_row.display_id=990001 FOR UPDATE;
  FOR settlement IN
    SELECT profile_row.id AS user_id,
      CASE WHEN profile_row.role='agency_owner' THEN 'agency_owner' ELSE 'host' END AS role,
      COALESCE(profile_row.beans,0)::BIGINT AS balance_before,
      COALESCE(SUM(tx_row.amount) FILTER (WHERE tx_row.id IS NOT NULL),0)::BIGINT AS earned
    FROM public.profiles AS profile_row
    LEFT JOIN public.transactions AS tx_row ON tx_row.user_id=profile_row.id AND tx_row.currency='bean' AND tx_row.status='completed'
      AND tx_row.amount>0 AND tx_row.type IN ('gift_received','live_hour_reward') AND tx_row.created_at>=v_start AND tx_row.created_at<v_end
    WHERE profile_row.role IN ('host','agency_owner') OR EXISTS(
      SELECT 1 FROM public.agency_members AS host_membership
      WHERE host_membership.host_id=profile_row.id AND host_membership.status IN ('active','leave_pending')
    )
    GROUP BY profile_row.id,profile_row.role,profile_row.beans
  LOOP
    IF EXISTS(SELECT 1 FROM public.anubis_monthly_ledger AS ledger_row WHERE ledger_row.period_month=v_month AND ledger_row.user_id=settlement.user_id) THEN CONTINUE; END IF;
    SELECT COALESCE(profile_row.beans,0)::BIGINT INTO v_balance_before
    FROM public.profiles AS profile_row WHERE profile_row.id=settlement.user_id FOR UPDATE;
    v_deposit:=LEAST(v_balance_before,settlement.earned);
    UPDATE public.profiles SET beans=COALESCE(beans,0)-v_deposit WHERE id=settlement.user_id;
    INSERT INTO public.anubis_monthly_ledger(period_month,user_id,holder_id,role_at_settlement,earned_beans,deposited_beans,balance_before,balance_after)
    VALUES(v_month,settlement.user_id,v_holder,settlement.role,settlement.earned,v_deposit,v_balance_before,v_balance_before-v_deposit);
    IF v_deposit>0 THEN
      INSERT INTO public.transactions(user_id,type,currency,amount,balance_after,status,notes)
      VALUES(settlement.user_id,'anubis_monthly_deposit','bean',-v_deposit,v_balance_before-v_deposit,'completed','Monthly beans deposited to Anubis ID 990001 for '||v_month);
    END IF;
    v_total:=v_total+v_deposit; v_count:=v_count+1;
  END LOOP;
  UPDATE public.bins_holder_accounts SET total_bins_received=total_bins_received+v_total WHERE id=v_holder;
  RETURN jsonb_build_object('success',TRUE,'period_month',v_month,'accounts_settled',v_count,'beans_deposited',v_total,'anubis_display_id',990001);
END $$;

CREATE OR REPLACE FUNCTION public.admin_run_anubis_monthly_settlement(p_period_month DATE)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.profiles AS profile_row WHERE profile_row.id=auth.uid() AND profile_row.role='super_admin')
  THEN RAISE EXCEPTION 'Super admin access required'; END IF;
  RETURN public.run_anubis_monthly_settlement(p_period_month);
END $$;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
DO $$ BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname='anubis-monthly-beans-settlement';
  PERFORM cron.schedule('anubis-monthly-beans-settlement','10 0 1 * *',$cron$SELECT public.run_anubis_monthly_settlement();$cron$);
END $$;

-- -------------------------------------------------------------------
-- Lucky Bag global discovery: one persisted realtime row per drop.
-- New room entrants can query the same unexpired row until the timer ends.
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lucky_bag_global_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bag_id UUID NOT NULL UNIQUE REFERENCES public.lucky_bags(id) ON DELETE CASCADE,
  stream_id UUID NOT NULL REFERENCES public.live_streams(id) ON DELETE CASCADE,
  room_host_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  dropper_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  prize_diamonds BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS lucky_bag_global_active_idx ON public.lucky_bag_global_announcements(expires_at DESC);
ALTER TABLE public.lucky_bag_global_announcements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lucky_bag_global_read ON public.lucky_bag_global_announcements;
CREATE POLICY lucky_bag_global_read ON public.lucky_bag_global_announcements FOR SELECT TO authenticated USING(expires_at>NOW());
GRANT SELECT ON public.lucky_bag_global_announcements TO authenticated;
REVOKE INSERT,UPDATE,DELETE ON public.lucky_bag_global_announcements FROM anon,authenticated;

CREATE OR REPLACE FUNCTION public.create_lucky_bag(prize_diamonds BIGINT,winner_count INT,p_room_host_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid(); per_winner BIGINT; bag_id UUID; ttl_seconds INT; stream_id UUID; bag_expires TIMESTAMPTZ;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF prize_diamonds<>ALL(ARRAY[5000,10000,50000,100000]::BIGINT[]) THEN RAISE EXCEPTION 'Invalid Lucky Bag amount'; END IF;
  IF winner_count NOT BETWEEN 1 AND 100 OR prize_diamonds<winner_count THEN RAISE EXCEPTION 'Invalid winner count'; END IF;
  SELECT stream_row.id INTO stream_id FROM public.live_streams AS stream_row
  WHERE stream_row.broadcaster_id=p_room_host_id AND stream_row.status='live' ORDER BY stream_row.started_at DESC LIMIT 1;
  IF stream_id IS NULL THEN RAISE EXCEPTION 'The target live is no longer running'; END IF;
  UPDATE public.profiles SET diamonds=diamonds-prize_diamonds WHERE id=me AND diamonds>=prize_diamonds;
  IF NOT FOUND THEN RAISE EXCEPTION 'Insufficient diamonds'; END IF;
  per_winner:=prize_diamonds/winner_count; ttl_seconds:=public.get_setting_int('lucky_bag_ttl_seconds',60); bag_expires:=NOW()+MAKE_INTERVAL(secs=>ttl_seconds);
  INSERT INTO public.lucky_bags(host_id,room_host_id,prize_diamonds,winner_count,per_winner,expires_at)
  VALUES(me,p_room_host_id,prize_diamonds,winner_count,per_winner,bag_expires) RETURNING id INTO bag_id;
  INSERT INTO public.lucky_bag_global_announcements(bag_id,stream_id,room_host_id,dropper_id,prize_diamonds,expires_at)
  VALUES(bag_id,stream_id,p_room_host_id,me,prize_diamonds,bag_expires);
  RETURN bag_id;
END $$;

-- Atomic ALL-recipient path: validates and locks once, debits the sender
-- once, credits every receiver in one statement, and writes ordered rows
-- in the same transaction. p_recipients is a JSON array of user UUIDs.
CREATE OR REPLACE FUNCTION public.send_gift_batch(
  p_recipients JSONB,
  p_gift_id TEXT,
  p_diamond_cost BIGINT,
  p_room_id UUID DEFAULT NULL,
  p_gift_name TEXT DEFAULT NULL,
  p_count INT DEFAULT 1
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE me UUID:=auth.uid(); v_unit_cost BIGINT; v_bean_value BIGINT; v_name TEXT; v_active BOOLEAN;
  v_required_vip TEXT; v_sender_vip TEXT; v_vip_expires TIMESTAMPTZ;
  v_recipient_count INT; v_total_cost BIGINT; v_total_beans BIGINT; v_sender_balance BIGINT; v_balance_after BIGINT;
BEGIN
  IF me IS NULL THEN RETURN jsonb_build_object('success',FALSE,'message','Not authenticated'); END IF;
  IF p_count IS NULL OR p_count<1 OR p_count>1000 THEN RETURN jsonb_build_object('success',FALSE,'message','Invalid gift quantity'); END IF;
  IF JSONB_TYPEOF(p_recipients)<>'array' THEN RETURN jsonb_build_object('success',FALSE,'message','Recipients must be a JSON array'); END IF;
  CREATE TEMP TABLE batch_recipients(user_id UUID PRIMARY KEY,delivery_order INT NOT NULL) ON COMMIT DROP;
  BEGIN
    INSERT INTO batch_recipients(user_id,delivery_order)
    SELECT value::UUID,ordinality::INT FROM JSONB_ARRAY_ELEMENTS_TEXT(p_recipients) WITH ORDINALITY AS recipient(value,ordinality);
  EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('success',FALSE,'message','Duplicate recipients are not allowed');
    WHEN invalid_text_representation THEN RETURN jsonb_build_object('success',FALSE,'message','Invalid recipient id'); END;
  SELECT COUNT(*) INTO v_recipient_count FROM batch_recipients;
  IF v_recipient_count<1 OR v_recipient_count>20 THEN RETURN jsonb_build_object('success',FALSE,'message','Choose 1 to 20 recipients'); END IF;
  IF EXISTS(SELECT 1 FROM batch_recipients WHERE user_id=me) THEN RETURN jsonb_build_object('success',FALSE,'message','You cannot gift yourself'); END IF;
  IF EXISTS(SELECT 1 FROM batch_recipients AS recipient LEFT JOIN public.profiles AS profile_row ON profile_row.id=recipient.user_id
    WHERE profile_row.id IS NULL OR COALESCE(profile_row.is_banned,FALSE)) THEN RETURN jsonb_build_object('success',FALSE,'message','A recipient is unavailable'); END IF;

  SELECT gift_row.diamond_cost,COALESCE(gift_row.bean_value,gift_row.diamond_cost/2),gift_row.name,COALESCE(gift_row.is_active,TRUE),gift_row.required_vip_type
  INTO v_unit_cost,v_bean_value,v_name,v_active,v_required_vip FROM public.gifts AS gift_row WHERE gift_row.id=p_gift_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',FALSE,'message','Gift is not in the active catalog');
  ELSIF NOT v_active THEN RETURN jsonb_build_object('success',FALSE,'message','This gift is unavailable'); END IF;
  IF v_unit_cost IS NULL OR v_unit_cost<=0 THEN RETURN jsonb_build_object('success',FALSE,'message','Invalid gift price'); END IF;
  IF v_required_vip IS NOT NULL THEN
    SELECT profile_row.vip_type,profile_row.vip_expires_at INTO v_sender_vip,v_vip_expires FROM public.profiles AS profile_row WHERE profile_row.id=me;
    IF v_vip_expires IS NULL OR v_vip_expires<=NOW()
      OR (v_required_vip='VIP' AND v_sender_vip NOT IN ('VIP','SVIP','VVIP'))
      OR (v_required_vip='SVIP' AND v_sender_vip NOT IN ('SVIP','VVIP'))
      OR (v_required_vip='VVIP' AND v_sender_vip<>'VVIP')
    THEN RETURN jsonb_build_object('success',FALSE,'message',v_required_vip||' membership is required'); END IF;
  END IF;
  v_total_cost:=v_unit_cost*p_count*v_recipient_count; v_total_beans:=v_bean_value*p_count;
  SELECT profile_row.diamonds INTO v_sender_balance FROM public.profiles AS profile_row
  WHERE profile_row.id=me AND NOT COALESCE(profile_row.is_banned,FALSE) FOR UPDATE;
  IF NOT FOUND OR COALESCE(v_sender_balance,0)<v_total_cost THEN RETURN jsonb_build_object('success',FALSE,'message','Insufficient diamonds'); END IF;
  UPDATE public.profiles SET diamonds=diamonds-v_total_cost,updated_at=NOW() WHERE id=me RETURNING diamonds INTO v_balance_after;
  UPDATE public.profiles AS profile_row SET beans=COALESCE(profile_row.beans,0)+v_total_beans,updated_at=NOW()
  FROM batch_recipients AS recipient WHERE profile_row.id=recipient.user_id;
  INSERT INTO public.gifts_log(sender_id,receiver_id,gift_id,gift_name,diamond_cost,bean_value,count,room_id)
  SELECT me,recipient.user_id,p_gift_id,v_name,v_unit_cost*p_count,v_total_beans,p_count,p_room_id
  FROM batch_recipients AS recipient ORDER BY recipient.delivery_order;
  INSERT INTO public.transactions(user_id,related_user_id,type,currency,amount,status,notes)
  VALUES(me,NULL,'gift_sent','diamond',-v_total_cost,'completed','Atomic batch gift to '||v_recipient_count||' recipients');
  INSERT INTO public.transactions(user_id,related_user_id,type,currency,amount,status,notes)
  SELECT recipient.user_id,me,'gift_received','bean',v_total_beans,'completed','Atomic batch gift'
  FROM batch_recipients AS recipient ORDER BY recipient.delivery_order;
  IF p_room_id IS NOT NULL THEN
    UPDATE public.live_streams AS stream_row
    SET total_gifts=COALESCE(stream_row.total_gifts,0)+p_count,
      total_earnings=COALESCE(stream_row.total_earnings,0)+v_total_beans
    WHERE stream_row.id=p_room_id
      AND EXISTS(SELECT 1 FROM batch_recipients AS recipient WHERE recipient.user_id=stream_row.broadcaster_id);
  END IF;
  RETURN jsonb_build_object('success',TRUE,'delivery_mode','atomic_batch','recipient_count',v_recipient_count,
    'diamonds_spent',v_total_cost,'diamond_balance',v_balance_after,'beans_per_recipient',v_total_beans);
END $$;

-- Persist the configured audio room capacity so reconnects never reset a
-- 12-seat room to a client default of 8.
ALTER TABLE public.live_streams ADD COLUMN IF NOT EXISTS audio_slot_count INT NOT NULL DEFAULT 8;
DO $$ BEGIN
  ALTER TABLE public.live_streams ADD CONSTRAINT live_streams_audio_slot_count_check CHECK(audio_slot_count BETWEEN 1 AND 12);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.set_audio_slot_count(p_stream_id UUID,p_slot_count INT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid();
BEGIN
  IF p_slot_count NOT BETWEEN 1 AND 12 THEN RETURN jsonb_build_object('success',FALSE,'message','Audio slot count must be 1 to 12'); END IF;
  UPDATE public.live_streams AS stream_row SET audio_slot_count=p_slot_count
  WHERE stream_row.id=p_stream_id AND stream_row.broadcaster_id=me AND stream_row.type='audio' AND stream_row.status='live';
  IF NOT FOUND THEN RETURN jsonb_build_object('success',FALSE,'message','Only the audio host can update this running room'); END IF;
  RETURN jsonb_build_object('success',TRUE,'stream_id',p_stream_id,'audio_slot_count',p_slot_count);
END $$;

GRANT EXECUTE ON FUNCTION public.get_host_stats(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_top_gifters(TEXT,INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_top_broadcasters_daily(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agency_host_period_report(UUID,TIMESTAMPTZ,TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_agencies_by_code(TEXT,INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_leave_request(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_agency_member(UUID,UUID,UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.run_anubis_monthly_settlement(DATE) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.run_anubis_monthly_settlement(DATE) TO service_role;
REVOKE ALL ON FUNCTION public.admin_run_anubis_monthly_settlement(DATE) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_run_anubis_monthly_settlement(DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_lucky_bag(BIGINT,INT,UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_gift_batch(JSONB,TEXT,BIGINT,UUID,TEXT,INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_audio_slot_count(UUID,INT) TO authenticated;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.lucky_bag_global_announcements; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.anubis_monthly_ledger; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
NOTIFY pgrst,'reload schema';
