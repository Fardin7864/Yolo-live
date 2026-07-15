-- 121_tin_patti_pro_playability_fix.sql
-- Fixes Tin Patti Pro runtime playability:
-- - avoids ambiguous output-column references from tin_patti_pro_options()
-- - lets bets place before an admin payout owner is configured
-- - prefers the newest playable betting round once result display is over

CREATE OR REPLACE FUNCTION public.tin_patti_pro_options()
RETURNS TABLE(id TEXT, label TEXT, multiplier NUMERIC, sort_order INT)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_settings public.game_settings%ROWTYPE;
BEGIN
  SELECT * INTO v_settings FROM public.game_settings gs WHERE gs.id = 'tin_patti_pro';

  RETURN QUERY
  SELECT item.value ->> 'id' AS id,
         COALESCE(item.value ->> 'label', item.value ->> 'id') AS label,
         COALESCE((item.value ->> 'm')::numeric, 2.9) AS multiplier,
         item.ordinality::int AS sort_order
    FROM jsonb_array_elements(COALESCE(v_settings.multipliers, '[]'::jsonb)) WITH ORDINALITY AS item(value, ordinality);
END $$;

CREATE OR REPLACE FUNCTION public.tin_patti_pro_result_is_valid(p_position TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM (
        SELECT opt.id AS position_id
          FROM public.tin_patti_pro_options() AS opt
      ) AS positions
     WHERE positions.position_id = p_position
  );
$$;

