-- Fix the Agency Dashboard "Hosts Report", which never rendered.
--
-- agency_host_period_report declares host_display_id BIGINT but selects
-- profiles.display_id, which is INTEGER, with no cast. PL/pgSQL's RETURN QUERY
-- checks the row type exactly, so every single call raised:
--
--   ERROR 42804: structure of query does not match function result type
--   DETAIL: Returned type integer does not match expected type bigint in column 3
--
-- The report was therefore always empty regardless of data or date range - the
-- RPC failed before returning a row. agency_host_earnings does cast display_id,
-- which is why Total Earnings could load while the report could not.
--
-- Patched in place from the deployed definition so only the cast changes.

DO $mig$
DECLARE
  src     TEXT;
  patched TEXT;
BEGIN
  src := pg_get_functiondef('public.agency_host_period_report(uuid,timestamptz,timestamptz)'::regprocedure);

  IF position('profile_row.display_id::BIGINT' IN src) > 0 THEN
    RAISE NOTICE 'agency_host_period_report already casts display_id';
    RETURN;
  END IF;

  patched := replace(
    src,
    E'    profile_row.display_id,\n',
    E'    profile_row.display_id::BIGINT,\n'
  );

  IF patched = src THEN
    RAISE EXCEPTION 'Could not patch agency_host_period_report: display_id projection not found';
  END IF;

  EXECUTE patched;
  RAISE NOTICE 'agency_host_period_report now casts display_id to BIGINT';
END;
$mig$;
