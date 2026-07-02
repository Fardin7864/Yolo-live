-- =====================================================================
-- 107_greedy_lion_native.sql
-- Native Greedy Lion game backed by shared Supabase rounds.
-- =====================================================================

-- Greedy Lion pays from a configured house wallet. The house may go
-- negative so winning users are never blocked by a mid-round shortfall.
DO $$
BEGIN
  ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_beans_check;
END $$;

ALTER TABLE public.game_settings
  ADD COLUMN IF NOT EXISTS round_duration_s INT NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS house_profile_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS forced_next_category TEXT;

DO $$
BEGIN
  ALTER TABLE public.game_settings
    ADD CONSTRAINT game_settings_forced_next_category_check
    CHECK (forced_next_category IS NULL OR forced_next_category IN ('pizza', 'salad'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO public.game_settings (
  id,
  is_active,
  win_chance_percent,
  min_bet,
  max_bet,
  daily_loss_cap,
  multipliers,
  round_duration_s,
  house_profile_id,
  forced_next_category
)
VALUES (
  'greedy_lion',
  true,
  60,
  10,
  NULL,
  NULL,
  '[
    {"id":"corn","label":"Corn","category":"salad","m":5},
    {"id":"chicken","label":"Chicken","category":"pizza","m":45},
    {"id":"shrimp","label":"Shrimp","category":"pizza","m":25},
    {"id":"tomato","label":"Tomato","category":"salad","m":5},
    {"id":"ham","label":"Ham","category":"pizza","m":15},
    {"id":"pepper","label":"Pepper","category":"salad","m":5},
    {"id":"fish","label":"Fish","category":"pizza","m":10},
    {"id":"carrot","label":"Carrot","category":"salad","m":5}
  ]'::jsonb,
  15,
  NULL,
  NULL
)
ON CONFLICT (id) DO UPDATE SET
  multipliers = EXCLUDED.multipliers,
  round_duration_s = COALESCE(public.game_settings.round_duration_s, EXCLUDED.round_duration_s),
  min_bet = COALESCE(public.game_settings.min_bet, EXCLUDED.min_bet);

CREATE OR REPLACE FUNCTION public.greedy_lion_multiplier(p_position TEXT)
RETURNS TABLE(category TEXT, multiplier NUMERIC)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_settings public.game_settings%ROWTYPE;
  v_item jsonb;
BEGIN
  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'greedy_lion';

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(v_settings.multipliers, '[]'::jsonb))
  LOOP
    IF v_item ->> 'id' = p_position THEN
      category := v_item ->> 'category';
      multiplier := COALESCE((v_item ->> 'm')::numeric, 0);
      RETURN;
    END IF;
  END LOOP;

  category := NULL;
  multiplier := NULL;
END $$;

CREATE OR REPLACE FUNCTION public.validate_greedy_lion_bet()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_game_type TEXT;
  v_category TEXT;
  v_multiplier NUMERIC;
