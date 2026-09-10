-- Client state RPCs and the server coordinator both call the game tick
-- functions. Serialize every call per game so two callers cannot create
-- competing global rounds at the same boundary.

DO $$
BEGIN
  IF to_regprocedure('public.greedy_lion_tick_unlocked_149()') IS NULL THEN
    ALTER FUNCTION public.greedy_lion_tick() RENAME TO greedy_lion_tick_unlocked_149;
  END IF;

  IF to_regprocedure('public.tin_patti_pro_tick_unlocked_149()') IS NULL THEN
    ALTER FUNCTION public.tin_patti_pro_tick() RENAME TO tin_patti_pro_tick_unlocked_149;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.greedy_lion_tick_unlocked_149() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tin_patti_pro_tick_unlocked_149() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.greedy_lion_tick()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(1729, 1);
  RETURN public.greedy_lion_tick_unlocked_149();
END;
$$;

CREATE OR REPLACE FUNCTION public.tin_patti_pro_tick()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(1729, 2);
  RETURN public.tin_patti_pro_tick_unlocked_149();
END;
$$;

GRANT EXECUTE ON FUNCTION public.greedy_lion_tick() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tin_patti_pro_tick() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.greedy_lion_tick() IS
  'Serialized Greedy Lion global-round coordinator entry point.';
COMMENT ON FUNCTION public.tin_patti_pro_tick() IS
  'Serialized Teen Patti Pro global-round coordinator entry point.';
