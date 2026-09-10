-- Give Teen Patti rounds a useful mix of all six hand classes without moving
-- winner selection to the client. The authoritative winner is unchanged; this
-- function only finds a deterministic valid 52-card presentation deal in which
-- that chair is strictly strongest.

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
  v_winner_eval JSONB;
  v_winner_score BIGINT;
  v_attempt INT;
  v_rank_seed BIGINT;
  v_target_ranks INT[] := ARRAY[1,1,1,2,2,2,3,3,4,4,5,6];
  v_target_rank INT;
BEGIN
  IF p_winner NOT IN ('crown', 'coffee', 'cake') THEN
    RAISE EXCEPTION 'Invalid Teen Patti winner: %', p_winner;
  END IF;

  v_rank_seed := ('x' || substr(md5(p_round_id::text || ':hand-class'), 1, 8))::bit(32)::bigint;
  v_target_rank := v_target_ranks[mod(v_rank_seed, array_length(v_target_ranks, 1))::int + 1];

  -- The first 3,000 attempts require the round's deterministic target class.
  -- The final 1,000 attempts accept any strict deal, preventing settlement from
  -- failing if an unusually constrained set of public cards cannot match it.
  FOR v_attempt IN 0..3999 LOOP
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
             ORDER BY md5(p_round_id::text || ':balanced-deal:' || v_attempt::text || ':' || value || suit)
           )
      INTO v_deck
      FROM remaining;

    v_crown_cards := jsonb_build_array(v_first->'crown', v_deck->0, v_deck->1);
    v_coffee_cards := jsonb_build_array(v_first->'coffee', v_deck->2, v_deck->3);
    v_cake_cards := jsonb_build_array(v_first->'cake', v_deck->4, v_deck->5);
    v_crown_eval := public.tin_patti_pro_evaluate_hand(v_crown_cards);
    v_coffee_eval := public.tin_patti_pro_evaluate_hand(v_coffee_cards);
    v_cake_eval := public.tin_patti_pro_evaluate_hand(v_cake_cards);
    v_winner_eval := CASE p_winner
      WHEN 'crown' THEN v_crown_eval
      WHEN 'coffee' THEN v_coffee_eval
      ELSE v_cake_eval
    END;
    v_winner_score := (v_winner_eval->>'score')::bigint;

    IF (v_attempt >= 3000 OR (v_winner_eval->>'rank_value')::int = v_target_rank)
       AND (
         (p_winner = 'crown' AND v_winner_score > (v_coffee_eval->>'score')::bigint AND v_winner_score > (v_cake_eval->>'score')::bigint)
         OR (p_winner = 'coffee' AND v_winner_score > (v_crown_eval->>'score')::bigint AND v_winner_score > (v_cake_eval->>'score')::bigint)
         OR (p_winner = 'cake' AND v_winner_score > (v_crown_eval->>'score')::bigint AND v_winner_score > (v_coffee_eval->>'score')::bigint)
       ) THEN
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

GRANT EXECUTE ON FUNCTION public.tin_patti_pro_deal_hands(TEXT, UUID)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.tin_patti_pro_deal_hands(TEXT, UUID) IS
  'Deterministic balanced-class 52-card presentation deal whose strict winner matches the authoritative result.';

