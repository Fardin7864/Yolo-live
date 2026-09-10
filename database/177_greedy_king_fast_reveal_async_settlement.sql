-- Greedy King result delivery must not wait for payout settlement.
--
-- Phase 1 (fast): choose and publish an immutable winner as `resolving`.
-- Phase 2 (next clock transaction): settle aggregated payouts idempotently.
-- State reads never run the clock, so a large settlement cannot delay the popup.

CREATE OR REPLACE FUNCTION public.reveal_greedy_pro_round(p_round_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_round public.game_rounds%ROWTYPE;
  v_settings public.game_settings%ROWTYPE;
  v_rules JSONB := '{}'::JSONB;
  v_result_type TEXT := 'item';
  v_winner_pos TEXT;
  v_category TEXT;
  v_forced BOOLEAN := FALSE;
  v_schedule_reason TEXT := 'item_rtp_range';
  v_total_bet BIGINT := 0;
  v_target_min_percent NUMERIC := 30;
  v_target_max_percent NUMERIC := 40;
  v_target_mid_percent NUMERIC := 35;
  v_target_min_payout NUMERIC := 0;
  v_target_max_payout NUMERIC := 0;
  v_target_payout NUMERIC := 0;
  v_is_empty_round BOOLEAN := FALSE;
  v_liabilities JSONB := '{}'::JSONB;
  v_item RECORD;
  v_best_item TEXT;
  v_best_score NUMERIC;
  v_item_score NUMERIC;
  v_best_category TEXT;
  v_category_candidate TEXT;
  v_empty_pick TEXT;
  v_pizza_hour_count INT := 0;
  v_pizza_day_count INT := 0;
  v_salad_hour_count INT := 0;
  v_salad_day_count INT := 0;
  v_pizza_enabled BOOLEAN;
  v_salad_enabled BOOLEAN;
  v_pizza_per_hour INT;
  v_salad_per_hour INT;
  v_pizza_max_day INT;
  v_salad_max_day INT;
  v_revealed_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO v_round
    FROM public.game_rounds
   WHERE id = p_round_id
   FOR UPDATE;

  IF NOT FOUND OR v_round.game_type <> 'greedy_pro' THEN
    RETURN json_build_object('success', FALSE, 'message', 'Greedy King round not found');
  END IF;
  IF v_round.status IN ('resolving', 'settled') AND v_round.winner_pos IS NOT NULL THEN
    RETURN json_build_object(
      'success', TRUE,
      'already_revealed', TRUE,
      'round_id', v_round.id,
      'winner_pos', v_round.winner_pos,
      'result', v_round.result
    );
  END IF;

  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'greedy_pro';
  IF v_round.status <> 'betting'
     OR v_round.ends_at + (public.greedy_pro_bet_grace_seconds() || ' seconds')::INTERVAL > clock_timestamp() THEN
    RETURN json_build_object('success', FALSE, 'message', 'Round has not ended yet');
  END IF;

  SELECT COALESCE(SUM(amount), 0)
    INTO v_total_bet
    FROM public.game_round_bets
   WHERE round_id = p_round_id;

  v_is_empty_round := v_total_bet = 0;
  v_rules := COALESCE(v_settings.special_result_rules, '{}'::JSONB);
  v_target_min_percent := GREATEST(0, COALESCE(
    (v_rules->>'target_payout_min_percent')::NUMERIC,
    COALESCE(v_settings.win_chance_percent, 30)
  ));
  v_target_max_percent := GREATEST(v_target_min_percent, COALESCE(
    (v_rules->>'target_payout_max_percent')::NUMERIC,
    GREATEST(v_target_min_percent, COALESCE(v_settings.win_chance_percent, 30))
  ));
  v_target_mid_percent := (v_target_min_percent + v_target_max_percent) / 2.0;
  v_target_min_payout := v_total_bet * (v_target_min_percent / 100.0);
  v_target_max_payout := v_total_bet * (v_target_max_percent / 100.0);
  v_target_payout := v_total_bet * (v_target_mid_percent / 100.0);

  IF v_is_empty_round THEN
    SELECT pick INTO v_empty_pick
      FROM unnest(ARRAY['pizza','salad','corn','chicken','shrimp','tomato','ham','pepper','fish','carrot']) pick
     ORDER BY random()
     LIMIT 1;
    v_winner_pos := v_empty_pick;
    v_result_type := CASE WHEN v_empty_pick IN ('pizza', 'salad') THEN 'category' ELSE 'item' END;
    v_category := CASE
      WHEN v_empty_pick IN ('pizza', 'salad') THEN v_empty_pick
      ELSE (SELECT gm.category FROM public.greedy_pro_multiplier(v_empty_pick) gm LIMIT 1)
    END;
    v_schedule_reason := 'empty_random';
  ELSE
    v_pizza_enabled := COALESCE((v_rules->>'pizza_enabled')::BOOLEAN, TRUE);
    v_salad_enabled := COALESCE((v_rules->>'salad_enabled')::BOOLEAN, TRUE);
    v_pizza_per_hour := GREATEST(0, COALESCE((v_rules->>'pizza_per_hour')::INT, 0));
    v_salad_per_hour := GREATEST(0, COALESCE((v_rules->>'salad_per_hour')::INT, 0));
    v_pizza_max_day := GREATEST(0, COALESCE((v_rules->>'pizza_max_per_day')::INT, 0));
    v_salad_max_day := GREATEST(0, COALESCE((v_rules->>'salad_max_per_day')::INT, 0));

    SELECT
      COUNT(*) FILTER (WHERE winner_pos = 'pizza' AND COALESCE(result->>'result_type', 'category') = 'category' AND ends_at >= NOW() - INTERVAL '1 hour'),
      COUNT(*) FILTER (WHERE winner_pos = 'pizza' AND COALESCE(result->>'result_type', 'category') = 'category' AND ends_at >= date_trunc('day', NOW())),
      COUNT(*) FILTER (WHERE winner_pos = 'salad' AND COALESCE(result->>'result_type', 'category') = 'category' AND ends_at >= NOW() - INTERVAL '1 hour'),
      COUNT(*) FILTER (WHERE winner_pos = 'salad' AND COALESCE(result->>'result_type', 'category') = 'category' AND ends_at >= date_trunc('day', NOW()))
      INTO v_pizza_hour_count, v_pizza_day_count, v_salad_hour_count, v_salad_day_count
      FROM public.game_rounds
     WHERE room_id = public.greedy_pro_global_room_id()
       AND game_type = 'greedy_pro'
       AND status = 'settled';

    IF v_settings.forced_next_result IS NOT NULL
       AND public.greedy_pro_result_is_valid(v_settings.forced_next_result) THEN
      v_winner_pos := v_settings.forced_next_result;
      v_forced := TRUE;
      v_schedule_reason := 'forced';
      UPDATE public.game_settings
         SET forced_next_result = NULL,
             forced_next_category = NULL
       WHERE id = 'greedy_pro';
    ELSIF v_settings.forced_next_category IN ('pizza', 'salad') THEN
      v_winner_pos := v_settings.forced_next_category;
      v_forced := TRUE;
      v_schedule_reason := 'forced_legacy';
      UPDATE public.game_settings
         SET forced_next_category = NULL
       WHERE id = 'greedy_pro';
    ELSE
      IF v_pizza_enabled AND v_pizza_per_hour > 0
         AND v_pizza_hour_count < v_pizza_per_hour
         AND (v_pizza_max_day = 0 OR v_pizza_day_count < v_pizza_max_day) THEN
        v_category_candidate := 'pizza';
      END IF;
      IF v_salad_enabled AND v_salad_per_hour > 0
         AND v_salad_hour_count < v_salad_per_hour
         AND (v_salad_max_day = 0 OR v_salad_day_count < v_salad_max_day)
         AND (v_category_candidate IS NULL
           OR (v_salad_hour_count::NUMERIC / NULLIF(v_salad_per_hour, 0))
             < (v_pizza_hour_count::NUMERIC / NULLIF(v_pizza_per_hour, 0))) THEN
        v_category_candidate := 'salad';
      END IF;
      IF v_category_candidate IS NOT NULL THEN
        v_winner_pos := v_category_candidate;
        v_schedule_reason := 'scheduled_' || v_category_candidate;
      END IF;
    END IF;

    IF v_winner_pos IN ('pizza', 'salad') THEN
      v_result_type := 'category';
      v_category := v_winner_pos;
    ELSE
      v_result_type := 'item';
      IF v_winner_pos IS NULL THEN
        FOR v_item IN
          SELECT item.id,
                 item.category,
                 item.multiplier,
                 COALESCE(SUM(b.amount), 0)::NUMERIC * item.multiplier AS liability
            FROM (
              SELECT j->>'id' AS id,
                     j->>'category' AS category,
                     COALESCE((j->>'m')::NUMERIC, 0) AS multiplier
                FROM jsonb_array_elements(COALESCE(v_settings.multipliers, '[]'::JSONB)) j
            ) item
            LEFT JOIN public.game_round_bets b
              ON b.round_id = p_round_id AND b.position = item.id
           GROUP BY item.id, item.category, item.multiplier
        LOOP
          v_liabilities := jsonb_set(v_liabilities, ARRAY[v_item.id], to_jsonb(v_item.liability), TRUE);
          IF v_item.liability BETWEEN v_target_min_payout AND v_target_max_payout THEN
            v_item_score := ABS(v_item.liability - v_target_payout);
          ELSIF v_item.liability > 0 AND v_item.liability < v_target_min_payout THEN
            v_item_score := (v_target_min_payout - v_item.liability) + 1000000000000;
          ELSIF v_item.liability = 0 THEN
            v_item_score := 9000000000000;
          ELSE
            v_item_score := (v_item.liability - v_target_max_payout) + 9900000000000;
          END IF;
          IF v_best_item IS NULL
             OR v_item_score < COALESCE(v_best_score, 999999999999999)
             OR (v_item_score = v_best_score
               AND v_item.liability < COALESCE((v_liabilities->>v_best_item)::NUMERIC, v_item.liability + 1)) THEN
            v_best_item := v_item.id;
            v_best_category := v_item.category;
            v_best_score := v_item_score;
          END IF;
        END LOOP;
        v_winner_pos := COALESCE(v_best_item, 'corn');
        v_category := v_best_category;
      END IF;
      IF v_category IS NULL THEN
        SELECT category INTO v_category FROM public.greedy_pro_multiplier(v_winner_pos);
      END IF;
    END IF;
  END IF;

  UPDATE public.game_rounds
     SET status = 'resolving',
         winner_pos = v_winner_pos,
         total_bet = v_total_bet,
         result = jsonb_build_object(
           'result_type', v_result_type,
           'winner_pos', v_winner_pos,
           'category', v_category,
           'is_empty_round', v_is_empty_round,
           'target_payout_min_percent', v_target_min_percent,
           'target_payout_max_percent', v_target_max_percent,
           'target_payout_min', FLOOR(v_target_min_payout)::BIGINT,
           'target_payout_max', FLOOR(v_target_max_payout)::BIGINT,
           'target_payout', FLOOR(v_target_payout)::BIGINT,
           'forced', v_forced,
           'schedule_reason', v_schedule_reason,
           'item_liabilities', v_liabilities,
           'result_ready_at', v_revealed_at,
           'payout_status', 'pending',
           'top_winners', '[]'::JSONB,
           'currency', 'diamond'
         )
   WHERE id = p_round_id;

  RETURN json_build_object(
    'success', TRUE,
    'round_id', p_round_id,
    'winner_pos', v_winner_pos,
    'category', v_category,
    'result_type', v_result_type,
    'result_ready_at', v_revealed_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_revealed_greedy_pro_round(p_round_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_round public.game_rounds%ROWTYPE;
  v_settings public.game_settings%ROWTYPE;
  v_result_type TEXT;
  v_category TEXT;
  v_total_win BIGINT := 0;
  v_user_win RECORD;
  v_user_balance BIGINT;
  v_owner_balance BIGINT;
  v_top_winners JSONB := '[]'::JSONB;
  v_completed_at TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_round
    FROM public.game_rounds
   WHERE id = p_round_id
   FOR UPDATE;

  IF NOT FOUND OR v_round.game_type <> 'greedy_pro' THEN
    RETURN json_build_object('success', FALSE, 'message', 'Greedy King round not found');
  END IF;
  IF v_round.status = 'settled' THEN
    RETURN json_build_object('success', TRUE, 'already_settled', TRUE, 'round_id', p_round_id);
  END IF;
  IF v_round.status <> 'resolving' OR v_round.winner_pos IS NULL THEN
    RETURN json_build_object('success', FALSE, 'message', 'Winner has not been revealed');
  END IF;

  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'greedy_pro';
  v_result_type := COALESCE(v_round.result->>'result_type',
    CASE WHEN v_round.winner_pos IN ('pizza', 'salad') THEN 'category' ELSE 'item' END);
  v_category := COALESCE(v_round.result->>'category', v_round.winner_pos);

  -- One set-based write replaces the old per-chip-row update loop.
  WITH payout_rows AS (
    SELECT b.id,
           CASE
             WHEN (v_result_type = 'category' AND gm.category = v_category)
               OR (v_result_type = 'item' AND b.position = v_round.winner_pos)
             THEN FLOOR(b.amount * gm.multiplier)::BIGINT
             ELSE 0
           END AS payout
      FROM public.game_round_bets b
      CROSS JOIN LATERAL public.greedy_pro_multiplier(b.position) gm
     WHERE b.round_id = p_round_id
  )
  UPDATE public.game_round_bets b
     SET win_amount = payout_rows.payout
    FROM payout_rows
   WHERE b.id = payout_rows.id;

  SELECT COALESCE(SUM(win_amount), 0)
    INTO v_total_win
    FROM public.game_round_bets
   WHERE round_id = p_round_id;

  -- Wallet work scales with winning users, not chip quantity or bet rows.
  FOR v_user_win IN
    SELECT user_id, SUM(win_amount)::BIGINT AS payout
      FROM public.game_round_bets
     WHERE round_id = p_round_id AND win_amount > 0
     GROUP BY user_id
     ORDER BY user_id
  LOOP
    IF v_settings.house_profile_id IS NOT NULL THEN
      UPDATE public.profiles
         SET diamonds = COALESCE(diamonds, 0) - v_user_win.payout
       WHERE id = v_settings.house_profile_id
       RETURNING diamonds INTO v_owner_balance;

      UPDATE public.profiles
         SET diamonds = COALESCE(diamonds, 0) + v_user_win.payout
       WHERE id = v_user_win.user_id
       RETURNING diamonds INTO v_user_balance;

      INSERT INTO public.transactions
        (user_id, related_user_id, type, currency, amount, balance_after,
         related_entity_type, related_entity_id, status, notes)
      VALUES
        (v_settings.house_profile_id, v_user_win.user_id, 'game_owner_payout', 'diamond',
         -v_user_win.payout, v_owner_balance, 'game_round', p_round_id, 'completed',
         'Greedy King aggregated payout funded'),
        (v_user_win.user_id, v_settings.house_profile_id, 'game_win', 'diamond',
         v_user_win.payout, v_user_balance, 'game_round', p_round_id, 'completed',
         'Greedy King aggregated win');
    END IF;
  END LOOP;

  SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY w.win_amount DESC), '[]'::JSONB)
    INTO v_top_winners
    FROM (
      SELECT b.user_id,
             COALESCE(p.full_name, 'Guest') AS name,
             p.avatar_url,
             SUM(b.win_amount)::BIGINT AS win_amount
        FROM public.game_round_bets b
        LEFT JOIN public.profiles p ON p.id = b.user_id
       WHERE b.round_id = p_round_id AND b.win_amount > 0
       GROUP BY b.user_id, p.full_name, p.avatar_url
       ORDER BY SUM(b.win_amount) DESC
       LIMIT 3
    ) w;

  v_completed_at := clock_timestamp();
  UPDATE public.game_rounds
     SET status = 'settled',
         win_amount = v_total_win,
         result = COALESCE(result, '{}'::JSONB) || jsonb_build_object(
           'actual_payout', v_total_win,
           'burned_amount', GREATEST(0, COALESCE(total_bet, 0) - v_total_win),
           'top_winners', v_top_winners,
           'owner_balance', v_owner_balance,
           'payout_status', 'completed',
           'payout_completed_at', v_completed_at,
           'settled_at', v_completed_at
         )
   WHERE id = p_round_id;

  RETURN json_build_object(
    'success', TRUE,
    'round_id', p_round_id,
    'winner_pos', v_round.winner_pos,
    'total_win', v_total_win,
    'top_winners', v_top_winners,
    'payout_completed_at', v_completed_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.greedy_pro_tick()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_settings public.game_settings%ROWTYPE;
  v_round public.game_rounds%ROWTYPE;
  v_latest public.game_rounds%ROWTYPE;
  v_duration INT;
  v_display INT;
  v_grace INT;
  v_result_ready_at TIMESTAMPTZ;
  v_created_id UUID;
  v_last_settlement JSON;
  v_last_reveal JSON;
BEGIN
  PERFORM pg_advisory_xact_lock(1729, 4);
  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'greedy_pro';
  IF NOT FOUND OR v_settings.is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', FALSE, 'message', 'Greedy King is offline', 'server_now', NOW());
  END IF;

  v_duration := GREATEST(5, LEAST(120, COALESCE(v_settings.round_duration_s, 25)));
  v_display := GREATEST(3, LEAST(60, COALESCE(v_settings.result_display_s, 7)));
  v_grace := public.greedy_pro_bet_grace_seconds();

  -- Settle only winners committed by a previous clock transaction.
  FOR v_round IN
    SELECT * FROM public.game_rounds
     WHERE room_id = public.greedy_pro_global_room_id()
       AND game_type = 'greedy_pro'
       AND status = 'resolving'
       AND winner_pos IS NOT NULL
     ORDER BY started_at
     FOR UPDATE SKIP LOCKED
  LOOP
    v_last_settlement := public.settle_revealed_greedy_pro_round(v_round.id);
  END LOOP;

  -- Reveal ended betting rounds and return without settling them this tick.
  FOR v_round IN
    SELECT * FROM public.game_rounds
     WHERE room_id = public.greedy_pro_global_room_id()
       AND game_type = 'greedy_pro'
       AND status = 'betting'
       AND ends_at + (v_grace || ' seconds')::INTERVAL <= clock_timestamp()
     ORDER BY started_at
     FOR UPDATE SKIP LOCKED
  LOOP
    v_last_reveal := public.reveal_greedy_pro_round(v_round.id);
  END LOOP;

  SELECT * INTO v_latest
    FROM public.game_rounds
   WHERE room_id = public.greedy_pro_global_room_id()
     AND game_type = 'greedy_pro'
   ORDER BY started_at DESC NULLS LAST, created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    INSERT INTO public.game_rounds
      (game_type, room_id, status, started_at, ends_at, bets, result, total_bet, win_amount)
    VALUES
      ('greedy_pro', public.greedy_pro_global_room_id(), 'betting', clock_timestamp(),
       clock_timestamp() + (v_duration || ' seconds')::INTERVAL, '{}'::JSONB, '{}'::JSONB, 0, 0)
    RETURNING id INTO v_created_id;
  ELSIF v_latest.status = 'settled' THEN
    v_result_ready_at := COALESCE(
      (v_latest.result->>'result_ready_at')::TIMESTAMPTZ,
      (v_latest.result->>'settled_at')::TIMESTAMPTZ,
      v_latest.ends_at + (v_grace || ' seconds')::INTERVAL
    );
    IF v_result_ready_at + (v_display || ' seconds')::INTERVAL <= clock_timestamp() THEN
      INSERT INTO public.game_rounds
        (game_type, room_id, status, started_at, ends_at, bets, result, total_bet, win_amount)
      VALUES
        ('greedy_pro', public.greedy_pro_global_room_id(), 'betting', clock_timestamp(),
         clock_timestamp() + (v_duration || ' seconds')::INTERVAL, '{}'::JSONB, '{}'::JSONB, 0, 0)
      RETURNING id INTO v_created_id;
    END IF;
  END IF;

  PERFORM public.greedy_pro_sync_robot_bets();
  RETURN json_build_object(
    'success', TRUE,
    'created_round_id', v_created_id,
    'last_reveal', v_last_reveal,
    'last_settlement', v_last_settlement,
    'server_now', clock_timestamp()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_greedy_pro_state()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me UUID := auth.uid();
  v_settings public.game_settings%ROWTYPE;
  v_round public.game_rounds%ROWTYPE;
  v_display INT;
  v_grace INT;
  v_my_bets JSONB := '[]'::JSONB;
  v_history JSONB := '[]'::JSONB;
  v_my_balance BIGINT;
  v_my_bet BIGINT := 0;
  v_state JSONB;
BEGIN
  -- Deliberately no greedy_pro_tick() call: reads must never wait for settlement.
  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'greedy_pro';
  v_display := GREATEST(3, LEAST(60, COALESCE(v_settings.result_display_s, 7)));
  v_grace := public.greedy_pro_bet_grace_seconds();

  SELECT * INTO v_round
    FROM public.game_rounds
   WHERE room_id = public.greedy_pro_global_room_id()
     AND game_type = 'greedy_pro'
     AND (
       (status = 'betting' AND ends_at + (v_grace || ' seconds')::INTERVAL > clock_timestamp())
       OR
       (status IN ('resolving', 'settled') AND winner_pos IS NOT NULL
        AND COALESCE((result->>'result_ready_at')::TIMESTAMPTZ,
                     (result->>'settled_at')::TIMESTAMPTZ,
                     ends_at + (v_grace || ' seconds')::INTERVAL)
          + (v_display || ' seconds')::INTERVAL > clock_timestamp())
     )
   ORDER BY CASE WHEN status IN ('resolving', 'settled') THEN 0 ELSE 1 END, started_at DESC
   LIMIT 1;

  IF FOUND AND me IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.created_at), '[]'::JSONB),
           COALESCE(SUM(b.amount), 0)
      INTO v_my_bets, v_my_bet
      FROM public.game_round_bets b
     WHERE b.round_id = v_round.id AND b.user_id = me;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.settled_at DESC), '[]'::JSONB)
    INTO v_history
    FROM (
      SELECT gr.id, gr.winner_pos, gr.result, gr.total_bet, gr.win_amount,
             COALESCE((gr.result->>'settled_at')::TIMESTAMPTZ, gr.ends_at) AS settled_at
        FROM public.game_rounds gr
       WHERE gr.room_id = public.greedy_pro_global_room_id()
         AND gr.game_type = 'greedy_pro'
         AND gr.status = 'settled'
       ORDER BY COALESCE(gr.ends_at, gr.started_at, gr.created_at) DESC
       LIMIT 15
    ) h;

  IF me IS NOT NULL THEN
    SELECT diamonds INTO v_my_balance FROM public.profiles WHERE id = me;
  END IF;

  v_state := jsonb_build_object(
    'success', TRUE,
    'server_now', clock_timestamp(),
    'settings', to_jsonb(v_settings),
    'round', CASE WHEN v_round.id IS NULL THEN NULL ELSE to_jsonb(v_round) END,
    'bets', v_my_bets,
    'my_bets', v_my_bets,
    'history', v_history,
    'my_balance', v_my_balance,
    'my_round_bet', v_my_bet
  );
  RETURN public.decorate_realtime_game_state(v_state, TRUE)::JSON;
END;
$$;

REVOKE ALL ON FUNCTION public.reveal_greedy_pro_round(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_revealed_greedy_pro_round(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.greedy_pro_tick() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_greedy_pro_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reveal_greedy_pro_round(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_revealed_greedy_pro_round(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.greedy_pro_tick() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_greedy_pro_state() TO authenticated, service_role;

COMMENT ON FUNCTION public.reveal_greedy_pro_round(UUID) IS
  'Publishes an immutable Greedy King winner without waiting for wallet settlement.';
COMMENT ON FUNCTION public.settle_revealed_greedy_pro_round(UUID) IS
  'Idempotently settles a previously revealed Greedy King winner, aggregated per user.';
COMMENT ON FUNCTION public.get_greedy_pro_state() IS
  'Read-only Greedy King snapshot; never invokes the clock or payout settlement.';