CREATE OR REPLACE FUNCTION public.resolve_tin_patti_pro_round(p_round_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  v_round public.game_rounds%ROWTYPE;
  v_settings public.game_settings%ROWTYPE;
  v_rules JSONB := '{}'::jsonb;
  v_grace INT := public.tin_patti_pro_bet_grace_seconds();
  v_total_bet BIGINT := 0;
  v_min_pct NUMERIC := 30;
  v_max_pct NUMERIC := 40;
  v_mid_pct NUMERIC := 35;
  v_winner_pos TEXT;
  v_multiplier NUMERIC := 1;
  v_hands JSONB;
  v_payout_total BIGINT := 0;
  v_my_win_amount BIGINT := 0;
  v_top_winners JSONB := '[]'::jsonb;
  v_public_bets JSONB := '[]'::jsonb;
  v_settled_at TIMESTAMPTZ := NOW();
  v_bet RECORD;
  v_forced BOOLEAN := FALSE;
BEGIN
  SELECT * INTO v_round
    FROM public.game_rounds
   WHERE game_rounds.id = p_round_id
   FOR UPDATE;

  IF NOT FOUND OR v_round.game_type <> 'tin_patti_pro' OR v_round.room_id <> public.tin_patti_pro_global_room_id() THEN
    RETURN json_build_object('success', false, 'message', 'Tin Patti Pro round not found');
  END IF;

  IF v_round.status = 'settled' THEN
    SELECT COALESCE(SUM(win_amount), 0)
      INTO v_my_win_amount
      FROM public.game_round_bets
     WHERE round_id = v_round.id
       AND user_id = me;

    RETURN json_build_object(
      'success', true,
      'round_id', v_round.id,
      'winner_pos', v_round.winner_pos,
      'result', v_round.result,
      'already_settled', true,
      'my_win_amount', v_my_win_amount
    );
  END IF;

  IF v_round.ends_at + (v_grace || ' seconds')::interval > NOW() THEN
    RETURN json_build_object('success', false, 'message', 'Round has not ended yet');
  END IF;

  SELECT * INTO v_settings FROM public.game_settings gs WHERE gs.id = 'tin_patti_pro';
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'Tin Patti Pro settings not found');
  END IF;

  v_rules := COALESCE(v_settings.special_result_rules, '{}'::jsonb);
  BEGIN
    v_min_pct := COALESCE((v_rules->>'target_payout_min_percent')::numeric, 30);
    v_max_pct := COALESCE((v_rules->>'target_payout_max_percent')::numeric, 40);
  EXCEPTION WHEN others THEN
    v_min_pct := 30;
    v_max_pct := 40;
  END;
  v_min_pct := GREATEST(0, v_min_pct);
  v_max_pct := GREATEST(v_min_pct, v_max_pct);
  v_mid_pct := (v_min_pct + v_max_pct) / 2;

  SELECT COALESCE(SUM(amount), 0)
    INTO v_total_bet
    FROM public.game_round_bets
   WHERE round_id = v_round.id;

  IF public.tin_patti_pro_result_is_valid(v_settings.forced_next_result) THEN
    v_winner_pos := v_settings.forced_next_result;
    v_forced := TRUE;
    UPDATE public.game_settings
       SET forced_next_result = NULL,
           updated_at = NOW()
     WHERE game_settings.id = 'tin_patti_pro';
  ELSIF COALESCE(v_total_bet, 0) <= 0 THEN
    SELECT positions.position_id INTO v_winner_pos
      FROM (
        SELECT opt.id AS position_id
          FROM public.tin_patti_pro_options() AS opt
      ) AS positions
     ORDER BY random()
     LIMIT 1;
  ELSE
    WITH option_totals AS (
      SELECT options.position_id,
             options.multiplier,
             COALESCE(SUM(b.amount), 0)::numeric AS stake,
             (COALESCE(SUM(b.amount), 0)::numeric * options.multiplier) AS payout,
             CASE WHEN v_total_bet > 0 THEN (COALESCE(SUM(b.amount), 0)::numeric * options.multiplier * 100 / v_total_bet) ELSE 0 END AS payout_pct
        FROM (
          SELECT opt.id AS position_id,
                 opt.multiplier,
                 opt.sort_order
            FROM public.tin_patti_pro_options() AS opt
        ) AS options
        LEFT JOIN public.game_round_bets b
          ON b.round_id = v_round.id
         AND b.position = options.position_id
       GROUP BY options.position_id, options.multiplier, options.sort_order
    )
    SELECT option_totals.position_id INTO v_winner_pos
      FROM option_totals
     ORDER BY
       CASE
         WHEN payout_pct BETWEEN v_min_pct AND v_max_pct THEN 0
         WHEN payout_pct > 0 AND payout_pct < v_min_pct THEN 1
         WHEN payout_pct = 0 THEN 2
         ELSE 3
       END,
       CASE
         WHEN payout_pct BETWEEN v_min_pct AND v_max_pct THEN abs(payout_pct - v_mid_pct)
         WHEN payout_pct > 0 AND payout_pct < v_min_pct THEN abs(v_min_pct - payout_pct)
         WHEN payout_pct = 0 THEN random() * 1000
         ELSE abs(payout_pct - v_max_pct)
       END ASC,
       random()
     LIMIT 1;
  END IF;

  SELECT options.multiplier INTO v_multiplier
    FROM (
      SELECT opt.id AS position_id,
             opt.multiplier
        FROM public.tin_patti_pro_options() AS opt
    ) AS options
   WHERE options.position_id = v_winner_pos
   LIMIT 1;
  v_multiplier := COALESCE(v_multiplier, 1);
  v_hands := public.tin_patti_pro_deal_hands(v_winner_pos);

  FOR v_bet IN
    SELECT b.id, b.user_id, b.amount
      FROM public.game_round_bets b
     WHERE b.round_id = v_round.id
       AND b.position = v_winner_pos
  LOOP
    UPDATE public.game_round_bets
       SET win_amount = (v_bet.amount * v_multiplier)::bigint
     WHERE game_round_bets.id = v_bet.id;

    UPDATE public.profiles
       SET diamonds = COALESCE(diamonds, 0) + (v_bet.amount * v_multiplier)::bigint
     WHERE profiles.id = v_bet.user_id;

    IF v_settings.house_profile_id IS NOT NULL THEN
      UPDATE public.profiles
         SET diamonds = COALESCE(diamonds, 0) - (v_bet.amount * v_multiplier)::bigint
       WHERE profiles.id = v_settings.house_profile_id;

      INSERT INTO public.transactions
        (user_id, related_user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
      VALUES
        (v_settings.house_profile_id, v_bet.user_id, 'game_owner_payout', 'diamond', -(v_bet.amount * v_multiplier)::bigint, 'game_round', v_round.id, 'completed', 'Tin Patti Pro payout funded');
    END IF;

    INSERT INTO public.transactions
      (user_id, related_user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
    VALUES
      (v_bet.user_id, v_settings.house_profile_id, 'game_win', 'diamond', (v_bet.amount * v_multiplier)::bigint, 'game_round', v_round.id, 'completed', 'Tin Patti Pro win');
  END LOOP;

  SELECT COALESCE(SUM(win_amount), 0)
    INTO v_payout_total
    FROM public.game_round_bets
   WHERE round_id = v_round.id;

  SELECT COALESCE(SUM(win_amount), 0)
    INTO v_my_win_amount
    FROM public.game_round_bets
   WHERE round_id = v_round.id
     AND user_id = me;

  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.win_amount DESC), '[]'::jsonb)
    INTO v_top_winners
    FROM (
      SELECT b.user_id,
             COALESCE(p.full_name, 'Guest') AS name,
             p.avatar_url,
             SUM(b.win_amount)::bigint AS win_amount
        FROM public.game_round_bets b
        LEFT JOIN public.profiles p ON p.id = b.user_id
       WHERE b.round_id = v_round.id
         AND b.win_amount > 0
       GROUP BY b.user_id, p.full_name, p.avatar_url
       ORDER BY SUM(b.win_amount) DESC
       LIMIT 10
    ) t;

  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO v_public_bets
    FROM (
      SELECT b.id,
             b.user_id,
             COALESCE(p.full_name, 'Guest') AS name,
             p.avatar_url,
             b.position,
             b.amount,
             b.win_amount,
             b.created_at
        FROM public.game_round_bets b
        LEFT JOIN public.profiles p ON p.id = b.user_id
       WHERE b.round_id = v_round.id
       ORDER BY b.created_at DESC
       LIMIT 60
    ) t;

  UPDATE public.game_rounds
     SET status = 'settled',
         winner_pos = v_winner_pos,
         total_bet = v_total_bet,
         win_amount = v_payout_total,
         result = jsonb_build_object(
           'winner_pos', v_winner_pos,
           'multiplier', v_multiplier,
           'hands', v_hands,
           'settled_at', v_settled_at,
           'forced', v_forced,
           'top_winners', v_top_winners,
           'public_bets', v_public_bets
         )
   WHERE game_rounds.id = v_round.id;

  RETURN json_build_object(
    'success', true,
    'round_id', v_round.id,
    'winner_pos', v_winner_pos,
    'multiplier', v_multiplier,
    'hands', v_hands,
    'top_winners', v_top_winners,
    'my_win_amount', v_my_win_amount,
    'settled_at', v_settled_at
  );
