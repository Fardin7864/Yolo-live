-- Replace the fixed Teen Patti presentation cards with a deterministic deal
-- derived from the authoritative round id. Every round uses one 52-card deck,
-- and the backend-selected winning chair is dealt the strictly strongest hand.

CREATE OR REPLACE FUNCTION public.tin_patti_pro_first_cards(p_round_id UUID)
RETURNS JSONB
LANGUAGE SQL
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  WITH deck AS (
    SELECT value, suit
      FROM unnest(ARRAY['2','3','4','5','6','7','8','9','10','J','Q','K','A']) AS values_list(value)
      CROSS JOIN unnest(ARRAY['C','D','H','S']) AS suits_list(suit)
  ), shuffled AS (
    SELECT jsonb_build_object('value', value, 'suit', suit) AS card,
           row_number() OVER (ORDER BY md5(p_round_id::text || ':first:' || value || suit)) AS position
      FROM deck
  ), cards AS (
    SELECT jsonb_agg(card ORDER BY position) AS list FROM shuffled
  )
  SELECT jsonb_build_object('crown', list->0, 'coffee', list->1, 'cake', list->2)
    FROM cards;
$$;

CREATE OR REPLACE FUNCTION public.tin_patti_pro_evaluate_hand(p_cards JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_values INT[];
  v_suits TEXT[];
  v_distinct_values INT;
  v_distinct_cards INT;
  v_is_flush BOOLEAN;
  v_is_sequence BOOLEAN := FALSE;
  v_sequence_score INT := 0;
  v_pair_value INT := 0;
  v_pair_count INT := 0;
  v_kicker INT := 0;
  v_rank TEXT;
  v_rank_value INT;
  v_tie_score BIGINT;
BEGIN
  IF jsonb_typeof(p_cards) <> 'array' OR jsonb_array_length(p_cards) <> 3 THEN
    RAISE EXCEPTION 'Teen Patti hand must contain exactly three cards';
  END IF;

  SELECT array_agg(card_value ORDER BY card_value DESC),
         array_agg(suit ORDER BY card_value DESC),
         count(DISTINCT card_value),
         count(DISTINCT (value || ':' || suit))
    INTO v_values, v_suits, v_distinct_values, v_distinct_cards
    FROM (
      SELECT upper(card->>'value') AS value,
             upper(card->>'suit') AS suit,
             CASE upper(card->>'value')
               WHEN 'A' THEN 14 WHEN 'K' THEN 13 WHEN 'Q' THEN 12 WHEN 'J' THEN 11
               ELSE (card->>'value')::int
             END AS card_value
        FROM jsonb_array_elements(p_cards) AS card
    ) parsed;

  IF v_distinct_cards <> 3 THEN
    RAISE EXCEPTION 'Teen Patti hand contains a duplicate card';
  END IF;

  v_is_flush := v_suits[1] = v_suits[2] AND v_suits[2] = v_suits[3];
  IF v_distinct_values = 3 THEN
    IF v_values = ARRAY[14,13,12] THEN
      v_is_sequence := TRUE;
      v_sequence_score := 15;
    ELSIF v_values = ARRAY[14,3,2] THEN
      v_is_sequence := TRUE;
      v_sequence_score := 14;
    ELSIF v_values[1] = v_values[2] + 1 AND v_values[2] = v_values[3] + 1 THEN
      v_is_sequence := TRUE;
      v_sequence_score := v_values[1];
    END IF;
  END IF;

  SELECT card_value, count(*)::int
    INTO v_pair_value, v_pair_count
    FROM unnest(v_values) AS card_value
   GROUP BY card_value
   ORDER BY count(*) DESC, card_value DESC
   LIMIT 1;

  IF v_pair_count = 3 THEN
    v_rank := 'Trail';
    v_rank_value := 6;
    v_tie_score := v_pair_value;
  ELSIF v_is_sequence AND v_is_flush THEN
    v_rank := 'Pure Sequence';
    v_rank_value := 5;
    v_tie_score := v_sequence_score;
  ELSIF v_is_sequence THEN
    v_rank := 'Sequence';
    v_rank_value := 4;
    v_tie_score := v_sequence_score;
  ELSIF v_is_flush THEN
    v_rank := 'Color';
    v_rank_value := 3;
    v_tie_score := v_values[1] * 225 + v_values[2] * 15 + v_values[3];
  ELSIF v_pair_count = 2 THEN
    SELECT card_value INTO v_kicker
      FROM unnest(v_values) AS card_value
     WHERE card_value <> v_pair_value
     LIMIT 1;
    v_rank := 'Pair';
    v_rank_value := 2;
    v_tie_score := v_pair_value * 15 + v_kicker;
  ELSE
    v_rank := 'High Card';
    v_rank_value := 1;
    v_tie_score := v_values[1] * 225 + v_values[2] * 15 + v_values[3];
  END IF;

  RETURN jsonb_build_object(
    'rank', v_rank,
    'rank_value', v_rank_value,
    'score', v_rank_value::bigint * 1000000 + v_tie_score
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.tin_patti_pro_deal_hands(p_winner TEXT, p_round_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_first JSONB := public.tin_patti_pro_first_cards(p_round_id);
  v_deck JSONB;
  v_crown_cards JSONB;
  v_coffee_cards JSONB;
  v_cake_cards JSONB;
  v_crown_eval JSONB;
  v_coffee_eval JSONB;
  v_cake_eval JSONB;
  v_winner_score BIGINT;
  v_attempt INT;
BEGIN
  IF p_winner NOT IN ('crown', 'coffee', 'cake') THEN
    RAISE EXCEPTION 'Invalid Teen Patti winner: %', p_winner;
  END IF;

  FOR v_attempt IN 0..499 LOOP
    WITH deck AS (
      SELECT value, suit
        FROM unnest(ARRAY['2','3','4','5','6','7','8','9','10','J','Q','K','A']) AS values_list(value)
        CROSS JOIN unnest(ARRAY['C','D','H','S']) AS suits_list(suit)
    ), remaining AS (
      SELECT value, suit
        FROM deck
       WHERE NOT EXISTS (
         SELECT 1
           FROM jsonb_each(v_first) AS first_card(chair, card)
          WHERE first_card.card->>'value' = deck.value
            AND first_card.card->>'suit' = deck.suit
       )
    )
    SELECT jsonb_agg(
             jsonb_build_object('value', value, 'suit', suit)
             ORDER BY md5(p_round_id::text || ':deal:' || v_attempt::text || ':' || value || suit)
           )
      INTO v_deck
      FROM remaining;

    v_crown_cards := jsonb_build_array(v_first->'crown', v_deck->0, v_deck->1);
    v_coffee_cards := jsonb_build_array(v_first->'coffee', v_deck->2, v_deck->3);
    v_cake_cards := jsonb_build_array(v_first->'cake', v_deck->4, v_deck->5);
    v_crown_eval := public.tin_patti_pro_evaluate_hand(v_crown_cards);
    v_coffee_eval := public.tin_patti_pro_evaluate_hand(v_coffee_cards);
    v_cake_eval := public.tin_patti_pro_evaluate_hand(v_cake_cards);
    v_winner_score := CASE p_winner
      WHEN 'crown' THEN (v_crown_eval->>'score')::bigint
      WHEN 'coffee' THEN (v_coffee_eval->>'score')::bigint
      ELSE (v_cake_eval->>'score')::bigint
    END;

    IF (p_winner = 'crown' AND v_winner_score > (v_coffee_eval->>'score')::bigint AND v_winner_score > (v_cake_eval->>'score')::bigint)
       OR (p_winner = 'coffee' AND v_winner_score > (v_crown_eval->>'score')::bigint AND v_winner_score > (v_cake_eval->>'score')::bigint)
       OR (p_winner = 'cake' AND v_winner_score > (v_crown_eval->>'score')::bigint AND v_winner_score > (v_coffee_eval->>'score')::bigint) THEN
      RETURN jsonb_build_object(
        'crown', (v_crown_eval - 'score') || jsonb_build_object('cards', v_crown_cards),
        'coffee', (v_coffee_eval - 'score') || jsonb_build_object('cards', v_coffee_cards),
        'cake', (v_cake_eval - 'score') || jsonb_build_object('cards', v_cake_cards)
      );
    END IF;
  END LOOP;

  RAISE EXCEPTION 'Could not produce a strict winning Teen Patti deal for round %', p_round_id;
END;
$$;

-- The existing resolver remains authoritative for winner selection and payout.
-- This trigger replaces only its presentation cards before the settled row is
-- written, so Realtime can never publish the old fixed-card result first.
CREATE OR REPLACE FUNCTION public.tin_patti_pro_apply_varied_hands()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_first JSONB;
  v_hands JSONB;
BEGIN
  IF NEW.game_type = 'tin_patti_pro'
     AND NEW.status = 'settled'
     AND NEW.winner_pos IN ('crown', 'coffee', 'cake')
     AND OLD.status IS DISTINCT FROM 'settled' THEN
    v_first := public.tin_patti_pro_first_cards(NEW.id);
    v_hands := public.tin_patti_pro_deal_hands(NEW.winner_pos, NEW.id);
    NEW.result := COALESCE(NEW.result, '{}'::jsonb) || jsonb_build_object(
      'first_cards', v_first,
      'hands', v_hands
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tin_patti_pro_varied_hands_before_settle ON public.game_rounds;
CREATE TRIGGER tin_patti_pro_varied_hands_before_settle
BEFORE UPDATE OF status, winner_pos, result ON public.game_rounds
FOR EACH ROW
EXECUTE FUNCTION public.tin_patti_pro_apply_varied_hands();

-- Keep one public card stable for the full betting window. The serialized tick
-- remains the only coordinator and adds the cards immediately after creation.
CREATE OR REPLACE FUNCTION public.tin_patti_pro_tick()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result JSON;
BEGIN
  PERFORM pg_advisory_xact_lock(1729, 2);
  v_result := public.tin_patti_pro_tick_unlocked_149();

  UPDATE public.game_rounds
     SET result = jsonb_set(
       COALESCE(result, '{}'::jsonb),
       '{first_cards}',
       public.tin_patti_pro_first_cards(id),
       true
     )
   WHERE game_type = 'tin_patti_pro'
     AND room_id = public.tin_patti_pro_global_room_id()
     AND status = 'betting'
     AND NOT COALESCE(result, '{}'::jsonb) ? 'first_cards';

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_tin_patti_pro_state()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_state JSONB;
  v_round_id UUID;
  v_first JSONB;
BEGIN
  v_state := public.get_tin_patti_pro_state_base_154()::jsonb;
  BEGIN
    v_round_id := (v_state #>> '{round,id}')::uuid;
  EXCEPTION WHEN others THEN
    v_round_id := NULL;
  END;

  IF v_round_id IS NOT NULL THEN
    v_first := COALESCE(
      v_state #> '{round,result,first_cards}',
      public.tin_patti_pro_first_cards(v_round_id)
    );
    v_state := jsonb_set(v_state, '{first_cards}', v_first, true);
  END IF;
  RETURN v_state::json;
END;
$$;

-- Repair the currently open round without changing any settled history.
UPDATE public.game_rounds
   SET result = jsonb_set(
     COALESCE(result, '{}'::jsonb),
     '{first_cards}',
     public.tin_patti_pro_first_cards(id),
     true
   )
 WHERE game_type = 'tin_patti_pro'
   AND room_id = public.tin_patti_pro_global_room_id()
   AND status = 'betting';

REVOKE ALL ON FUNCTION public.tin_patti_pro_apply_varied_hands() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tin_patti_pro_first_cards(UUID) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tin_patti_pro_evaluate_hand(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tin_patti_pro_deal_hands(TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tin_patti_pro_tick() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_tin_patti_pro_state() TO authenticated, service_role;

COMMENT ON FUNCTION public.tin_patti_pro_deal_hands(TEXT, UUID) IS
  'Deterministic per-round 52-card deal whose strongest hand matches the authoritative winner.';
COMMENT ON FUNCTION public.tin_patti_pro_evaluate_hand(JSONB) IS
  'Teen Patti hand evaluator: Trail, Pure Sequence, Sequence, Color, Pair, High Card.';
