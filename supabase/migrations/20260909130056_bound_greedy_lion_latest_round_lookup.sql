-- Unfreeze the mini-games: Greedy Lion was eating the whole coordinator tick.
--
-- tick_authoritative_mini_games() runs the four games in sequence inside one
-- transaction, and Greedy Lion runs FIRST. Its tick was taking so long that
-- everything behind it -- Teen Patti, Lucky Dice, Greedy King -- was starved.
-- Measured from the Postgres logs over four hours, with the cron firing every
-- 10 seconds:
--     42s, 45s, 47s, 48s, 53s, 63s, 65s, 70s, 79s, 84s, 94s, 96s, 105s
-- Round creation had collapsed to roughly 1 round per 10 minutes on games whose
-- cycle is ~30 seconds. Teen Patti kept limping only because its state read
-- self-ticks on every client poll; Greedy Lion and Greedy King have no such
-- fallback, so they simply stopped.
--
-- Two compounding causes, both in the v_latest lookup below.
--
-- 1. IT SORTED THE ENTIRE GAME'S HISTORY TO RETURN ONE ROW.
--        ORDER BY started_at DESC NULLS LAST, created_at DESC LIMIT 1
--    game_rounds_room_game_started_idx is (room_id, game_type, started_at DESC),
--    and a DESC btree column is NULLS FIRST. Asking for NULLS LAST -- plus a
--    created_at tiebreaker that is not in the index at all -- means the index can
--    still filter but cannot order, so the planner read every matching row and
--    sorted it:
--        Limit  (cost=27337.36..27337.36 rows=1)
--          ->  Sort  (rows=43414)
--                Sort Key: started_at DESC NULLS LAST, created_at DESC
--                ->  Index Scan using game_rounds_room_game_started_idx
--    43,414 greedy_lion rounds read and sorted, every tick, for one row.
--
--    The sibling v_active lookup further down already carries
--    "started_at > NOW() - INTERVAL '10 minutes'" from the earlier
--    bound_all_game_active_round_lookups work. This one was missed.
--
-- 2. IT FED A CATCH-UP LOOP THAT REPLAYED HISTORY.
--    v_latest sets v_next_start, and the WHILE loop below then creates AND
--    resolves rounds until the schedule reaches now, up to 20 per tick. Because
--    the game was starved, v_next_start was always far in the past, so every tick
--    ground through 20 insert+settle cycles for rounds nobody had bet on. The
--    time bound fixes this too: when nothing recent exists the loop is skipped
--    entirely and a single fresh round starts at NOW(), which is the right
--    behaviour after an outage. Replaying a dead game's backlog helps no one.
--
-- The bound also removes the need for NULLS LAST: "started_at > NOW() - ..." is
-- false for NULL, so NULL-started rows cannot be selected as the latest anyway.
-- ORDER BY started_at DESC now matches the index exactly.
--
-- After: Limit (cost=0.43..1.70 rows=1) -> Index Scan, 4 rows examined.
-- Cost 27337 -> 1.70. The coordinator tick dropped below the 10s auto_explain
-- threshold and stopped appearing in the slow log at all.
--
-- Only that one SELECT changed; the rest of the function is byte-identical.

CREATE OR REPLACE FUNCTION public.greedy_lion_tick_unlocked_149()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_settings public.game_settings%ROWTYPE;
  v_round public.game_rounds%ROWTYPE;
  v_active public.game_rounds%ROWTYPE;
  v_latest public.game_rounds%ROWTYPE;
  v_duration INT;
  v_display INT;
  v_grace INT;
  v_latest_settled_at TIMESTAMPTZ;
  v_created_id UUID;
  v_resolved JSON;
  v_next_start TIMESTAMPTZ;
  v_next_end TIMESTAMPTZ;
  v_loop_guard INT := 0;
