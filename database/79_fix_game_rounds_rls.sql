-- =====================================================================
-- 79_fix_game_rounds_rls.sql
-- =====================================================================
-- ROOT CAUSE of the "game timer hits 0 then stays stuck forever" bug
-- that survived migrations 51, 54, and 77 plus the mobile client
-- retry-loop fix.
--
-- The base schema (yolo_schema.sql line 1162-1163) declared:
--
--   CREATE POLICY game_rounds_read ON public.game_rounds FOR SELECT
--     USING (user_id = auth.uid() OR public.is_admin(auth.uid()));
--
-- Migration 51 then converted game_rounds to a MULTIPLAYER model where
-- room-scoped rounds are inserted with user_id = NULL (see
-- 51_multiplayer_games.sql lines 53 and 193-198). It added a permissive
-- policy for game_round_bets (`USING (TRUE)`) but never updated
-- game_rounds_read. So `NULL = auth.uid()` evaluates to NULL → falsy,
-- and every non-admin viewer is blocked from SELECTing the rounds.
--
-- Two consequences:
--
--   1. Reading round history / current state in the mobile app returns
--      no rows for non-admins.
--   2. CRITICAL: Supabase Realtime re-evaluates the same SELECT policy
--      per-subscriber before delivering postgres_changes payloads.
--      When resolve_game_round flips status='betting' → 'settled'
--      (SECURITY DEFINER, server-side bypasses RLS), the UPDATE event
--      reaches Realtime, gets filtered out for every non-admin client,
--      and the mobile UI's UPDATE listener (TeenPatti.js / FruitRoulette.js)
--      never fires. The countdown timer hits 0, the row IS settled in
--      the DB, but the client never learns about it. Status state
--      stays 'betting', UI stays at "BETTING 0s" forever.
--
-- Fix: make the read policy permissive, matching game_round_bets. Live
-- room state is public information — anyone watching the room can see
-- the bets, so the round metadata being public is no security loss.
-- Writes remain locked to the SECURITY DEFINER RPCs, so cheating via
-- direct INSERT/UPDATE is still impossible.
--
-- Also rescues any stuck rounds left in 'betting' or 'resolving' state
-- past their expiry. Some of them may have been mid-resolve when a
-- prior call errored or got cancelled — the previous rescue script
-- couldn't recover those because resolve_game_round only claims
-- status='betting'. We reset 'resolving' → 'betting' first so the
-- normal claim path can re-run cleanly.
--
-- Idempotent.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. REPLACE the over-restrictive read policy
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS game_rounds_read ON public.game_rounds;
CREATE POLICY game_rounds_read ON public.game_rounds
  FOR SELECT
  USING (TRUE);

-- Belt-and-braces: ensure RLS is on AND the table is in the realtime
-- publication. Both should already be true from earlier migrations but
-- a clean re-run guarantees the state we need.
ALTER TABLE public.game_rounds ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='game_rounds'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.game_rounds;
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 2. RESCUE stuck rounds (both 'betting' and 'resolving' state past
--    expiry). Reset 'resolving' to 'betting' so resolve_game_round's
--    atomic claim path can re-run.
-- ---------------------------------------------------------------------
UPDATE public.game_rounds
   SET status = 'betting'
 WHERE status = 'resolving'
   AND ends_at < NOW();


-- ---------------------------------------------------------------------
-- 3. Run the resolver against everything still stuck. Impersonates the
--    primary super_admin so resolve_game_round's auth.uid() check
--    passes; that admin will appear in the audit trail.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_admin_id UUID;
  r RECORD;
  v_count   INT := 0;
BEGIN
  SELECT id INTO v_admin_id FROM public.profiles WHERE role = 'super_admin' LIMIT 1;
  IF v_admin_id IS NULL THEN
    RAISE NOTICE 'No super_admin found; skipping rescue';
    RETURN;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_admin_id::TEXT, true);

  FOR r IN
    SELECT id FROM public.game_rounds
     WHERE status = 'betting' AND ends_at < NOW()
     ORDER BY started_at ASC
  LOOP
    BEGIN
      PERFORM public.resolve_game_round(r.id);
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Failed to resolve %: %', r.id, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'Rescue resolved % rounds', v_count;
END $$;


-- =====================================================================
-- DONE — after running this in Supabase SQL Editor, wait ~30 seconds
-- for Realtime to refresh its policy cache, then test in the app.
-- =====================================================================
