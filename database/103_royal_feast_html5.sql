-- Royal Feast HTML5 multiplayer game.
-- Run after migration 102. Wallet mutations and winner selection stay
-- server-side; the WebView is presentation only.

INSERT INTO public.game_settings
  (id, win_chance_percent, is_active, min_bet, max_bet, daily_loss_cap, multipliers)
VALUES (
  'royal_feast',
  30,
  TRUE,
  10,
  100000,
  NULL,
  '[
    {"id":0,"type":"chicken","m":45},
    {"id":1,"type":"shrimp","m":25},
    {"id":2,"type":"ham","m":15},
    {"id":3,"type":"fish","m":10},
    {"id":4,"type":"carrot","m":5},
    {"id":5,"type":"pepper","m":5},
    {"id":6,"type":"tomato","m":5},
    {"id":7,"type":"corn","m":5}
  ]'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  is_active = TRUE,
  multipliers = EXCLUDED.multipliers,
  min_bet = COALESCE(public.game_settings.min_bet, EXCLUDED.min_bet),
  max_bet = COALESCE(public.game_settings.max_bet, EXCLUDED.max_bet);

-- Defense in depth: a modified WebView cannot submit an invented food id.
CREATE OR REPLACE FUNCTION public.validate_royal_feast_bet()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_game_type text;
  v_valid boolean;
BEGIN
  SELECT game_type INTO v_game_type
    FROM public.game_rounds
   WHERE id = NEW.round_id;

  IF v_game_type = 'royal_feast' THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.game_settings gs,
             jsonb_array_elements(COALESCE(gs.multipliers, '[]'::jsonb)) slot
       WHERE gs.id = 'royal_feast'
         AND slot ->> 'type' = NEW.position
    ) INTO v_valid;
    IF NOT v_valid THEN
      RAISE EXCEPTION 'Invalid Royal Feast position';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_royal_feast_bet_trigger ON public.game_round_bets;
CREATE TRIGGER validate_royal_feast_bet_trigger
BEFORE INSERT OR UPDATE OF position, round_id ON public.game_round_bets
FOR EACH ROW EXECUTE FUNCTION public.validate_royal_feast_bet();

CREATE OR REPLACE FUNCTION public.resolve_royal_feast_round(p_round_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
  v_round public.game_rounds%ROWTYPE;
  v_settings public.game_settings%ROWTYPE;
  v_positions text[];
  v_covered text[];
  v_uncovered text[];
  v_winner text;
  v_should_win boolean;
  v_multiplier numeric;
  v_payout bigint;
  v_my_win bigint := 0;
  v_balance bigint := 0;
  v_bet record;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  SELECT * INTO v_round
    FROM public.game_rounds
   WHERE id = p_round_id
   FOR UPDATE;

  IF NOT FOUND OR v_round.game_type <> 'royal_feast' THEN
    RETURN json_build_object('success', false, 'message', 'Royal Feast round not found');
  END IF;

  IF v_round.status = 'settled' THEN
    SELECT COALESCE(SUM(win_amount), 0) INTO v_my_win
      FROM public.game_round_bets
     WHERE round_id = p_round_id AND user_id = me;
    SELECT diamonds INTO v_balance FROM public.profiles WHERE id = me;
    RETURN json_build_object(
      'success', true,
      'already_settled', true,
      'winner_pos', v_round.winner_pos,
      'my_win_amount', v_my_win,
      'balance', COALESCE(v_balance, 0)
    );
  END IF;

  IF v_round.ends_at > now() THEN
    RETURN json_build_object('success', false, 'pending', true, 'message', 'Betting is still open');
  END IF;

  IF v_round.status NOT IN ('betting', 'resolving') THEN
    RETURN json_build_object('success', false, 'message', 'Round cannot be resolved');
  END IF;

  UPDATE public.game_rounds SET status = 'resolving' WHERE id = p_round_id;
  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'royal_feast';

  SELECT array_agg(slot ->> 'type' ORDER BY (slot ->> 'id')::int)
    INTO v_positions
    FROM jsonb_array_elements(COALESCE(v_settings.multipliers, '[]'::jsonb)) slot;

  IF COALESCE(array_length(v_positions, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Royal Feast multipliers are not configured';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT position)
           FILTER (WHERE position = ANY(v_positions)), ARRAY[]::text[])
    INTO v_covered
    FROM public.game_round_bets
   WHERE round_id = p_round_id;

  v_uncovered := ARRAY(
    SELECT unnest(v_positions)
    EXCEPT
    SELECT unnest(v_covered)
  );
  v_should_win := random() * 100 < COALESCE(v_settings.win_chance_percent, 30);

  IF COALESCE(array_length(v_covered, 1), 0) = 0 THEN
    v_winner := v_positions[1 + floor(random() * array_length(v_positions, 1))::int];
  ELSIF v_should_win OR COALESCE(array_length(v_uncovered, 1), 0) = 0 THEN
    v_winner := v_covered[1 + floor(random() * array_length(v_covered, 1))::int];
  ELSE
    v_winner := v_uncovered[1 + floor(random() * array_length(v_uncovered, 1))::int];
  END IF;

  SELECT (slot ->> 'm')::numeric
    INTO v_multiplier
    FROM jsonb_array_elements(v_settings.multipliers) slot
   WHERE slot ->> 'type' = v_winner
   LIMIT 1;

  FOR v_bet IN
    SELECT id, user_id, amount
      FROM public.game_round_bets
     WHERE round_id = p_round_id AND position = v_winner
  LOOP
    v_payout := (v_bet.amount * COALESCE(v_multiplier, 1))::bigint;
    UPDATE public.profiles
       SET diamonds = diamonds + v_payout
     WHERE id = v_bet.user_id;
    UPDATE public.game_round_bets
       SET win_amount = v_payout
     WHERE id = v_bet.id;
    INSERT INTO public.transactions
      (user_id, type, currency, amount, related_entity_type, related_entity_id, status)
    VALUES
      (v_bet.user_id, 'game_win', 'diamond', v_payout, 'game_round', p_round_id, 'completed');
  END LOOP;

  SELECT COALESCE(SUM(win_amount), 0) INTO v_my_win
    FROM public.game_round_bets
   WHERE round_id = p_round_id AND user_id = me;
  SELECT diamonds INTO v_balance FROM public.profiles WHERE id = me;

  UPDATE public.game_rounds
     SET status = 'settled',
         winner_pos = v_winner,
         total_bet = (SELECT COALESCE(SUM(amount), 0) FROM public.game_round_bets WHERE round_id = p_round_id),
         result = jsonb_build_object('winner_pos', v_winner, 'multiplier', v_multiplier)
   WHERE id = p_round_id;

  RETURN json_build_object(
    'success', true,
    'round_id', p_round_id,
    'winner_pos', v_winner,
    'multiplier', v_multiplier,
    'my_win_amount', v_my_win,
    'balance', COALESCE(v_balance, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_royal_feast_round(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_royal_feast_round(uuid) TO authenticated;