BEGIN
  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'greedy_lion';
  IF NOT FOUND OR v_settings.is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Greedy Lion is offline', 'server_now', NOW());
  END IF;

  v_duration := GREATEST(5, LEAST(120, COALESCE(v_settings.round_duration_s, 30)));
  v_display := GREATEST(3, LEAST(60, COALESCE(v_settings.result_display_s, 15)));
  v_grace := public.greedy_lion_bet_grace_seconds();

  FOR v_round IN
    SELECT *
      FROM public.game_rounds
     WHERE room_id = public.greedy_lion_global_room_id()
       AND game_type = 'greedy_lion'
       AND status IN ('betting', 'resolving')
       AND ends_at + (v_grace || ' seconds')::interval <= NOW()
     ORDER BY started_at ASC
     FOR UPDATE SKIP LOCKED
  LOOP
    v_resolved := public.resolve_greedy_lion_round(v_round.id);
  END LOOP;

  -- Bounded and index-ordered. Only a recent round can usefully anchor the next
  -- start time; anything older means the game was down and should restart clean.
  SELECT * INTO v_latest
    FROM public.game_rounds
   WHERE room_id = public.greedy_lion_global_room_id()
     AND game_type = 'greedy_lion'
     AND started_at > NOW() - INTERVAL '10 minutes'
   ORDER BY started_at DESC
   LIMIT 1;

  IF FOUND THEN
    IF v_latest.status = 'settled' THEN
      v_latest_settled_at := COALESCE((v_latest.result->>'settled_at')::timestamptz, v_latest.ends_at + (v_grace || ' seconds')::interval);
      v_next_start := v_latest_settled_at + (v_display || ' seconds')::interval;
    ELSE
      v_next_start := v_latest.ends_at;
    END IF;

    WHILE v_next_start + (v_duration || ' seconds')::interval + (v_grace || ' seconds')::interval <= NOW()
      AND v_loop_guard < 20
    LOOP
      v_next_end := v_next_start + (v_duration || ' seconds')::interval;
      INSERT INTO public.game_rounds
        (game_type, room_id, status, started_at, ends_at, bets, result, total_bet, win_amount)
      VALUES
        ('greedy_lion', public.greedy_lion_global_room_id(), 'betting', v_next_start, v_next_end, '{}'::jsonb, '{}'::jsonb, 0, 0)
      RETURNING * INTO v_round;

      v_resolved := public.resolve_greedy_lion_round(v_round.id);
      SELECT (result->>'settled_at')::timestamptz
        INTO v_latest_settled_at
        FROM public.game_rounds
       WHERE id = v_round.id;
      v_next_start := COALESCE(v_latest_settled_at, v_next_end + (v_grace || ' seconds')::interval) + (v_display || ' seconds')::interval;
      v_loop_guard := v_loop_guard + 1;
    END LOOP;
  END IF;

  SELECT * INTO v_active
    FROM public.game_rounds
   WHERE room_id = public.greedy_lion_global_room_id()
     AND game_type = 'greedy_lion'
     AND started_at > NOW() - INTERVAL '10 minutes' AND ((status = 'betting' AND ends_at + (v_grace || ' seconds')::interval > NOW())
       OR
       (status = 'settled' AND COALESCE((result->>'settled_at')::timestamptz, ends_at + (v_grace || ' seconds')::interval) + (v_display || ' seconds')::interval > NOW())
     )
   ORDER BY
     CASE WHEN status = 'settled' THEN 0 ELSE 1 END,
     started_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    IF v_next_start IS NULL OR v_next_start <= NOW() THEN
      v_next_start := NOW();
    END IF;
    INSERT INTO public.game_rounds
      (game_type, room_id, status, started_at, ends_at, bets, result, total_bet, win_amount)
    VALUES
      ('greedy_lion', public.greedy_lion_global_room_id(), 'betting', v_next_start, v_next_start + (v_duration || ' seconds')::interval, '{}'::jsonb, '{}'::jsonb, 0, 0)
    RETURNING id INTO v_created_id;
  END IF;

  RETURN json_build_object('success', true, 'created_round_id', v_created_id, 'last_resolve', v_resolved, 'server_now', NOW());
END $function$;
