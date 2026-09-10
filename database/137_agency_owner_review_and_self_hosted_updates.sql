-- Agency-owner request review plus configuration keys for direct APK updates.
-- Idempotent and safe to run after migration 135; it also includes the
-- owner inbox policy/notification trigger from migration 136.

DROP POLICY IF EXISTS agency_join_requests_own_read ON public.agency_join_requests;
CREATE POLICY agency_join_requests_own_read ON public.agency_join_requests
  FOR SELECT USING (
    user_id = auth.uid()
    OR public.is_live_staff(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.agencies a
      WHERE a.id = agency_join_requests.agency_id
        AND a.owner_id = auth.uid()
    )
  );

CREATE OR REPLACE FUNCTION public.notify_agency_owner_of_join_request()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_owner UUID; v_agency TEXT; v_applicant TEXT;
BEGIN
  SELECT owner_id,name INTO v_owner,v_agency FROM public.agencies WHERE id=NEW.agency_id;
  SELECT COALESCE(NULLIF(BTRIM(full_name),''),'A user') INTO v_applicant FROM public.profiles WHERE id=NEW.user_id;
  IF v_owner IS NOT NULL AND v_owner<>NEW.user_id THEN
    INSERT INTO public.notifications(user_id,type,title,body,payload)
    VALUES(v_owner,'agency_join_request','New agency join request',
      COALESCE(v_applicant,'A user')||' requested to join '||COALESCE(v_agency,'your agency'),
      jsonb_build_object('request_id',NEW.id,'agency_id',NEW.agency_id,'applicant_id',NEW.user_id,'route','/main/agency'));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS agency_join_request_notify_owner ON public.agency_join_requests;
CREATE TRIGGER agency_join_request_notify_owner AFTER INSERT ON public.agency_join_requests
  FOR EACH ROW EXECUTE FUNCTION public.notify_agency_owner_of_join_request();

CREATE OR REPLACE FUNCTION public.owner_review_agency_request(
  p_request_id UUID,
  p_approve BOOLEAN,
  p_review_note TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  me UUID:=auth.uid();
  r public.agency_join_requests%ROWTYPE;
  v_agency public.agencies%ROWTYPE;
BEGIN
  IF me IS NULL THEN RETURN jsonb_build_object('success',FALSE,'message','Authentication required'); END IF;

  SELECT * INTO r FROM public.agency_join_requests
  WHERE id=p_request_id AND status='pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',FALSE,'message','Pending request not found'); END IF;

  SELECT * INTO v_agency FROM public.agencies
  WHERE id=r.agency_id AND owner_id=me AND status='verified' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',FALSE,'message','Only the verified agency owner can review this request'); END IF;

  IF NOT p_approve THEN
    UPDATE public.agency_join_requests
      SET status='rejected',reviewed_by=me,reviewed_at=NOW(),updated_at=NOW(),review_note=NULLIF(BTRIM(p_review_note),'')
      WHERE id=r.id;
    INSERT INTO public.notifications(user_id,type,title,body,payload)
    VALUES(r.user_id,'agency_rejected','Agency request rejected',
      COALESCE(NULLIF(BTRIM(p_review_note),''),v_agency.name||' did not accept your join request'),
      jsonb_build_object('request_id',r.id,'agency_id',r.agency_id));
    INSERT INTO public.admin_audit_log(admin_id,action,target_type,target_id,payload)
    VALUES(me,'agency_owner_reject_request','profile',r.user_id,jsonb_build_object('request_id',r.id,'agency_id',r.agency_id,'note',p_review_note));
    RETURN jsonb_build_object('success',TRUE,'status','rejected');
  END IF;

  IF EXISTS(SELECT 1 FROM public.profiles WHERE id=r.user_id AND COALESCE(is_banned,FALSE)) THEN
    RETURN jsonb_build_object('success',FALSE,'message','This user cannot be added');
  END IF;

  UPDATE public.agency_members SET status='released',released_at=NOW()
    WHERE host_id=r.user_id AND status IN ('active','pending','leave_pending');
  INSERT INTO public.agency_members(agency_id,host_id,status,joined_at,released_at)
  VALUES(r.agency_id,r.user_id,'active',NOW(),NULL)
  ON CONFLICT(agency_id,host_id) DO UPDATE SET status='active',joined_at=NOW(),released_at=NULL;
  UPDATE public.profiles
    SET agency_id=r.agency_id,role=CASE WHEN role='user' THEN 'host' ELSE role END,updated_at=NOW()
    WHERE id=r.user_id;
  UPDATE public.agency_join_requests
    SET status='approved',reviewed_by=me,reviewed_at=NOW(),updated_at=NOW(),review_note=NULLIF(BTRIM(p_review_note),'')
    WHERE id=r.id;
  UPDATE public.agency_join_requests
    SET status='rejected',reviewed_by=me,reviewed_at=NOW(),updated_at=NOW(),review_note='Joined another agency'
    WHERE user_id=r.user_id AND status='pending' AND id<>r.id;
  UPDATE public.agencies a
    SET member_count=(SELECT COUNT(*) FROM public.agency_members m WHERE m.agency_id=a.id AND m.status='active')
    WHERE a.id=r.agency_id OR EXISTS(SELECT 1 FROM public.agency_members m2 WHERE m2.agency_id=a.id AND m2.host_id=r.user_id);
  INSERT INTO public.notifications(user_id,type,title,body,payload)
  VALUES(r.user_id,'agency_approved','Agency request accepted','You are now a host in '||v_agency.name,
    jsonb_build_object('request_id',r.id,'agency_id',r.agency_id));
  INSERT INTO public.admin_audit_log(admin_id,action,target_type,target_id,payload)
  VALUES(me,'agency_owner_approve_request','profile',r.user_id,jsonb_build_object('request_id',r.id,'agency_id',r.agency_id,'note',p_review_note));
  RETURN jsonb_build_object('success',TRUE,'status','approved','agency_id',r.agency_id,'agency_name',v_agency.name);
END $$;

GRANT SELECT ON public.agency_join_requests TO authenticated;
GRANT EXECUTE ON FUNCTION public.owner_review_agency_request(UUID,BOOLEAN,TEXT) TO authenticated;

INSERT INTO public.system_settings(key,value) VALUES
  ('latest_app_version','"1.1.20"'::jsonb),
  ('min_supported_app_version','"1.1.19"'::jsonb),
  ('store_url_android','"https://github.com/Fardin7864/live-streaming-app/releases/download/v1.1.20/green-live-v1.1.20-in-app-updates-production-20260721.apk"'::jsonb),
  ('app_update_notes','"Agency owner request review and secure in-app APK updates."'::jsonb)
ON CONFLICT(key) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = NOW();