BEGIN
  SELECT game_type INTO v_game_type FROM public.game_rounds WHERE id = NEW.round_id;

  IF v_game_type = 'greedy_lion' THEN
    SELECT category, multiplier
      INTO v_category, v_multiplier
      FROM public.greedy_lion_multiplier(NEW.position);

    IF v_category IS NULL OR v_multiplier IS NULL THEN
      RAISE EXCEPTION 'Invalid Greedy Lion item: %', NEW.position;
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS validate_greedy_lion_bet_trigger ON public.game_round_bets;
CREATE TRIGGER validate_greedy_lion_bet_trigger
BEFORE INSERT OR UPDATE OF position, round_id ON public.game_round_bets
FOR EACH ROW EXECUTE FUNCTION public.validate_greedy_lion_bet();

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
  v_house_balance BIGINT;
  v_unique_count INT;
  v_has_position BOOLEAN;
  v_user_round_total BIGINT;
  v_loss_24h BIGINT;
  v_bet_id UUID;
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

  SELECT * INTO v_round
    FROM public.game_rounds
    WHERE id = p_round_id
    FOR UPDATE;

  IF NOT FOUND OR v_round.game_type <> 'greedy_lion' THEN
    RETURN json_build_object('success', false, 'message', 'Greedy Lion round not found');
  END IF;
  IF v_round.status <> 'betting' OR v_round.ends_at <= NOW() THEN
    RETURN json_build_object('success', false, 'message', 'Betting window closed');
  END IF;

  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'greedy_lion';
  IF v_settings.is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Greedy Lion is offline');
  END IF;
  IF v_settings.house_profile_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'House wallet is not configured');
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
        WHEN amount < 0 THEN -amount
        WHEN type = 'game_win' THEN -amount
        ELSE 0
      END
    ), 0)
    INTO v_loss_24h
    FROM public.transactions
    WHERE user_id = me
      AND currency = 'bean'
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

  SELECT beans INTO v_balance FROM public.profiles WHERE id = me FOR UPDATE;
  IF v_balance IS NULL OR v_balance < p_amount THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient beans');
  END IF;

  SELECT beans INTO v_house_balance
    FROM public.profiles
    WHERE id = v_settings.house_profile_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'House wallet profile not found');
  END IF;

  UPDATE public.profiles
     SET beans = beans - p_amount
   WHERE id = me
   RETURNING beans INTO v_balance;

  UPDATE public.profiles
     SET beans = COALESCE(beans, 0) + p_amount
   WHERE id = v_settings.house_profile_id
   RETURNING beans INTO v_house_balance;

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
    (me, v_settings.house_profile_id, 'game_bet', 'bean', -p_amount, v_balance, 'game_round', p_round_id, 'completed', 'Greedy Lion bet'),
    (v_settings.house_profile_id, me, 'game_house_credit', 'bean', p_amount, v_house_balance, 'game_round', p_round_id, 'completed', 'Greedy Lion stake received');

  RETURN json_build_object(
    'success', true,
    'round_id', p_round_id,
    'bet_id', v_bet_id,
    'position', p_position,
    'balance', v_balance,
    'house_balance', v_house_balance
  );
END $$;

