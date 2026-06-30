-- =====================================================================
-- 35_agency_leave_and_salary.sql
-- =====================================================================
-- Two missing pieces of the agency-owner dashboard:
--
--   1. LEAVE REQUEST FLOW. Today `leave_agency` instantly releases the
--      host. The owner never sees a leave request. New behaviour: the
--      host's agency_members row transitions to status='leave_pending'.
--      Owner sees it in the Members tab and approves (→ released) or
--      rejects (→ active).
--
--   2. PER-HOST SALARY VIEW. `agency_host_earnings(agency_id)` returns
--      every host's current beans, the BDT they would owed at the
--      agency's current `payout_rate`, plus their pending + lifetime
--      paid totals, so the dashboard can show real salary numbers
--      instead of just bean counts.
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1a. Allow 'leave_pending' in the status enum
-- ---------------------------------------------------------------------
DO $$
BEGIN
  ALTER TABLE public.agency_members DROP CONSTRAINT IF EXISTS agency_members_status_check;
  ALTER TABLE public.agency_members
    ADD CONSTRAINT agency_members_status_check
    CHECK (status IN ('active', 'pending', 'released', 'leave_pending'));
EXCEPTION WHEN OTHERS THEN
  -- Already in the right shape — fine.
  NULL;
END $$;

-- ---------------------------------------------------------------------
-- 1b. leave_agency now creates a *request* instead of releasing instantly
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.leave_agency(p_host_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agency_id UUID;
  v_existing_status TEXT;
BEGIN
  -- Caller must be the host themselves.
  IF auth.uid() IS NULL OR auth.uid() <> p_host_id THEN
    RETURN json_build_object('success', false, 'message', 'Not authorized');
  END IF;

  SELECT agency_id INTO v_agency_id FROM public.profiles WHERE id = p_host_id;
  IF v_agency_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'You are not in any agency');
  END IF;

  SELECT status INTO v_existing_status
    FROM public.agency_members
    WHERE host_id = p_host_id AND agency_id = v_agency_id;

  IF v_existing_status = 'leave_pending' THEN
    RETURN json_build_object('success', false, 'message', 'Leave request already pending');
  END IF;
  IF v_existing_status IS NULL OR v_existing_status <> 'active' THEN
    RETURN json_build_object('success', false, 'message', 'Active membership required to leave');
  END IF;

  UPDATE public.agency_members
     SET status = 'leave_pending'
   WHERE host_id = p_host_id AND agency_id = v_agency_id AND status = 'active';

  RETURN json_build_object('success', true, 'agency_id', v_agency_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.leave_agency(UUID) TO authenticated;

-- ---------------------------------------------------------------------
-- 1c. Owner approves the leave → host released
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_leave_request(p_host_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
  v_agency_id uuid;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  SELECT agency_id INTO v_agency_id
    FROM public.agency_members
    WHERE host_id = p_host_id AND status = 'leave_pending';
  IF v_agency_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'No pending leave request');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.agencies WHERE id = v_agency_id AND owner_id = me
  ) THEN
    RETURN json_build_object('success', false, 'message', 'Not your agency');
  END IF;

  UPDATE public.agency_members
     SET status = 'released', released_at = NOW()
   WHERE host_id = p_host_id AND agency_id = v_agency_id;

  UPDATE public.profiles
     SET agency_id = NULL
   WHERE id = p_host_id AND agency_id = v_agency_id;

  UPDATE public.agencies
     SET member_count = GREATEST(0, COALESCE(member_count, 0) - 1)
   WHERE id = v_agency_id;

  RETURN json_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_leave_request(UUID) TO authenticated;

-- ---------------------------------------------------------------------
-- 1d. Owner rejects the leave → membership stays 'active'
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_leave_request(p_host_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
  v_agency_id uuid;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  SELECT agency_id INTO v_agency_id
    FROM public.agency_members
    WHERE host_id = p_host_id AND status = 'leave_pending';
  IF v_agency_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'No pending leave request');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.agencies WHERE id = v_agency_id AND owner_id = me
  ) THEN
    RETURN json_build_object('success', false, 'message', 'Not your agency');
  END IF;

  UPDATE public.agency_members
     SET status = 'active'
   WHERE host_id = p_host_id AND agency_id = v_agency_id;

  RETURN json_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.reject_leave_request(UUID) TO authenticated;

-- ---------------------------------------------------------------------
-- 2. PER-HOST SALARY VIEW
-- Returns a row per host with: profile basics, current beans (= salary
-- in waiting), BDT equivalent at the agency's current payout rate,
-- pending payout total, and lifetime paid total.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agency_host_earnings(p_agency_id UUID)
RETURNS TABLE (
  host_id          uuid,
  full_name        text,
  avatar_url       text,
  display_id       bigint,
  status           text,
  current_beans    bigint,
  current_bdt      numeric,
  pending_bdt      numeric,
  pending_count    int,
  paid_bdt         numeric,
  paid_count       int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
  v_rate numeric;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agencies WHERE id = p_agency_id AND owner_id = me
  ) THEN
    RAISE EXCEPTION 'Not your agency';
  END IF;

  SELECT payout_rate INTO v_rate FROM public.agencies WHERE id = p_agency_id;
  v_rate := COALESCE(v_rate, 1150);

  RETURN QUERY
  WITH members AS (
    SELECT am.host_id, am.status
      FROM public.agency_members am
      WHERE am.agency_id = p_agency_id
        AND am.status IN ('active', 'leave_pending')
  ),
  payout_totals AS (
    SELECT
      ap.host_id,
      SUM(CASE WHEN ap.status = 'paid'    THEN ap.bdt_value ELSE 0 END)::numeric AS paid_bdt,
      COUNT(*) FILTER (WHERE ap.status = 'paid')::int                            AS paid_count,
      SUM(CASE WHEN ap.status = 'pending' THEN ap.bdt_value ELSE 0 END)::numeric AS pending_bdt,
      COUNT(*) FILTER (WHERE ap.status = 'pending')::int                         AS pending_count
    FROM public.agency_payouts ap
    WHERE ap.agency_id = p_agency_id
    GROUP BY ap.host_id
  )
  SELECT
    m.host_id,
    p.full_name,
    p.avatar_url,
    p.display_id,
    m.status,
    COALESCE(p.beans, 0)::bigint                                  AS current_beans,
    ROUND((COALESCE(p.beans, 0)::numeric / 100000.0) * v_rate, 2) AS current_bdt,
    COALESCE(t.pending_bdt, 0)                                    AS pending_bdt,
    COALESCE(t.pending_count, 0)                                  AS pending_count,
    COALESCE(t.paid_bdt, 0)                                       AS paid_bdt,
    COALESCE(t.paid_count, 0)                                     AS paid_count
  FROM members m
  JOIN public.profiles p ON p.id = m.host_id
  LEFT JOIN payout_totals t ON t.host_id = m.host_id
  ORDER BY p.beans DESC NULLS LAST;
END;
$$;

GRANT EXECUTE ON FUNCTION public.agency_host_earnings(UUID) TO authenticated;

-- ---------------------------------------------------------------------
-- 3. Enable Supabase realtime on agency_members so leave + join requests
--    push to the owner dashboard instantly (no manual refresh).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename  = 'agency_members'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.agency_members;
  END IF;
END $$;