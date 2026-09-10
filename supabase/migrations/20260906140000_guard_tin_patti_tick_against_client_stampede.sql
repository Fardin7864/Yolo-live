-- Teen Patti Pro: stop client reads and bets from stampeding the game engine.
--
-- `get_tin_patti_pro_state` and `place_tin_patti_pro_bet` both begin with
-- `PERFORM public.tin_patti_pro_tick()`, so every state poll and every bet runs
-- the full authoritative engine: settlement, dealing, robot sync, payouts. The
-- engine takes `FOR UPDATE` row locks on the round and on profiles but carries
-- no advisory guard of its own (the guard lives only in the cron coordinator
-- wrapper), so concurrent callers all execute the body and queue on the same
-- row locks.
--
-- Measured against production before this change:
--
--   get_tin_patti_pro_state : 4.24s ok, 8.16s TIMEOUT, 3.54s ok, 8.12s TIMEOUT,
--                             8.14s TIMEOUT   (57014 statement timeout)
--   any trivial table read  : ~0.13s
--
-- The database was healthy; only this call path was pathological. Clients that
-- time out cannot render the result, which is why rounds appeared to "not show
-- the result" and to desynchronise, and why placing a bet made it worse. The
-- client-side 350ms overdue-recovery retry turned each waiting device into ~3
-- engine executions per second, feeding back on itself.
--
-- Fix: make the tick self-guarding. Exactly one caller runs the engine at a
-- time; everyone else returns immediately instead of blocking on row locks.
-- Deliberately a *try* lock rather than removing the call from the read path:
-- clients remain a working fallback if the cron coordinator is ever stopped, so
-- this cannot freeze the game. The advisory key is distinct from the
-- coordinator's (1729, 20260809), so the coordinator still nests correctly.

DO $$
BEGIN
  IF to_regprocedure('public.tin_patti_pro_tick_core_171()') IS NULL THEN
    RAISE EXCEPTION 'tin_patti_pro_tick_core_171() is missing; expected it from 20260825010000';
  END IF;
  IF to_regprocedure('public.tin_patti_pro_sync_robot_bets()') IS NULL THEN
    RAISE EXCEPTION 'tin_patti_pro_sync_robot_bets() is missing; expected it from 20260825010000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.tin_patti_pro_tick()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  tick_result JSON;
BEGIN
  -- Another session is already advancing this game. Skip rather than queue:
  -- the winner's work is authoritative and shared, and the caller only needs
  -- the round to be advanced by *someone*.
  IF NOT pg_try_advisory_xact_lock(1729, 20260906) THEN
    RETURN NULL;
  END IF;

  tick_result := public.tin_patti_pro_tick_core_171();
  PERFORM public.tin_patti_pro_sync_robot_bets();
  RETURN tick_result;
END;
$$;

REVOKE ALL ON FUNCTION public.tin_patti_pro_tick() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tin_patti_pro_tick() TO authenticated, service_role;

COMMENT ON FUNCTION public.tin_patti_pro_tick() IS
  'Advances Teen Patti Pro. Self-guarding: concurrent callers skip instead of '
  'blocking, so client state reads and bet placement cannot stampede the engine.';

-- 20260905031000_consolidate_game_clocks moves this clock to 10 seconds. Teen
-- Patti runs a 4s deal window and a 5s result display, and Lucky Dice a 3s/5s
-- pair, so a 10s clock cannot resolve either window on time. Pin the clock back
-- to 1 second here so the ordering of these two migrations cannot leave
-- production on a period longer than the windows it has to serve. The run
-- history pruning added by that migration is intentionally left in place.
DO $$
DECLARE
  coordinator_job_id BIGINT;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'pg_cron unavailable; clients remain the fallback clock.';
    RETURN;
  END IF;

  SELECT jobid
    INTO coordinator_job_id
    FROM cron.job
   WHERE jobname = 'authoritative-mini-game-clock'
   ORDER BY jobid DESC
   LIMIT 1;

  IF coordinator_job_id IS NULL THEN
    PERFORM cron.schedule(
      'authoritative-mini-game-clock',
      '1 second',
      $cron$ SELECT public.tick_authoritative_mini_games(); $cron$
    );
  ELSE
    PERFORM cron.alter_job(
      job_id := coordinator_job_id,
      schedule := '1 second',
      active := TRUE
    );
  END IF;
END;
$$;
