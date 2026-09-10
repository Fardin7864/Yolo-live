-- Phase 1b of the Teen Patti Pro audit: the game_rounds half.
--
-- This was blocked for two days: game_rounds was held almost continuously by
-- tick_authoritative_mini_games (observed at 117 s on DataFileRead), so an
-- ACCESS EXCLUSIVE lock could never be acquired. Now that the Greedy Lion and
-- Greedy King latest-round lookups are bounded and the tick runs in well under a
-- second, the table is free between ticks and this applied on the first attempt.
--
-- game_rounds carried 310 MB of indexes on 269 MB of heap, and every insert and
-- update maintained all eleven. That is also why only 12% of its updates were
-- HOT: a heap-only tuple needs a spare slot on the page and no index covering
-- the changed column, and with eleven indexes there was rarely either.
--
-- Group A -- never scanned since the stats window opened on 2026-09-04:
--   idx_game_rounds_realtime_lookup       61 MB, 0 scans
--   idx_game_rounds_game                  34 MB, 0 scans
--   idx_game_rounds_type_winner_settled   28 MB, 0 scans
--   idx_game_rounds_user                  28 MB, 0 scans
--   game_rounds_game_status_started_idx   18 MB, 10 scans
--
-- Group B -- exact duplicates; the survivor is the smaller, far more used copy:
--   idx_game_rounds_tin_patti_pro_active  47 MB, 19,761 scans
--     -> survivor game_rounds_room_game_status_ends_idx  24 MB, 250,917 scans
--   idx_game_rounds_room_recent           36 MB, 76,871 scans
--     -> survivor game_rounds_room_game_started_idx      20 MB, 424,807 scans
--
-- game_rounds_room_game_started_idx is deliberately kept: it is the index the
-- newly bounded greedy_lion latest-round lookup now depends on.
--
-- Verified: none is UNIQUE, a primary key, or backing a constraint, and both
-- Group B survivors were confirmed present with byte-identical definitions.
--
-- Result: 11 indexes / 310 MB -> 4 indexes / 59 MB. All four survivors are hot
-- (285k, 455k, 5.5M and 391k scans respectively).
--
-- Short lock_timeout on purpose: a queued ACCESS EXCLUSIVE blocks every reader
-- behind it, so failing fast and retrying beats waiting. Idempotent.
--
-- To restore any of these, re-create with CREATE INDEX CONCURRENTLY using the
-- definitions recorded above.

SET lock_timeout = '4s';

-- Group A: dead weight.
DROP INDEX IF EXISTS public.idx_game_rounds_realtime_lookup;
DROP INDEX IF EXISTS public.idx_game_rounds_game;
DROP INDEX IF EXISTS public.idx_game_rounds_type_winner_settled;
DROP INDEX IF EXISTS public.idx_game_rounds_user;
DROP INDEX IF EXISTS public.game_rounds_game_status_started_idx;

-- Group B: duplicate twins.
DROP INDEX IF EXISTS public.idx_game_rounds_tin_patti_pro_active;
DROP INDEX IF EXISTS public.idx_game_rounds_room_recent;
