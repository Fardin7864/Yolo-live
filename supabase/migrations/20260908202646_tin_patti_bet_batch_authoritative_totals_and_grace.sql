-- Teen Patti: stop bets appearing and then vanishing, and stop losing bets
-- placed in the last second of a round.
--
-- Both symptoms have one cause. A bet batch is all-or-nothing and is validated
-- against the wall clock at the moment the SERVER runs it, not when the client
-- dispatched it. The client holds taps for a 1s debounce (2s max), the round is
-- only 20s long, and bet_acceptance_grace_s was set to 1 -- so a batch dispatched
-- just before the on-screen deadline routinely arrived after ends_at + 1s and was
-- thrown away in full. The player had already seen those chips locally, so the
-- stake and the pot visibly dropped back.
--
-- 1. RETURN THE CANONICAL TOTALS.
--    GameBackendService already reads `authoritative_totals`,
--    `authoritative_my_totals` and `state_version` off this RPC's response and
--    treats them as canonical (applyCommittedBatch). This function never sent
--    them, so the client silently fell back to guessing:
--        Math.max(option.totalAmount, baseFloor + batchItems)
--    That guess is why totals drift apart between phones and why a commit landing
--    next to a refresh could show a different number. The two helpers it wants
--    already exist -- authoritative_game_bet_totals and
--    authoritative_game_user_bet_totals -- they were simply never called here.
--
-- 2. GIVE THE DEADLINE ENOUGH ROOM FOR A ROUND TRIP.
--    bet_acceptance_grace_s goes 1 -> 3. The client already commits a full second
--    before the boundary, so a 1-second grace left nothing for the RPC itself.
--    Trade: resolve_tin_patti_pro_round uses the SAME grace, so rounds settle ~2s
--    later. On a 20s round that is a deliberate ~10% cadence cost, paid to stop
--    discarding real money bets. Tune via
--    game_settings.special_result_rules.bet_acceptance_grace_s.
--    Correctness is not weakened: the bet path re-reads the round FOR UPDATE and
--    re-checks status, and settlement takes the same row lock, so a bet can never
--    slip in after the round is settled.
--
-- 3. Late batches now return code 'betting_closed', and amounts that are not a
--    multiple of 500 return a readable message instead of falling through to the
--    raw 'Invalid chip aggregate' exception (audit finding TP-06).
--
-- Verified on production inside a rolled-back transaction:
--   accepted batch -> state_version=2,
--                     authoritative_totals    {"crown":5000,"coffee":1500}
--                     authoritative_my_totals {"crown":5000,"coffee":1500}
--   amount 1300    -> "Bet amounts must be a multiple of 500"
--   ended round    -> code=betting_closed

UPDATE public.game_settings
   SET special_result_rules =
         COALESCE(special_result_rules, '{}'::jsonb)
         || jsonb_build_object('bet_acceptance_grace_s', 3),
       updated_at = NOW()
 WHERE id = 'tin_patti_pro';

