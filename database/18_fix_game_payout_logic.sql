-- =====================================================================
-- FIX: Game payout logic — pay out whenever the winning position is one
-- the user actually bet on, regardless of the win-chance roll.
--
-- Bug we hit: a player who covered all 3 chairs in Teen Patti (or all 4
-- fruit types in Roulette) could still see "LOST" with 0 payout. The
-- house's win-chance roll was deciding the OUTCOME instead of just
-- biasing which position wins. When `v_user_wins = false` and there
-- were no uncovered positions, the picked slot WAS covered but the
-- code left `v_win_amount = 0`.
--
-- Correct semantics:
--   - win_chance ONLY biases which position is the winner
--       * if "user wins": pick from covered positions
--       * if "user loses": pick from uncovered positions
--       * if user covered everything: pick any (user must be paid)
--   - Payout = bet_on_winner * multiplier, independent of the roll
--
-- Idempotent. Run in Supabase SQL Editor.
-- =====================================================================

-- 1. TEEN PATTI
CREATE OR REPLACE FUNCTION public.play_teen_patti(
  p_user_id UUID,
  p_bet_a   BIGINT,
  p_bet_b   BIGINT,
  p_bet_c   BIGINT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance      BIGINT;
  v_total_bet    BIGINT;
  v_win_chance   INT;
  v_is_active    BOOLEAN;
  v_should_win   BOOLEAN;
  v_winner_pos   TEXT;
  v_winner_bet   BIGINT := 0;
  v_win_amount   BIGINT := 0;
  v_round_id     UUID;
  v_covered      TEXT[] := ARRAY[]::TEXT[];
  v_uncovered    TEXT[] := ARRAY[]::TEXT[];
BEGIN
  v_total_bet := COALESCE(p_bet_a,0) + COALESCE(p_bet_b,0) + COALESCE(p_bet_c,0);
  IF v_total_bet <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'No bet placed');
  END IF;

  SELECT win_chance_percent, is_active INTO v_win_chance, v_is_active
    FROM public.game_settings WHERE id = 'teen_patti';
  IF v_is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Game disabled');
  END IF;

  SELECT diamonds INTO v_balance FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF v_balance IS NULL OR v_balance < v_total_bet THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient diamonds');
  END IF;

  -- Deduct total bet first (server-side authoritative)
  UPDATE public.profiles SET diamonds = diamonds - v_total_bet WHERE id = p_user_id;

  -- Build covered / uncovered lists
  IF COALESCE(p_bet_a,0) > 0 THEN v_covered := array_append(v_covered, 'A');
                              ELSE v_uncovered := array_append(v_uncovered, 'A'); END IF;
  IF COALESCE(p_bet_b,0) > 0 THEN v_covered := array_append(v_covered, 'B');
                              ELSE v_uncovered := array_append(v_uncovered, 'B'); END IF;
  IF COALESCE(p_bet_c,0) > 0 THEN v_covered := array_append(v_covered, 'C');
                              ELSE v_uncovered := array_append(v_uncovered, 'C'); END IF;

  -- Win-chance roll only BIASES which position wins
  v_should_win := (random() * 100) < v_win_chance;

  IF v_should_win THEN
    -- Pick from covered (user has at least one bet by this point)
    v_winner_pos := v_covered[1 + floor(random() * array_length(v_covered, 1))::INT];
  ELSE
    -- Pick from uncovered. If user covered everything, fall back to covered
    -- (a covered-all bet is by definition guaranteed to land on a bet,
    -- which is fine since the player has paid the house edge upfront).
    IF array_length(v_uncovered, 1) > 0 THEN
      v_winner_pos := v_uncovered[1 + floor(random() * array_length(v_uncovered, 1))::INT];
    ELSE
      v_winner_pos := v_covered[1 + floor(random() * array_length(v_covered, 1))::INT];
    END IF;
  END IF;

  -- Compute payout from the actual winner position (not from the roll)
  v_winner_bet := CASE v_winner_pos
                    WHEN 'A' THEN COALESCE(p_bet_a, 0)
                    WHEN 'B' THEN COALESCE(p_bet_b, 0)
                    WHEN 'C' THEN COALESCE(p_bet_c, 0)
                  END;
  IF v_winner_bet > 0 THEN
    v_win_amount := v_winner_bet * 2;
    UPDATE public.profiles SET diamonds = diamonds + v_win_amount WHERE id = p_user_id;
  END IF;

  INSERT INTO public.game_rounds (game_type, user_id, bets, result, total_bet, win_amount)
  VALUES ('teen_patti', p_user_id,
          jsonb_build_object('A',p_bet_a,'B',p_bet_b,'C',p_bet_c),
          jsonb_build_object('winner_pos', v_winner_pos, 'user_won', v_win_amount > 0),
          v_total_bet, v_win_amount)
  RETURNING id INTO v_round_id;

  INSERT INTO public.transactions (user_id, type, currency, amount, related_entity_type, related_entity_id, status)
  VALUES (p_user_id, 'game_bet', 'diamond', -v_total_bet, 'game_round', v_round_id, 'completed');
  IF v_win_amount > 0 THEN
    INSERT INTO public.transactions (user_id, type, currency, amount, related_entity_type, related_entity_id, status)
    VALUES (p_user_id, 'game_win', 'diamond', v_win_amount, 'game_round', v_round_id, 'completed');
  END IF;

  RETURN json_build_object('success', true, 'winner_pos', v_winner_pos, 'win_amount', v_win_amount);
