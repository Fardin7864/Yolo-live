-- Make the Lucky Dice admin "force next result" control authoritative.
-- The forced option is consumed exactly once by the round resolver.

CREATE OR REPLACE FUNCTION public.lucky_dice_roll_for_option(p_position TEXT)
RETURNS INT[]
LANGUAGE sql
VOLATILE
SET search_path = public
AS $$
  SELECT ARRAY[d1, d2, d3]::int[]
  FROM generate_series(1, 6) AS d1
  CROSS JOIN generate_series(1, 6) AS d2
  CROSS JOIN generate_series(1, 6) AS d3
  WHERE p_position = ANY(public.lucky_dice_winning_options(d1, d2, d3))
  ORDER BY random()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.resolve_lucky_dice_round(p_round_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me UUID := auth.uid();
  v_round public.game_rounds%ROWTYPE;
  v_settings public.game_settings%ROWTYPE;
  v_grace INT := public.lucky_dice_bet_grace_seconds();
  v_d1 INT; v_d2 INT; v_d3 INT; v_total INT;
  v_forced_roll INT[];
  v_winners TEXT[];
  v_payout BIGINT := 0;
  v_my_payout BIGINT := 0;
  v_top_winners JSONB := '[]'::jsonb;
  v_settled_at TIMESTAMPTZ := NOW();
  v_bet RECORD;
  v_multiplier NUMERIC;
  v_win BIGINT;
BEGIN
  SELECT * INTO v_round FROM public.game_rounds WHERE id = p_round_id FOR UPDATE;
  IF NOT FOUND OR v_round.game_type <> 'lucky_dice' OR v_round.room_id <> public.lucky_dice_global_room_id() THEN
    RETURN json_build_object('success', false, 'message', 'Lucky Dice round not found');
  END IF;
  IF v_round.status = 'settled' THEN
    SELECT COALESCE(SUM(win_amount), 0) INTO v_my_payout FROM public.game_round_bets WHERE round_id = p_round_id AND user_id = me;
    RETURN json_build_object('success', true, 'round_id', p_round_id, 'already_settled', true,
      'winner_pos', v_round.winner_pos, 'result', v_round.result, 'my_win_amount', v_my_payout);
  END IF;
  IF v_round.ends_at + (v_grace || ' seconds')::interval > NOW() THEN
    RETURN json_build_object('success', false, 'message', 'Round has not ended yet');
  END IF;
  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'lucky_dice' FOR UPDATE;
  IF v_settings.house_profile_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_settings.house_profile_id) THEN
    RETURN json_build_object('success', false, 'message', 'Payout owner account is not configured');
  END IF;

  IF public.lucky_dice_result_is_valid(v_settings.forced_next_result) THEN
    v_forced_roll := public.lucky_dice_roll_for_option(v_settings.forced_next_result);
    v_d1 := v_forced_roll[1];
    v_d2 := v_forced_roll[2];
    v_d3 := v_forced_roll[3];
    UPDATE public.game_settings SET forced_next_result = NULL, updated_at = NOW() WHERE id = 'lucky_dice';
  ELSE
    v_d1 := floor(random() * 6)::int + 1;
    v_d2 := floor(random() * 6)::int + 1;
    v_d3 := floor(random() * 6)::int + 1;
  END IF;
  v_total := v_d1 + v_d2 + v_d3;
  v_winners := public.lucky_dice_winning_options(v_d1, v_d2, v_d3);

  FOR v_bet IN
    SELECT b.id, b.user_id, b.position, b.amount
      FROM public.game_round_bets b
     WHERE b.round_id = p_round_id AND b.position = ANY(v_winners)
     FOR UPDATE
  LOOP
    SELECT multiplier INTO v_multiplier FROM public.lucky_dice_options() WHERE id = v_bet.position;
    v_win := floor(v_bet.amount * COALESCE(v_multiplier, 0))::bigint;
    UPDATE public.game_round_bets SET win_amount = v_win WHERE id = v_bet.id;
    UPDATE public.profiles SET diamonds = COALESCE(diamonds, 0) + v_win WHERE id = v_bet.user_id;
    UPDATE public.profiles SET diamonds = COALESCE(diamonds, 0) - v_win WHERE id = v_settings.house_profile_id;
    INSERT INTO public.transactions
      (user_id, related_user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
    VALUES
      (v_settings.house_profile_id, v_bet.user_id, 'game_owner_payout', 'diamond', -v_win, 'game_round', p_round_id, 'completed', 'Lucky Dice payout funded'),
      (v_bet.user_id, v_settings.house_profile_id, 'game_win', 'diamond', v_win, 'game_round', p_round_id, 'completed', 'Lucky Dice win');
  END LOOP;

  SELECT COALESCE(SUM(win_amount), 0) INTO v_payout FROM public.game_round_bets WHERE round_id = p_round_id;
  SELECT COALESCE(SUM(win_amount), 0) INTO v_my_payout FROM public.game_round_bets WHERE round_id = p_round_id AND user_id = me;
  SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY w.win_amount DESC), '[]'::jsonb) INTO v_top_winners
    FROM (
      SELECT b.user_id, COALESCE(p.full_name, 'Player') AS name, p.avatar_url, SUM(b.win_amount)::bigint AS win_amount
        FROM public.game_round_bets b LEFT JOIN public.profiles p ON p.id = b.user_id
       WHERE b.round_id = p_round_id AND b.win_amount > 0
       GROUP BY b.user_id, p.full_name, p.avatar_url ORDER BY SUM(b.win_amount) DESC LIMIT 10
    ) w;

  UPDATE public.game_rounds SET
    status = 'settled', winner_pos = v_winners[1],
    total_bet = (SELECT COALESCE(SUM(amount), 0) FROM public.game_round_bets WHERE round_id = p_round_id),
    win_amount = v_payout,
    result = jsonb_build_object('dice', jsonb_build_array(v_d1, v_d2, v_d3), 'total', v_total,
      'winner_pos', v_winners[1], 'winning_option_ids', to_jsonb(v_winners), 'settled_at', v_settled_at,
      'top_winners', v_top_winners)
  WHERE id = p_round_id;

  RETURN json_build_object('success', true, 'round_id', p_round_id, 'dice', ARRAY[v_d1,v_d2,v_d3],
    'total', v_total, 'winning_option_ids', v_winners, 'my_win_amount', v_my_payout, 'settled_at', v_settled_at);
END;
$$;

REVOKE ALL ON FUNCTION public.lucky_dice_roll_for_option(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lucky_dice_roll_for_option(TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.resolve_lucky_dice_round(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_lucky_dice_round(UUID) TO authenticated, service_role;
