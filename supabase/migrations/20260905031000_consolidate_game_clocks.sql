-- Run every authoritative mini-game from one modest database clock. The old
-- one-second clocks and Edge Function clocks overlapped, filled pg_cron run
-- history, and saturated small database compute with disk I/O.

CREATE OR REPLACE FUNCTION public.tick_authoritative_mini_games()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(1729, 20260809) THEN
    RETURN;
  END IF;

  BEGIN
    PERFORM public.greedy_lion_tick();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Greedy Lion coordinator tick failed: %', SQLERRM;
  END;

  BEGIN
    PERFORM public.tin_patti_pro_tick();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Teen Patti Pro coordinator tick failed: %', SQLERRM;
  END;

  BEGIN
    PERFORM public.lucky_dice_tick();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Lucky Dice coordinator tick failed: %', SQLERRM;
  END;

  BEGIN
    PERFORM public.greedy_pro_tick();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Greedy King coordinator tick failed: %', SQLERRM;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.tick_authoritative_mini_games()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tick_authoritative_mini_games()
  TO service_role;

DO $$
DECLARE
  game_job RECORD;
  coordinator_job_id BIGINT;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'pg_cron is unavailable; authoritative game clock was not scheduled.';
    RETURN;
  END IF;

  -- Disable every previous clock before enabling the consolidated clock so
  -- deployment cannot briefly run duplicate coordinators.
  FOR game_job IN
    SELECT jobid
      FROM cron.job
     WHERE jobname IN (
       'greedy-lion-tick-10s',
       'tin-patti-pro-tick-10s',
       'greedy-king-authoritative-clock',
       'authoritative-mini-game-clock'
     )
  LOOP
    PERFORM cron.alter_job(job_id := game_job.jobid, active := FALSE);
  END LOOP;

  SELECT jobid
    INTO coordinator_job_id
    FROM cron.job
   WHERE jobname = 'authoritative-mini-game-clock'
   ORDER BY jobid DESC
   LIMIT 1;

  IF coordinator_job_id IS NULL THEN
    PERFORM cron.schedule(
      'authoritative-mini-game-clock',
      '10 seconds',
      $cron$ SELECT public.tick_authoritative_mini_games(); $cron$
    );
  ELSE
    PERFORM cron.alter_job(
      job_id := coordinator_job_id,
      schedule := '10 seconds',
      command := $cron$ SELECT public.tick_authoritative_mini_games(); $cron$,
      active := TRUE
    );
  END IF;

  -- pg_cron does not prune run history automatically. With a sub-minute game
  -- clock, retaining one week is enough for diagnosis without unbounded I/O.
  PERFORM cron.unschedule(jobid)
    FROM cron.job
   WHERE jobname = 'cleanup-cron-run-history';
  PERFORM cron.schedule(
    'cleanup-cron-run-history',
    '30 3 * * *',
    $cron$
      DELETE FROM cron.job_run_details
       WHERE end_time < NOW() - INTERVAL '7 days';
    $cron$
  );
END;
$$;

COMMENT ON FUNCTION public.tick_authoritative_mini_games() IS
  'Runs Greedy Lion, Teen Patti Pro, Lucky Dice, and Greedy King from one 10-second pg_cron clock.';
