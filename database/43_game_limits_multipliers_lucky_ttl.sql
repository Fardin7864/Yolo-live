-- =====================================================================
-- 43_game_limits_multipliers_lucky_ttl.sql
-- =====================================================================
-- Pulls the last few hardcoded knobs out of the game RPCs and into the
-- admin-controllable tables, so super_admin can re-tune the economy
-- without code deploys.
--
-- WHAT MOVES OUT OF CODE:
--   1. Per-game min/max bet + daily loss cap → game_settings columns.
--   2. Per-game payout multipliers           → game_settings.multipliers JSONB.
--      teen_patti uses {"win": 2}; fruit_roulette uses the full slot
--      list it used to hard-code (a wheel of 8 slots).
--   3. Lucky bag TTL                         → system_settings entry
--      `lucky_bag_ttl_seconds` (default 60).
--
-- WHAT STILL EXISTS UNCHANGED:
--   * win_chance_percent and is_active on game_settings (already
--     admin-controlled in /games page).
--   * Atomic FOR UPDATE locking and existing payout math.
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. game_settings — new admin-tunable columns
-- ---------------------------------------------------------------------
ALTER TABLE public.game_settings ADD COLUMN IF NOT EXISTS min_bet         BIGINT DEFAULT 10;
ALTER TABLE public.game_settings ADD COLUMN IF NOT EXISTS max_bet         BIGINT DEFAULT 100000;
ALTER TABLE public.game_settings ADD COLUMN IF NOT EXISTS daily_loss_cap  BIGINT;  -- NULL = no cap
ALTER TABLE public.game_settings ADD COLUMN IF NOT EXISTS multipliers     JSONB;

-- Seed multipliers for the two existing games (no-op if already set).
UPDATE public.game_settings
   SET multipliers = '{"win": 2}'::jsonb
 WHERE id = 'teen_patti' AND (multipliers IS NULL OR multipliers = '{}'::jsonb);

UPDATE public.game_settings
   SET multipliers = '[
        {"id":0,"type":"apple","m":5},
        {"id":1,"type":"watermelon","m":10},
        {"id":2,"type":"apple","m":5},
        {"id":3,"type":"star","m":15},
        {"id":4,"type":"apple","m":5},
        {"id":5,"type":"watermelon","m":10},
        {"id":6,"type":"apple","m":5},
        {"id":7,"type":"crown","m":25}
      ]'::jsonb
 WHERE id = 'fruit_roulette' AND (multipliers IS NULL OR multipliers = '{}'::jsonb);

-- ---------------------------------------------------------------------
-- 2. Lucky bag TTL — pulled into system_settings
-- ---------------------------------------------------------------------
INSERT INTO public.system_settings (key, value)
VALUES ('lucky_bag_ttl_seconds', '60'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. Helper — fetch numeric scalar from system_settings.
--    Tolerates both `'60'::jsonb` (json scalar) and `'"60"'::jsonb`
--    (json string) so admin UI is free to store either.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_setting_int(p_key text, p_default int)
RETURNS int
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_raw text;
  v_int int;
BEGIN
  SELECT value #>> '{}' INTO v_raw FROM public.system_settings WHERE key = p_key;
  IF v_raw IS NULL THEN RETURN p_default; END IF;
  BEGIN
    v_int := v_raw::int;
    RETURN v_int;
  EXCEPTION WHEN OTHERS THEN
    RETURN p_default;
  END;
END $$;

-- ---------------------------------------------------------------------
-- 4. Helper — sum of net losses (bet - win) by a user across game_rounds
--    in the last 24 hours. Used by both game RPCs for the daily cap.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.user_24h_game_loss(p_user uuid)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(GREATEST(total_bet - COALESCE(win_amount, 0), 0)), 0)::bigint
    FROM public.game_rounds
    WHERE user_id = p_user
      AND created_at > NOW() - INTERVAL '24 hours';
$$;

-- ---------------------------------------------------------------------
-- 5. play_teen_patti — bet limits + DB multiplier
-- ---------------------------------------------------------------------
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
  v_settings     public.game_settings%ROWTYPE;
  v_should_win   BOOLEAN;
  v_winner_pos   TEXT;
  v_winner_bet   BIGINT := 0;
  v_win_amount   BIGINT := 0;
  v_round_id     UUID;
  v_covered      TEXT[] := ARRAY[]::TEXT[];
  v_uncovered    TEXT[] := ARRAY[]::TEXT[];
  v_multiplier   int;
  v_loss_today   bigint;
