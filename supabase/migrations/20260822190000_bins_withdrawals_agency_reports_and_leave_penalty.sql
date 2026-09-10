-- Bins (beans) holder, universal host withdrawals, agency period reports,
-- and agency-approved leave with a 50,000 diamond penalty.

CREATE TABLE IF NOT EXISTS public.bins_holder_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_id BIGINT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT 'Bins Holder',
  is_login_disabled BOOLEAN NOT NULL DEFAULT TRUE CHECK (is_login_disabled),
  total_bins_received BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.bins_holder_accounts(display_id, name)
VALUES (990001, 'Popular Live Bins Holder')
ON CONFLICT (display_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.bins_withdrawal_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  holder_id UUID NOT NULL REFERENCES public.bins_holder_accounts(id) ON DELETE RESTRICT,
  beans_amount BIGINT NOT NULL CHECK (beans_amount > 0),
  bdt_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','rejected')),
  requester_note TEXT,
  review_note TEXT,
  reviewed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS bins_withdrawal_requester_idx ON public.bins_withdrawal_requests(requester_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bins_withdrawal_admin_idx ON public.bins_withdrawal_requests(status, created_at DESC);

ALTER TABLE public.bins_holder_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bins_withdrawal_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bins_holder_authenticated_read ON public.bins_holder_accounts;
CREATE POLICY bins_holder_authenticated_read ON public.bins_holder_accounts FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS bins_withdrawal_own_or_staff_read ON public.bins_withdrawal_requests;
CREATE POLICY bins_withdrawal_own_or_staff_read ON public.bins_withdrawal_requests FOR SELECT TO authenticated
USING (requester_id = auth.uid() OR public.is_live_staff(auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON public.bins_holder_accounts FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.bins_withdrawal_requests FROM anon, authenticated;
GRANT SELECT ON public.bins_holder_accounts, public.bins_withdrawal_requests TO authenticated;

CREATE OR REPLACE FUNCTION public.request_bins_withdrawal(p_beans_amount BIGINT, p_note TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  me UUID := auth.uid(); v_holder UUID; v_balance BIGINT; v_rate NUMERIC := 1150; v_bdt NUMERIC; v_id UUID; v_role TEXT;
BEGIN
  IF me IS NULL THEN RETURN jsonb_build_object('success',FALSE,'message','Not authenticated'); END IF;
  IF p_beans_amount IS NULL OR p_beans_amount < 1000 THEN RETURN jsonb_build_object('success',FALSE,'message','Minimum withdrawal is 1,000 bins'); END IF;
  SELECT beans, role INTO v_balance, v_role FROM public.profiles WHERE id=me FOR UPDATE;
  IF v_role NOT IN ('host','agency_owner','admin','super_admin') THEN RETURN jsonb_build_object('success',FALSE,'message','Only hosts and agency owners can withdraw bins'); END IF;
  IF COALESCE(v_balance,0) < p_beans_amount THEN RETURN jsonb_build_object('success',FALSE,'message','Insufficient bins'); END IF;
  IF EXISTS (SELECT 1 FROM public.bins_withdrawal_requests WHERE requester_id=me AND status IN ('pending','approved')) THEN
    RETURN jsonb_build_object('success',FALSE,'message','You already have a withdrawal under review');
  END IF;
  SELECT COALESCE(a.payout_rate,1150) INTO v_rate FROM public.profiles p LEFT JOIN public.agencies a ON a.id=p.agency_id WHERE p.id=me;
  v_rate := COALESCE(v_rate,1150);
  v_bdt := ROUND((p_beans_amount::NUMERIC / 100000.0) * v_rate, 2);
  SELECT id INTO v_holder FROM public.bins_holder_accounts ORDER BY created_at LIMIT 1 FOR UPDATE;
  UPDATE public.profiles SET beans=beans-p_beans_amount WHERE id=me;
  UPDATE public.bins_holder_accounts SET total_bins_received=total_bins_received+p_beans_amount WHERE id=v_holder;
  INSERT INTO public.bins_withdrawal_requests(requester_id,holder_id,beans_amount,bdt_value,requester_note)
  VALUES(me,v_holder,p_beans_amount,v_bdt,NULLIF(BTRIM(p_note),'')) RETURNING id INTO v_id;
  INSERT INTO public.transactions(user_id,type,currency,amount,balance_after,related_entity_type,related_entity_id,status,notes)
  VALUES(me,'bins_withdrawal','bean',-p_beans_amount,v_balance-p_beans_amount,'bins_withdrawal',v_id,'pending','Bins sent to holder account 990001');
  RETURN jsonb_build_object('success',TRUE,'request_id',v_id,'bdt_value',v_bdt,'holder_display_id',990001,'balance_after',v_balance-p_beans_amount);
END $$;

CREATE OR REPLACE FUNCTION public.admin_review_bins_withdrawal(p_request_id UUID,p_status TEXT,p_note TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid(); r public.bins_withdrawal_requests%ROWTYPE;
BEGIN
  IF NOT public.is_live_staff(me) THEN RETURN jsonb_build_object('success',FALSE,'message','Admin access required'); END IF;
  IF p_status NOT IN ('approved','paid','rejected') THEN RETURN jsonb_build_object('success',FALSE,'message','Invalid status'); END IF;
  SELECT * INTO r FROM public.bins_withdrawal_requests WHERE id=p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RETURN jsonb_build_object('success',FALSE,'message','Request not found'); END IF;
  IF r.status IN ('paid','rejected') THEN RETURN jsonb_build_object('success',FALSE,'message','Request already closed'); END IF;
  IF p_status='rejected' THEN
    UPDATE public.profiles SET beans=beans+r.beans_amount WHERE id=r.requester_id;
    UPDATE public.bins_holder_accounts SET total_bins_received=GREATEST(0,total_bins_received-r.beans_amount) WHERE id=r.holder_id;
    UPDATE public.transactions SET status='reversed',notes=COALESCE(NULLIF(BTRIM(p_note),''),'Bins withdrawal rejected and refunded') WHERE related_entity_type='bins_withdrawal' AND related_entity_id=r.id;
  ELSE
    UPDATE public.transactions SET status=CASE WHEN p_status='paid' THEN 'completed' ELSE 'pending' END WHERE related_entity_type='bins_withdrawal' AND related_entity_id=r.id;
  END IF;
  UPDATE public.bins_withdrawal_requests SET status=p_status,review_note=NULLIF(BTRIM(p_note),''),reviewed_by=me,reviewed_at=NOW(),paid_at=CASE WHEN p_status='paid' THEN NOW() ELSE paid_at END WHERE id=r.id;
  INSERT INTO public.notifications(user_id,type,title,body,payload) VALUES(r.requester_id,'bins_withdrawal','Bins withdrawal '||p_status,'Your '||r.beans_amount||' bins withdrawal is '||p_status,jsonb_build_object('request_id',r.id,'status',p_status));
  RETURN jsonb_build_object('success',TRUE);
END $$;

CREATE OR REPLACE FUNCTION public.agency_host_period_report(p_agency_id UUID,p_start TIMESTAMPTZ,p_end TIMESTAMPTZ)
RETURNS TABLE(host_id UUID,host_name TEXT,host_display_id BIGINT,report_day DATE,income BIGINT,live_minutes BIGINT,live_sessions BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid();
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.agencies WHERE id=p_agency_id AND owner_id=me) AND NOT public.is_live_staff(me) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN QUERY
  WITH members AS (SELECT am.host_id FROM public.agency_members am WHERE am.agency_id=p_agency_id AND am.status IN ('active','leave_pending','released')),
  days AS (
    SELECT m.host_id,(t.created_at AT TIME ZONE 'Asia/Dhaka')::DATE AS report_date,SUM(t.amount)::BIGINT AS income
    FROM members m JOIN public.transactions t ON t.user_id=m.host_id
    WHERE t.status='completed' AND t.currency='bean' AND t.amount>0 AND t.type IN ('gift_received','live_hour_reward') AND t.created_at>=p_start AND t.created_at<p_end GROUP BY m.host_id,report_date
  ), lives AS (
    SELECT m.host_id,(l.started_at AT TIME ZONE 'Asia/Dhaka')::DATE AS report_date,COUNT(*)::BIGINT AS sessions,
      ROUND(SUM(GREATEST(EXTRACT(EPOCH FROM (COALESCE(l.ended_at,NOW())-l.started_at))/60,0)))::BIGINT AS minutes
    FROM members m JOIN public.live_streams l ON l.broadcaster_id=m.host_id
    WHERE l.started_at>=p_start AND l.started_at<p_end GROUP BY m.host_id,report_date
  ), keys AS (SELECT host_id,report_date FROM days UNION SELECT host_id,report_date FROM lives)
  SELECT p.id,p.full_name,p.display_id,k.report_date,COALESCE(d.income,0),COALESCE(l.minutes,0),COALESCE(l.sessions,0)
  FROM keys k JOIN public.profiles p ON p.id=k.host_id LEFT JOIN days d ON d.host_id=k.host_id AND d.report_date=k.report_date LEFT JOIN lives l ON l.host_id=k.host_id AND l.report_date=k.report_date
  ORDER BY k.report_date DESC,p.full_name;
END $$;

CREATE OR REPLACE FUNCTION public.approve_leave_request(p_host_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid(); v_agency UUID; v_diamonds BIGINT; v_penalty CONSTANT BIGINT:=50000;
BEGIN
  SELECT agency_id INTO v_agency FROM public.agency_members WHERE host_id=p_host_id AND status='leave_pending' FOR UPDATE;
  IF v_agency IS NULL THEN RETURN json_build_object('success',FALSE,'message','No pending leave request'); END IF;
  IF NOT EXISTS(SELECT 1 FROM public.agencies WHERE id=v_agency AND owner_id=me) THEN RETURN json_build_object('success',FALSE,'message','Not your agency'); END IF;
  SELECT diamonds INTO v_diamonds FROM public.profiles WHERE id=p_host_id FOR UPDATE;
  IF COALESCE(v_diamonds,0)<v_penalty THEN RETURN json_build_object('success',FALSE,'message','Host needs 50,000 diamonds for the leave penalty'); END IF;
  UPDATE public.profiles SET diamonds=diamonds-v_penalty,agency_id=NULL WHERE id=p_host_id;
  UPDATE public.agency_members SET status='released',released_at=NOW() WHERE host_id=p_host_id AND agency_id=v_agency;
  UPDATE public.agencies SET member_count=GREATEST(0,COALESCE(member_count,0)-1) WHERE id=v_agency;
  INSERT INTO public.transactions(user_id,type,currency,amount,balance_after,status,notes) VALUES(p_host_id,'agency_leave_penalty','diamond',-v_penalty,v_diamonds-v_penalty,'completed','Approved agency leave penalty');
  INSERT INTO public.notifications(user_id,type,title,body,payload) VALUES(p_host_id,'agency_leave_approved','Agency leave approved','Your agency approved the leave request. 50,000 diamonds were deducted.','{}');
  RETURN json_build_object('success',TRUE,'penalty',v_penalty,'balance_after',v_diamonds-v_penalty);
END $$;

GRANT EXECUTE ON FUNCTION public.request_bins_withdrawal(BIGINT,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_review_bins_withdrawal(UUID,TEXT,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agency_host_period_report(UUID,TIMESTAMPTZ,TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_leave_request(UUID) TO authenticated;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.bins_withdrawal_requests; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
NOTIFY pgrst,'reload schema';
