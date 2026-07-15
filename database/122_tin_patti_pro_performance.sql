-- 122_tin_patti_pro_performance.sql
-- Keeps global-round lookup and bet aggregation fast as history grows.

CREATE INDEX IF NOT EXISTS idx_game_rounds_tin_patti_pro_active
  ON public.game_rounds (room_id, game_type, status, ends_at DESC);

CREATE INDEX IF NOT EXISTS idx_game_round_bets_round_created
  ON public.game_round_bets (round_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_game_round_bets_round_user
  ON public.game_round_bets (round_id, user_id);

ANALYZE public.game_rounds;
ANALYZE public.game_round_bets;
