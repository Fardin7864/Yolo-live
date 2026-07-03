-- =====================================================================
-- 115_greedy_lion_bet_grace_window.sql
-- Keep the 30s visible timer, but allow delayed last-second bet RPCs
-- to arrive for a short backend-only grace window before settlement.
-- =====================================================================

UPDATE public.game_settings
   SET special_result_rules = jsonb_set(
         jsonb_set(
           COALESCE(special_result_rules, '{}'::jsonb),
           '{bet_acceptance_grace_s}',
           '10'::jsonb,
           true
         ),
         '{post_betting_block_s}',
         '5'::jsonb,
         true
       )
 WHERE id = 'greedy_lion'
   AND (
     NOT (COALESCE(special_result_rules, '{}'::jsonb) ? 'bet_acceptance_grace_s')
     OR NOT (COALESCE(special_result_rules, '{}'::jsonb) ? 'post_betting_block_s')
   );

CREATE OR REPLACE FUNCTION public.greedy_lion_bet_grace_seconds()
RETURNS INT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rules JSONB := '{}'::jsonb;
  v_grace INT := 10;
BEGIN
  SELECT COALESCE(special_result_rules, '{}'::jsonb)
    INTO v_rules
    FROM public.game_settings
   WHERE id = 'greedy_lion';

  BEGIN
    v_grace := COALESCE((v_rules->>'bet_acceptance_grace_s')::int, 10);
  EXCEPTION WHEN others THEN
    v_grace := 10;
  END;

  RETURN GREATEST(0, LEAST(30, v_grace));
END $$;

CREATE OR REPLACE FUNCTION public.greedy_lion_post_betting_block_seconds()
RETURNS INT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rules JSONB := '{}'::jsonb;
  v_block INT := 5;
BEGIN
  SELECT COALESCE(special_result_rules, '{}'::jsonb)
    INTO v_rules
    FROM public.game_settings
   WHERE id = 'greedy_lion';

  BEGIN
    v_block := COALESCE((v_rules->>'post_betting_block_s')::int, 5);
  EXCEPTION WHEN others THEN
    v_block := 5;
  END;

  RETURN GREATEST(0, LEAST(30, v_block));
END $$;

