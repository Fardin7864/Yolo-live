-- Let admins and the owning agency review host agency-leave requests.
-- The host remains active until a pending request is approved.

CREATE OR REPLACE FUNCTION public.can_review_agency_leave(
  p_agency_id UUID,
  p_user_id UUID DEFAULT auth.uid()
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    public.is_admin(p_user_id)
    OR EXISTS (
      SELECT 1
      FROM public.agencies AS agency_row
      WHERE agency_row.id = p_agency_id
        AND agency_row.owner_id = p_user_id
        AND agency_row.status = 'verified'
    ),
    FALSE
  );
$$;

GRANT EXECUTE ON FUNCTION public.can_review_agency_leave(UUID, UUID) TO authenticated;

DROP POLICY IF EXISTS agency_leave_requests_host_read ON public.agency_leave_requests;
DROP POLICY IF EXISTS agency_leave_requests_read ON public.agency_leave_requests;
CREATE POLICY agency_leave_requests_read ON public.agency_leave_requests
  FOR SELECT TO authenticated
  USING (
    host_id = auth.uid()
    OR public.can_review_agency_leave(agency_id, auth.uid())
  );

CREATE OR REPLACE FUNCTION public.leave_agency(p_host_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  v_agency_id UUID;
  v_request_id UUID;
  v_agency_name TEXT;
  v_owner_id UUID;
BEGIN
  IF me IS NULL OR me <> p_host_id THEN
    RETURN json_build_object('success', FALSE, 'message', 'Not authorized');
  END IF;

  SELECT member_row.agency_id
    INTO v_agency_id
    FROM public.agency_members AS member_row
   WHERE member_row.host_id = me
     AND member_row.status = 'active'
   ORDER BY member_row.joined_at DESC
   LIMIT 1
   FOR UPDATE;

  IF v_agency_id IS NULL THEN
    RETURN json_build_object('success', FALSE, 'message', 'Active agency membership required');
  END IF;

  SELECT request_row.id
    INTO v_request_id
    FROM public.agency_leave_requests AS request_row
   WHERE request_row.host_id = me
     AND request_row.status = 'pending'
   FOR UPDATE;

  IF v_request_id IS NOT NULL THEN
    RETURN json_build_object(
      'success', FALSE,
      'message', 'Leave request already pending',
      'request_id', v_request_id
    );
  END IF;

  INSERT INTO public.agency_leave_requests(host_id, agency_id)
  VALUES (me, v_agency_id)
  RETURNING id INTO v_request_id;

  SELECT agency_row.name, agency_row.owner_id
    INTO v_agency_name, v_owner_id
    FROM public.agencies AS agency_row
   WHERE agency_row.id = v_agency_id;

  INSERT INTO public.notifications(user_id, type, title, body, payload)
  SELECT reviewer_id,
    'agency_leave_request',
    'Agency leave request',
    'A host requested approval to leave ' || COALESCE(v_agency_name, 'an agency') || '.',
    jsonb_build_object(
      'request_id', v_request_id,
      'host_id', me,
      'agency_id', v_agency_id,
      'penalty_amount', 50000
    )
  FROM (
    SELECT profile_row.id AS reviewer_id
    FROM public.profiles AS profile_row
    WHERE profile_row.role IN ('admin', 'super_admin')
    UNION
    SELECT admin_row.profile_id
    FROM public.admin_accounts AS admin_row
    WHERE admin_row.is_active
    UNION
    SELECT v_owner_id
    WHERE v_owner_id IS NOT NULL
  ) AS reviewers
  WHERE reviewer_id IS NOT NULL;

  RETURN json_build_object(
    'success', TRUE,
    'request_id', v_request_id,
    'agency_id', v_agency_id,
    'status', 'pending',
    'penalty_charged', FALSE
  );
END $$;

CREATE OR REPLACE FUNCTION public.approve_leave_request(
  p_host_id UUID,
  p_review_note TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  v_request public.agency_leave_requests%ROWTYPE;
  v_diamonds BIGINT;
  v_balance_after BIGINT;
  v_reviewer_label TEXT;
BEGIN
  SELECT * INTO v_request
    FROM public.agency_leave_requests AS request_row
   WHERE request_row.host_id = p_host_id
     AND request_row.status = 'pending'
   ORDER BY request_row.requested_at
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', FALSE, 'message', 'No pending leave request');
  END IF;

  IF me IS NULL OR NOT public.can_review_agency_leave(v_request.agency_id, me) THEN
    RETURN json_build_object('success', FALSE, 'message', 'Only an admin or this agency owner can approve this request');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.agency_members AS member_row
    JOIN public.profiles AS profile_row ON profile_row.id = member_row.host_id
    WHERE member_row.host_id = p_host_id
      AND member_row.agency_id = v_request.agency_id
      AND member_row.status = 'active'
      AND profile_row.agency_id = v_request.agency_id
  ) THEN
    RETURN json_build_object('success', FALSE, 'message', 'Host is no longer an active member of this agency');
  END IF;

  SELECT profile_row.diamonds INTO v_diamonds
    FROM public.profiles AS profile_row
   WHERE profile_row.id = p_host_id
   FOR UPDATE;

  IF COALESCE(v_diamonds, 0) < v_request.penalty_amount THEN
    RETURN json_build_object(
      'success', FALSE,
      'message', 'Host needs 50,000 diamonds for the leave penalty'
    );
  END IF;

  v_balance_after := v_diamonds - v_request.penalty_amount;
  v_reviewer_label := CASE WHEN public.is_admin(me) THEN 'Admin' ELSE 'Agency owner' END;

  UPDATE public.profiles
     SET diamonds = v_balance_after,
         agency_id = NULL,
         updated_at = NOW()
   WHERE id = p_host_id;

  UPDATE public.agency_members
     SET status = 'released', released_at = NOW()
   WHERE host_id = p_host_id
     AND agency_id = v_request.agency_id
     AND status = 'active';

  UPDATE public.agency_leave_requests
     SET status = 'approved',
         reviewed_by = me,
         reviewed_at = NOW(),
         review_note = NULLIF(BTRIM(p_review_note), '')
   WHERE id = v_request.id;

  UPDATE public.agencies AS agency_row
     SET member_count = (
       SELECT COUNT(*)
       FROM public.agency_members AS member_row
       WHERE member_row.agency_id = v_request.agency_id
         AND member_row.status = 'active'
     )
   WHERE agency_row.id = v_request.agency_id;

  INSERT INTO public.transactions(
    user_id, type, currency, amount, balance_after, status, notes
  ) VALUES (
    p_host_id,
    'agency_leave_penalty',
    'diamond',
    -v_request.penalty_amount,
    v_balance_after,
    'completed',
    v_reviewer_label || ' approved agency leave penalty'
  );

  INSERT INTO public.notifications(user_id, type, title, body, payload)
  VALUES (
    p_host_id,
    'agency_leave_approved',
    'Agency leave approved',
    v_reviewer_label || ' approved your request. 50,000 diamonds were deducted.',
    jsonb_build_object(
      'request_id', v_request.id,
      'agency_id', v_request.agency_id,
      'penalty_amount', v_request.penalty_amount,
      'balance_after', v_balance_after
    )
  );

  INSERT INTO public.admin_audit_log(admin_id, action, target_type, target_id, payload)
  VALUES (
    me,
    'approve_agency_leave',
    'profile',
    p_host_id,
    jsonb_build_object(
      'request_id', v_request.id,
      'agency_id', v_request.agency_id,
      'penalty_amount', v_request.penalty_amount,
      'review_note', p_review_note,
      'reviewer_is_admin', public.is_admin(me)
    )
  );

  RETURN json_build_object(
    'success', TRUE,
    'request_id', v_request.id,
    'penalty', v_request.penalty_amount,
    'balance_after', v_balance_after
  );
END $$;

CREATE OR REPLACE FUNCTION public.reject_leave_request(
  p_host_id UUID,
  p_review_note TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  v_request public.agency_leave_requests%ROWTYPE;
  v_reviewer_label TEXT;
BEGIN
  SELECT * INTO v_request
    FROM public.agency_leave_requests AS request_row
   WHERE request_row.host_id = p_host_id
     AND request_row.status = 'pending'
   ORDER BY request_row.requested_at
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', FALSE, 'message', 'No pending leave request');
  END IF;

  IF me IS NULL OR NOT public.can_review_agency_leave(v_request.agency_id, me) THEN
    RETURN json_build_object('success', FALSE, 'message', 'Only an admin or this agency owner can reject this request');
  END IF;

  v_reviewer_label := CASE WHEN public.is_admin(me) THEN 'Admin' ELSE 'Agency owner' END;

  UPDATE public.agency_leave_requests
     SET status = 'rejected',
         reviewed_by = me,
         reviewed_at = NOW(),
         review_note = NULLIF(BTRIM(p_review_note), '')
   WHERE id = v_request.id;

  INSERT INTO public.notifications(user_id, type, title, body, payload)
  VALUES (
    p_host_id,
    'agency_leave_rejected',
    'Agency leave request reviewed',
    COALESCE(NULLIF(BTRIM(p_review_note), ''), v_reviewer_label || ' did not approve your agency leave request.'),
    jsonb_build_object('request_id', v_request.id, 'agency_id', v_request.agency_id)
  );

  INSERT INTO public.admin_audit_log(admin_id, action, target_type, target_id, payload)
  VALUES (
    me,
    'reject_agency_leave',
    'profile',
    p_host_id,
    jsonb_build_object(
      'request_id', v_request.id,
      'agency_id', v_request.agency_id,
      'review_note', p_review_note,
      'reviewer_is_admin', public.is_admin(me)
    )
  );

  RETURN json_build_object('success', TRUE, 'request_id', v_request.id);
END $$;

GRANT EXECUTE ON FUNCTION public.leave_agency(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_leave_request(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_leave_request(UUID, TEXT) TO authenticated;
