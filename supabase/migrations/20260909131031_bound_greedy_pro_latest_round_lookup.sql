-- Greedy King: same unbounded latest-round lookup that was freezing Greedy Lion.
--
-- Companion to bound_greedy_lion_latest_round_lookup. Greedy King moved to its
-- own greedy_pro_rounds table in the dedicated-tables migration, so the earlier
-- pass that bounded these lookups on game_rounds never reached this one.
--
-- Before:
--     Limit  (cost=4061.14..4061.14 rows=1)
--       ->  Sort  (rows=31407)
--             Sort Key: started_at DESC NULLS LAST, created_at DESC
--             ->  Seq Scan on greedy_pro_rounds  (rows=31407)
-- Every tick sequentially scanned all 31,407 rounds and sorted them to return a
-- single row. greedy_pro_rounds_room_id_game_type_started_at_idx already covers
-- (room_id, game_type, started_at DESC), but a DESC btree column is NULLS FIRST,
-- so asking for NULLS LAST -- plus a created_at tiebreaker absent from the index
-- -- made the index useless for ordering and the planner fell back to a seq scan.
--
-- As with Greedy Lion, the time bound also disarms the catch-up WHILE loop below.
-- v_latest sets v_next_start, and that loop then creates AND settles up to 20
-- rounds per tick to walk the schedule forward to now. While the game was starved
-- v_next_start sat far in the past, so every tick replayed 20 insert+settle
-- cycles for rounds nobody bet on. With the bound, an outage longer than the
-- window simply starts one fresh round at NOW(), which is what players want.
--
-- The bound removes the need for NULLS LAST on its own: "started_at > NOW() - ..."
-- is false for NULL, so a NULL-started row can never be chosen as the latest.
--
-- After: Limit (cost=0.42..1.49 rows=1) -> Index Scan, 3 rows examined.
-- Cost 4061 -> 1.49.
--
-- Only that one SELECT changed; the rest of the function is byte-identical.

CREATE OR REPLACE FUNCTION public.greedy_pro_tick_unlocked_149()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_settings public.game_settings%ROWTYPE;
  v_round public.greedy_pro_rounds%ROWTYPE;
  v_active public.greedy_pro_rounds%ROWTYPE;
  v_latest public.greedy_pro_rounds%ROWTYPE;
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
  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'greedy_pro';
  IF NOT FOUND OR v_settings.is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Greedy King is offline', 'server_now', NOW());
  END IF;

  v_duration := GREATEST(5, LEAST(120, COALESCE(v_settings.round_duration_s, 30)));
  v_display := GREATEST(3, LEAST(60, COALESCE(v_settings.result_display_s, 15)));
  v_grace := public.greedy_pro_bet_grace_seconds();

  FOR v_round IN
    SELECT *
      FROM public.greedy_pro_rounds
     WHERE room_id = public.greedy_pro_global_room_id()
       AND game_type = 'greedy_pro'
       AND status IN ('betting', 'resolving')
       AND ends_at + (v_grace || ' seconds')::interval <= NOW()
     ORDER BY started_at ASC
     FOR UPDATE SKIP LOCKED
  LOOP
    v_resolved := public.resolve_greedy_pro_round(v_round.id);
  END LOOP;

  -- Bounded and index-ordered. Only a recent round can usefully anchor the next
  -- start time; anything older means the game was down and should restart clean.
  SELECT * INTO v_latest
    FROM public.greedy_pro_rounds
   WHERE room_id = public.greedy_pro_global_room_id()
     AND game_type = 'greedy_pro'
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
      INSERT INTO public.greedy_pro_rounds
        (game_type, room_id, status, started_at, ends_at, bets, result, total_bet, win_amount)
      VALUES
        ('greedy_pro', public.greedy_pro_global_room_id(), 'betting', v_next_start, v_next_end, '{}'::jsonb, '{}'::jsonb, 0, 0)
      RETURNING * INTO v_round;

      v_resolved := public.resolve_greedy_pro_round(v_round.id);
      SELECT (result->>'settled_at')::timestamptz
        INTO v_latest_settled_at
        FROM public.greedy_pro_rounds
       WHERE id = v_round.id;
      v_next_start := COALESCE(v_latest_settled_at, v_next_end + (v_grace || ' seconds')::interval) + (v_display || ' seconds')::interval;
      v_loop_guard := v_loop_guard + 1;
    END LOOP;
  END IF;

  SELECT * INTO v_active
    FROM public.greedy_pro_rounds
   WHERE room_id = public.greedy_pro_global_room_id()
     AND game_type = 'greedy_pro'
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
    INSERT INTO public.greedy_pro_rounds
      (game_type, room_id, status, started_at, ends_at, bets, result, total_bet, win_amount)
    VALUES
      ('greedy_pro', public.greedy_pro_global_room_id(), 'betting', v_next_start, v_next_start + (v_duration || ' seconds')::interval, '{}'::jsonb, '{}'::jsonb, 0, 0)
    RETURNING id INTO v_created_id;
  END IF;

  RETURN json_build_object('success', true, 'created_round_id', v_created_id, 'last_resolve', v_resolved, 'server_now', NOW());
END $function$;
