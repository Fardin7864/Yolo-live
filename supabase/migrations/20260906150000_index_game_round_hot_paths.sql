-- Index the queries every game state read performs.
--
-- `game_rounds` holds ~318k rows and `game_round_bets` ~346k, shared across all
-- games. The per-call round lookup filters by room + game_type and orders by
-- started_at, and the public bet list filters by round_id ordered by created_at.
-- Measured before this change, each of those took 0.24-0.43s on their own -
-- sequential-scan territory for tables this small - and the state function runs
-- several of them per call, which is most of its ~2-3s cost.
--
-- CREATE INDEX (not CONCURRENTLY) briefly blocks writes on these tables while it
-- builds. At this row count that is on the order of seconds, and the games
-- tolerate a short pause far better than the current timeouts.

CREATE INDEX IF NOT EXISTS game_rounds_room_game_started_idx
  ON public.game_rounds (room_id, game_type, started_at DESC);

CREATE INDEX IF NOT EXISTS game_rounds_game_status_started_idx
  ON public.game_rounds (game_type, status, started_at DESC);

CREATE INDEX IF NOT EXISTS game_round_bets_round_created_idx
  ON public.game_round_bets (round_id, created_at DESC);

CREATE INDEX IF NOT EXISTS game_round_bets_round_user_idx
  ON public.game_round_bets (round_id, user_id);

ANALYZE public.game_rounds;
ANALYZE public.game_round_bets;
