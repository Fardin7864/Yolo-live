-- Phase 1a of the Teen Patti Pro audit: the game_round_bets half.
--
-- Both indexes below are exact duplicates of an index that stays. Same columns,
-- same order, different name -- the planner prefers the survivor and the twin
-- being dropped is the more bloated copy:
--
--   idx_game_round_bets_round_created  13 MB, 10,967 scans
--     -> survivor game_round_bets_round_created_idx  9.2 MB, 50,871 scans
--   idx_game_round_bets_round_user    4.2 MB, 412 scans
--     -> survivor game_round_bets_round_user_idx     3.1 MB, 41,684 scans
--
-- Verified: neither is UNIQUE, a primary key, or backing a constraint, and both
-- survivors were confirmed present with byte-identical definitions.
--
-- Split out from the game_rounds drops because game_rounds is held almost
-- continuously by tick_authoritative_mini_games (observed running 117 s on
-- DataFileRead), so the two tables need separate lock windows.
--
-- Short lock_timeout on purpose: a queued ACCESS EXCLUSIVE blocks every reader
-- behind it, so failing fast and retrying is safer than waiting. Idempotent.

SET lock_timeout = '3s';

DROP INDEX IF EXISTS public.idx_game_round_bets_round_created;
DROP INDEX IF EXISTS public.idx_game_round_bets_round_user;
