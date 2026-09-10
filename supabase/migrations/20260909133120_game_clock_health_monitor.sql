-- A stalled game should not be able to hide for two weeks.
--
-- tick_authoritative_mini_games() wraps each game in
--     BEGIN ... EXCEPTION WHEN OTHERS THEN RAISE WARNING ... END
-- so a game whose tick fails, or never gets CPU, fails silently forever. Greedy
-- King stopped producing rounds on 2026-08-26 and nothing noticed until a player
-- reported frozen games on 2026-09-09. Greedy Lion was in the same state.
--
-- The cheapest reliable signal is simply: is this game still producing rounds?
-- Every active game creates one every round_duration_s + result_display_s, so a
-- game that has produced nothing for several cycles is stalled, whatever the
-- cause -- exception, starvation, a stuck round blocking the single-active-round
-- guard, or a disabled cron.
--
-- game_clock_health() is a read-only snapshot for the admin panel.
-- record_game_clock_health() is the scheduled version: it writes a row ONLY when
-- something is stalled, so the table stays an alert trail rather than a log.

CREATE TABLE IF NOT EXISTS public.game_health_alerts (
  id           BIGSERIAL PRIMARY KEY,
  game_id      TEXT NOT NULL,
  rounds_5min  INT NOT NULL,
  last_round_age_s INT,
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS game_health_alerts_detected_idx
  ON public.game_health_alerts (detected_at DESC);

ALTER TABLE public.game_health_alerts ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.game_clock_health()
RETURNS TABLE (
  game_id TEXT,
  is_active BOOLEAN,
  cycle_s INT,
  rounds_5min INT,
  expected_5min INT,
  last_round_age_s INT,
  status TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  WITH games AS (
    SELECT gs.id,
           COALESCE(gs.is_active, FALSE) AS active,
           GREATEST(5, COALESCE(gs.round_duration_s, 30))
             + GREATEST(3, COALESCE(gs.result_display_s, 15)) AS cycle
      FROM public.game_settings gs
     WHERE gs.id IN ('tin_patti_pro', 'greedy_lion', 'lucky_dice', 'greedy_pro')
  ), counted AS (
    SELECT g.id, g.active, g.cycle,
           CASE WHEN g.id = 'greedy_pro'
                THEN (SELECT COUNT(*) FROM public.greedy_pro_rounds r
                       WHERE r.started_at > NOW() - INTERVAL '5 minutes')
                ELSE (SELECT COUNT(*) FROM public.game_rounds r
                       WHERE r.game_type = g.id
                         AND r.started_at > NOW() - INTERVAL '5 minutes')
           END AS seen,
           CASE WHEN g.id = 'greedy_pro'
                THEN (SELECT MAX(r.started_at) FROM public.greedy_pro_rounds r
                       WHERE r.started_at > NOW() - INTERVAL '1 day')
                ELSE (SELECT MAX(r.started_at) FROM public.game_rounds r
                       WHERE r.game_type = g.id
                         AND r.started_at > NOW() - INTERVAL '1 day')
           END AS newest
      FROM games g
  )
  SELECT c.id::TEXT,
         c.active,
         c.cycle::INT,
         c.seen::INT,
         GREATEST(1, (300 / c.cycle))::INT,
         EXTRACT(EPOCH FROM (NOW() - c.newest))::INT,
         CASE
           WHEN NOT c.active THEN 'disabled'
           -- Three cycles with nothing is well beyond normal jitter.
           WHEN c.newest IS NULL
             OR EXTRACT(EPOCH FROM (NOW() - c.newest)) > (c.cycle * 3) THEN 'stalled'
           WHEN c.seen < GREATEST(1, (300 / c.cycle)) / 2 THEN 'degraded'
           ELSE 'ok'
         END::TEXT
    FROM counted c
   ORDER BY c.id;
$function$;

REVOKE ALL ON FUNCTION public.game_clock_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.game_clock_health() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_game_clock_health()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_rows INT := 0;
BEGIN
  INSERT INTO public.game_health_alerts (game_id, rounds_5min, last_round_age_s)
  SELECT h.game_id, h.rounds_5min, h.last_round_age_s
    FROM public.game_clock_health() h
   WHERE h.status = 'stalled';
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Keep the alert trail bounded; this table is for humans, not history.
  DELETE FROM public.game_health_alerts
   WHERE detected_at < NOW() - INTERVAL '30 days';

  RETURN v_rows;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_game_clock_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_game_clock_health() TO service_role;

DO $$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'pg_cron unavailable; game health monitor was not scheduled.';
    RETURN;
  END IF;
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'game-clock-health';
  PERFORM cron.schedule(
    'game-clock-health',
    '*/5 * * * *',
    $cron$ SELECT public.record_game_clock_health(); $cron$
  );
END $$;
