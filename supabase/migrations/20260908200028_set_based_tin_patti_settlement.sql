-- Phase 2 of the Teen Patti Pro audit (TP-02): make settlement set-based.
--
-- resolve_tin_patti_pro_round paid winners with a row-by-row loop that issued
-- FIVE statements per winning bet row:
--
--   FOR v_bet IN SELECT ... LOOP
--     UPDATE game_round_bets SET win_amount = ...   -- per row
--     UPDATE profiles        SET diamonds   = ...   -- winner
--     UPDATE profiles        SET diamonds   = ...   -- HOUSE: the same row, every iteration
--     INSERT INTO transactions ...                  -- house leg
--     INSERT INTO transactions ...                  -- winner leg
--   END LOOP;
--
-- Because a stake is stored as one row per chip denomination, "winning bet row"
-- is not "winning player" -- 50 players betting 10,000 each is ~100 rows, so
-- ~500 statements and ~100 sequential updates to a single profile row. Postgres
-- must serialise those and writes a new tuple version for each, which is why the
-- house profile churned and tick_authoritative_mini_games reached a 117-second
-- worst case against an 8-second statement_timeout.
--
-- The loop is now four set-based statements whose cost is independent of the
-- number of rows: mark winners, credit each player once, debit the house once,
-- write one ledger row per winner plus one for the house.
--
-- Behaviour preserved exactly:
--   * game_round_bets.win_amount is still set per row, so top_winners,
--     my_win_amount and the payout total are byte-identical.
--   * Winner selection, forced results, multipliers and dealt hands are untouched.
--   * Net diamond movement per player and for the house is unchanged.
--
-- Behaviour deliberately changed:
--   * Ledger granularity. Previously one 'game_win' and one 'game_owner_payout'
--     row per CHIP row; now one 'game_win' per winning player and a single
--     aggregated 'game_owner_payout' for the round. Sums are identical, so the
--     daily_loss_cap calculation in the bet path is unaffected -- there are just
--     far fewer rows, and they are readable.
--   * result is now merged rather than replaced, so 'first_cards' written during
--     the betting phase survives settlement instead of being recomputed on read.
--
-- Verified on production inside a rolled-back transaction: 6 winning chip rows
-- across 2 players produced 2 'game_win' rows and 1 'game_owner_payout' row;
-- player deltas were 33,350 and 4,350 against a multiplier of 2.9, the losing
-- player moved 0, and the house delta was exactly -37,700 = the sum of the two.

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

  -- ------------------------------------------------------------------
  -- Payout. Four statements, each independent of the number of bet rows.
  -- ------------------------------------------------------------------

  -- 1. Mark every winning row. Losing rows keep win_amount as-is (0/NULL),
  --    exactly as the old loop left them.
  UPDATE public.game_round_bets
     SET win_amount = (amount * v_multiplier)::bigint
   WHERE round_id = v_round.id
     AND position = v_winner_pos;

  SELECT COALESCE(SUM(win_amount), 0)
    INTO v_payout_total
    FROM public.game_round_bets
   WHERE round_id = v_round.id;

  -- 2. Credit each winning player once, aggregated across their chip rows,
  --    instead of once per row.
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

  -- 3. One ledger row per winning player.
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

  -- 4. Debit the house ONCE for the whole round, not once per chip row.
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

  -- Merge rather than replace, so first_cards written during betting survives.
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
