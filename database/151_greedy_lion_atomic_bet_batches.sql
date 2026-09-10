-- One idempotent database transaction per player/round replaces one RPC and
-- one database row per tap. Phaser remains optimistic; this function remains
-- authoritative for limits, wallet deduction and accepted bet amounts.

CREATE TABLE IF NOT EXISTS public.game_bet_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_type TEXT NOT NULL,
  round_id UUID NOT NULL REFERENCES public.game_rounds(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  client_batch_id TEXT NOT NULL,
  total_amount BIGINT NOT NULL DEFAULT 0,
  bets JSONB NOT NULL DEFAULT '[]'::jsonb,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_type, round_id, user_id, client_batch_id)
);

ALTER TABLE public.game_bet_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.game_bet_batches FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.place_greedy_lion_bet_batch(
  p_round_id UUID,
  p_client_batch_id TEXT,
  p_bets JSONB
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me UUID := auth.uid();
  v_round public.game_rounds%ROWTYPE;
  v_settings public.game_settings%ROWTYPE;
  v_balance BIGINT;
  v_total BIGINT := 0;
  v_existing_total BIGINT := 0;
  v_loss_24h BIGINT := 0;
  v_unique_count INT := 0;
  v_grace INT;
  v_batch_row public.game_bet_batches%ROWTYPE;
  v_item RECORD;
  v_bet_id UUID;
  v_chip BIGINT;
  v_remaining BIGINT;
  v_inserted JSONB := '[]'::jsonb;
  v_normalized JSONB := '[]'::jsonb;
  v_round_bets JSONB;
  v_response JSONB;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF p_round_id IS NULL OR p_client_batch_id IS NULL OR length(trim(p_client_batch_id)) NOT BETWEEN 8 AND 160 THEN
    RETURN json_build_object('success', false, 'message', 'Invalid bet batch');
  END IF;
  IF jsonb_typeof(p_bets) <> 'array' OR jsonb_array_length(p_bets) NOT BETWEEN 1 AND 6 THEN
    RETURN json_build_object('success', false, 'message', 'Bet batch must contain 1 to 6 items');
  END IF;

  SELECT * INTO v_batch_row
    FROM public.game_bet_batches
   WHERE game_type = 'greedy_lion'
     AND round_id = p_round_id
     AND user_id = me
     AND client_batch_id = p_client_batch_id;
  IF FOUND AND v_batch_row.response IS NOT NULL THEN
    RETURN v_batch_row.response::json;
  END IF;

  v_grace := public.greedy_lion_bet_grace_seconds();
  SELECT * INTO v_round
    FROM public.game_rounds
   WHERE id = p_round_id;
  IF NOT FOUND OR v_round.game_type <> 'greedy_lion' OR v_round.room_id <> public.greedy_lion_global_room_id() THEN
    RETURN json_build_object('success', false, 'message', 'Greedy Lion round not found');
  END IF;
  IF v_round.status <> 'betting' OR v_round.ends_at + (v_grace || ' seconds')::interval <= NOW() THEN
    RETURN json_build_object('success', false, 'message', 'Betting window closed');
  END IF;

  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'greedy_lion';
  IF v_settings.is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Greedy Lion is offline');
  END IF;
  IF v_settings.house_profile_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_settings.house_profile_id) THEN
    RETURN json_build_object('success', false, 'message', 'Payout owner account is not configured');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_bets) AS invalid(position TEXT, amount NUMERIC)
     WHERE invalid.amount IS NULL
        OR invalid.amount <> trunc(invalid.amount)
        OR invalid.amount > 9223372036854775807::numeric
  ) THEN
    RETURN json_build_object('success', false, 'message', 'Bet batch contains an invalid amount');
  END IF;

  FOR v_item IN
    SELECT trim(x.position) AS position, SUM(x.amount)::bigint AS amount
      FROM jsonb_to_recordset(p_bets) AS x(position TEXT, amount NUMERIC)
     GROUP BY trim(x.position)
  LOOP
    IF v_item.position IS NULL OR v_item.position = ''
       OR v_item.amount IS NULL OR v_item.amount <= 0
       OR v_item.amount < COALESCE(v_settings.min_bet, 1)
       OR NOT EXISTS (
         SELECT 1 FROM public.greedy_lion_multiplier(v_item.position) gm
          WHERE gm.category IS NOT NULL AND gm.multiplier IS NOT NULL
       ) THEN
      RETURN json_build_object('success', false, 'message', 'Bet batch contains an invalid item or amount');
    END IF;
    v_total := v_total + v_item.amount;
    v_normalized := v_normalized || jsonb_build_array(jsonb_build_object(
      'position', v_item.position,
      'amount', v_item.amount
    ));
  END LOOP;

  IF jsonb_array_length(v_normalized) NOT BETWEEN 1 AND 6 OR v_total <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'Bet batch is empty');
  END IF;

  SELECT COUNT(DISTINCT position), COALESCE(SUM(amount), 0)
    INTO v_unique_count, v_existing_total
    FROM public.game_round_bets
   WHERE round_id = p_round_id AND user_id = me;
  SELECT COUNT(DISTINCT position)
    INTO v_unique_count
    FROM (
      SELECT position FROM public.game_round_bets WHERE round_id = p_round_id AND user_id = me
      UNION
      SELECT item->>'position' FROM jsonb_array_elements(v_normalized) item
    ) positions;
  IF v_unique_count > 6 THEN
    RETURN json_build_object('success', false, 'message', 'You can select up to 6 unique items per round');
  END IF;
  IF v_settings.max_bet IS NOT NULL AND v_existing_total + v_total > v_settings.max_bet THEN
    RETURN json_build_object('success', false, 'message', 'Round bet limit is ' || v_settings.max_bet);
  END IF;

  IF v_settings.daily_loss_cap IS NOT NULL THEN
    SELECT COALESCE(SUM(
      CASE WHEN type = 'game_bet' THEN -amount WHEN type = 'game_win' THEN -amount ELSE 0 END
    ), 0)
      INTO v_loss_24h
      FROM public.transactions
     WHERE user_id = me
       AND currency = 'diamond'
       AND related_entity_type = 'game_round'
       AND created_at >= NOW() - INTERVAL '24 hours';
    IF v_loss_24h + v_total > v_settings.daily_loss_cap THEN
      RETURN json_build_object('success', false, 'message', 'Daily loss cap reached');
    END IF;
  END IF;

  -- Take the global round lock only for the short write section. Validation
  -- and daily-limit reads above do not block other players flushing at once.
  SELECT * INTO v_round
    FROM public.game_rounds
   WHERE id = p_round_id
   FOR UPDATE;
  IF v_round.status <> 'betting' OR v_round.ends_at + (v_grace || ' seconds')::interval <= NOW() THEN
    RETURN json_build_object('success', false, 'message', 'Betting window closed');
  END IF;

  SELECT diamonds INTO v_balance FROM public.profiles WHERE id = me FOR UPDATE;
  IF v_balance IS NULL OR v_balance < v_total THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient diamonds');
  END IF;

  INSERT INTO public.game_bet_batches
    (game_type, round_id, user_id, client_batch_id, total_amount, bets)
  VALUES
    ('greedy_lion', p_round_id, me, p_client_batch_id, v_total, v_normalized)
  ON CONFLICT (game_type, round_id, user_id, client_batch_id) DO NOTHING
  RETURNING * INTO v_batch_row;
  IF NOT FOUND THEN
    SELECT * INTO v_batch_row
      FROM public.game_bet_batches
     WHERE game_type = 'greedy_lion'
       AND round_id = p_round_id
       AND user_id = me
       AND client_batch_id = p_client_batch_id;
    IF v_batch_row.response IS NOT NULL THEN
      RETURN v_batch_row.response::json;
    END IF;
    RETURN json_build_object('success', false, 'message', 'Bet batch is already processing');
  END IF;

  UPDATE public.profiles
     SET diamonds = diamonds - v_total
   WHERE id = me
   RETURNING diamonds INTO v_balance;

  v_round_bets := COALESCE(v_round.bets, '{}'::jsonb);
  FOR v_item IN
    SELECT item->>'position' AS position, (item->>'amount')::bigint AS amount
      FROM jsonb_array_elements(v_normalized) item
  LOOP
    -- Preserve the database's chip-denomination invariant. The bridge sends
    -- one total per item, but stored rows still represent valid physical chips.
    v_remaining := v_item.amount;
    FOREACH v_chip IN ARRAY ARRAY[100000, 50000, 5000, 1000]::bigint[]
    LOOP
      WHILE v_remaining >= v_chip LOOP
        INSERT INTO public.game_round_bets (round_id, user_id, position, amount)
        VALUES (p_round_id, me, v_item.position, v_chip)
        RETURNING id INTO v_bet_id;
        v_inserted := v_inserted || jsonb_build_array(jsonb_build_object(
          'betId', v_bet_id,
          'position', v_item.position,
          'amount', v_chip
        ));
        v_remaining := v_remaining - v_chip;
      END LOOP;
    END LOOP;
    IF v_remaining <> 0 THEN
      RAISE EXCEPTION 'Invalid chip aggregate'
        USING ERRCODE = '22023';
    END IF;
    v_round_bets := jsonb_set(
      v_round_bets,
      ARRAY[v_item.position],
      to_jsonb(COALESCE((v_round_bets ->> v_item.position)::bigint, 0) + v_item.amount),
      true
    );
  END LOOP;

  UPDATE public.game_rounds
     SET total_bet = COALESCE(total_bet, 0) + v_total,
         bets = v_round_bets
   WHERE id = p_round_id;

  INSERT INTO public.transactions
    (user_id, related_user_id, type, currency, amount, balance_after, related_entity_type, related_entity_id, status, notes)
  VALUES
    (me, v_settings.house_profile_id, 'game_bet', 'diamond', -v_total, v_balance, 'game_round', p_round_id, 'completed', 'Greedy Lion atomic bet batch');

  v_response := jsonb_build_object(
    'success', true,
    'round_id', p_round_id,
    'client_batch_id', p_client_batch_id,
    'total_amount', v_total,
    'balance', v_balance,
    'bets', v_inserted
  );
  UPDATE public.game_bet_batches SET response = v_response WHERE id = v_batch_row.id;
  RETURN v_response::json;
END;
$$;

REVOKE ALL ON FUNCTION public.place_greedy_lion_bet_batch(UUID, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_greedy_lion_bet_batch(UUID, TEXT, JSONB) TO authenticated, service_role;
