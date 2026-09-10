-- Wire the win-strategy quota into settlement.
--
-- The ONLY thing this changes is which board is selected as the winner when the
-- strategy is enabled. Payouts, bean handling, hands, top winners, the ledger
-- and the set-based payout rewrite are all byte-identical to the previous
-- version of this function.
--
-- Selection order:
--   1. forced_next_result  -- manual admin override, unchanged, still first.
--   2. no bets on the round -> random board, unchanged.
--   3. strategy enabled and a tier was drawn -> rank the boards by stake and
--      take max / medium / min. Ties broken randomly.
--   4. otherwise -> the original payout-band logic, unchanged.
--
-- Because the tier is only drawn in branch 3, disabling the strategy leaves the
-- bag untouched and the game behaves exactly as it did before. A tier is also
-- only drawn when the round actually took bets, so idle rounds never consume a
-- slot out of the admin's quota.

CREATE OR REPLACE FUNCTION public.resolve_tin_patti_pro_round(p_round_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  v_forced BOOLEAN := FALSE;
  v_tier TEXT;
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
    -- Draw a tier only when there is real money on the table, so idle rounds
    -- never burn slots out of the admin's quota.
    v_tier := public.tin_patti_pro_draw_win_tier();

    IF v_tier IS NOT NULL THEN
      -- Rank the boards by how much is staked on them. Boards with no bets rank
      -- last, and equal stakes are separated randomly.
      WITH ranked AS (
        SELECT opt.id AS position_id,
               ROW_NUMBER() OVER (
                 ORDER BY COALESCE(SUM(b.amount), 0) DESC, random()
               ) AS rank_desc,
               COUNT(*) OVER () AS total_options
          FROM public.tin_patti_pro_options() AS opt
          LEFT JOIN public.game_round_bets b
            ON b.round_id = v_round.id
           AND b.position = opt.id
         GROUP BY opt.id
      )
      SELECT position_id INTO v_winner_pos
        FROM ranked
       WHERE rank_desc = CASE
               WHEN v_tier = 'max' THEN 1
               WHEN v_tier = 'min' THEN total_options
               -- With three boards this is the middle one. With a different
               -- option count it stays the central rank.
               ELSE GREATEST(1, LEAST(total_options, (total_options + 1) / 2))
             END
       LIMIT 1;
    END IF;

    IF v_winner_pos IS NULL THEN
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

  -- Payout: four statements, each independent of the number of bet rows.
  UPDATE public.game_round_bets
     SET win_amount = (amount * v_multiplier)::bigint
   WHERE round_id = v_round.id
     AND position = v_winner_pos;

  SELECT COALESCE(SUM(win_amount), 0)
    INTO v_payout_total
    FROM public.game_round_bets
   WHERE round_id = v_round.id;

  WITH per_user AS (
    SELECT user_id, SUM(win_amount)::bigint AS win
      FROM public.game_round_bets
     WHERE round_id = v_round.id
       AND position = v_winner_pos
       AND user_id IS NOT NULL
     GROUP BY user_id
  )
  UPDATE public.profiles AS profile_row
     SET diamonds = COALESCE(profile_row.diamonds, 0) + per_user.win
    FROM per_user
   WHERE profile_row.id = per_user.user_id;

  INSERT INTO public.transactions
    (user_id, related_user_id, type, currency, amount,
     related_entity_type, related_entity_id, status, notes)
  SELECT winners.user_id, v_settings.house_profile_id, 'game_win', 'diamond',
         winners.win, 'game_round', v_round.id, 'completed', 'Tin Patti Pro win'
    FROM (
      SELECT user_id, SUM(win_amount)::bigint AS win
        FROM public.game_round_bets
       WHERE round_id = v_round.id
         AND position = v_winner_pos
         AND user_id IS NOT NULL
       GROUP BY user_id
    ) AS winners;

  IF v_settings.house_profile_id IS NOT NULL AND v_payout_total > 0 THEN
    UPDATE public.profiles
       SET diamonds = COALESCE(diamonds, 0) - v_payout_total
     WHERE profiles.id = v_settings.house_profile_id;

    INSERT INTO public.transactions
      (user_id, related_user_id, type, currency, amount,
       related_entity_type, related_entity_id, status, notes)
    VALUES
      (v_settings.house_profile_id, NULL, 'game_owner_payout', 'diamond',
       -v_payout_total, 'game_round', v_round.id, 'completed',
       'Tin Patti Pro payout funded');
  END IF;

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
         result = COALESCE(game_rounds.result, '{}'::jsonb) || jsonb_build_object(
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
END $function$;

GRANT EXECUTE ON FUNCTION public.resolve_tin_patti_pro_round(UUID) TO authenticated, service_role;