END $$;

CREATE OR REPLACE FUNCTION public.tin_patti_pro_tick()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settings public.game_settings%ROWTYPE;
  v_round public.game_rounds%ROWTYPE;
  v_active public.game_rounds%ROWTYPE;
  v_duration INT;
  v_display INT;
  v_grace INT;
  v_resolved JSON;
  v_created_id UUID;
BEGIN
  SELECT * INTO v_settings FROM public.game_settings gs WHERE gs.id = 'tin_patti_pro';
  IF NOT FOUND OR v_settings.is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Tin Patti Pro is offline', 'server_now', NOW());
  END IF;

  v_duration := GREATEST(5, LEAST(120, COALESCE(v_settings.round_duration_s, 30)));
  v_display := GREATEST(3, LEAST(60, COALESCE(v_settings.result_display_s, 15)));
  v_grace := public.tin_patti_pro_bet_grace_seconds();

  FOR v_round IN
    SELECT *
      FROM public.game_rounds
     WHERE room_id = public.tin_patti_pro_global_room_id()
       AND game_type = 'tin_patti_pro'
       AND status IN ('betting', 'resolving')
       AND ends_at + (v_grace || ' seconds')::interval <= NOW()
     ORDER BY started_at ASC
     FOR UPDATE SKIP LOCKED
  LOOP
    v_resolved := public.resolve_tin_patti_pro_round(v_round.id);
  END LOOP;

  SELECT * INTO v_active
    FROM public.game_rounds
   WHERE room_id = public.tin_patti_pro_global_room_id()
     AND game_type = 'tin_patti_pro'
     AND (
       (status = 'betting' AND ends_at + (v_grace || ' seconds')::interval > NOW())
       OR
       (status = 'settled' AND COALESCE((result->>'settled_at')::timestamptz, ends_at + (v_grace || ' seconds')::interval) + (v_display || ' seconds')::interval > NOW())
     )
   ORDER BY
     CASE WHEN status = 'betting' THEN 0 ELSE 1 END,
     started_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    INSERT INTO public.game_rounds
      (game_type, room_id, status, started_at, ends_at, bets, result, total_bet, win_amount)
    VALUES
      ('tin_patti_pro', public.tin_patti_pro_global_room_id(), 'betting', NOW(), NOW() + (v_duration || ' seconds')::interval, '{}'::jsonb, '{}'::jsonb, 0, 0)
    RETURNING id INTO v_created_id;
  END IF;

  RETURN json_build_object('success', true, 'created_round_id', v_created_id, 'last_resolve', v_resolved, 'server_now', NOW());
