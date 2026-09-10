-- Green Live feature expansion: agencies, live eligibility/feed, banners,
-- nicknames, expiring cosmetics and cumulative daily host rewards.
-- Idempotent and intended to be run after migration 127.

-- ------------------------------------------------------------------
-- Shared helpers
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_live_staff(p_user UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_user AND role IN ('admin', 'super_admin')
  );
$$;

-- ------------------------------------------------------------------
-- Agency applications and admin-owned membership lifecycle
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agency_join_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  applicant_note TEXT,
  review_note TEXT,
  reviewed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS agency_join_requests_one_pending_user
  ON public.agency_join_requests(user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS agency_join_requests_queue_idx
  ON public.agency_join_requests(status, created_at DESC);
-- Heal legacy duplicates before adding the invariant. Keep the newest
-- active membership and release every older active row for that host.
WITH ranked AS (
  SELECT ctid, ROW_NUMBER() OVER (
    PARTITION BY host_id ORDER BY joined_at DESC NULLS LAST, id DESC
  ) AS position
  FROM public.agency_members
  WHERE status = 'active'
)
UPDATE public.agency_members m
SET status = 'released', released_at = COALESCE(m.released_at, NOW())
FROM ranked r
WHERE m.ctid = r.ctid AND r.position > 1;
CREATE UNIQUE INDEX IF NOT EXISTS agency_members_one_active_host
  ON public.agency_members(host_id) WHERE status = 'active';

ALTER TABLE public.agency_join_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agency_join_requests_own_read ON public.agency_join_requests;
CREATE POLICY agency_join_requests_own_read ON public.agency_join_requests
  FOR SELECT USING (user_id = auth.uid() OR public.is_live_staff(auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON public.agency_join_requests FROM anon, authenticated;
GRANT SELECT ON public.agency_join_requests TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_agency_join_request(
  p_agency_id UUID, p_note TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE me UUID := auth.uid(); v_id UUID; v_name TEXT;
BEGIN
  IF me IS NULL THEN RETURN jsonb_build_object('success', FALSE, 'message', 'Authentication required'); END IF;
  IF EXISTS (SELECT 1 FROM public.agency_members WHERE host_id = me AND status = 'active') THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'You already belong to an agency');
  END IF;
  IF EXISTS (SELECT 1 FROM public.agency_join_requests WHERE user_id = me AND status = 'pending') THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'You already have a pending application');
  END IF;
  SELECT name INTO v_name FROM public.agencies WHERE id = p_agency_id AND status = 'verified';
  IF v_name IS NULL THEN RETURN jsonb_build_object('success', FALSE, 'message', 'Agency is unavailable'); END IF;
  INSERT INTO public.agency_join_requests(user_id, agency_id, applicant_note)
  VALUES (me, p_agency_id, NULLIF(BTRIM(p_note), '')) RETURNING id INTO v_id;
  INSERT INTO public.notifications(user_id, type, title, body, payload)
  VALUES (me, 'agency_request', 'Application sent', 'Your application to ' || v_name || ' is awaiting admin review', jsonb_build_object('request_id', v_id));
  RETURN jsonb_build_object('success', TRUE, 'request_id', v_id);
END $$;

CREATE OR REPLACE FUNCTION public.cancel_agency_join_request(p_request_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.agency_join_requests SET status='cancelled', updated_at=NOW()
  WHERE id=p_request_id AND user_id=auth.uid() AND status='pending';
  IF NOT FOUND THEN RETURN jsonb_build_object('success', FALSE, 'message', 'Pending request not found'); END IF;
  RETURN jsonb_build_object('success', TRUE);
END $$;

CREATE OR REPLACE FUNCTION public.admin_assign_agency_host(
  p_user_id UUID, p_agency_id UUID, p_request_id UUID DEFAULT NULL,
  p_review_note TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE me UUID := auth.uid(); v_name TEXT;
BEGIN
  IF NOT public.is_live_staff(me) THEN RETURN jsonb_build_object('success', FALSE, 'message', 'Admin access required'); END IF;
  SELECT name INTO v_name FROM public.agencies WHERE id=p_agency_id AND status='verified' FOR UPDATE;
  IF v_name IS NULL THEN RETURN jsonb_build_object('success', FALSE, 'message', 'Verified agency not found'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id=p_user_id AND NOT COALESCE(is_banned,FALSE)) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Eligible user not found');
  END IF;
  UPDATE public.agency_members SET status='released', released_at=NOW()
   WHERE host_id=p_user_id AND status IN ('active','pending','leave_pending');
  INSERT INTO public.agency_members(agency_id, host_id, status, joined_at, released_at)
  VALUES(p_agency_id,p_user_id,'active',NOW(),NULL)
  ON CONFLICT(agency_id,host_id) DO UPDATE SET status='active',joined_at=NOW(),released_at=NULL;
  UPDATE public.profiles SET agency_id=p_agency_id, role=CASE WHEN role='user' THEN 'host' ELSE role END, updated_at=NOW() WHERE id=p_user_id;
  UPDATE public.agency_join_requests SET status='rejected',reviewed_by=me,reviewed_at=NOW(),updated_at=NOW(),review_note='Assigned to another agency'
   WHERE user_id=p_user_id AND status='pending' AND (p_request_id IS NULL OR id<>p_request_id);
  IF p_request_id IS NOT NULL THEN
    UPDATE public.agency_join_requests SET status='approved',agency_id=p_agency_id,reviewed_by=me,reviewed_at=NOW(),updated_at=NOW(),review_note=NULLIF(BTRIM(p_review_note),'')
     WHERE id=p_request_id AND user_id=p_user_id AND status='pending';
  END IF;
  UPDATE public.agencies a
  SET member_count=(SELECT COUNT(*) FROM public.agency_members m WHERE m.agency_id=a.id AND m.status='active')
  WHERE a.id=p_agency_id OR EXISTS(SELECT 1 FROM public.agency_members affected WHERE affected.agency_id=a.id AND affected.host_id=p_user_id);
  INSERT INTO public.notifications(user_id,type,title,body,payload)
  VALUES(p_user_id,'agency_approved','Agency approved','You are now a host in '||v_name,jsonb_build_object('agency_id',p_agency_id));
  INSERT INTO public.admin_audit_log(admin_id,action,target_type,target_id,payload)
  VALUES(me,'assign_agency_host','profile',p_user_id,jsonb_build_object('agency_id',p_agency_id,'request_id',p_request_id,'note',p_review_note));
  RETURN jsonb_build_object('success',TRUE,'agency_id',p_agency_id,'agency_name',v_name);
END $$;

CREATE OR REPLACE FUNCTION public.admin_review_agency_request(
  p_request_id UUID, p_approve BOOLEAN, p_agency_id UUID DEFAULT NULL, p_review_note TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE me UUID:=auth.uid(); r public.agency_join_requests%ROWTYPE;
BEGIN
  IF NOT public.is_live_staff(me) THEN RETURN jsonb_build_object('success',FALSE,'message','Admin access required'); END IF;
  SELECT * INTO r FROM public.agency_join_requests WHERE id=p_request_id AND status='pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',FALSE,'message','Pending request not found'); END IF;
  IF p_approve THEN RETURN public.admin_assign_agency_host(r.user_id,COALESCE(p_agency_id,r.agency_id),r.id,p_review_note); END IF;
  UPDATE public.agency_join_requests SET status='rejected',reviewed_by=me,reviewed_at=NOW(),updated_at=NOW(),review_note=NULLIF(BTRIM(p_review_note),'') WHERE id=r.id;
  INSERT INTO public.notifications(user_id,type,title,body,payload) VALUES(r.user_id,'agency_rejected','Agency application reviewed',COALESCE(NULLIF(BTRIM(p_review_note),''),'Your agency application was not approved'),jsonb_build_object('request_id',r.id));
  INSERT INTO public.admin_audit_log(admin_id,action,target_type,target_id,payload) VALUES(me,'reject_agency_request','profile',r.user_id,jsonb_build_object('request_id',r.id,'note',p_review_note));
  RETURN jsonb_build_object('success',TRUE);
END $$;

CREATE OR REPLACE FUNCTION public.admin_release_agency_host(p_user_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid();
BEGIN
  IF NOT public.is_live_staff(me) THEN RETURN jsonb_build_object('success',FALSE,'message','Admin access required'); END IF;
  UPDATE public.agency_members SET status='released',released_at=NOW() WHERE host_id=p_user_id AND status IN ('active','pending','leave_pending');
  UPDATE public.profiles SET agency_id=NULL,updated_at=NOW() WHERE id=p_user_id;
  UPDATE public.agencies a
  SET member_count=(SELECT COUNT(*) FROM public.agency_members m WHERE m.agency_id=a.id AND m.status='active')
  WHERE EXISTS(SELECT 1 FROM public.agency_members affected WHERE affected.agency_id=a.id AND affected.host_id=p_user_id);
  INSERT INTO public.notifications(user_id,type,title,body,payload) VALUES(p_user_id,'agency_released','Agency membership ended',COALESCE(NULLIF(BTRIM(p_reason),''),'An admin ended your agency membership'),'{}');
  INSERT INTO public.admin_audit_log(admin_id,action,target_type,target_id,payload) VALUES(me,'release_agency_host','profile',p_user_id,jsonb_build_object('reason',p_reason));
  RETURN jsonb_build_object('success',TRUE);
END $$;

-- Agency owners may no longer activate hosts through the old RPC.
CREATE OR REPLACE FUNCTION public.approve_agency_member(p_agency_id UUID,p_host_id UUID,p_owner_id UUID)
RETURNS JSON LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT json_build_object('success',false,'message','Only a dashboard admin can approve agency hosts');
$$;
CREATE OR REPLACE FUNCTION public.release_agency_member(p_agency_id UUID,p_owner_id UUID,p_host_id UUID)
RETURNS JSON LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$ SELECT json_build_object('success',false,'message','Only a dashboard admin can release agency hosts'); $$;
CREATE OR REPLACE FUNCTION public.reject_agency_join(p_agency_id UUID,p_owner_id UUID,p_host_id UUID)
RETURNS JSON LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$ SELECT json_build_object('success',false,'message','Only a dashboard admin can review agency requests'); $$;
CREATE OR REPLACE FUNCTION public.approve_leave_request(p_host_id UUID)
RETURNS JSON LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$ SELECT json_build_object('success',false,'message','Only a dashboard admin can release agency hosts'); $$;
CREATE OR REPLACE FUNCTION public.reject_leave_request(p_host_id UUID)
RETURNS JSON LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$ SELECT json_build_object('success',false,'message','Only a dashboard admin can manage agency membership'); $$;

-- ------------------------------------------------------------------
-- Live eligibility and dynamic viewer feed
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_live_stream(
  p_broadcaster_id UUID,p_type TEXT,p_title TEXT,p_tag TEXT,p_cover_url TEXT
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid(); v_id UUID; v_profile public.profiles%ROWTYPE;
BEGIN
  IF me IS NULL OR me<>p_broadcaster_id THEN RETURN json_build_object('success',false,'code','not_authenticated','message','Authentication required'); END IF;
  SELECT * INTO v_profile FROM public.profiles WHERE id=me;
  IF NOT FOUND OR COALESCE(v_profile.is_banned,FALSE) THEN RETURN json_build_object('success',false,'code','account_blocked','message','This account cannot start live'); END IF;
  -- Only a plain user needs an approved agency membership. Every elevated
  -- profile role can broadcast, and an actual agency owner is also exempt
  -- even if a legacy profile still has role='user'.
  IF COALESCE(LOWER(NULLIF(BTRIM(v_profile.role),'')),'user')='user'
    AND NOT EXISTS(SELECT 1 FROM public.agencies owned WHERE owned.owner_id=me)
    AND NOT EXISTS(
    SELECT 1 FROM public.agency_members am JOIN public.agencies a ON a.id=am.agency_id
    WHERE am.host_id=me AND am.status='active' AND a.status='verified'
  ) THEN
    RETURN json_build_object('success',false,'code','agency_required','message','Join an approved agency before starting live');
  END IF;
  UPDATE public.live_streams SET status='ended',ended_at=COALESCE(ended_at,NOW()),current_viewers=0 WHERE broadcaster_id=me AND status='live';
  INSERT INTO public.live_streams(broadcaster_id,type,title,tag,cover_url)
  VALUES(me,CASE WHEN p_type='audio' THEN 'audio' ELSE 'video' END,NULLIF(BTRIM(p_title),''),NULLIF(BTRIM(p_tag),''),p_cover_url) RETURNING id INTO v_id;
  RETURN json_build_object('success',true,'stream_id',v_id);
END $$;

CREATE OR REPLACE FUNCTION public.get_active_live_feed(
  p_tag TEXT DEFAULT NULL,p_type TEXT DEFAULT NULL,p_country TEXT DEFAULT NULL,p_offset INT DEFAULT 0,p_limit INT DEFAULT 20
) RETURNS TABLE(stream_id UUID,broadcaster_id UUID,type TEXT,title TEXT,tag TEXT,cover_url TEXT,current_viewers INT,total_gifts BIGINT,started_at TIMESTAMPTZ,full_name TEXT,avatar_url TEXT,country TEXT,vip_type TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT l.id,l.broadcaster_id,l.type,l.title,l.tag,l.cover_url,COALESCE(l.current_viewers,0),COALESCE(l.total_gifts,0)::BIGINT,l.started_at,p.full_name,p.avatar_url,p.country,p.vip_type
  FROM public.live_streams l JOIN public.profiles p ON p.id=l.broadcaster_id
  WHERE l.status='live' AND NOT COALESCE(p.is_banned,FALSE)
    AND COALESCE(l.last_heartbeat_at,l.started_at)>NOW()-INTERVAL '5 minutes'
    AND (p_tag IS NULL OR l.tag=p_tag)
    AND (p_type IS NULL OR l.type=p_type)
    AND (p_country IS NULL OR p.country=p_country)
  ORDER BY l.current_viewers DESC,l.total_gifts DESC,l.started_at DESC
  OFFSET GREATEST(COALESCE(p_offset,0),0) LIMIT LEAST(GREATEST(COALESCE(p_limit,20),1),50);
$$;

-- ------------------------------------------------------------------
-- Banner placement limit: five active rows per position.
-- ------------------------------------------------------------------
ALTER TABLE public.home_banners ADD COLUMN IF NOT EXISTS position TEXT NOT NULL DEFAULT 'top';
CREATE OR REPLACE FUNCTION public.enforce_home_banner_limit()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.is_active AND (SELECT COUNT(*) FROM public.home_banners WHERE is_active AND position=NEW.position AND id<>NEW.id)>=5 THEN
    RAISE EXCEPTION 'Only 5 active % banners are allowed',NEW.position;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS home_banners_max_five ON public.home_banners;
CREATE TRIGGER home_banners_max_five BEFORE INSERT OR UPDATE OF is_active,position ON public.home_banners FOR EACH ROW EXECUTE FUNCTION public.enforce_home_banner_limit();

-- ------------------------------------------------------------------
-- Nickname applications
-- ------------------------------------------------------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS nickname TEXT;
CREATE TABLE IF NOT EXISTS public.nickname_applications(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  requested_nickname TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected','cancelled')),
  review_note TEXT,reviewed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS nickname_one_pending_user ON public.nickname_applications(user_id) WHERE status='pending';
ALTER TABLE public.nickname_applications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nickname_apps_own_read ON public.nickname_applications;
CREATE POLICY nickname_apps_own_read ON public.nickname_applications FOR SELECT USING(user_id=auth.uid() OR public.is_live_staff(auth.uid()));
REVOKE INSERT,UPDATE,DELETE ON public.nickname_applications FROM anon,authenticated;
GRANT SELECT ON public.nickname_applications TO authenticated;

CREATE OR REPLACE FUNCTION public.nickname_is_valid(p_value TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT char_length(BTRIM(COALESCE(p_value,''))) BETWEEN 2 AND 24 AND BTRIM(COALESCE(p_value,'')) !~ '[[:cntrl:]]';
$$;
CREATE OR REPLACE FUNCTION public.submit_nickname_application(p_nickname TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid(); v TEXT:=BTRIM(p_nickname); v_id UUID;
BEGIN
  IF me IS NULL OR NOT public.nickname_is_valid(v) THEN RETURN jsonb_build_object('success',FALSE,'message','Nickname must be 2–24 characters and contain no control characters'); END IF;
  IF EXISTS(SELECT 1 FROM public.nickname_applications WHERE user_id=me AND status='pending') THEN RETURN jsonb_build_object('success',FALSE,'message','You already have a pending nickname request'); END IF;
  INSERT INTO public.nickname_applications(user_id,requested_nickname) VALUES(me,v) RETURNING id INTO v_id;
  RETURN jsonb_build_object('success',TRUE,'application_id',v_id);
END $$;
CREATE OR REPLACE FUNCTION public.admin_review_nickname_application(p_application_id UUID,p_approve BOOLEAN,p_note TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid(); r public.nickname_applications%ROWTYPE;
BEGIN
  IF NOT public.is_live_staff(me) THEN RETURN jsonb_build_object('success',FALSE,'message','Admin access required'); END IF;
  SELECT * INTO r FROM public.nickname_applications WHERE id=p_application_id AND status='pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',FALSE,'message','Pending application not found'); END IF;
  UPDATE public.nickname_applications SET status=CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,review_note=NULLIF(BTRIM(p_note),''),reviewed_by=me,reviewed_at=NOW(),updated_at=NOW() WHERE id=r.id;
  IF p_approve THEN UPDATE public.profiles SET nickname=r.requested_nickname,updated_at=NOW() WHERE id=r.user_id; END IF;
  INSERT INTO public.notifications(user_id,type,title,body,payload) VALUES(r.user_id,'nickname_review',CASE WHEN p_approve THEN 'Nickname approved' ELSE 'Nickname request reviewed' END,CASE WHEN p_approve THEN r.requested_nickname ELSE COALESCE(NULLIF(BTRIM(p_note),''),'Your nickname request was not approved') END,jsonb_build_object('application_id',r.id));
  INSERT INTO public.admin_audit_log(admin_id,action,target_type,target_id,payload) VALUES(me,'review_nickname','profile',r.user_id,jsonb_build_object('approved',p_approve,'nickname',r.requested_nickname,'note',p_note));
  RETURN jsonb_build_object('success',TRUE);
END $$;
CREATE OR REPLACE FUNCTION public.admin_set_user_nickname(p_user_id UUID,p_nickname TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid(); v TEXT:=NULLIF(BTRIM(p_nickname),'');
BEGIN
  IF NOT public.is_live_staff(me) THEN RETURN jsonb_build_object('success',FALSE,'message','Admin access required'); END IF;
  IF v IS NOT NULL AND NOT public.nickname_is_valid(v) THEN RETURN jsonb_build_object('success',FALSE,'message','Nickname must be 2–24 characters'); END IF;
  UPDATE public.profiles SET nickname=v,updated_at=NOW() WHERE id=p_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',FALSE,'message','User not found'); END IF;
  INSERT INTO public.admin_audit_log(admin_id,action,target_type,target_id,payload) VALUES(me,'set_nickname','profile',p_user_id,jsonb_build_object('nickname',v));
  RETURN jsonb_build_object('success',TRUE,'nickname',v);
END $$;

-- ------------------------------------------------------------------
-- Expiring profile frames and mall intros
-- ------------------------------------------------------------------
ALTER TABLE public.profile_frames ADD COLUMN IF NOT EXISTS validity_days INT NOT NULL DEFAULT 7 CHECK(validity_days>0), ADD COLUMN IF NOT EXISTS access_scope TEXT NOT NULL DEFAULT 'public' CHECK(access_scope IN('public','admin_only'));
ALTER TABLE public.mall_intro_items ADD COLUMN IF NOT EXISTS validity_days INT NOT NULL DEFAULT 7 CHECK(validity_days>0), ADD COLUMN IF NOT EXISTS access_scope TEXT NOT NULL DEFAULT 'public' CHECK(access_scope IN('public','admin_only'));
ALTER TABLE public.user_profile_frames ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS acquisition_source TEXT NOT NULL DEFAULT 'purchase';
ALTER TABLE public.user_mall_intros ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS acquisition_source TEXT NOT NULL DEFAULT 'purchase';
UPDATE public.user_profile_frames u SET expires_at=acquired_at+make_interval(days=>f.validity_days) FROM public.profile_frames f WHERE f.id=u.frame_id AND u.expires_at IS NULL AND u.acquisition_source<>'admin_permanent';
UPDATE public.user_mall_intros u SET expires_at=acquired_at+make_interval(days=>i.validity_days) FROM public.mall_intro_items i WHERE i.id=u.intro_id AND u.expires_at IS NULL AND u.acquisition_source<>'admin_permanent';
DROP POLICY IF EXISTS "profile frames public read" ON public.profile_frames;
CREATE POLICY "profile frames public read" ON public.profile_frames FOR SELECT USING((is_active AND access_scope='public') OR public.is_super_admin(auth.uid()) OR EXISTS(SELECT 1 FROM public.user_profile_frames u WHERE u.frame_id=id AND u.user_id=auth.uid() AND (u.expires_at IS NULL OR u.expires_at>NOW())));
DROP POLICY IF EXISTS "mall intro public read" ON public.mall_intro_items;
CREATE POLICY "mall intro public read" ON public.mall_intro_items FOR SELECT USING((is_active AND access_scope='public') OR public.is_super_admin(auth.uid()) OR EXISTS(SELECT 1 FROM public.user_mall_intros u WHERE u.intro_id=id AND u.user_id=auth.uid() AND (u.expires_at IS NULL OR u.expires_at>NOW())));

CREATE OR REPLACE FUNCTION public.cleanup_expired_cosmetics(p_user UUID DEFAULT auth.uid()) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  UPDATE public.profiles p SET selected_profile_frame=NULL,selected_profile_frame_url=NULL
   WHERE p.id=p_user AND p.selected_profile_frame IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.user_profile_frames u WHERE u.user_id=p.id AND u.frame_id=p.selected_profile_frame AND (u.expires_at IS NULL OR u.expires_at>NOW()));
  UPDATE public.profiles p SET selected_mall_intro=NULL,selected_mall_intro_video_url=NULL,selected_mall_intro_thumbnail_url=NULL
   WHERE p.id=p_user AND p.selected_mall_intro IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.user_mall_intros u WHERE u.user_id=p.id AND u.intro_id=p.selected_mall_intro AND (u.expires_at IS NULL OR u.expires_at>NOW()));
  RETURN jsonb_build_object('success',TRUE);
END $$;

CREATE OR REPLACE FUNCTION public.equip_cosmetic(p_kind TEXT,p_item_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid();
BEGIN
  IF p_kind='frame' AND EXISTS(SELECT 1 FROM public.user_profile_frames WHERE user_id=me AND frame_id=p_item_id AND (expires_at IS NULL OR expires_at>NOW())) THEN
    UPDATE public.profiles p SET selected_profile_frame=p_item_id,selected_profile_frame_url=f.frame_url,updated_at=NOW() FROM public.profile_frames f WHERE p.id=me AND f.id=p_item_id;
  ELSIF p_kind='intro' AND EXISTS(SELECT 1 FROM public.user_mall_intros WHERE user_id=me AND intro_id=p_item_id AND (expires_at IS NULL OR expires_at>NOW())) THEN
    UPDATE public.profiles p SET selected_mall_intro=p_item_id,selected_mall_intro_video_url=i.video_url,selected_mall_intro_thumbnail_url=i.thumbnail_url,updated_at=NOW() FROM public.mall_intro_items i WHERE p.id=me AND i.id=p_item_id;
  ELSE RETURN jsonb_build_object('success',FALSE,'message','This item is not owned or has expired'); END IF;
  RETURN jsonb_build_object('success',TRUE);
END $$;

CREATE OR REPLACE FUNCTION public.purchase_profile_frame(p_frame_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid(); f public.profile_frames%ROWTYPE; bal BIGINT; exp TIMESTAMPTZ;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO f FROM public.profile_frames WHERE id=p_frame_id AND is_active AND access_scope='public';
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile frame is unavailable'; END IF;
  SELECT diamonds INTO bal FROM public.profiles WHERE id=me FOR UPDATE;
  IF bal<f.diamond_cost THEN RAISE EXCEPTION 'Insufficient diamonds'; END IF;
  UPDATE public.profiles SET diamonds=diamonds-f.diamond_cost WHERE id=me;
  INSERT INTO public.user_profile_frames(user_id,frame_id,expires_at,acquisition_source)
  VALUES(me,p_frame_id,NOW()+make_interval(days=>f.validity_days),'purchase')
  ON CONFLICT(user_id,frame_id) DO UPDATE SET expires_at=GREATEST(COALESCE(user_profile_frames.expires_at,NOW()),NOW())+make_interval(days=>f.validity_days),acquired_at=NOW(),acquisition_source='purchase'
  RETURNING expires_at INTO exp;
  UPDATE public.profiles SET owned_profile_frames=CASE WHEN p_frame_id=ANY(owned_profile_frames) THEN owned_profile_frames ELSE array_append(owned_profile_frames,p_frame_id) END,selected_profile_frame=p_frame_id,selected_profile_frame_url=f.frame_url,updated_at=NOW() WHERE id=me;
  RETURN jsonb_build_object('success',TRUE,'frame_id',p_frame_id,'frame_url',f.frame_url,'price',f.diamond_cost,'expires_at',exp,'selected',TRUE);
END $$;

CREATE OR REPLACE FUNCTION public.gift_profile_frame(p_frame_id TEXT,p_recipient_display_id BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid(); recipient UUID; f public.profile_frames%ROWTYPE; bal BIGINT; exp TIMESTAMPTZ;
BEGIN
  SELECT id INTO recipient FROM public.profiles WHERE display_id=p_recipient_display_id AND NOT COALESCE(is_banned,FALSE);
  IF recipient IS NULL OR recipient=me THEN RAISE EXCEPTION 'Eligible recipient not found'; END IF;
  SELECT * INTO f FROM public.profile_frames WHERE id=p_frame_id AND is_active AND access_scope='public'; IF NOT FOUND THEN RAISE EXCEPTION 'Profile frame is unavailable'; END IF;
  SELECT diamonds INTO bal FROM public.profiles WHERE id=me FOR UPDATE; IF bal<f.diamond_cost THEN RAISE EXCEPTION 'Insufficient diamonds'; END IF;
  UPDATE public.profiles SET diamonds=diamonds-f.diamond_cost WHERE id=me;
  INSERT INTO public.user_profile_frames(user_id,frame_id,gifted_by,expires_at,acquisition_source) VALUES(recipient,p_frame_id,me,NOW()+make_interval(days=>f.validity_days),'gift')
  ON CONFLICT(user_id,frame_id) DO UPDATE SET expires_at=GREATEST(COALESCE(user_profile_frames.expires_at,NOW()),NOW())+make_interval(days=>f.validity_days),gifted_by=me,acquired_at=NOW(),acquisition_source='gift' RETURNING expires_at INTO exp;
  UPDATE public.profiles SET owned_profile_frames=CASE WHEN p_frame_id=ANY(owned_profile_frames) THEN owned_profile_frames ELSE array_append(owned_profile_frames,p_frame_id) END WHERE id=recipient;
  RETURN jsonb_build_object('success',TRUE,'recipient_id',recipient,'price',f.diamond_cost,'expires_at',exp);
END $$;

CREATE OR REPLACE FUNCTION public.purchase_mall_intro(p_intro_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid(); i public.mall_intro_items%ROWTYPE; bal BIGINT; exp TIMESTAMPTZ;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO i FROM public.mall_intro_items WHERE id=p_intro_id AND is_active AND access_scope='public'; IF NOT FOUND THEN RAISE EXCEPTION 'Intro is unavailable'; END IF;
  SELECT diamonds INTO bal FROM public.profiles WHERE id=me FOR UPDATE; IF bal<i.diamond_cost THEN RAISE EXCEPTION 'Insufficient diamonds'; END IF;
  UPDATE public.profiles SET diamonds=diamonds-i.diamond_cost WHERE id=me;
  INSERT INTO public.user_mall_intros(user_id,intro_id,expires_at,acquisition_source) VALUES(me,p_intro_id,NOW()+make_interval(days=>i.validity_days),'purchase')
  ON CONFLICT(user_id,intro_id) DO UPDATE SET expires_at=GREATEST(COALESCE(user_mall_intros.expires_at,NOW()),NOW())+make_interval(days=>i.validity_days),acquired_at=NOW(),acquisition_source='purchase' RETURNING expires_at INTO exp;
  UPDATE public.profiles SET owned_mall_intros=CASE WHEN p_intro_id=ANY(owned_mall_intros) THEN owned_mall_intros ELSE array_append(owned_mall_intros,p_intro_id) END,selected_mall_intro=p_intro_id,selected_mall_intro_video_url=i.video_url,selected_mall_intro_thumbnail_url=i.thumbnail_url,updated_at=NOW() WHERE id=me;
  RETURN jsonb_build_object('success',TRUE,'intro_id',p_intro_id,'video_url',i.video_url,'thumbnail_url',i.thumbnail_url,'price',i.diamond_cost,'expires_at',exp,'selected',TRUE);
END $$;

CREATE OR REPLACE FUNCTION public.gift_mall_intro(p_intro_id TEXT,p_recipient_display_id BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid(); recipient UUID; i public.mall_intro_items%ROWTYPE; bal BIGINT; exp TIMESTAMPTZ;
BEGIN
  SELECT id INTO recipient FROM public.profiles WHERE display_id=p_recipient_display_id AND NOT COALESCE(is_banned,FALSE);
  IF recipient IS NULL OR recipient=me THEN RAISE EXCEPTION 'Eligible recipient not found'; END IF;
  SELECT * INTO i FROM public.mall_intro_items WHERE id=p_intro_id AND is_active AND access_scope='public'; IF NOT FOUND THEN RAISE EXCEPTION 'Intro is unavailable'; END IF;
  SELECT diamonds INTO bal FROM public.profiles WHERE id=me FOR UPDATE; IF bal<i.diamond_cost THEN RAISE EXCEPTION 'Insufficient diamonds'; END IF;
  UPDATE public.profiles SET diamonds=diamonds-i.diamond_cost WHERE id=me;
  INSERT INTO public.user_mall_intros(user_id,intro_id,gifted_by,expires_at,acquisition_source) VALUES(recipient,p_intro_id,me,NOW()+make_interval(days=>i.validity_days),'gift')
  ON CONFLICT(user_id,intro_id) DO UPDATE SET expires_at=GREATEST(COALESCE(user_mall_intros.expires_at,NOW()),NOW())+make_interval(days=>i.validity_days),gifted_by=me,acquired_at=NOW(),acquisition_source='gift' RETURNING expires_at INTO exp;
  UPDATE public.profiles SET owned_mall_intros=CASE WHEN p_intro_id=ANY(owned_mall_intros) THEN owned_mall_intros ELSE array_append(owned_mall_intros,p_intro_id) END WHERE id=recipient;
  RETURN jsonb_build_object('success',TRUE,'recipient_id',recipient,'price',i.diamond_cost,'expires_at',exp);
END $$;

CREATE OR REPLACE FUNCTION public.admin_grant_cosmetic(p_user_id UUID,p_kind TEXT,p_item_id TEXT,p_days INT DEFAULT NULL,p_permanent BOOLEAN DEFAULT FALSE,p_equip BOOLEAN DEFAULT TRUE)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid(); v_days INT; v_exp TIMESTAMPTZ;
BEGIN
  IF NOT public.is_live_staff(me) THEN RETURN jsonb_build_object('success',FALSE,'message','Admin access required'); END IF;
  IF p_kind='frame' THEN
    SELECT validity_days INTO v_days FROM public.profile_frames WHERE id=p_item_id;
    IF v_days IS NULL THEN RETURN jsonb_build_object('success',FALSE,'message','Frame not found'); END IF;
    v_exp:=CASE WHEN p_permanent THEN NULL ELSE NOW()+make_interval(days=>COALESCE(p_days,v_days)) END;
    INSERT INTO public.user_profile_frames(user_id,frame_id,expires_at,acquisition_source) VALUES(p_user_id,p_item_id,v_exp,CASE WHEN p_permanent THEN 'admin_permanent' ELSE 'admin_grant' END)
    ON CONFLICT(user_id,frame_id) DO UPDATE SET expires_at=EXCLUDED.expires_at,acquisition_source=EXCLUDED.acquisition_source,acquired_at=NOW();
    IF p_equip THEN UPDATE public.profiles p SET selected_profile_frame=p_item_id,selected_profile_frame_url=f.frame_url FROM public.profile_frames f WHERE p.id=p_user_id AND f.id=p_item_id; END IF;
  ELSIF p_kind='intro' THEN
    SELECT validity_days INTO v_days FROM public.mall_intro_items WHERE id=p_item_id;
    IF v_days IS NULL THEN RETURN jsonb_build_object('success',FALSE,'message','Intro not found'); END IF;
    v_exp:=CASE WHEN p_permanent THEN NULL ELSE NOW()+make_interval(days=>COALESCE(p_days,v_days)) END;
    INSERT INTO public.user_mall_intros(user_id,intro_id,expires_at,acquisition_source) VALUES(p_user_id,p_item_id,v_exp,CASE WHEN p_permanent THEN 'admin_permanent' ELSE 'admin_grant' END)
    ON CONFLICT(user_id,intro_id) DO UPDATE SET expires_at=EXCLUDED.expires_at,acquisition_source=EXCLUDED.acquisition_source,acquired_at=NOW();
    IF p_equip THEN UPDATE public.profiles p SET selected_mall_intro=p_item_id,selected_mall_intro_video_url=i.video_url,selected_mall_intro_thumbnail_url=i.thumbnail_url FROM public.mall_intro_items i WHERE p.id=p_user_id AND i.id=p_item_id; END IF;
  ELSE RETURN jsonb_build_object('success',FALSE,'message','Kind must be frame or intro'); END IF;
  INSERT INTO public.admin_audit_log(admin_id,action,target_type,target_id,payload) VALUES(me,'grant_cosmetic','profile',p_user_id,jsonb_build_object('kind',p_kind,'item_id',p_item_id,'days',p_days,'permanent',p_permanent,'equip',p_equip));
  RETURN jsonb_build_object('success',TRUE,'expires_at',v_exp);
END $$;

-- ------------------------------------------------------------------
-- Cumulative video-live reward per Asia/Dhaka day
-- ------------------------------------------------------------------
INSERT INTO public.system_settings(key,value) VALUES('host_hour_reward',jsonb_build_object('enabled',TRUE,'beans',6000,'minutes',60)) ON CONFLICT(key) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.host_daily_live_rewards(
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,reward_date DATE NOT NULL,
  eligible_seconds BIGINT NOT NULL DEFAULT 0,reward_beans BIGINT NOT NULL DEFAULT 0,rewarded_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(user_id,reward_date)
);
ALTER TABLE public.host_daily_live_rewards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS host_reward_own_read ON public.host_daily_live_rewards;
CREATE POLICY host_reward_own_read ON public.host_daily_live_rewards FOR SELECT USING(user_id=auth.uid() OR public.is_admin(auth.uid()));

CREATE OR REPLACE FUNCTION public.live_stream_heartbeat(p_stream_id UUID,p_viewer_count INT DEFAULT NULL,p_current_viewers INT DEFAULT NULL)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid(); v_host UUID; v_type TEXT; v_date DATE:=(NOW() AT TIME ZONE 'Asia/Dhaka')::DATE; v_start TIMESTAMPTZ; v_end TIMESTAMPTZ; v_seconds BIGINT:=0; v_cfg JSONB; v_enabled BOOLEAN; v_beans BIGINT; v_minutes INT; v_award BOOLEAN:=FALSE;
BEGIN
  SELECT broadcaster_id,type INTO v_host,v_type FROM public.live_streams WHERE id=p_stream_id;
  IF v_host IS NULL THEN RETURN json_build_object('success',false,'message','Stream not found'); END IF;
  IF v_host<>me THEN RETURN json_build_object('success',false,'message','Not your stream'); END IF;
  UPDATE public.live_streams SET last_heartbeat_at=NOW(),peak_viewers=GREATEST(COALESCE(peak_viewers,0),COALESCE(p_viewer_count,0)),current_viewers=COALESCE(p_current_viewers,current_viewers) WHERE id=p_stream_id AND status='live';
  SELECT value INTO v_cfg FROM public.system_settings WHERE key='host_hour_reward';
  v_enabled:=COALESCE((v_cfg->>'enabled')::BOOLEAN,TRUE); v_beans:=COALESCE((v_cfg->>'beans')::BIGINT,6000); v_minutes:=COALESCE((v_cfg->>'minutes')::INT,60);
  IF v_type='video' THEN
    v_start:=(v_date::TIMESTAMP AT TIME ZONE 'Asia/Dhaka'); v_end:=((v_date+1)::TIMESTAMP AT TIME ZONE 'Asia/Dhaka');
    SELECT COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (LEAST(COALESCE(ended_at,NOW()),v_end)-GREATEST(started_at,v_start))))),0)::BIGINT INTO v_seconds
    FROM public.live_streams WHERE broadcaster_id=me AND type='video' AND started_at<v_end AND COALESCE(ended_at,NOW())>v_start;
    INSERT INTO public.host_daily_live_rewards(user_id,reward_date,eligible_seconds) VALUES(me,v_date,v_seconds)
    ON CONFLICT(user_id,reward_date) DO UPDATE SET eligible_seconds=EXCLUDED.eligible_seconds,updated_at=NOW();
    IF v_enabled AND v_seconds>=v_minutes*60 THEN
      UPDATE public.host_daily_live_rewards SET reward_beans=v_beans,rewarded_at=NOW(),updated_at=NOW() WHERE user_id=me AND reward_date=v_date AND rewarded_at IS NULL;
      IF FOUND THEN
        UPDATE public.profiles SET beans=beans+v_beans WHERE id=me; v_award:=TRUE;
        INSERT INTO public.transactions(user_id,type,currency,amount,status,notes) VALUES(me,'live_hour_reward','bean',v_beans,'completed','Daily cumulative video live reward');
        INSERT INTO public.notifications(user_id,type,title,body,payload) VALUES(me,'task_reward','Daily live reward','+'||v_beans||' beans added to your wallet',jsonb_build_object('reward',v_beans,'eligible_seconds',v_seconds,'reward_date',v_date));
      END IF;
    END IF;
  END IF;
  RETURN json_build_object('success',true,'eligible_seconds',v_seconds,'rewarded_now',v_award,'reward_date',v_date);
END $$;

GRANT EXECUTE ON FUNCTION public.submit_agency_join_request(UUID,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_agency_join_request(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_agency_host(UUID,UUID,UUID,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_review_agency_request(UUID,BOOLEAN,UUID,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_release_agency_host(UUID,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_active_live_feed(TEXT,TEXT,TEXT,INT,INT) TO authenticated,anon;
GRANT EXECUTE ON FUNCTION public.submit_nickname_application(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_review_nickname_application(UUID,BOOLEAN,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_user_nickname(UUID,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_cosmetics(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.equip_cosmetic(TEXT,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_grant_cosmetic(UUID,TEXT,TEXT,INT,BOOLEAN,BOOLEAN) TO authenticated;

DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.agency_join_requests; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.nickname_applications; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
NOTIFY pgrst,'reload schema';