DO $$
BEGIN
  IF to_regprocedure('public.resolve_greedy_lion_round_without_grace_115(uuid)') IS NULL THEN
    EXECUTE 'ALTER FUNCTION public.resolve_greedy_lion_round(UUID) RENAME TO resolve_greedy_lion_round_without_grace_115';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.resolve_greedy_lion_round(p_round_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_round public.game_rounds%ROWTYPE;
  v_grace INT := public.greedy_lion_bet_grace_seconds();
  v_resolved JSON;
  v_settled_at TIMESTAMPTZ := NOW();
BEGIN
  SELECT * INTO v_round
    FROM public.game_rounds
   WHERE id = p_round_id
   FOR UPDATE;

  IF NOT FOUND OR v_round.game_type <> 'greedy_lion' THEN
    RETURN json_build_object('success', false, 'message', 'Greedy Lion round not found');
  END IF;

  IF v_round.status <> 'settled'
     AND v_round.ends_at + (v_grace || ' seconds')::interval > NOW() THEN
    RETURN json_build_object('success', false, 'message', 'Round has not ended yet');
  END IF;

  v_resolved := public.resolve_greedy_lion_round_without_grace_115(p_round_id);

  IF COALESCE((v_resolved->>'success')::boolean, false)
     AND COALESCE((v_resolved->>'already_settled')::boolean, false) IS DISTINCT FROM TRUE THEN
    UPDATE public.game_rounds
       SET result = jsonb_set(
             COALESCE(result, '{}'::jsonb),
             '{settled_at}',
             to_jsonb(v_settled_at),
             true
           )
     WHERE id = p_round_id
       AND game_type = 'greedy_lion'
       AND status = 'settled';

    v_resolved := jsonb_set(
      v_resolved::jsonb,
      '{settled_at}',
      to_jsonb(v_settled_at),
      true
    )::json;
  END IF;

  RETURN v_resolved;
END $$;

REVOKE ALL ON FUNCTION public.resolve_greedy_lion_round_without_grace_115(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.greedy_lion_tick()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  SELECT * INTO v_latest
    FROM public.game_rounds
   WHERE room_id = public.greedy_lion_global_room_id()
     AND game_type = 'greedy_lion'
   ORDER BY started_at DESC NULLS LAST, created_at DESC
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
     AND (
       (status = 'betting' AND ends_at + (v_grace || ' seconds')::interval > NOW())
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
END $$;

CREATE OR REPLACE FUNCTION public.get_greedy_lion_state()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  v_settings public.game_settings%ROWTYPE;
  v_round public.game_rounds%ROWTYPE;
  v_display INT;
  v_grace INT;
  v_my_bets JSONB := '[]'::jsonb;
  v_history JSONB := '[]'::jsonb;
  v_my_balance BIGINT;
  v_my_bet BIGINT := 0;
BEGIN
  PERFORM public.greedy_lion_tick();
  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'greedy_lion';
  v_display := GREATEST(3, LEAST(60, COALESCE(v_settings.result_display_s, 15)));
  v_grace := public.greedy_lion_bet_grace_seconds();

  SELECT * INTO v_round
    FROM public.game_rounds
   WHERE room_id = public.greedy_lion_global_room_id()
     AND game_type = 'greedy_lion'
     AND (
       (status = 'betting' AND ends_at + (v_grace || ' seconds')::interval > NOW())
       OR
       (status = 'settled' AND COALESCE((result->>'settled_at')::timestamptz, ends_at + (v_grace || ' seconds')::interval) + (v_display || ' seconds')::interval > NOW())
     )
   ORDER BY
     CASE WHEN status = 'settled' THEN 0 ELSE 1 END,
     started_at DESC
   LIMIT 1;

  IF FOUND AND me IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.created_at ASC), '[]'::jsonb)
      INTO v_my_bets
      FROM public.game_round_bets b
     WHERE b.round_id = v_round.id
       AND b.user_id = me;

    SELECT COALESCE(SUM(amount), 0)
      INTO v_my_bet
      FROM public.game_round_bets
     WHERE round_id = v_round.id AND user_id = me;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.settled_at DESC), '[]'::jsonb)
    INTO v_history
  FROM (
    SELECT gr.id,
           gr.winner_pos,
           gr.result,
           gr.total_bet,
           gr.win_amount,
           COALESCE((gr.result->>'settled_at')::timestamptz, gr.ends_at + (v_grace || ' seconds')::interval, gr.started_at, gr.created_at) AS settled_at
      FROM public.game_rounds gr
     WHERE gr.room_id = public.greedy_lion_global_room_id()
       AND gr.game_type = 'greedy_lion'
       AND gr.status = 'settled'
     ORDER BY COALESCE(gr.ends_at, gr.started_at, gr.created_at) DESC
     LIMIT 15
  ) h;

  IF me IS NOT NULL THEN
    SELECT diamonds INTO v_my_balance FROM public.profiles WHERE id = me;
  END IF;

  RETURN json_build_object(
    'success', true,
    'server_now', NOW(),
    'settings', to_jsonb(v_settings),
    'round', CASE WHEN v_round.id IS NULL THEN NULL ELSE to_jsonb(v_round) END,
    'bets', v_my_bets,
    'my_bets', v_my_bets,
    'history', v_history,
    'my_balance', v_my_balance,
    'my_round_bet', v_my_bet
  );
END $$;

