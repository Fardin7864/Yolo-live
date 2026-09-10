-- Keep Teen Patti round creation independent from result-card loading and
-- client network latency. Realtime remains the primary delivery path; client
-- boundary refreshes are only recovery.

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
END;
$$;

REVOKE ALL ON FUNCTION public.tick_authoritative_mini_games() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tick_authoritative_mini_games() TO service_role;

DO $$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'pg_cron is unavailable; clients retain boundary and fallback recovery.';
  ELSE
    PERFORM cron.unschedule(jobid)
      FROM cron.job
     WHERE jobname = 'authoritative-mini-game-clock';

    PERFORM cron.schedule(
      'authoritative-mini-game-clock',
      '1 second',
      $cron$ SELECT public.tick_authoritative_mini_games(); $cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule authoritative mini-game clock: %', SQLERRM;
END;
$$;

COMMENT ON FUNCTION public.tick_authoritative_mini_games() IS
  'Advances global mini-game rounds every second, independently of connected clients.';