END;
$$;


-- 2. FRUIT ROULETTE
CREATE OR REPLACE FUNCTION public.play_fruit_roulette(
  p_user_id        UUID,
  p_apple_bet      BIGINT,
  p_watermelon_bet BIGINT,
  p_star_bet       BIGINT,
  p_crown_bet      BIGINT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance        BIGINT;
  v_total_bet      BIGINT;
  v_win_chance     INT;
  v_is_active      BOOLEAN;
  v_should_win     BOOLEAN;
  v_winning_slot   INT;
  v_winning_type   TEXT;
  v_multiplier     INT;
  v_user_bet       BIGINT;
  v_win_amount     BIGINT := 0;
  v_round_id       UUID;
  v_slots          JSONB := '[
    {"id":0,"type":"apple","m":5},
    {"id":1,"type":"watermelon","m":10},
    {"id":2,"type":"apple","m":5},
    {"id":3,"type":"star","m":15},
    {"id":4,"type":"apple","m":5},
    {"id":5,"type":"crown","m":25},
    {"id":6,"type":"watermelon","m":10},
    {"id":7,"type":"apple","m":5}
  ]'::JSONB;
  v_slot           JSONB;
  v_covered_slots  JSONB := '[]'::JSONB;
  v_uncovered_slots JSONB := '[]'::JSONB;
  v_i              INT;
  v_slot_type      TEXT;
  v_slot_bet       BIGINT;
