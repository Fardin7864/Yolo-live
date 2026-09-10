-- Bound the "which round is live" lookup in every remaining game.
--
-- 20260906180000/190000 fixed this for Teen Patti's read and tick. The same
-- unbounded query exists in Greedy Lion, Greedy King and Lucky Dice, and that
-- still hurts Teen Patti: all four tick functions run inside the single
-- tick_authoritative_mini_games coordinator, each behind a *blocking*
-- pg_advisory_xact_lock, so a slow scan in any one of them delays settlement in
-- all of them.
--
-- Evidence after fixing Teen Patti alone: the 1-second clock was still averaging
-- 1.0-2.2s per tick and completing only ~30-43 runs per minute instead of 60,
-- because the other three games were still each walking their full round history
-- on every tick.
--
-- The bound is the same reasoning throughout: a round can only satisfy either
-- branch of the predicate if ends_at + grace + display is still in the future, so
-- it started within roughly the last half-minute. Ten minutes is generous by two
-- orders of magnitude and cannot change which round is selected.
--
-- The functions are patched in place from their deployed definitions rather than
-- retyped, so nothing but the added predicate can change. CREATE OR REPLACE
-- preserves existing grants.

DO $mig$
DECLARE
  target   TEXT;
  src      TEXT;
  patched  TEXT;
  changed  INT := 0;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'public.greedy_lion_tick_unlocked_149()',
    'public.greedy_pro_tick_unlocked_149()',
    'public.lucky_dice_tick()',
    'public.get_greedy_lion_state_filtered_152()',
    'public.get_greedy_pro_state_filtered_152()',
    'public.get_lucky_dice_state()',
    'public.get_tin_patti_pro_state_base_154()'
  ]
  LOOP
    IF to_regprocedure(target) IS NULL THEN
      RAISE NOTICE 'Skipping %: not present on this database', target;
      CONTINUE;
    END IF;

    src := pg_get_functiondef(to_regprocedure(target));

    IF position('started_at > NOW() - INTERVAL' IN src) > 0 THEN
      RAISE NOTICE 'Skipping %: already bounded', target;
      CONTINUE;
    END IF;

    patched := regexp_replace(
      src,
      $q$AND\s*\(\s*\(status = 'betting'$q$,
      $q$AND started_at > NOW() - INTERVAL '10 minutes' AND ((status = 'betting'$q$
    );

    IF patched = src THEN
      RAISE EXCEPTION 'Could not bound %: expected active-round predicate not found', target;
    END IF;

    EXECUTE patched;
    changed := changed + 1;
    RAISE NOTICE 'Bounded active-round lookup in %', target;
  END LOOP;

  RAISE NOTICE 'Bounded % function(s)', changed;
END;
$mig$;

-- Fail the deploy if any of them is still unbounded.
DO $verify$
DECLARE
  leftover TEXT;
BEGIN
  SELECT string_agg(p.proname, ', ')
    INTO leftover
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND pg_get_functiondef(p.oid) LIKE '%settled_at%'
     AND pg_get_functiondef(p.oid) LIKE '%ORDER BY%CASE WHEN status%'
     AND pg_get_functiondef(p.oid) NOT LIKE '%started_at > NOW() - INTERVAL%';

  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'Active-round lookup still unbounded in: %', leftover;
  END IF;
END;
$verify$;