BEGIN
  v_total_bet := COALESCE(p_bet_a,0) + COALESCE(p_bet_b,0) + COALESCE(p_bet_c,0);
  IF v_total_bet <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'No bet placed');
  END IF;

  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'teen_patti';
  IF v_settings.is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Game disabled');
  END IF;

  -- Bet limit enforcement (admin-controlled).
  IF v_total_bet < COALESCE(v_settings.min_bet, 1) THEN
    RETURN json_build_object('success', false, 'message',
      'Minimum bet is ' || COALESCE(v_settings.min_bet, 1));
  END IF;
  IF v_total_bet > COALESCE(v_settings.max_bet, 100000000) THEN
    RETURN json_build_object('success', false, 'message',
      'Maximum bet is ' || COALESCE(v_settings.max_bet, 100000000));
  END IF;

  -- Daily loss cap (player protection).
  IF v_settings.daily_loss_cap IS NOT NULL THEN
    v_loss_today := public.user_24h_game_loss(p_user_id);
    IF v_loss_today + v_total_bet > v_settings.daily_loss_cap THEN
      RETURN json_build_object('success', false, 'message',
        'Daily loss cap reached. Come back tomorrow.');
    END IF;
  END IF;

  SELECT diamonds INTO v_balance FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF v_balance IS NULL OR v_balance < v_total_bet THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient diamonds');
  END IF;

  UPDATE public.profiles SET diamonds = diamonds - v_total_bet WHERE id = p_user_id;

  IF COALESCE(p_bet_a,0) > 0 THEN v_covered := array_append(v_covered, 'A');
                              ELSE v_uncovered := array_append(v_uncovered, 'A'); END IF;
  IF COALESCE(p_bet_b,0) > 0 THEN v_covered := array_append(v_covered, 'B');
                              ELSE v_uncovered := array_append(v_uncovered, 'B'); END IF;
  IF COALESCE(p_bet_c,0) > 0 THEN v_covered := array_append(v_covered, 'C');
                              ELSE v_uncovered := array_append(v_uncovered, 'C'); END IF;

  v_should_win := (random() * 100) < COALESCE(v_settings.win_chance_percent, 30);

  IF v_should_win THEN
    v_winner_pos := v_covered[1 + floor(random() * array_length(v_covered, 1))::INT];
  ELSE
    IF array_length(v_uncovered, 1) > 0 THEN
      v_winner_pos := v_uncovered[1 + floor(random() * array_length(v_uncovered, 1))::INT];
    ELSE
      v_winner_pos := v_covered[1 + floor(random() * array_length(v_covered, 1))::INT];
    END IF;
  END IF;

  v_winner_bet := CASE v_winner_pos
                    WHEN 'A' THEN COALESCE(p_bet_a, 0)
                    WHEN 'B' THEN COALESCE(p_bet_b, 0)
                    WHEN 'C' THEN COALESCE(p_bet_c, 0)
                  END;
  v_multiplier := COALESCE((v_settings.multipliers ->> 'win')::int, 2);
  IF v_winner_bet > 0 THEN
    v_win_amount := v_winner_bet * v_multiplier;
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
END $$;

-- ---------------------------------------------------------------------
-- 6. play_fruit_roulette — bet limits + DB-driven slot multipliers
-- ---------------------------------------------------------------------
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
  v_settings       public.game_settings%ROWTYPE;
  v_should_win     BOOLEAN;
  v_winning_slot   INT;
  v_winning_type   TEXT;
  v_multiplier     INT;
  v_user_bet       BIGINT;
  v_win_amount     BIGINT := 0;
  v_round_id       UUID;
  v_slots          JSONB;
  v_covered_types  TEXT[] := ARRAY[]::TEXT[];
  v_uncovered_types TEXT[] := ARRAY[]::TEXT[];
  v_target_slots   INT[]  := ARRAY[]::INT[];
  v_loss_today     bigint;
