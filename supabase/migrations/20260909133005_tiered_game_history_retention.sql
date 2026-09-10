-- Bounded retention for game history (audit finding TP-07).
--
-- Nothing was ever pruned. State before this ran:
--   game_robot_bets    1,125,021 rows / 284 MB  -- only 17,991 from the last 24h
--   game_rounds          337,327 rows / 341 MB  -- only  3,825 from the last 24h
--   game_round_bets      339,239 rows /  87 MB  -- only  2,777 from the last 24h
--   greedy_pro_rounds     31,456 rows /  54 MB
--
-- WHY NOT "KEEP THE LAST 30 ROUNDS".
-- The player-visible history is already capped in SQL at 15 rounds
-- (get_tin_patti_pro_state ... ORDER BY ends_at DESC LIMIT 15), so retention
-- beyond that changes nothing players can see. What deeper history buys is the
-- ability to answer "I bet 5,000 and was not paid" three weeks later. Every
-- child table cascades from the round:
--   game_round_bets, game_robot_bets, game_bet_batches,
--   game_round_position_totals  -> ON DELETE CASCADE from game_rounds
-- so dropping a round silently destroys the bets attached to it. A 30-round cap
-- would leave roughly fifteen minutes of dispute evidence.
--
-- What makes aggressive pruning safe here is that the money ledger is NOT
-- attached to rounds. public.transactions has no foreign key to game_rounds --
-- it references rounds loosely via related_entity_id -- and it holds the full
-- trail back to 2026-05-26: 300,534 game_bet, 121,778 game_win and 99,104
-- game_owner_payout rows. Balances and accounting are reconstructible from
-- transactions alone. So transactions is never pruned here; round history is.
--
-- TIERS
--   Robot bets            48 hours. Cosmetic filler that makes rooms look busy.
--                         Zero audit value, and the single biggest table.
--   Rounds with no bets     7 days. Filler the clock produced while nobody
--                         played. Nothing to dispute.
--   Rounds with bets       90 days. Real gameplay: keep the detail that backs a
--                         dispute, well past any realistic complaint window.
--   transactions          never pruned by this job.
--
-- Deletes are batched and only ever touch settled rounds, so an in-flight round
-- can never be removed. p_max_rounds bounds each call; the cron below drains the
-- existing backlog gradually instead of taking one enormous lock.
--
-- First manual run deleted 10,000 robot bets, 2,000 empty rounds, 20 rounds past
-- 90 days and 2,000 greedy_pro rounds -- and zero player bets (game_round_bets
-- stayed at 339,239, the ledger at 521,417).

CREATE OR REPLACE FUNCTION public.prune_game_history(p_max_rounds INT DEFAULT 2000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_robot_bets   BIGINT := 0;
  v_empty_rounds BIGINT := 0;
  v_old_rounds   BIGINT := 0;
  v_pro_rounds   BIGINT := 0;
  v_batch INT := GREATEST(100, LEAST(20000, COALESCE(p_max_rounds, 2000)));
BEGIN
  -- 1. Robot bets are pure decoration. Drop them well before their round goes.
  WITH doomed AS (
    SELECT id FROM public.game_robot_bets
     WHERE created_at < NOW() - INTERVAL '48 hours'
     LIMIT v_batch * 5
  )
  DELETE FROM public.game_robot_bets b USING doomed WHERE b.id = doomed.id;
  GET DIAGNOSTICS v_robot_bets = ROW_COUNT;

  -- 2. Settled rounds nobody bet on, older than 7 days.
  WITH doomed AS (
    SELECT r.id
      FROM public.game_rounds r
     WHERE r.status = 'settled'
       AND r.started_at < NOW() - INTERVAL '7 days'
       AND NOT EXISTS (SELECT 1 FROM public.game_round_bets b WHERE b.round_id = r.id)
     LIMIT v_batch
  )
  DELETE FROM public.game_rounds r USING doomed WHERE r.id = doomed.id;
  GET DIAGNOSTICS v_empty_rounds = ROW_COUNT;

  -- 3. Everything older than 90 days, bets included. transactions still holds
  --    the money trail for these.
  WITH doomed AS (
    SELECT r.id
      FROM public.game_rounds r
     WHERE r.status = 'settled'
       AND r.started_at < NOW() - INTERVAL '90 days'
     LIMIT v_batch
  )
  DELETE FROM public.game_rounds r USING doomed WHERE r.id = doomed.id;
  GET DIAGNOSTICS v_old_rounds = ROW_COUNT;

  -- 4. Greedy King keeps its own table; same two round rules in one pass.
  WITH doomed AS (
    SELECT r.id
      FROM public.greedy_pro_rounds r
     WHERE r.status = 'settled'
       AND (
         (r.started_at < NOW() - INTERVAL '7 days'
           AND NOT EXISTS (SELECT 1 FROM public.greedy_pro_bets b WHERE b.round_id = r.id))
         OR r.started_at < NOW() - INTERVAL '90 days'
       )
     LIMIT v_batch
  )
  DELETE FROM public.greedy_pro_rounds r USING doomed WHERE r.id = doomed.id;
  GET DIAGNOSTICS v_pro_rounds = ROW_COUNT;

  RETURN jsonb_build_object(
    'robot_bets_deleted',   v_robot_bets,
    'empty_rounds_deleted', v_empty_rounds,
    'old_rounds_deleted',   v_old_rounds,
    'greedy_pro_deleted',   v_pro_rounds,
    'ran_at', NOW()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.prune_game_history(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_game_history(INT) TO service_role;

DO $$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'pg_cron unavailable; prune_game_history was not scheduled.';
    RETURN;
  END IF;

  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'prune-game-history';

  -- Every 5 minutes. Small batches keep each run short and lock-friendly, and
  -- drain the existing backlog over several hours rather than in one hit.
  PERFORM cron.schedule(
    'prune-game-history',
    '*/5 * * * *',
    $cron$ SELECT public.prune_game_history(2000); $cron$
  );
END $$;
