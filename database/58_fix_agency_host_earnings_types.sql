-- =====================================================================
-- 58_fix_agency_host_earnings_types.sql
-- =====================================================================
-- Silences the PostgreSQL warning "structure of query does not match
-- function result type" that the mobile app surfaces as
--   `host earnings: structure of query does not match function result type`
-- whenever the agency owner dashboard opens (GlobalStateContext.js
-- calls supabase.rpc('agency_host_earnings', ...)).
--
-- Root cause: the function declares RETURNS TABLE with bare `numeric`
-- and `int` types, but the SELECT columns come from a LEFT JOIN against
-- a CTE that casts SUM() / COUNT() expressions. PostgreSQL's row-type
-- checker compares the SELECT column types element-by-element and
-- treats `numeric(12,2)` (from the underlying agency_payouts.bdt_value)
-- as different from the declared bare `numeric`. Same story with int
-- vs bigint from COUNT().
--
-- Fix: cast every SELECT column to the EXACT type the RETURNS TABLE
-- declares, so the row-type signature matches verbatim. Behaviour is
-- identical to migration 35 — only the cast site changes.
--
-- Idempotent: re-runnable.
-- =====================================================================

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
  me     uuid := auth.uid();
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
    m.host_id::uuid                                                                AS host_id,
    p.full_name::text                                                              AS full_name,
    p.avatar_url::text                                                             AS avatar_url,
    p.display_id::bigint                                                           AS display_id,
    m.status::text                                                                 AS status,
    (COALESCE(p.beans, 0))::bigint                                                 AS current_beans,
    ROUND((COALESCE(p.beans, 0)::numeric / 100000.0) * v_rate, 2)::numeric         AS current_bdt,
    COALESCE(t.pending_bdt, 0::numeric)::numeric                                   AS pending_bdt,
    COALESCE(t.pending_count, 0)::int                                              AS pending_count,
    COALESCE(t.paid_bdt, 0::numeric)::numeric                                      AS paid_bdt,
    COALESCE(t.paid_count, 0)::int                                                 AS paid_count
  FROM members m
  JOIN public.profiles p ON p.id = m.host_id
  LEFT JOIN payout_totals t ON t.host_id = m.host_id
  ORDER BY p.beans DESC NULLS LAST;
END;
$$;

GRANT EXECUTE ON FUNCTION public.agency_host_earnings(UUID) TO authenticated;