CREATE OR REPLACE FUNCTION public.place_greedy_lion_bet(
  p_round_id UUID,
  p_position TEXT,
  p_amount BIGINT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  v_round public.game_rounds%ROWTYPE;
  v_settings public.game_settings%ROWTYPE;
  v_category TEXT;
  v_multiplier NUMERIC;
  v_balance BIGINT;
  v_unique_count INT;
  v_has_position BOOLEAN;
  v_user_round_total BIGINT;
  v_loss_24h BIGINT;
  v_bet_id UUID;
  v_grace INT;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'Amount must be positive');
  END IF;
  IF p_position IS NULL OR length(trim(p_position)) = 0 THEN
    RETURN json_build_object('success', false, 'message', 'Item required');
  END IF;

  PERFORM public.greedy_lion_tick();
  v_grace := public.greedy_lion_bet_grace_seconds();

  SELECT * INTO v_round
    FROM public.game_rounds
   WHERE id = p_round_id
   FOR UPDATE;

  IF NOT FOUND OR v_round.game_type <> 'greedy_lion' OR v_round.room_id <> public.greedy_lion_global_room_id() THEN
    RETURN json_build_object('success', false, 'message', 'Greedy Lion round not found');
  END IF;
  IF v_round.status <> 'betting' OR v_round.ends_at + (v_grace || ' seconds')::interval <= NOW() THEN
    RETURN json_build_object('success', false, 'message', 'Betting window closed');
  END IF;

  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'greedy_lion';
  IF v_settings.is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Greedy Lion is offline');
  END IF;
  IF v_settings.house_profile_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Payout owner account is not configured');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_settings.house_profile_id) THEN
    RETURN json_build_object('success', false, 'message', 'Payout owner profile not found');
  END IF;

  SELECT category, multiplier
    INTO v_category, v_multiplier
    FROM public.greedy_lion_multiplier(p_position);
  IF v_category IS NULL OR v_multiplier IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Invalid Greedy Lion item');
  END IF;

  IF p_amount < COALESCE(v_settings.min_bet, 1) THEN
    RETURN json_build_object('success', false, 'message', 'Minimum bet is ' || COALESCE(v_settings.min_bet, 1));
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_user_round_total
    FROM public.game_round_bets
   WHERE round_id = p_round_id AND user_id = me;
  IF v_settings.max_bet IS NOT NULL AND (v_user_round_total + p_amount) > v_settings.max_bet THEN
    RETURN json_build_object('success', false, 'message', 'Round bet limit is ' || v_settings.max_bet);
  END IF;

  IF v_settings.daily_loss_cap IS NOT NULL THEN
    SELECT COALESCE(SUM(
      CASE
        WHEN type = 'game_bet' THEN -amount
        WHEN type = 'game_win' THEN -amount
        ELSE 0
      END
    ), 0)
    INTO v_loss_24h
    FROM public.transactions
    WHERE user_id = me
      AND currency = 'diamond'
      AND related_entity_type = 'game_round'
      AND created_at >= NOW() - INTERVAL '24 hours';

    IF (v_loss_24h + p_amount) > v_settings.daily_loss_cap THEN
      RETURN json_build_object('success', false, 'message', 'Daily loss cap reached');
    END IF;
  END IF;

  SELECT COUNT(DISTINCT position),
         EXISTS (
           SELECT 1 FROM public.game_round_bets
            WHERE round_id = p_round_id AND user_id = me AND position = p_position
         )
    INTO v_unique_count, v_has_position
    FROM public.game_round_bets
   WHERE round_id = p_round_id AND user_id = me;

  IF v_has_position IS DISTINCT FROM TRUE AND COALESCE(v_unique_count, 0) >= 6 THEN
    RETURN json_build_object('success', false, 'message', 'You can select up to 6 unique items per round');
  END IF;

  SELECT diamonds INTO v_balance FROM public.profiles WHERE id = me FOR UPDATE;
  IF v_balance IS NULL OR v_balance < p_amount THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient diamonds');
  END IF;

  UPDATE public.profiles
     SET diamonds = diamonds - p_amount
   WHERE id = me
   RETURNING diamonds INTO v_balance;

  INSERT INTO public.game_round_bets (round_id, user_id, position, amount)
  VALUES (p_round_id, me, p_position, p_amount)
  RETURNING id INTO v_bet_id;

  UPDATE public.game_rounds
     SET total_bet = COALESCE(total_bet, 0) + p_amount,
         bets = jsonb_set(
           COALESCE(bets, '{}'::jsonb),
           ARRAY[p_position],
           to_jsonb(COALESCE((bets ->> p_position)::bigint, 0) + p_amount)
         )
   WHERE id = p_round_id;

  INSERT INTO public.transactions
    (user_id, related_user_id, type, currency, amount, balance_after, related_entity_type, related_entity_id, status, notes)
  VALUES
    (me, v_settings.house_profile_id, 'game_bet', 'diamond', -p_amount, v_balance, 'game_round', p_round_id, 'completed', 'Greedy Lion bet - losing stakes are burned');

  RETURN json_build_object(
    'success', true,
    'round_id', p_round_id,
    'bet_id', v_bet_id,
    'position', p_position,
    'balance', v_balance
  );
END $$;

GRANT EXECUTE ON FUNCTION public.greedy_lion_bet_grace_seconds() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.greedy_lion_post_betting_block_seconds() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_greedy_lion_round(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.greedy_lion_tick() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_greedy_lion_state() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.place_greedy_lion_bet(UUID, TEXT, BIGINT) TO authenticated;
