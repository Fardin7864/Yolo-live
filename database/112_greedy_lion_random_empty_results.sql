-- =====================================================================
-- 112_greedy_lion_random_empty_results.sql
-- Empty Greedy Lion boards randomly store one of 8 items, Pizza, or Salad.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.resolve_greedy_lion_round(p_round_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  v_round public.game_rounds%ROWTYPE;
  v_settings public.game_settings%ROWTYPE;
  v_result_type TEXT := 'item';
  v_winner_pos TEXT;
  v_category TEXT;
  v_forced BOOLEAN := false;
  v_schedule_reason TEXT := 'item_rtp_range';
  v_rules JSONB := '{}'::jsonb;
  v_total_bet BIGINT := 0;
  v_total_win BIGINT := 0;
  v_target_min_percent NUMERIC := 30;
  v_target_max_percent NUMERIC := 40;
  v_target_mid_percent NUMERIC := 35;
  v_target_min_payout NUMERIC := 0;
  v_target_max_payout NUMERIC := 0;
  v_target_payout NUMERIC := 0;
  v_actual_payout BIGINT := 0;
  v_burned BIGINT := 0;
  v_is_empty_round BOOLEAN := false;
  v_payout BIGINT;
  v_my_win BIGINT := 0;
  v_my_bet BIGINT := 0;
  v_balance BIGINT;
  v_owner_balance BIGINT;
  v_top_winners JSONB := '[]'::jsonb;
  v_liabilities JSONB := '{}'::jsonb;
  v_item RECORD;
  v_bet RECORD;
  v_best_item TEXT;
  v_best_liability NUMERIC;
  v_best_score NUMERIC;
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
BEGIN
  SELECT * INTO v_round
    FROM public.game_rounds
   WHERE id = p_round_id
   FOR UPDATE;

  IF NOT FOUND OR v_round.game_type <> 'greedy_lion' THEN
    RETURN json_build_object('success', false, 'message', 'Greedy Lion round not found');
  END IF;

  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'greedy_lion';

  IF v_round.status = 'settled' THEN
    IF me IS NOT NULL THEN
      SELECT COALESCE(SUM(win_amount), 0), COALESCE(SUM(amount), 0)
        INTO v_my_win, v_my_bet
        FROM public.game_round_bets
       WHERE round_id = p_round_id AND user_id = me;
      SELECT diamonds INTO v_balance FROM public.profiles WHERE id = me;
    END IF;
    RETURN json_build_object(
      'success', true,
      'already_settled', true,
      'round_id', p_round_id,
      'winner_pos', v_round.winner_pos,
      'category', v_round.result->>'category',
      'result_type', COALESCE(v_round.result->>'result_type', CASE WHEN v_round.winner_pos IN ('pizza','salad') THEN 'category' ELSE 'item' END),
      'result', COALESCE(v_round.result, '{}'::jsonb),
      'top_winners', COALESCE(v_round.result->'top_winners', '[]'::jsonb),
      'my_win_amount', v_my_win,
      'my_bet_amount', v_my_bet,
      'balance', v_balance,
      'server_now', NOW()
    );
  END IF;

  IF v_round.ends_at > NOW() THEN
    RETURN json_build_object('success', false, 'message', 'Round has not ended yet');
  END IF;

  UPDATE public.game_rounds SET status = 'resolving' WHERE id = p_round_id;

  SELECT COALESCE(SUM(amount), 0)
    INTO v_total_bet
    FROM public.game_round_bets
   WHERE round_id = p_round_id;

  v_is_empty_round := COALESCE(v_total_bet, 0) = 0;
  v_rules := COALESCE(v_settings.special_result_rules, '{}'::jsonb);
  v_target_min_percent := GREATEST(0, LEAST(100, COALESCE((v_rules->>'target_payout_min_percent')::numeric, COALESCE(v_settings.win_chance_percent, 30))));
  v_target_max_percent := GREATEST(0, LEAST(100, COALESCE((v_rules->>'target_payout_max_percent')::numeric, GREATEST(v_target_min_percent, COALESCE(v_settings.win_chance_percent, 30)))));
  IF v_target_max_percent < v_target_min_percent THEN
    v_target_max_percent := v_target_min_percent;
  END IF;
  v_target_mid_percent := (v_target_min_percent + v_target_max_percent) / 2.0;
  v_target_min_payout := v_total_bet * (v_target_min_percent / 100.0);
  v_target_max_payout := v_total_bet * (v_target_max_percent / 100.0);
  v_target_payout := v_total_bet * (v_target_mid_percent / 100.0);

  IF v_is_empty_round THEN
    SELECT pick INTO v_empty_pick
      FROM unnest(ARRAY['pizza','salad','corn','chicken','shrimp','tomato','ham','pepper','fish','carrot']) AS pick
     ORDER BY random()
     LIMIT 1;

    v_winner_pos := v_empty_pick;
    v_result_type := CASE WHEN v_empty_pick IN ('pizza', 'salad') THEN 'category' ELSE 'item' END;
    v_category := CASE
      WHEN v_empty_pick IN ('pizza', 'salad') THEN v_empty_pick
      ELSE (SELECT gm.category FROM public.greedy_lion_multiplier(v_empty_pick) gm LIMIT 1)
    END;
    v_schedule_reason := 'empty_random';
  ELSE
    v_pizza_enabled := COALESCE((v_rules->>'pizza_enabled')::boolean, true);
    v_salad_enabled := COALESCE((v_rules->>'salad_enabled')::boolean, true);
    v_pizza_per_hour := GREATEST(0, COALESCE((v_rules->>'pizza_per_hour')::int, 0));
    v_salad_per_hour := GREATEST(0, COALESCE((v_rules->>'salad_per_hour')::int, 0));
    v_pizza_max_day := GREATEST(0, COALESCE((v_rules->>'pizza_max_per_day')::int, 0));
    v_salad_max_day := GREATEST(0, COALESCE((v_rules->>'salad_max_per_day')::int, 0));

    SELECT
      COUNT(*) FILTER (WHERE winner_pos = 'pizza' AND COALESCE(result->>'result_type', 'category') = 'category' AND ends_at >= NOW() - INTERVAL '1 hour'),
      COUNT(*) FILTER (WHERE winner_pos = 'pizza' AND COALESCE(result->>'result_type', 'category') = 'category' AND ends_at >= date_trunc('day', NOW())),
      COUNT(*) FILTER (WHERE winner_pos = 'salad' AND COALESCE(result->>'result_type', 'category') = 'category' AND ends_at >= NOW() - INTERVAL '1 hour'),
      COUNT(*) FILTER (WHERE winner_pos = 'salad' AND COALESCE(result->>'result_type', 'category') = 'category' AND ends_at >= date_trunc('day', NOW()))
      INTO v_pizza_hour_count, v_pizza_day_count, v_salad_hour_count, v_salad_day_count
      FROM public.game_rounds
     WHERE room_id = public.greedy_lion_global_room_id()
       AND game_type = 'greedy_lion'
       AND status = 'settled';

    IF v_settings.forced_next_result IS NOT NULL AND public.greedy_lion_result_is_valid(v_settings.forced_next_result) THEN
      v_winner_pos := v_settings.forced_next_result;
      v_forced := true;
      v_schedule_reason := 'forced';
      UPDATE public.game_settings
         SET forced_next_result = NULL,
             forced_next_category = NULL
       WHERE id = 'greedy_lion';
    ELSIF v_settings.forced_next_category IN ('pizza', 'salad') THEN
      v_winner_pos := v_settings.forced_next_category;
      v_forced := true;
      v_schedule_reason := 'forced_legacy';
      UPDATE public.game_settings
         SET forced_next_category = NULL
       WHERE id = 'greedy_lion';
    ELSE
      IF v_pizza_enabled AND v_pizza_per_hour > 0
         AND v_pizza_hour_count < v_pizza_per_hour
         AND (v_pizza_max_day = 0 OR v_pizza_day_count < v_pizza_max_day) THEN
        v_category_candidate := 'pizza';
      END IF;
      IF v_salad_enabled AND v_salad_per_hour > 0
         AND v_salad_hour_count < v_salad_per_hour
         AND (v_salad_max_day = 0 OR v_salad_day_count < v_salad_max_day)
         AND (
           v_category_candidate IS NULL
           OR (v_salad_hour_count::numeric / NULLIF(v_salad_per_hour, 0)) < (v_pizza_hour_count::numeric / NULLIF(v_pizza_per_hour, 0))
         ) THEN
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
                 COALESCE(SUM(b.amount), 0)::numeric * item.multiplier AS liability
            FROM (
              SELECT (j->>'id')::text AS id,
                     (j->>'category')::text AS category,
                     COALESCE((j->>'m')::numeric, 0) AS multiplier
                FROM jsonb_array_elements(COALESCE(v_settings.multipliers, '[]'::jsonb)) j
            ) item
            LEFT JOIN public.game_round_bets b
              ON b.round_id = p_round_id
             AND b.position = item.id
           GROUP BY item.id, item.category, item.multiplier
        LOOP
          v_liabilities := jsonb_set(v_liabilities, ARRAY[v_item.id], to_jsonb(v_item.liability), true);

          IF v_item.liability BETWEEN v_target_min_payout AND v_target_max_payout THEN
            v_best_score := ABS(v_item.liability - v_target_payout);
          ELSIF v_item.liability > 0 AND v_item.liability < v_target_min_payout THEN
            v_best_score := (v_target_min_payout - v_item.liability) + 1000000000000;
          ELSIF v_item.liability = 0 THEN
            v_best_score := 9000000000000;
          ELSE
            v_best_score := (v_item.liability - v_target_max_payout) + 9900000000000;
          END IF;

          IF v_best_item IS NULL
             OR v_best_score < COALESCE(v_best_liability, 999999999999999)
             OR (v_best_score = COALESCE(v_best_liability, 999999999999999) AND v_item.liability < COALESCE((v_liabilities->>v_best_item)::numeric, v_item.liability + 1)) THEN
            v_best_item := v_item.id;
            v_best_liability := v_best_score;
            v_best_category := v_item.category;
          END IF;
        END LOOP;
        v_winner_pos := COALESCE(v_best_item, 'corn');
        v_category := v_best_category;
      END IF;
      IF v_category IS NULL THEN
        SELECT category INTO v_category FROM public.greedy_lion_multiplier(v_winner_pos);
      END IF;
    END IF;
  END IF;

  FOR v_bet IN
    SELECT b.id, b.user_id, b.amount, b.position, gm.category, gm.multiplier
      FROM public.game_round_bets b
      CROSS JOIN LATERAL public.greedy_lion_multiplier(b.position) gm
     WHERE b.round_id = p_round_id
       AND (
         (v_result_type = 'category' AND gm.category = v_category)
         OR
         (v_result_type = 'item' AND b.position = v_winner_pos)
       )
  LOOP
    v_payout := FLOOR(v_bet.amount * v_bet.multiplier)::BIGINT;
    v_total_win := v_total_win + v_payout;

    UPDATE public.game_round_bets
       SET win_amount = v_payout
     WHERE id = v_bet.id;

    IF v_payout > 0 AND v_settings.house_profile_id IS NOT NULL THEN
      UPDATE public.profiles
         SET diamonds = COALESCE(diamonds, 0) - v_payout
       WHERE id = v_settings.house_profile_id
       RETURNING diamonds INTO v_owner_balance;

      UPDATE public.profiles
         SET diamonds = COALESCE(diamonds, 0) + v_payout
       WHERE id = v_bet.user_id
       RETURNING diamonds INTO v_balance;

      INSERT INTO public.transactions
        (user_id, related_user_id, type, currency, amount, balance_after, related_entity_type, related_entity_id, status, notes)
      VALUES
        (v_settings.house_profile_id, v_bet.user_id, 'game_owner_payout', 'diamond', -v_payout, v_owner_balance, 'game_round', p_round_id, 'completed', 'Greedy Lion payout funded'),
        (v_bet.user_id, v_settings.house_profile_id, 'game_win', 'diamond', v_payout, v_balance, 'game_round', p_round_id, 'completed', 'Greedy Lion win');
    END IF;
  END LOOP;

  UPDATE public.game_round_bets
     SET win_amount = 0
   WHERE round_id = p_round_id
     AND win_amount IS NULL;

  v_actual_payout := COALESCE(v_total_win, 0);
  v_burned := GREATEST(0, COALESCE(v_total_bet, 0) - v_actual_payout);

  SELECT COALESCE(jsonb_agg(row_to_json(winner_row)::jsonb ORDER BY winner_row.win_amount DESC), '[]'::jsonb)
    INTO v_top_winners
  FROM (
    SELECT b.user_id,
           COALESCE(p.full_name, 'Guest') AS name,
           p.avatar_url,
           SUM(b.win_amount)::bigint AS win_amount
      FROM public.game_round_bets b
      LEFT JOIN public.profiles p ON p.id = b.user_id
     WHERE b.round_id = p_round_id
       AND b.win_amount > 0
     GROUP BY b.user_id, p.full_name, p.avatar_url
     ORDER BY SUM(b.win_amount) DESC
     LIMIT 3
  ) winner_row;

  IF me IS NOT NULL THEN
    SELECT COALESCE(SUM(win_amount), 0), COALESCE(SUM(amount), 0)
      INTO v_my_win, v_my_bet
      FROM public.game_round_bets
     WHERE round_id = p_round_id AND user_id = me;
    SELECT diamonds INTO v_balance FROM public.profiles WHERE id = me;
  END IF;
  IF v_settings.house_profile_id IS NOT NULL THEN
    SELECT diamonds INTO v_owner_balance FROM public.profiles WHERE id = v_settings.house_profile_id;
  END IF;

  UPDATE public.game_rounds
     SET status = 'settled',
         winner_pos = v_winner_pos,
         total_bet = v_total_bet,
         win_amount = v_total_win,
         result = jsonb_build_object(
           'result_type', v_result_type,
           'winner_pos', v_winner_pos,
           'category', v_category,
           'is_empty_round', v_is_empty_round,
           'target_payout_min_percent', v_target_min_percent,
           'target_payout_max_percent', v_target_max_percent,
           'target_payout_min', FLOOR(v_target_min_payout)::bigint,
           'target_payout_max', FLOOR(v_target_max_payout)::bigint,
           'target_payout', FLOOR(v_target_payout)::bigint,
           'actual_payout', v_actual_payout,
           'burned_amount', v_burned,
           'forced', v_forced,
           'schedule_reason', v_schedule_reason,
           'item_liabilities', v_liabilities,
           'top_winners', v_top_winners,
           'owner_balance', v_owner_balance,
           'currency', 'diamond'
         )
   WHERE id = p_round_id;

  RETURN json_build_object(
    'success', true,
    'round_id', p_round_id,
    'winner_pos', v_winner_pos,
    'category', v_category,
    'result_type', v_result_type,
    'my_win_amount', v_my_win,
    'my_bet_amount', v_my_bet,
    'balance', v_balance,
    'owner_balance', v_owner_balance,
    'top_winners', v_top_winners,
    'server_now', NOW(),
    'result', json_build_object(
      'result_type', v_result_type,
      'winner_pos', v_winner_pos,
      'category', v_category,
      'is_empty_round', v_is_empty_round,
      'target_payout_min_percent', v_target_min_percent,
      'target_payout_max_percent', v_target_max_percent,
      'target_payout_min', FLOOR(v_target_min_payout)::bigint,
      'target_payout_max', FLOOR(v_target_max_payout)::bigint,
      'target_payout', FLOOR(v_target_payout)::bigint,
      'actual_payout', v_actual_payout,
      'burned_amount', v_burned,
      'forced', v_forced,
      'schedule_reason', v_schedule_reason,
      'top_winners', v_top_winners,
      'currency', 'diamond'
    )
  );
END $$;

GRANT EXECUTE ON FUNCTION public.resolve_greedy_lion_round(UUID) TO authenticated, service_role;
