-- =====================================================================
-- 36_topup_admin_updates.sql
-- =====================================================================
-- topup_requests only had a SELECT RLS policy. UPDATEs from the admin
-- panel (cancel + mark-contacted) were silently blocked: no error,
-- 0 rows changed, status stayed 'pending'. The 'confirm' button worked
-- only because it goes through a SECURITY DEFINER RPC.
--
-- This migration adds:
--   1. An UPDATE policy that lets admins / super_admins change any
--      topup_requests row. End-users + resellers stay locked out.
--   2. cancel_topup_request(id)         - rejects a pending/contacted
--      request with proper logging.
--   3. mark_topup_contacted(id)         - moves pending -> contacted.
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. UPDATE policy for admins
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS topup_admin_update ON public.topup_requests;
CREATE POLICY topup_admin_update ON public.topup_requests
  FOR UPDATE
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------
-- 2. cancel_topup_request — explicit RPC so the admin panel can call it
--    with the same shape as confirm_topup_request (and we get an
--    authoritative success / message back).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_topup_request(
  p_request_id uuid,
  p_admin_id   uuid DEFAULT NULL,
  p_reason     text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me        uuid := auth.uid();
  v_status  text;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF NOT public.is_admin(me) THEN
    RETURN json_build_object('success', false, 'message', 'Admin only');
  END IF;

  SELECT status INTO v_status
    FROM public.topup_requests
    WHERE id = p_request_id
    FOR UPDATE;

  IF v_status IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Request not found');
  END IF;
  IF v_status = 'confirmed' THEN
    RETURN json_build_object('success', false, 'message', 'Already confirmed — cannot cancel');
  END IF;
  IF v_status = 'cancelled' THEN
    RETURN json_build_object('success', true, 'message', 'Already cancelled');
  END IF;

  UPDATE public.topup_requests
     SET status = 'cancelled',
         notes  = COALESCE(p_reason, notes)
   WHERE id = p_request_id;

  RETURN json_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_topup_request(uuid, uuid, text) TO authenticated;

-- ---------------------------------------------------------------------
-- 3. mark_topup_contacted — pending -> contacted
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_topup_contacted(p_request_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me       uuid := auth.uid();
  v_status text;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF NOT public.is_admin(me) THEN
    RETURN json_build_object('success', false, 'message', 'Admin only');
  END IF;

  SELECT status INTO v_status
    FROM public.topup_requests
    WHERE id = p_request_id
    FOR UPDATE;

  IF v_status IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Request not found');
  END IF;
  IF v_status <> 'pending' THEN
    RETURN json_build_object('success', false, 'message', 'Only pending requests can be marked contacted');
  END IF;

  UPDATE public.topup_requests
     SET status = 'contacted'
   WHERE id = p_request_id;

  RETURN json_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_topup_contacted(uuid) TO authenticated;