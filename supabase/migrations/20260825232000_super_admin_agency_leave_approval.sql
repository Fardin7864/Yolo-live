-- Agency leave is a request, never a host-side release. Membership remains
-- active until a Super Admin atomically approves the request and penalty.

CREATE TABLE IF NOT EXISTS public.agency_leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  agency_id UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  penalty_amount BIGINT NOT NULL DEFAULT 50000 CHECK (penalty_amount = 50000),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS agency_leave_requests_one_pending_host_idx
  ON public.agency_leave_requests(host_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS agency_leave_requests_pending_order_idx
  ON public.agency_leave_requests(status, requested_at);

ALTER TABLE public.agency_leave_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agency_leave_requests_host_read ON public.agency_leave_requests;
CREATE POLICY agency_leave_requests_host_read ON public.agency_leave_requests
  FOR SELECT TO authenticated
  USING (host_id = auth.uid() OR public.is_super_admin(auth.uid()));

GRANT SELECT ON public.agency_leave_requests TO authenticated;

-- Preserve requests created by the legacy status-based flow while restoring
-- those hosts to fully active membership until an administrator decides.
INSERT INTO public.agency_leave_requests(host_id, agency_id, status, requested_at)
SELECT member_row.host_id,
  member_row.agency_id,
  'pending',
  COALESCE(member_row.joined_at, NOW())
FROM public.agency_members AS member_row
WHERE member_row.status = 'leave_pending'
ON CONFLICT (host_id) WHERE status = 'pending' DO NOTHING;

UPDATE public.agency_members
SET status = 'active', released_at = NULL
WHERE status = 'leave_pending';

UPDATE public.agencies AS agency_row
SET member_count = (
  SELECT COUNT(*)
  FROM public.agency_members AS member_row
  WHERE member_row.agency_id = agency_row.id
    AND member_row.status = 'active'
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

  SELECT agency_row.name INTO v_agency_name
    FROM public.agencies AS agency_row
   WHERE agency_row.id = v_agency_id;

  INSERT INTO public.notifications(user_id, type, title, body, payload)
  SELECT super_admin_id,
    'agency_leave_request',
    'Agency leave request',
    'A host requested Super Admin approval to leave ' || COALESCE(v_agency_name, 'an agency') || '.',
    jsonb_build_object(
      'request_id', v_request_id,
      'host_id', me,
      'agency_id', v_agency_id,
      'penalty_amount', 50000
    )
  FROM (
    SELECT profile_row.id AS super_admin_id
    FROM public.profiles AS profile_row
    WHERE profile_row.role = 'super_admin'
    UNION
    SELECT admin_row.profile_id
    FROM public.admin_accounts AS admin_row
    WHERE admin_row.role = 'super_admin' AND admin_row.is_active
  ) AS super_admins;

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
BEGIN
  IF me IS NULL OR NOT public.is_super_admin(me) THEN
    RETURN json_build_object('success', FALSE, 'message', 'Super Admin approval required');
  END IF;

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
    'Super Admin approved agency leave penalty'
  );

  INSERT INTO public.notifications(user_id, type, title, body, payload)
  VALUES (
    p_host_id,
    'agency_leave_approved',
    'Agency leave approved',
    'A Super Admin approved your request. 50,000 diamonds were deducted.',
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
      'review_note', p_review_note
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
BEGIN
  IF me IS NULL OR NOT public.is_super_admin(me) THEN
    RETURN json_build_object('success', FALSE, 'message', 'Super Admin approval required');
  END IF;

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
    COALESCE(NULLIF(BTRIM(p_review_note), ''), 'Your agency leave request was not approved.'),
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
      'review_note', p_review_note
    )
  );

  RETURN json_build_object('success', TRUE, 'request_id', v_request.id);
END $$;

-- Agency owners cannot approve/reject or directly release hosts.
CREATE OR REPLACE FUNCTION public.release_agency_member(
  p_agency_id UUID,
  p_owner_id UUID,
  p_host_id UUID
)
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT json_build_object(
    'success', FALSE,
    'message', 'Only a Super Admin can release agency hosts'
  );
$$;

-- The dashboard's older direct-release action is also Super Admin-only. It is
-- retained for forced moderation removals, but regular staff cannot use it to
-- bypass the leave-request review queue.
CREATE OR REPLACE FUNCTION public.admin_release_agency_host(
  p_user_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
BEGIN
  IF me IS NULL OR NOT public.is_super_admin(me) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Super Admin access required');
  END IF;

  UPDATE public.agency_members
     SET status = 'released', released_at = NOW()
   WHERE host_id = p_user_id
     AND status IN ('active', 'pending', 'leave_pending');

  UPDATE public.profiles
     SET agency_id = NULL, updated_at = NOW()
   WHERE id = p_user_id;

  UPDATE public.agencies AS agency_row
     SET member_count = (
       SELECT COUNT(*)
       FROM public.agency_members AS member_row
       WHERE member_row.agency_id = agency_row.id
         AND member_row.status = 'active'
     )
   WHERE EXISTS (
     SELECT 1
     FROM public.agency_members AS affected
     WHERE affected.agency_id = agency_row.id
       AND affected.host_id = p_user_id
   );

  INSERT INTO public.notifications(user_id, type, title, body, payload)
  VALUES (
    p_user_id,
    'agency_released',
    'Agency membership ended',
    COALESCE(NULLIF(BTRIM(p_reason), ''), 'A Super Admin ended your agency membership'),
    '{}'::jsonb
  );

  INSERT INTO public.admin_audit_log(admin_id, action, target_type, target_id, payload)
  VALUES (
    me,
    'release_agency_host',
    'profile',
    p_user_id,
    jsonb_build_object('reason', p_reason)
  );

  RETURN jsonb_build_object('success', TRUE);
END $$;

GRANT EXECUTE ON FUNCTION public.leave_agency(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_leave_request(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_leave_request(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_agency_member(UUID, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_release_agency_host(UUID, TEXT) TO authenticated;

-- Remove the obsolete one-argument overloads so clients cannot reach a stale
-- owner-authorized implementation by omitting the review note.
DROP FUNCTION IF EXISTS public.approve_leave_request(UUID);
DROP FUNCTION IF EXISTS public.reject_leave_request(UUID);
