-- Close the "no active round" gap that zeroed the board between rounds.
--
-- 20260906170000 removed `PERFORM public.tin_patti_pro_tick()` from
-- get_tin_patti_pro_state, on the grounds that the cron coordinator owns the
-- clock. That was premature. The round-selection predicate only matches a round
-- that is either still open for betting or still inside its result display
-- window, so once the display window lapses there is genuinely no matching row
-- until the coordinator inserts the next round. The read then returns
-- `round: null`.
--
-- A null round is not harmless on the client: normalizeGameSnapshot maps it to
-- phase WAITING with empty options, so every board total and the player's own
-- stake render as 0, and the scene resets its round visuals. Players saw their
-- bet amount blank out around the round boundary.
--
-- Previously the read itself ticked, so it created the next round on demand and
-- the gap was never observable. The reason for removing it - that the tick was
-- expensive and every reader paid for it - no longer holds: 20260906140000 made
-- the tick self-guarding (one caller at a time, everyone else returns
-- immediately) and 20260906190000/200000 bounded the scans it performed, so a
-- tick from a reader is now cheap and almost always a no-op.
--
-- Restore it as an on-demand fallback. The coordinator remains the primary
-- clock; this just means a client asking for state during the changeover gets
-- the next round immediately instead of a null one.

DO $mig$
DECLARE
  src     TEXT;
  patched TEXT;
BEGIN
  src := pg_get_functiondef('public.get_tin_patti_pro_state()'::regprocedure);

  IF position('tin_patti_pro_tick()' IN src) > 0 THEN
    RAISE NOTICE 'get_tin_patti_pro_state already ticks; nothing to do';
    RETURN;
  END IF;

  patched := replace(
    src,
    E'  -- No tick here: the cron coordinator owns the clock (verified active at 1s).\n'
    || E'  -- place_tin_patti_pro_bet still ticks, so betting remains a fallback clock.',
    E'  -- Fallback clock: guarded, so this is a no-op for all but one caller.\n'
    || E'  -- Without it a read landing between the end of the result display and\n'
    || E'  -- the coordinator''s next insert returns a null round, which blanks the\n'
    || E'  -- board and the player''s own stake.\n'
    || E'  PERFORM public.tin_patti_pro_tick();'
  );

  IF patched = src THEN
    RAISE EXCEPTION 'Could not restore the read tick: expected preamble not found';
  END IF;

  EXECUTE patched;
  RAISE NOTICE 'Restored on-demand tick fallback in get_tin_patti_pro_state';
END;
$mig$;

DO $verify$
BEGIN
  IF position('tin_patti_pro_tick()' IN pg_get_functiondef('public.get_tin_patti_pro_state()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'get_tin_patti_pro_state is still missing its tick fallback';
  END IF;
  IF position('started_at > NOW() - INTERVAL' IN pg_get_functiondef('public.get_tin_patti_pro_state()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'get_tin_patti_pro_state lost its bounded round lookup';
  END IF;
END;
$verify$;
