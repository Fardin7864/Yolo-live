-- =====================================================================
-- 38_demote_agency_owner.sql
-- =====================================================================
-- Mirror of promote_to_agency_owner: lets a super_admin demote an
-- agency owner back to a regular user without manually editing tables.
--
-- WHAT IT DOES — all in one atomic transaction:
--   1. Suspends the agency (status='suspended').
--      - Members keep their data but agency_direct_transfer and stock
--        operations refuse because both check `status <> 'suspended'`.
--      - Wallet's "Agencies" tab filters on status='verified' so the
--        suspended agency disappears from the user-facing picker.
--   2. Releases every active host so they are free to join another
--      agency right away. Pending join + leave requests are auto-cancelled.
--   3. Resets the user's role on profiles back to 'user'.
--   4. Writes an admin_audit_log entry with the agency snapshot.
--
-- WHAT IT KEEPS — for audit / refund:
--   * The agency row itself (so historic topup_requests, payouts, and
--     transactions still resolve via FK).
--   * Any remaining diamond_balance on the agency.
--   * The complete agency_payouts / transactions history.
--
-- Idempotent: re-runnable. Calling it on a non-owner returns a clean
-- error instead of corrupting state.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.demote_agency_owner(
  p_admin_id UUID,
  p_user_id  UUID,
  p_reason   TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agency_id     uuid;
  v_agency_name   text;
  v_released_cnt  int;
  v_stock_left    bigint;
BEGIN
  -- AuthZ: only admin / super_admin can call this.
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = p_admin_id AND role IN ('admin', 'super_admin')
  ) THEN
    RETURN json_build_object('success', false, 'message', 'Not an admin');
  END IF;

  -- Find the agency this user owns (only one is allowed by promote_*).
  SELECT id, name, diamond_balance
    INTO v_agency_id, v_agency_name, v_stock_left
    FROM public.agencies
    WHERE owner_id = p_user_id
    FOR UPDATE;

  IF v_agency_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'User does not own an agency');
  END IF;

  -- 1. Suspend the agency so it disappears from the wallet picker and
  --    can no longer execute direct transfers.
  UPDATE public.agencies
     SET status = 'suspended'
   WHERE id = v_agency_id;

  -- 2. Release every active / leave-pending host, free their slot, and
  --    drop pending join requests so the system is fully cleaned up.
  WITH released AS (
    UPDATE public.agency_members
       SET status       = 'released',
           released_at  = NOW()
     WHERE agency_id = v_agency_id
       AND status    IN ('active', 'leave_pending')
     RETURNING host_id
  )
  UPDATE public.profiles
     SET agency_id = NULL
   WHERE id IN (SELECT host_id FROM released);

  GET DIAGNOSTICS v_released_cnt = ROW_COUNT;

  -- Cancel pending join requests too, so the now-suspended agency
  -- isn't sitting on a queue it can't act on.
  DELETE FROM public.agency_members
   WHERE agency_id = v_agency_id
     AND status    = 'pending';

  -- 3. Reset role back to a normal user.
  UPDATE public.profiles
     SET role      = 'user',
         agency_id = NULL
   WHERE id = p_user_id;

  -- 4. Audit trail.
  INSERT INTO public.admin_audit_log
    (admin_id, action, target_type, target_id, payload)
  VALUES (
    p_admin_id,
    'demote_agency_owner',
    'profile',
    p_user_id,
    jsonb_build_object(
      'agency_id',      v_agency_id,
      'agency_name',    v_agency_name,
      'reason',         p_reason,
      'stock_left',     v_stock_left,
      'released_hosts', v_released_cnt
    )
  );

  RETURN json_build_object(
    'success',         true,
    'agency_id',       v_agency_id,
    'agency_name',     v_agency_name,
    'released_hosts',  v_released_cnt,
    'stock_left',      v_stock_left,
    'message',         'Agency suspended, owner demoted. Stock retained for audit.'
  );
END $$;

GRANT EXECUTE ON FUNCTION public.demote_agency_owner(UUID, UUID, TEXT) TO authenticated;