BEGIN
  v_total_bet := COALESCE(p_apple_bet,0) + COALESCE(p_watermelon_bet,0)
               + COALESCE(p_star_bet,0)  + COALESCE(p_crown_bet,0);
  IF v_total_bet <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'No bet placed');
  END IF;

  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'fruit_roulette';
  IF v_settings.is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Game disabled');
  END IF;

  IF v_total_bet < COALESCE(v_settings.min_bet, 1) THEN
    RETURN json_build_object('success', false, 'message',
      'Minimum bet is ' || COALESCE(v_settings.min_bet, 1));
  END IF;
  IF v_total_bet > COALESCE(v_settings.max_bet, 100000000) THEN
    RETURN json_build_object('success', false, 'message',
      'Maximum bet is ' || COALESCE(v_settings.max_bet, 100000000));
  END IF;
  IF v_settings.daily_loss_cap IS NOT NULL THEN
    v_loss_today := public.user_24h_game_loss(p_user_id);
    IF v_loss_today + v_total_bet > v_settings.daily_loss_cap THEN
      RETURN json_build_object('success', false, 'message',
        'Daily loss cap reached. Come back tomorrow.');
    END IF;
  END IF;

  v_slots := COALESCE(v_settings.multipliers, '[]'::jsonb);
  IF jsonb_array_length(v_slots) = 0 THEN
    RETURN json_build_object('success', false, 'message', 'Wheel config missing');
  END IF;

  SELECT diamonds INTO v_balance FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF v_balance IS NULL OR v_balance < v_total_bet THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient diamonds');
  END IF;

  UPDATE public.profiles SET diamonds = diamonds - v_total_bet WHERE id = p_user_id;

  -- Build covered / uncovered TYPE lists from the bets.
  IF COALESCE(p_apple_bet,0)      > 0 THEN v_covered_types := array_append(v_covered_types,'apple');
                                      ELSE v_uncovered_types := array_append(v_uncovered_types,'apple'); END IF;
  IF COALESCE(p_watermelon_bet,0) > 0 THEN v_covered_types := array_append(v_covered_types,'watermelon');
                                      ELSE v_uncovered_types := array_append(v_uncovered_types,'watermelon'); END IF;
  IF COALESCE(p_star_bet,0)       > 0 THEN v_covered_types := array_append(v_covered_types,'star');
                                      ELSE v_uncovered_types := array_append(v_uncovered_types,'star'); END IF;
  IF COALESCE(p_crown_bet,0)      > 0 THEN v_covered_types := array_append(v_covered_types,'crown');
                                      ELSE v_uncovered_types := array_append(v_uncovered_types,'crown'); END IF;

  v_should_win := (random() * 100) < COALESCE(v_settings.win_chance_percent, 20);

  -- Pick a candidate TYPE from covered (win) or uncovered (loss),
  -- then choose one of its slots randomly.
  IF v_should_win THEN
    v_winning_type := v_covered_types[1 + floor(random() * array_length(v_covered_types, 1))::INT];
  ELSE
    IF array_length(v_uncovered_types, 1) > 0 THEN
      v_winning_type := v_uncovered_types[1 + floor(random() * array_length(v_uncovered_types, 1))::INT];
    ELSE
      v_winning_type := v_covered_types[1 + floor(random() * array_length(v_covered_types, 1))::INT];
    END IF;
  END IF;

  -- Find slot ids of that type.
  SELECT array_agg((slot ->> 'id')::int) INTO v_target_slots
    FROM jsonb_array_elements(v_slots) slot
   WHERE slot ->> 'type' = v_winning_type;
  IF array_length(v_target_slots, 1) IS NULL OR array_length(v_target_slots, 1) = 0 THEN
    v_winning_slot := 0;
    v_multiplier   := 1;
  ELSE
    v_winning_slot := v_target_slots[1 + floor(random() * array_length(v_target_slots, 1))::INT];
    SELECT (slot ->> 'm')::int INTO v_multiplier
      FROM jsonb_array_elements(v_slots) slot
     WHERE (slot ->> 'id')::int = v_winning_slot;
    v_multiplier := COALESCE(v_multiplier, 1);
  END IF;

  v_user_bet := CASE v_winning_type
                  WHEN 'apple'      THEN COALESCE(p_apple_bet, 0)
                  WHEN 'watermelon' THEN COALESCE(p_watermelon_bet, 0)
                  WHEN 'star'       THEN COALESCE(p_star_bet, 0)
                  WHEN 'crown'      THEN COALESCE(p_crown_bet, 0)
                END;
  IF v_user_bet > 0 THEN
    v_win_amount := v_user_bet * v_multiplier;
    UPDATE public.profiles SET diamonds = diamonds + v_win_amount WHERE id = p_user_id;
  END IF;

  INSERT INTO public.game_rounds (game_type, user_id, bets, result, total_bet, win_amount)
  VALUES ('fruit_roulette', p_user_id,
          jsonb_build_object(
            'apple', p_apple_bet, 'watermelon', p_watermelon_bet,
            'star',  p_star_bet,  'crown',      p_crown_bet
          ),
          jsonb_build_object(
            'winning_slot', v_winning_slot,
            'winning_type', v_winning_type,
            'multiplier',   v_multiplier,
            'user_won',     v_win_amount > 0
          ),
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
    'winning_slot', v_winning_slot,
    'winning_type', v_winning_type,
    'multiplier',   v_multiplier,
    'win_amount',   v_win_amount
  );
END $$;

-- ---------------------------------------------------------------------
-- 7. create_lucky_bag — TTL now read from system_settings
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_lucky_bag(
  prize_diamonds bigint,
  winner_count   int
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
  per bigint;
  bag_id uuid;
  v_ttl int;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF prize_diamonds <= 0 THEN RAISE EXCEPTION 'Prize must be positive'; END IF;
  IF winner_count NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Winner count must be 1..100'; END IF;
  IF prize_diamonds < winner_count THEN RAISE EXCEPTION 'Prize too small to split'; END IF;

  per := prize_diamonds / winner_count;

  UPDATE public.profiles
     SET diamonds = diamonds - prize_diamonds
   WHERE id = me AND diamonds >= prize_diamonds;
  IF NOT FOUND THEN RAISE EXCEPTION 'Insufficient diamonds'; END IF;

  v_ttl := public.get_setting_int('lucky_bag_ttl_seconds', 60);

  INSERT INTO public.lucky_bags
    (host_id, room_host_id, prize_diamonds, winner_count, per_winner, expires_at)
  VALUES
    (me, me, prize_diamonds, winner_count, per, NOW() + (v_ttl || ' seconds')::interval)
  RETURNING id INTO bag_id;

  RETURN bag_id;
END $$;