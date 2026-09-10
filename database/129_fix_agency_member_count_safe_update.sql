-- Fix agency approval/release on projects that enforce safe UPDATE queries.
-- Migration 128 recalculated every agency count without a WHERE clause, which
-- is rejected by Supabase's safe-update hook. Only affected agencies are
-- recalculated here.

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
  WHERE a.id=p_agency_id OR EXISTS(
    SELECT 1 FROM public.agency_members affected
    WHERE affected.agency_id=a.id AND affected.host_id=p_user_id
  );

  INSERT INTO public.notifications(user_id,type,title,body,payload)
  VALUES(p_user_id,'agency_approved','Agency approved','You are now a host in '||v_name,jsonb_build_object('agency_id',p_agency_id));
  INSERT INTO public.admin_audit_log(admin_id,action,target_type,target_id,payload)
  VALUES(me,'assign_agency_host','profile',p_user_id,jsonb_build_object('agency_id',p_agency_id,'request_id',p_request_id,'note',p_review_note));
  RETURN jsonb_build_object('success',TRUE,'agency_id',p_agency_id,'agency_name',v_name);
END $$;

CREATE OR REPLACE FUNCTION public.admin_release_agency_host(p_user_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE me UUID:=auth.uid();
BEGIN
  IF NOT public.is_live_staff(me) THEN RETURN jsonb_build_object('success',FALSE,'message','Admin access required'); END IF;
  UPDATE public.agency_members SET status='released',released_at=NOW()
  WHERE host_id=p_user_id AND status IN ('active','pending','leave_pending');
  UPDATE public.profiles SET agency_id=NULL,updated_at=NOW() WHERE id=p_user_id;
  UPDATE public.agencies a
  SET member_count=(SELECT COUNT(*) FROM public.agency_members m WHERE m.agency_id=a.id AND m.status='active')
  WHERE EXISTS(
    SELECT 1 FROM public.agency_members affected
    WHERE affected.agency_id=a.id AND affected.host_id=p_user_id
  );
  INSERT INTO public.notifications(user_id,type,title,body,payload)
  VALUES(p_user_id,'agency_released','Agency membership ended',COALESCE(NULLIF(BTRIM(p_reason),''),'An admin ended your agency membership'),'{}');
  INSERT INTO public.admin_audit_log(admin_id,action,target_type,target_id,payload)
  VALUES(me,'release_agency_host','profile',p_user_id,jsonb_build_object('reason',p_reason));
  RETURN jsonb_build_object('success',TRUE);
END $$;

GRANT EXECUTE ON FUNCTION public.admin_assign_agency_host(UUID,UUID,UUID,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_release_agency_host(UUID,TEXT) TO authenticated;
