-- =====================================================================
-- 52_unlimited_round_bets.sql
-- =====================================================================
-- Lifts the "round-total" bet cap in place_game_bet.
--
-- The original (migration 51) version of place_game_bet treated
-- game_settings.max_bet as a CUMULATIVE ceiling for one user across a
-- whole round, so once a Teen Patti player crossed 100,000 diamonds of
-- bets in a round, every later chip got rejected — even if their
-- balance allowed it. The product call is: anyone can bet as much and
-- as many times as they want; only a per-tap ceiling stays useful.
--
-- This migration:
--   1. Rewrites place_game_bet so max_bet is interpreted as the
--      PER-BET ceiling (single tap). If max_bet is NULL the per-bet
--      check is skipped entirely. The cumulative round check is gone.
--   2. NULLs out max_bet on teen_patti so it has no ceiling at all,
--      matching the user's explicit intent. Fruit Roulette keeps its
--      existing max_bet untouched — admins can re-enable a per-tap
--      ceiling there from the admin panel whenever they want.
--
-- All other guards stay (min_bet floor, daily_loss_cap, balance check,
-- round state, FOR UPDATE lock).
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Drop the round-total ceiling for teen_patti so the new RPC has
--    nothing to enforce there.
-- ---------------------------------------------------------------------
UPDATE public.game_settings
   SET max_bet = NULL
 WHERE id = 'teen_patti';

-- ---------------------------------------------------------------------
-- 2. Rewritten place_game_bet
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.place_game_bet(
  p_round_id UUID,
  p_position TEXT,
  p_amount   BIGINT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me           uuid := auth.uid();
  v_round      public.game_rounds%ROWTYPE;
  v_settings   public.game_settings%ROWTYPE;
  v_balance    bigint;
  v_loss_today bigint;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'Amount must be positive');
  END IF;
  IF p_position IS NULL OR length(trim(p_position)) = 0 THEN
    RETURN json_build_object('success', false, 'message', 'Position required');
  END IF;

  SELECT * INTO v_round
    FROM public.game_rounds WHERE id = p_round_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'Round not found');
  END IF;
  IF v_round.status <> 'betting' THEN
    RETURN json_build_object('success', false, 'message', 'Betting window closed');
  END IF;
  IF v_round.ends_at <= NOW() THEN
    RETURN json_build_object('success', false, 'message', 'Round expired');
  END IF;

  SELECT * INTO v_settings FROM public.game_settings WHERE id = v_round.game_type;
  IF v_settings.is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Game disabled');
  END IF;

  -- Per-tap floor (sanity, prevents spam micro-bets).
  IF p_amount < COALESCE(v_settings.min_bet, 1) THEN
    RETURN json_build_object('success', false, 'message',
      'Minimum bet is ' || COALESCE(v_settings.min_bet, 1));
  END IF;

  -- Per-tap ceiling — applied to THIS single bet only. NULL on
  -- game_settings.max_bet means no ceiling at all.
  IF v_settings.max_bet IS NOT NULL AND p_amount > v_settings.max_bet THEN
    RETURN json_build_object('success', false, 'message',
      'Maximum single bet is ' || v_settings.max_bet);
  END IF;

  -- Daily loss cap (player protection).
  IF v_settings.daily_loss_cap IS NOT NULL THEN
    v_loss_today := public.user_24h_game_loss(me);
    IF v_loss_today + p_amount > v_settings.daily_loss_cap THEN
      RETURN json_build_object('success', false, 'message',
        'Daily loss cap reached. Come back tomorrow.');
    END IF;
  END IF;

  -- Balance check + atomic deduction.
  SELECT diamonds INTO v_balance FROM public.profiles WHERE id = me FOR UPDATE;
  IF v_balance IS NULL OR v_balance < p_amount THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient diamonds');
  END IF;

  UPDATE public.profiles SET diamonds = diamonds - p_amount WHERE id = me;

  INSERT INTO public.game_round_bets (round_id, user_id, position, amount)
    VALUES (p_round_id, me, p_position, p_amount);

  UPDATE public.game_rounds
     SET total_bet = COALESCE(total_bet, 0) + p_amount,
         bets      = jsonb_set(
                       COALESCE(bets, '{}'::jsonb),
                       ARRAY[p_position],
                       to_jsonb(COALESCE((bets ->> p_position)::bigint, 0) + p_amount)
                     )
   WHERE id = p_round_id;

  INSERT INTO public.transactions
    (user_id, type, currency, amount, related_entity_type, related_entity_id, status)
  VALUES (me, 'game_bet', 'diamond', -p_amount, 'game_round', p_round_id, 'completed');

  RETURN json_build_object(
    'success',  true,
    'round_id', p_round_id,
    'position', p_position
  );
END $$;

GRANT EXECUTE ON FUNCTION public.place_game_bet(uuid, text, bigint) TO authenticated;