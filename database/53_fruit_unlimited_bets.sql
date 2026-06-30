-- =====================================================================
-- 53_fruit_unlimited_bets.sql
-- =====================================================================
-- Matches Fruit Roulette's bet ceiling policy to Teen Patti — no
-- per-tap maximum either. Migration 52 already lifted the round-total
-- check for both games at the RPC level; this one finishes the job by
-- nulling max_bet on the fruit_roulette settings row so the per-tap
-- check (still in place for any game with max_bet IS NOT NULL) doesn't
-- fire there.
--
-- All other guards stay (min_bet, daily_loss_cap, balance, round state).
-- Idempotent: re-runnable.
-- =====================================================================

UPDATE public.game_settings
   SET max_bet = NULL
 WHERE id = 'fruit_roulette';