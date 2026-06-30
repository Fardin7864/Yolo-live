-- =====================================================================
-- 62_uncap_game_bets.sql
-- =====================================================================
-- Product decision: no per-round cap and no daily-loss cap on Teen Patti
-- or Fruit Roulette. Whales want to bet 100k chips back-to-back and the
-- old "Round bet limit is 100000" error was killing the flow.
--
-- Two changes:
--
--   1. Replace place_game_bet so a NULL max_bet means "no cap" instead
--      of falling back to the old 100M sentinel via COALESCE. The
--      daily_loss_cap branch already respected NULL = no cap, so it
--      stays as-is.
--
--   2. NULL out max_bet AND daily_loss_cap on game_settings rows for
--      teen_patti and fruit_roulette so the new behaviour kicks in
--      immediately. (Other game ids — if any — left untouched.)
--
-- IMPORTANT what we KEEP:
--   - min_bet: still enforced. A 0 or negative bet is still nonsense.
--   - Insufficient-diamond check: still enforced. That's not a cap,
--     it's basic accounting — if the user's balance is below the bet,
--     we reject. Otherwise people could bet money they don't have.
--   - Atomic FOR UPDATE balance deduct: unchanged. Race-safe.
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Replace place_game_bet — NULL max_bet now means "uncapped"
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
  me                  uuid := auth.uid();
  v_round             public.game_rounds%ROWTYPE;
  v_settings          public.game_settings%ROWTYPE;
  v_balance           bigint;
  v_loss_today        bigint;
  v_user_round_total  bigint;
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

  -- Minimum bet still applies — guards against zero / dust bets.
  IF p_amount < COALESCE(v_settings.min_bet, 1) THEN
    RETURN json_build_object('success', false, 'message',
      'Minimum bet is ' || COALESCE(v_settings.min_bet, 1));
  END IF;

  -- Per-round cap: NULL = uncapped (new behaviour). Only enforce when
  -- the admin explicitly set a number on game_settings.max_bet.
  IF v_settings.max_bet IS NOT NULL THEN
    SELECT COALESCE(SUM(amount), 0) INTO v_user_round_total
      FROM public.game_round_bets
      WHERE round_id = p_round_id AND user_id = me;
    IF (v_user_round_total + p_amount) > v_settings.max_bet THEN
      RETURN json_build_object('success', false, 'message',
        'Round bet limit is ' || v_settings.max_bet);
    END IF;
  END IF;

  -- Daily loss cap: same pattern — only enforce when admin set a value.
  IF v_settings.daily_loss_cap IS NOT NULL THEN
    v_loss_today := public.user_24h_game_loss(me);
    IF v_loss_today + p_amount > v_settings.daily_loss_cap THEN
      RETURN json_build_object('success', false, 'message',
        'Daily loss cap reached. Come back tomorrow.');
    END IF;
  END IF;

  -- Balance check + atomic deduction. Insufficient diamonds is NOT a
  -- cap — we can't let users bet money they don't have. So this stays
  -- enforced regardless of admin settings.
  SELECT diamonds INTO v_balance FROM public.profiles WHERE id = me FOR UPDATE;
  IF v_balance IS NULL OR v_balance < p_amount THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient diamonds');
  END IF;

  UPDATE public.profiles SET diamonds = diamonds - p_amount WHERE id = me;

  INSERT INTO public.game_round_bets (round_id, user_id, position, amount)
    VALUES (p_round_id, me, p_position, p_amount);

  -- Keep the round's running total + per-position aggregate in sync.
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
    'success', true,
    'round_id', p_round_id,
    'position', p_position,
    'my_round_total', COALESCE(v_user_round_total, 0) + p_amount
  );
END $$;

GRANT EXECUTE ON FUNCTION public.place_game_bet(uuid, text, bigint) TO authenticated;

-- ---------------------------------------------------------------------
-- 2. Clear the existing caps on the two games. NULL = uncapped, the
--    new RPC respects it.
-- ---------------------------------------------------------------------
UPDATE public.game_settings
   SET max_bet        = NULL,
       daily_loss_cap = NULL
 WHERE id IN ('teen_patti', 'fruit_roulette');