CREATE OR REPLACE FUNCTION public.resolve_greedy_lion_round(p_round_id UUID)
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
  v_forced BOOLEAN := false;
  v_pizza_liability NUMERIC := 0;
  v_salad_liability NUMERIC := 0;
  v_lower TEXT;
  v_higher TEXT;
  v_total_bet BIGINT := 0;
  v_payout BIGINT;
  v_my_win BIGINT := 0;
  v_my_bet BIGINT := 0;
  v_balance BIGINT;
  v_house_balance BIGINT;
  v_bet RECORD;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  SELECT * INTO v_round
    FROM public.game_rounds
    WHERE id = p_round_id
    FOR UPDATE;

  IF NOT FOUND OR v_round.game_type <> 'greedy_lion' THEN
    RETURN json_build_object('success', false, 'message', 'Greedy Lion round not found');
  END IF;

  IF v_round.status = 'settled' THEN
    SELECT COALESCE(SUM(win_amount), 0), COALESCE(SUM(amount), 0)
      INTO v_my_win, v_my_bet
      FROM public.game_round_bets
      WHERE round_id = p_round_id AND user_id = me;
    SELECT beans INTO v_balance FROM public.profiles WHERE id = me;
    RETURN json_build_object(
      'success', true,
      'already_settled', true,
      'round_id', p_round_id,
      'winner_pos', v_round.winner_pos,
      'category', v_round.winner_pos,
      'result', COALESCE(v_round.result, '{}'::jsonb),
      'my_win_amount', v_my_win,
      'my_bet_amount', v_my_bet,
      'balance', v_balance
    );
  END IF;

  IF v_round.ends_at > NOW() THEN
    RETURN json_build_object('success', false, 'message', 'Round has not ended yet');
  END IF;

  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'greedy_lion';
  IF v_settings.house_profile_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'House wallet is not configured');
  END IF;

  UPDATE public.game_rounds SET status = 'resolving' WHERE id = p_round_id;

  SELECT COALESCE(SUM(b.amount), 0) INTO v_total_bet
    FROM public.game_round_bets b
    WHERE b.round_id = p_round_id;

  SELECT
    COALESCE(SUM(CASE WHEN gm.category = 'pizza' THEN b.amount * gm.multiplier ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN gm.category = 'salad' THEN b.amount * gm.multiplier ELSE 0 END), 0)
  INTO v_pizza_liability, v_salad_liability
  FROM public.game_round_bets b
  CROSS JOIN LATERAL public.greedy_lion_multiplier(b.position) gm
  WHERE b.round_id = p_round_id;

  IF v_settings.forced_next_category IN ('pizza', 'salad') THEN
    v_category := v_settings.forced_next_category;
    v_forced := true;
    UPDATE public.game_settings
       SET forced_next_category = NULL
     WHERE id = 'greedy_lion';
  ELSIF v_pizza_liability = v_salad_liability OR v_total_bet = 0 THEN
    v_category := CASE WHEN random() < 0.5 THEN 'pizza' ELSE 'salad' END;
  ELSE
    v_lower := CASE WHEN v_pizza_liability < v_salad_liability THEN 'pizza' ELSE 'salad' END;
    v_higher := CASE WHEN v_lower = 'pizza' THEN 'salad' ELSE 'pizza' END;
    IF (random() * 100) < COALESCE(v_settings.win_chance_percent, 50) THEN
      v_category := v_lower;
    ELSE
      v_category := v_higher;
    END IF;
  END IF;

  FOR v_bet IN
    SELECT b.id, b.user_id, b.amount, b.position, gm.multiplier
      FROM public.game_round_bets b
      CROSS JOIN LATERAL public.greedy_lion_multiplier(b.position) gm
     WHERE b.round_id = p_round_id
       AND gm.category = v_category
  LOOP
    v_payout := FLOOR(v_bet.amount * v_bet.multiplier)::BIGINT;

    UPDATE public.game_round_bets
       SET win_amount = v_payout
     WHERE id = v_bet.id;

    UPDATE public.profiles
       SET beans = COALESCE(beans, 0) - v_payout
     WHERE id = v_settings.house_profile_id
     RETURNING beans INTO v_house_balance;

    UPDATE public.profiles
       SET beans = COALESCE(beans, 0) + v_payout
     WHERE id = v_bet.user_id
     RETURNING beans INTO v_balance;

    INSERT INTO public.transactions
      (user_id, related_user_id, type, currency, amount, balance_after, related_entity_type, related_entity_id, status, notes)
    VALUES
      (v_settings.house_profile_id, v_bet.user_id, 'game_house_payout', 'bean', -v_payout, v_house_balance, 'game_round', p_round_id, 'completed', 'Greedy Lion payout funded'),
      (v_bet.user_id, v_settings.house_profile_id, 'game_win', 'bean', v_payout, v_balance, 'game_round', p_round_id, 'completed', 'Greedy Lion win');
  END LOOP;

  UPDATE public.game_round_bets
     SET win_amount = 0
   WHERE round_id = p_round_id
     AND win_amount IS NULL;

  SELECT COALESCE(SUM(win_amount), 0), COALESCE(SUM(amount), 0)
    INTO v_my_win, v_my_bet
    FROM public.game_round_bets
    WHERE round_id = p_round_id AND user_id = me;
  SELECT beans INTO v_balance FROM public.profiles WHERE id = me;
  SELECT beans INTO v_house_balance FROM public.profiles WHERE id = v_settings.house_profile_id;

  UPDATE public.game_rounds
     SET status = 'settled',
         winner_pos = v_category,
         total_bet = v_total_bet,
         result = jsonb_build_object(
           'category', v_category,
           'pizza_liability', v_pizza_liability,
           'salad_liability', v_salad_liability,
           'forced', v_forced,
           'house_balance', v_house_balance
         )
   WHERE id = p_round_id;

  RETURN json_build_object(
    'success', true,
    'round_id', p_round_id,
    'winner_pos', v_category,
    'category', v_category,
    'my_win_amount', v_my_win,
    'my_bet_amount', v_my_bet,
    'balance', v_balance,
    'house_balance', v_house_balance,
    'result', json_build_object(
      'category', v_category,
      'pizza_liability', v_pizza_liability,
      'salad_liability', v_salad_liability,
      'forced', v_forced
    )
  );
END $$;

CREATE OR REPLACE FUNCTION public.get_greedy_lion_history(
  p_room_id UUID,
  p_limit INT DEFAULT 30
)
RETURNS TABLE (
  id UUID,
  winner_pos TEXT,
  result JSONB,
  settled_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT gr.id, gr.winner_pos, gr.result, COALESCE(gr.ends_at, gr.started_at, gr.created_at) AS settled_at
    FROM public.game_rounds gr
   WHERE gr.room_id = p_room_id
     AND gr.game_type = 'greedy_lion'
     AND gr.status = 'settled'
   ORDER BY COALESCE(gr.ends_at, gr.started_at, gr.created_at) DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 30);
$$;

GRANT EXECUTE ON FUNCTION public.greedy_lion_multiplier(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.place_greedy_lion_bet(UUID, TEXT, BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_greedy_lion_round(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_greedy_lion_history(UUID, INT) TO authenticated;