END $$;

CREATE OR REPLACE FUNCTION public.place_tin_patti_pro_bet(
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
  v_balance BIGINT;
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
  IF public.tin_patti_pro_result_is_valid(p_position) IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Invalid Tin Patti Pro board');
  END IF;

  PERFORM public.tin_patti_pro_tick();
  v_grace := public.tin_patti_pro_bet_grace_seconds();

  SELECT * INTO v_round
    FROM public.game_rounds
   WHERE game_rounds.id = p_round_id
   FOR UPDATE;

  IF NOT FOUND OR v_round.game_type <> 'tin_patti_pro' OR v_round.room_id <> public.tin_patti_pro_global_room_id() THEN
    RETURN json_build_object('success', false, 'message', 'Tin Patti Pro round not found');
  END IF;
  IF v_round.status <> 'betting' OR v_round.ends_at + (v_grace || ' seconds')::interval <= NOW() THEN
    RETURN json_build_object('success', false, 'message', 'Betting window closed');
  END IF;

  SELECT * INTO v_settings FROM public.game_settings gs WHERE gs.id = 'tin_patti_pro';
  IF v_settings.is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Tin Patti Pro is offline');
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

  SELECT p.diamonds INTO v_balance FROM public.profiles p WHERE p.id = me FOR UPDATE;
  IF v_balance IS NULL OR v_balance < p_amount THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient diamonds');
  END IF;

  UPDATE public.profiles
     SET diamonds = diamonds - p_amount
   WHERE profiles.id = me
   RETURNING diamonds INTO v_balance;

  INSERT INTO public.game_round_bets (round_id, user_id, position, amount)
  VALUES (p_round_id, me, p_position, p_amount)
  RETURNING id INTO v_bet_id;

  INSERT INTO public.transactions
    (user_id, related_user_id, type, currency, amount, balance_after, related_entity_type, related_entity_id, status, notes)
  VALUES
    (me, v_settings.house_profile_id, 'game_bet', 'diamond', -p_amount, v_balance, 'game_round', p_round_id, 'completed', 'Tin Patti Pro bet');

  RETURN json_build_object(
    'success', true,
    'round_id', p_round_id,
    'bet_id', v_bet_id,
    'position', p_position,
    'balance', v_balance
  );
END $$;

GRANT EXECUTE ON FUNCTION public.tin_patti_pro_options() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tin_patti_pro_result_is_valid(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_tin_patti_pro_round(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tin_patti_pro_tick() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.place_tin_patti_pro_bet(UUID, TEXT, BIGINT) TO authenticated;
