-- The authoritative game clock had drifted back to a 1-second schedule.
--
-- consolidate_game_clocks deliberately set this job to '10 seconds', with the
-- reasoning recorded in that migration: "The old one-second clocks and Edge
-- Function clocks overlapped, filled pg_cron run history, and saturated small
-- database compute with disk I/O." At some point it went back to '1 second',
-- which is how it was found today on a t3a.micro sitting at 87% CPU.
--
-- While each tick was taking 42-105 seconds this was mostly moot -- the advisory
-- lock meant almost every run returned immediately. Now that the tick completes
-- in milliseconds, a 1-second schedule means it genuinely runs 86,400 times a
-- day, and every one of those runs does real work against game_rounds.
--
-- 2 seconds instead of the original 10. Reasoning: Teen Patti and Lucky Dice
-- self-tick from their state reads, but Greedy Lion and Greedy King do not, so
-- for those two the cron interval IS the round-boundary precision. A 10-second
-- clock would let a 31-second round start up to 10 seconds late, which players
-- see as a stuttering timer. 2 seconds keeps boundaries tight while cutting the
-- clock's own load by 80%.
--
-- The two legacy per-game jobs (greedy-lion-tick-10s, tin-patti-pro-tick-10s)
-- and greedy-king-authoritative-clock remain inactive, as consolidate_game_clocks
-- left them; this only retimes the surviving coordinator.

DO $$
DECLARE
  v_jobid BIGINT;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'pg_cron unavailable; game clock interval unchanged.';
    RETURN;
  END IF;

  SELECT jobid INTO v_jobid
    FROM cron.job
   WHERE jobname = 'authoritative-mini-game-clock'
   ORDER BY jobid DESC
   LIMIT 1;

  IF v_jobid IS NULL THEN
    PERFORM cron.schedule(
      'authoritative-mini-game-clock',
      '2 seconds',
      $cron$ SELECT public.tick_authoritative_mini_games(); $cron$
    );
  ELSE
    PERFORM cron.alter_job(
      job_id   := v_jobid,
      schedule := '2 seconds',
      command  := $cron$ SELECT public.tick_authoritative_mini_games(); $cron$,
      active   := TRUE
    );
  END IF;
END $$;
