-- Reveal one backend-owned card per board throughout betting. Final hands
-- preserve these cards, while the authoritative resolver still chooses the
-- winner and supplies every rank/card in the settled result.

CREATE OR REPLACE FUNCTION public.tin_patti_pro_first_cards()
RETURNS JSONB
LANGUAGE SQL
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'crown',  jsonb_build_object('value', 'A', 'suit', 'H'),
    'coffee', jsonb_build_object('value', 'K', 'suit', 'S'),
    'cake',   jsonb_build_object('value', 'Q', 'suit', 'D')
  );
$$;

CREATE OR REPLACE FUNCTION public.tin_patti_pro_deal_hands(p_winner TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_winner = 'crown' THEN
    RETURN jsonb_build_object(
      'crown', jsonb_build_object('rank', 'Trail', 'rank_value', 6, 'cards', jsonb_build_array(
        jsonb_build_object('value', 'A', 'suit', 'H'), jsonb_build_object('value', 'A', 'suit', 'S'), jsonb_build_object('value', 'A', 'suit', 'D'))),
      'coffee', jsonb_build_object('rank', 'High Card', 'rank_value', 1, 'cards', jsonb_build_array(
        jsonb_build_object('value', 'K', 'suit', 'S'), jsonb_build_object('value', '9', 'suit', 'D'), jsonb_build_object('value', '5', 'suit', 'C'))),
      'cake', jsonb_build_object('rank', 'High Card', 'rank_value', 1, 'cards', jsonb_build_array(
        jsonb_build_object('value', 'Q', 'suit', 'D'), jsonb_build_object('value', '8', 'suit', 'C'), jsonb_build_object('value', '4', 'suit', 'S')))
    );
  ELSIF p_winner = 'coffee' THEN
    RETURN jsonb_build_object(
      'crown', jsonb_build_object('rank', 'High Card', 'rank_value', 1, 'cards', jsonb_build_array(
        jsonb_build_object('value', 'A', 'suit', 'H'), jsonb_build_object('value', '9', 'suit', 'H'), jsonb_build_object('value', '5', 'suit', 'C'))),
      'coffee', jsonb_build_object('rank', 'Pure Sequence', 'rank_value', 5, 'cards', jsonb_build_array(
        jsonb_build_object('value', 'K', 'suit', 'S'), jsonb_build_object('value', 'Q', 'suit', 'S'), jsonb_build_object('value', 'J', 'suit', 'S'))),
      'cake', jsonb_build_object('rank', 'High Card', 'rank_value', 1, 'cards', jsonb_build_array(
        jsonb_build_object('value', 'Q', 'suit', 'D'), jsonb_build_object('value', '8', 'suit', 'H'), jsonb_build_object('value', '3', 'suit', 'C')))
    );
  END IF;

  RETURN jsonb_build_object(
    'crown', jsonb_build_object('rank', 'High Card', 'rank_value', 1, 'cards', jsonb_build_array(
      jsonb_build_object('value', 'A', 'suit', 'H'), jsonb_build_object('value', '8', 'suit', 'S'), jsonb_build_object('value', '4', 'suit', 'C'))),
    'coffee', jsonb_build_object('rank', 'High Card', 'rank_value', 1, 'cards', jsonb_build_array(
      jsonb_build_object('value', 'K', 'suit', 'S'), jsonb_build_object('value', '7', 'suit', 'D'), jsonb_build_object('value', '3', 'suit', 'S'))),
    'cake', jsonb_build_object('rank', 'Pair', 'rank_value', 2, 'cards', jsonb_build_array(
      jsonb_build_object('value', 'Q', 'suit', 'D'), jsonb_build_object('value', 'Q', 'suit', 'H'), jsonb_build_object('value', '9', 'suit', 'D')))
  );
END;
$$;

DO $$
BEGIN
  IF to_regprocedure('public.get_tin_patti_pro_state_base_154()') IS NULL THEN
    ALTER FUNCTION public.get_tin_patti_pro_state()
      RENAME TO get_tin_patti_pro_state_base_154;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.get_tin_patti_pro_state_base_154()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_tin_patti_pro_state()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_state JSONB;
BEGIN
  v_state := public.get_tin_patti_pro_state_base_154()::jsonb;
  RETURN jsonb_set(v_state, '{first_cards}', public.tin_patti_pro_first_cards(), true)::json;
END;
$$;

GRANT EXECUTE ON FUNCTION public.tin_patti_pro_first_cards()
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tin_patti_pro_deal_hands(TEXT)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_tin_patti_pro_state()
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_tin_patti_pro_state() IS
  'Teen Patti Pro state with backend-owned public first cards.';
