-- Keep self-gifts out of rankings, ratings and earnings.
--
-- Every ranking/earnings function reads public.gifts_log directly, so a host
-- could otherwise buy their way up the charts with their own diamonds. Rather
-- than hand-editing seven WHERE clauses (each with a different alias, or none),
-- they are repointed at a filtered view. The view carries the same column set,
-- so each function's existing alias and column references keep working and the
-- change is a pure name swap.
--
-- Deliberately NOT repointed:
--   get_live_gift_state - the live gift feed and animation must show self-gifts
--   recalc_user_level   - already excludes them (receiver_id IS DISTINCT FROM sender)
--   room_get_guardians  - already excludes them (sender_id IS DISTINCT FROM host)
--   send_gift / send_gift_batch / self_gift_today - writers and the audit read

CREATE OR REPLACE VIEW public.gifts_log_earning AS
  SELECT * FROM public.gifts_log WHERE NOT is_self_gift;

GRANT SELECT ON public.gifts_log_earning TO authenticated, service_role;

DO $mig$
DECLARE
  target   TEXT;
  src      TEXT;
  patched  TEXT;
  changed  INT := 0;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'public.get_celebrity_host_ids()',
    'public.get_explore_ranking(text,text,integer)',
    'public.get_room_seat_earnings(uuid)',
    'public.get_top_broadcasters_24h(integer)',
    'public.get_top_broadcasters_daily(integer)',
    'public.get_top_gifters(text,integer)',
    'public.room_gifter_ranking(uuid,integer)'
  ]
  LOOP
    IF to_regprocedure(target) IS NULL THEN
      RAISE NOTICE 'Skipping %: not present', target;
      CONTINUE;
    END IF;

    src := pg_get_functiondef(to_regprocedure(target));

    IF position('gifts_log_earning' IN src) > 0 THEN
      RAISE NOTICE 'Skipping %: already filtered', target;
      CONTINUE;
    END IF;

    patched := replace(src, 'public.gifts_log', 'public.gifts_log_earning');

    IF patched = src THEN
      RAISE EXCEPTION 'Could not repoint %: no public.gifts_log reference found', target;
    END IF;

    EXECUTE patched;
    changed := changed + 1;
    RAISE NOTICE 'Excluded self-gifts from %', target;
  END LOOP;

  RAISE NOTICE 'Repointed % function(s)', changed;
END;
$mig$;

-- Guard the two that must still see self-gifts.
DO $verify$
BEGIN
  IF position('public.gifts_log_earning' IN pg_get_functiondef('public.get_live_gift_state(uuid)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'get_live_gift_state must keep showing self-gifts in the live feed';
  END IF;
  IF position('public.gifts_log_earning' IN pg_get_functiondef('public.self_gift_today(uuid)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'self_gift_today must read the unfiltered log';
  END IF;
END;
$verify$;

COMMENT ON VIEW public.gifts_log_earning IS
  'gifts_log without self-gifts. Source for rankings, ratings and earnings so a host cannot inflate them with their own diamonds.';