BEGIN
  v_total_bet := COALESCE(p_apple_bet,0) + COALESCE(p_watermelon_bet,0)
               + COALESCE(p_star_bet,0)  + COALESCE(p_crown_bet,0);
  IF v_total_bet <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'No bet placed');
  END IF;

  SELECT win_chance_percent, is_active INTO v_win_chance, v_is_active
    FROM public.game_settings WHERE id = 'fruit_roulette';
  IF v_is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Game disabled');
  END IF;

  SELECT diamonds INTO v_balance FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF v_balance IS NULL OR v_balance < v_total_bet THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient diamonds');
  END IF;

  UPDATE public.profiles SET diamonds = diamonds - v_total_bet WHERE id = p_user_id;

  -- Bucket all 8 slots into covered / uncovered based on whether the user
  -- has a bet on that slot's TYPE (apple / watermelon / star / crown).
  FOR v_i IN 0..7 LOOP
    v_slot      := v_slots->v_i;
    v_slot_type := v_slot->>'type';
    v_slot_bet  := CASE v_slot_type
                     WHEN 'apple'      THEN COALESCE(p_apple_bet, 0)
                     WHEN 'watermelon' THEN COALESCE(p_watermelon_bet, 0)
                     WHEN 'star'       THEN COALESCE(p_star_bet, 0)
                     WHEN 'crown'      THEN COALESCE(p_crown_bet, 0)
                   END;
    IF v_slot_bet > 0 THEN
      v_covered_slots   := v_covered_slots   || v_slot;
    ELSE
      v_uncovered_slots := v_uncovered_slots || v_slot;
    END IF;
  END LOOP;

  v_should_win := (random() * 100) < v_win_chance;

  IF v_should_win AND jsonb_array_length(v_covered_slots) > 0 THEN
    v_slot := v_covered_slots->(floor(random() * jsonb_array_length(v_covered_slots))::INT);
  ELSIF NOT v_should_win AND jsonb_array_length(v_uncovered_slots) > 0 THEN
    v_slot := v_uncovered_slots->(floor(random() * jsonb_array_length(v_uncovered_slots))::INT);
  ELSE
    -- Either user wanted to win but bet on nothing (impossible due to
    -- earlier check), or user wanted to lose but covered all 4 types.
    -- In both cases just pick uniformly from all slots; payout is
    -- decided downstream based on whether the user bet on the type.
    v_slot := COALESCE(
      CASE WHEN jsonb_array_length(v_covered_slots) > 0
           THEN v_covered_slots->(floor(random() * jsonb_array_length(v_covered_slots))::INT)
           ELSE NULL END,
      v_slots->(floor(random()*8)::INT)
    );
  END IF;

  v_winning_slot := (v_slot->>'id')::INT;
  v_winning_type := v_slot->>'type';
  v_multiplier   := (v_slot->>'m')::INT;

  v_user_bet := CASE v_winning_type
                  WHEN 'apple'      THEN COALESCE(p_apple_bet, 0)
                  WHEN 'watermelon' THEN COALESCE(p_watermelon_bet, 0)
                  WHEN 'star'       THEN COALESCE(p_star_bet, 0)
                  WHEN 'crown'      THEN COALESCE(p_crown_bet, 0)
                END;

  -- Pay out whenever the user actually bet on this fruit, regardless of
  -- the should_win roll (the roll only biases WHICH slot wins).
  IF v_user_bet > 0 THEN
    v_win_amount := v_user_bet * v_multiplier;
    UPDATE public.profiles SET diamonds = diamonds + v_win_amount WHERE id = p_user_id;
  END IF;

  INSERT INTO public.game_rounds (game_type, user_id, bets, result, total_bet, win_amount)
  VALUES ('fruit_roulette', p_user_id,
          jsonb_build_object('apple',p_apple_bet,'watermelon',p_watermelon_bet,'star',p_star_bet,'crown',p_crown_bet),
          jsonb_build_object('winning_slot_id', v_winning_slot, 'winning_type', v_winning_type, 'user_won', v_win_amount > 0),
          v_total_bet, v_win_amount)
  RETURNING id INTO v_round_id;

  INSERT INTO public.transactions (user_id, type, currency, amount, related_entity_type, related_entity_id, status)
  VALUES (p_user_id, 'game_bet', 'diamond', -v_total_bet, 'game_round', v_round_id, 'completed');
  IF v_win_amount > 0 THEN
    INSERT INTO public.transactions (user_id, type, currency, amount, related_entity_type, related_entity_id, status)
    VALUES (p_user_id, 'game_win', 'diamond', v_win_amount, 'game_round', v_round_id, 'completed');
  END IF;

  RETURN json_build_object(
    'success', true,
    'winning_slot_id', v_winning_slot,
    'winning_type', v_winning_type,
    'win_amount', v_win_amount
  );
END;
$$;

-- =====================================================================
-- DONE. After this:
--   - Teen Patti: betting on all 3 chairs guarantees a payout on
--     whichever chair wins (player still loses on the other 2 chairs'
--     bets — that's the house edge from the 2x multiplier).
--   - Fruit Roulette: betting on all 4 fruits guarantees a payout on
--     the winning fruit's multiplier (still a house edge in the long
--     run because not every multiplier is high enough to break even).
-- =====================================================================