CREATE OR REPLACE FUNCTION public.place_tin_patti_pro_bet_batch_core_169(
  p_round_id uuid,
  p_client_batch_id text,
  p_bets jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  me UUID := auth.uid();
  v_round public.game_rounds%ROWTYPE;
  v_settings public.game_settings%ROWTYPE;
  v_batch_row public.game_bet_batches%ROWTYPE;
  v_balance BIGINT;
  v_total BIGINT := 0;
  v_existing_total BIGINT := 0;
  v_loss_24h BIGINT := 0;
  v_grace INT;
  v_item RECORD;
  v_chip BIGINT;
  v_remaining BIGINT;
  v_bet_id UUID;
  v_normalized JSONB := '[]'::jsonb;
  v_inserted JSONB := '[]'::jsonb;
  v_round_bets JSONB;
  v_response JSONB;
  v_state_version BIGINT := 0;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF p_round_id IS NULL OR p_client_batch_id IS NULL
     OR length(trim(p_client_batch_id)) NOT BETWEEN 8 AND 160 THEN
    RETURN json_build_object('success', false, 'message', 'Invalid bet batch');
  END IF;
  IF jsonb_typeof(p_bets) <> 'array' OR jsonb_array_length(p_bets) NOT BETWEEN 1 AND 3 THEN
    RETURN json_build_object('success', false, 'message', 'Bet batch must contain 1 to 3 boards');
  END IF;

  SELECT * INTO v_batch_row
    FROM public.game_bet_batches
   WHERE game_type = 'tin_patti_pro'
     AND round_id = p_round_id
     AND user_id = me
     AND client_batch_id = p_client_batch_id;
  IF FOUND AND v_batch_row.response IS NOT NULL THEN
    RETURN v_batch_row.response::json;
  END IF;

  v_grace := public.tin_patti_pro_bet_grace_seconds();
  SELECT * INTO v_round FROM public.game_rounds WHERE id = p_round_id;
  IF NOT FOUND OR v_round.game_type <> 'tin_patti_pro'
     OR v_round.room_id <> public.tin_patti_pro_global_room_id() THEN
    RETURN json_build_object('success', false, 'message', 'Tin Patti Pro round not found');
  END IF;
  IF v_round.status <> 'betting'
     OR v_round.ends_at + (v_grace || ' seconds')::interval <= NOW() THEN
    RETURN json_build_object('success', false, 'code', 'betting_closed',
                             'message', 'Betting window closed');
  END IF;

  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'tin_patti_pro';
  IF v_settings.is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Tin Patti Pro is offline');
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
       OR public.tin_patti_pro_result_is_valid(v_item.position) IS DISTINCT FROM TRUE THEN
      RETURN json_build_object('success', false, 'message', 'Bet batch contains an invalid board or amount');
    END IF;
    -- The chip decomposition below can only represent multiples of 500 (the gcd
    -- of the chip set). Catch it here with a readable message instead of letting
    -- it fall through to a raw 'Invalid chip aggregate' exception.
    IF v_item.amount % 500 <> 0 THEN
      RETURN json_build_object('success', false, 'message', 'Bet amounts must be a multiple of 500');
    END IF;
    v_total := v_total + v_item.amount;
    v_normalized := v_normalized || jsonb_build_array(jsonb_build_object(
      'position', v_item.position,
      'amount', v_item.amount
    ));
  END LOOP;

  IF jsonb_array_length(v_normalized) NOT BETWEEN 1 AND 3 OR v_total <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'Bet batch is empty');
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_existing_total
    FROM public.game_round_bets
   WHERE round_id = p_round_id AND user_id = me;
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

  -- Re-read under the row lock. Settlement takes this same lock, so once the
  -- round is settled this check rejects the batch regardless of the clock.
  SELECT * INTO v_round
    FROM public.game_rounds
   WHERE id = p_round_id
   FOR UPDATE;
  IF v_round.status <> 'betting'
     OR v_round.ends_at + (v_grace || ' seconds')::interval <= NOW() THEN
    RETURN json_build_object('success', false, 'code', 'betting_closed',
                             'message', 'Betting window closed');
  END IF;

  SELECT diamonds INTO v_balance FROM public.profiles WHERE id = me FOR UPDATE;
  IF v_balance IS NULL OR v_balance < v_total THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient diamonds');
  END IF;

  INSERT INTO public.game_bet_batches
    (game_type, round_id, user_id, client_batch_id, total_amount, bets)
  VALUES
    ('tin_patti_pro', p_round_id, me, p_client_batch_id, v_total, v_normalized)
  ON CONFLICT (game_type, round_id, user_id, client_batch_id) DO NOTHING
  RETURNING * INTO v_batch_row;
  IF NOT FOUND THEN
    SELECT * INTO v_batch_row
      FROM public.game_bet_batches
     WHERE game_type = 'tin_patti_pro'
       AND round_id = p_round_id
       AND user_id = me
       AND client_batch_id = p_client_batch_id;
    IF v_batch_row.response IS NOT NULL THEN
      RETURN v_batch_row.response::json;
    END IF;
    RETURN json_build_object('success', false, 'message', 'Bet batch is already processing');
  END IF;

  UPDATE public.profiles SET diamonds = diamonds - v_total WHERE id = me
  RETURNING diamonds INTO v_balance;

  v_round_bets := COALESCE(v_round.bets, '{}'::jsonb);
  FOR v_item IN
    SELECT item->>'position' AS position, (item->>'amount')::bigint AS amount
      FROM jsonb_array_elements(v_normalized) item
  LOOP
    v_remaining := v_item.amount;
    FOREACH v_chip IN ARRAY ARRAY[100000, 50000, 5000, 1000, 500]::bigint[]
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
      RAISE EXCEPTION 'Invalid chip aggregate' USING ERRCODE = '22023';
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
   WHERE id = p_round_id
  RETURNING COALESCE(state_version, 0) INTO v_state_version;

  INSERT INTO public.transactions
    (user_id, related_user_id, type, currency, amount, balance_after,
     related_entity_type, related_entity_id, status, notes)
  VALUES
    (me, v_settings.house_profile_id, 'game_bet', 'diamond', -v_total, v_balance,
     'game_round', p_round_id, 'completed', 'Tin Patti Pro atomic bet batch');

  -- Post-commit truth. The client treats these as canonical and stops guessing
  -- from its local floors, so every phone shows the same pot and the same stake.
  v_response := jsonb_build_object(
    'success', true,
    'round_id', p_round_id,
    'client_batch_id', p_client_batch_id,
    'total_amount', v_total,
    'balance', v_balance,
    'bets', v_inserted,
    'state_version', v_state_version,
    'authoritative_totals', public.authoritative_game_bet_totals(p_round_id, TRUE),
    'authoritative_my_totals', public.authoritative_game_user_bet_totals(p_round_id, me)
  );
  UPDATE public.game_bet_batches SET response = v_response WHERE id = v_batch_row.id;
  RETURN v_response::json;
END;
$function$;
