-- Make autovacuum actually run on the game tables (audit finding TP-07).
--
-- autovacuum triggers at autovacuum_vacuum_threshold + scale_factor * live_rows.
-- The Postgres default scale_factor is 0.2, so game_rounds needed ~67,000 dead
-- tuples before a vacuum would fire. It had been sitting at 19.5% dead (65,628
-- of 337,222) -- permanently just under its own trigger. Result:
--
--   table              dead%   autovacuum_count   last_autovacuum
--   game_rounds        19.5%   0                  never
--   game_robot_bets     0.4%   0                  never
--   transactions        8.6%   0                  never
--   game_round_bets     3.2%   0                  never
--
-- Four of the busiest tables in the database had never been vacuumed once. Dead
-- tuples are still visited by index and heap scans, so this is a slow, invisible
-- tax on every read, and the space is never reclaimed.
--
-- Dropping seven indexes off game_rounds in the previous migration also raises
-- the ceiling for HOT updates (a heap-only tuple needs a free slot on the page
-- and no index covering the changed column; that table was at 12% HOT with
-- eleven indexes). Vacuum is what keeps those free slots available, so the two
-- changes compound.
--
-- 0.05 means "vacuum once 5% of the table is dead" instead of 20%. On tables
-- this size that is frequent enough to hold bloat flat without vacuum running
-- constantly. analyze at 0.02 keeps the planner's row estimates honest, which
-- matters here: the bounded latest-round lookups added today depend on the
-- planner correctly estimating that only a handful of rows fall inside the
-- 10-minute window.
--
-- A manual VACUUM (ANALYZE) was run alongside this migration to clear the
-- existing backlog. It also corrected badly stale statistics: transactions had
-- never been analysed and the planner believed it held 18,327 rows when it
-- actually holds 563,307 -- a 30x underestimate driving every plan that touches
-- it, including the daily_loss_cap check on the bet path.
--
--   game_rounds      19.5% dead -> 0.0%
--   game_round_bets   3.2% dead -> 0.0%
--   transactions      8.6% dead -> 0.3%
--
-- ALTER TABLE ... SET on autovacuum parameters takes only SHARE UPDATE EXCLUSIVE,
-- so this does not block reads or writes.
--
-- To revert a table to the global defaults:
--   ALTER TABLE public.<t> RESET (autovacuum_vacuum_scale_factor,
--                                 autovacuum_analyze_scale_factor);

ALTER TABLE public.game_rounds       SET (autovacuum_vacuum_scale_factor = 0.05,
                                          autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.game_round_bets   SET (autovacuum_vacuum_scale_factor = 0.05,
                                          autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.game_robot_bets   SET (autovacuum_vacuum_scale_factor = 0.05,
                                          autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.transactions      SET (autovacuum_vacuum_scale_factor = 0.05,
                                          autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.greedy_pro_rounds SET (autovacuum_vacuum_scale_factor = 0.05,
                                          autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.greedy_pro_bets   SET (autovacuum_vacuum_scale_factor = 0.05,
                                          autovacuum_analyze_scale_factor = 0.02);
