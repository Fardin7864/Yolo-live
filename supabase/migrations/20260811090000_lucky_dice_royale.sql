-- Lucky Dice Royale: authoritative global rounds, atomic queued bets and payouts.

INSERT INTO public.game_settings (
  id, is_active, win_chance_percent, min_bet, max_bet, daily_loss_cap,
  multipliers, round_duration_s, result_display_s, house_profile_id,
  forced_next_result, special_result_rules
)
VALUES (
  'lucky_dice', true, 100, 1000, NULL, NULL,
  '[
    {"id":"small","label":"SMALL 4-10","m":2},
    {"id":"big","label":"BIG 11-17","m":2},
    {"id":"odd","label":"ODD","m":2},
    {"id":"even","label":"EVEN","m":2},
    {"id":"any_triple","label":"ANY TRIPLE","m":31},
    {"id":"total_6","label":"TOTAL 6","m":15},
    {"id":"total_9","label":"TOTAL 9","m":7},
    {"id":"total_12","label":"TOTAL 12","m":7},
    {"id":"total_15","label":"TOTAL 15","m":15}
  ]'::jsonb,
  25, 5,
  COALESCE(
    (SELECT house_profile_id FROM public.game_settings WHERE id = 'greedy_lion'),
    (SELECT house_profile_id FROM public.game_settings WHERE id = 'tin_patti_pro')
  ),
  NULL,
  '{"bet_acceptance_grace_s":3,"dice_animation_s":3}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  is_active = true,
  multipliers = EXCLUDED.multipliers,
  round_duration_s = 25,
  result_display_s = 5,
  min_bet = 1000,
  house_profile_id = COALESCE(public.game_settings.house_profile_id, EXCLUDED.house_profile_id),
  special_result_rules = EXCLUDED.special_result_rules,
  updated_at = NOW();

CREATE OR REPLACE FUNCTION public.lucky_dice_global_room_id()
RETURNS UUID LANGUAGE sql IMMUTABLE AS $$
  SELECT '00000000-0000-0000-0000-000000000003'::uuid;
$$;

CREATE OR REPLACE FUNCTION public.lucky_dice_options()
RETURNS TABLE(id TEXT, label TEXT, multiplier NUMERIC, sort_order INT)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT item->>'id', COALESCE(item->>'label', item->>'id'),
         COALESCE((item->>'m')::numeric, 0), ordinality::int
    FROM public.game_settings settings,
         jsonb_array_elements(COALESCE(settings.multipliers, '[]'::jsonb)) WITH ORDINALITY AS rows(item, ordinality)
   WHERE settings.id = 'lucky_dice';
$$;

CREATE OR REPLACE FUNCTION public.lucky_dice_result_is_valid(p_position TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.lucky_dice_options() WHERE id = p_position);
$$;

CREATE OR REPLACE FUNCTION public.lucky_dice_bet_grace_seconds()
RETURNS INT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT GREATEST(0, LEAST(10, COALESCE(
    CASE WHEN special_result_rules->>'bet_acceptance_grace_s' ~ '^\d+$'
      THEN (special_result_rules->>'bet_acceptance_grace_s')::int END, 3
  ))) FROM public.game_settings WHERE id = 'lucky_dice';
$$;

CREATE OR REPLACE FUNCTION public.lucky_dice_winning_options(p_d1 INT, p_d2 INT, p_d3 INT)
RETURNS TEXT[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_total INT := p_d1 + p_d2 + p_d3;
  v_triple BOOLEAN := p_d1 = p_d2 AND p_d2 = p_d3;
  v_result TEXT[] := ARRAY[]::text[];
BEGIN
  IF NOT v_triple THEN
    v_result := v_result || ARRAY[CASE WHEN v_total BETWEEN 4 AND 10 THEN 'small' ELSE 'big' END];
    v_result := v_result || ARRAY[CASE WHEN v_total % 2 = 0 THEN 'even' ELSE 'odd' END];
  ELSE
    v_result := v_result || ARRAY['any_triple'];
  END IF;
  IF v_total IN (6, 9, 12, 15) THEN v_result := v_result || ARRAY['total_' || v_total::text]; END IF;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_lucky_dice_bet()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_game_type TEXT;
BEGIN
  SELECT game_type INTO v_game_type FROM public.game_rounds WHERE id = NEW.round_id;
  IF v_game_type = 'lucky_dice' AND public.lucky_dice_result_is_valid(NEW.position) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Invalid Lucky Dice position: %', NEW.position;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_lucky_dice_bet_trigger ON public.game_round_bets;
CREATE TRIGGER validate_lucky_dice_bet_trigger
BEFORE INSERT OR UPDATE OF position, round_id ON public.game_round_bets
FOR EACH ROW EXECUTE FUNCTION public.validate_lucky_dice_bet();

CREATE OR REPLACE FUNCTION public.resolve_lucky_dice_round(p_round_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me UUID := auth.uid();
  v_round public.game_rounds%ROWTYPE;
  v_settings public.game_settings%ROWTYPE;
  v_grace INT := public.lucky_dice_bet_grace_seconds();
  v_d1 INT; v_d2 INT; v_d3 INT; v_total INT;
  v_winners TEXT[];
  v_payout BIGINT := 0;
  v_my_payout BIGINT := 0;
  v_top_winners JSONB := '[]'::jsonb;
  v_settled_at TIMESTAMPTZ := NOW();
  v_bet RECORD;
  v_multiplier NUMERIC;
  v_win BIGINT;
BEGIN
  SELECT * INTO v_round FROM public.game_rounds WHERE id = p_round_id FOR UPDATE;
  IF NOT FOUND OR v_round.game_type <> 'lucky_dice' OR v_round.room_id <> public.lucky_dice_global_room_id() THEN
    RETURN json_build_object('success', false, 'message', 'Lucky Dice round not found');
  END IF;
  IF v_round.status = 'settled' THEN
    SELECT COALESCE(SUM(win_amount), 0) INTO v_my_payout FROM public.game_round_bets WHERE round_id = p_round_id AND user_id = me;
    RETURN json_build_object('success', true, 'round_id', p_round_id, 'already_settled', true,
      'winner_pos', v_round.winner_pos, 'result', v_round.result, 'my_win_amount', v_my_payout);
  END IF;
  IF v_round.ends_at + (v_grace || ' seconds')::interval > NOW() THEN
    RETURN json_build_object('success', false, 'message', 'Round has not ended yet');
  END IF;
  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'lucky_dice';
  IF v_settings.house_profile_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_settings.house_profile_id) THEN
    RETURN json_build_object('success', false, 'message', 'Payout owner account is not configured');
  END IF;

  -- Values exist only on the server until the settled row is committed.
  v_d1 := floor(random() * 6)::int + 1;
  v_d2 := floor(random() * 6)::int + 1;
  v_d3 := floor(random() * 6)::int + 1;
  v_total := v_d1 + v_d2 + v_d3;
  v_winners := public.lucky_dice_winning_options(v_d1, v_d2, v_d3);

  FOR v_bet IN
    SELECT b.id, b.user_id, b.position, b.amount
      FROM public.game_round_bets b
     WHERE b.round_id = p_round_id AND b.position = ANY(v_winners)
     FOR UPDATE
  LOOP
    SELECT multiplier INTO v_multiplier FROM public.lucky_dice_options() WHERE id = v_bet.position;
    v_win := floor(v_bet.amount * COALESCE(v_multiplier, 0))::bigint;
    UPDATE public.game_round_bets SET win_amount = v_win WHERE id = v_bet.id;
    UPDATE public.profiles SET diamonds = COALESCE(diamonds, 0) + v_win WHERE id = v_bet.user_id;
    UPDATE public.profiles SET diamonds = COALESCE(diamonds, 0) - v_win WHERE id = v_settings.house_profile_id;
    INSERT INTO public.transactions
      (user_id, related_user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
    VALUES
      (v_settings.house_profile_id, v_bet.user_id, 'game_owner_payout', 'diamond', -v_win, 'game_round', p_round_id, 'completed', 'Lucky Dice payout funded'),
      (v_bet.user_id, v_settings.house_profile_id, 'game_win', 'diamond', v_win, 'game_round', p_round_id, 'completed', 'Lucky Dice win');
  END LOOP;

  SELECT COALESCE(SUM(win_amount), 0) INTO v_payout FROM public.game_round_bets WHERE round_id = p_round_id;
  SELECT COALESCE(SUM(win_amount), 0) INTO v_my_payout FROM public.game_round_bets WHERE round_id = p_round_id AND user_id = me;
  SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY w.win_amount DESC), '[]'::jsonb) INTO v_top_winners
    FROM (
      SELECT b.user_id, COALESCE(p.full_name, 'Player') AS name, p.avatar_url, SUM(b.win_amount)::bigint AS win_amount
        FROM public.game_round_bets b LEFT JOIN public.profiles p ON p.id = b.user_id
       WHERE b.round_id = p_round_id AND b.win_amount > 0
       GROUP BY b.user_id, p.full_name, p.avatar_url ORDER BY SUM(b.win_amount) DESC LIMIT 10
    ) w;

  UPDATE public.game_rounds SET
    status = 'settled', winner_pos = v_winners[1],
    total_bet = (SELECT COALESCE(SUM(amount), 0) FROM public.game_round_bets WHERE round_id = p_round_id),
    win_amount = v_payout,
    result = jsonb_build_object('dice', jsonb_build_array(v_d1, v_d2, v_d3), 'total', v_total,
      'winner_pos', v_winners[1], 'winning_option_ids', to_jsonb(v_winners), 'settled_at', v_settled_at,
      'top_winners', v_top_winners)
  WHERE id = p_round_id;

  RETURN json_build_object('success', true, 'round_id', p_round_id, 'dice', ARRAY[v_d1,v_d2,v_d3],
    'total', v_total, 'winning_option_ids', v_winners, 'my_win_amount', v_my_payout, 'settled_at', v_settled_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.lucky_dice_tick()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_settings public.game_settings%ROWTYPE;
  v_round public.game_rounds%ROWTYPE;
  v_active public.game_rounds%ROWTYPE;
  v_grace INT; v_duration INT; v_display INT;
  v_resolved JSON; v_created UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(1729, 3);
  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'lucky_dice';
  IF NOT FOUND OR v_settings.is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Lucky Dice is offline', 'server_now', NOW());
  END IF;
  v_duration := GREATEST(10, LEAST(120, COALESCE(v_settings.round_duration_s, 25)));
  v_display := GREATEST(3, LEAST(30, COALESCE(v_settings.result_display_s, 5)));
  v_grace := public.lucky_dice_bet_grace_seconds();

  FOR v_round IN
    SELECT * FROM public.game_rounds
     WHERE room_id = public.lucky_dice_global_room_id() AND game_type = 'lucky_dice'
       AND status IN ('betting','resolving') AND ends_at + (v_grace || ' seconds')::interval <= NOW()
     ORDER BY started_at FOR UPDATE SKIP LOCKED
  LOOP
    v_resolved := public.resolve_lucky_dice_round(v_round.id);
  END LOOP;

  SELECT * INTO v_active FROM public.game_rounds
   WHERE room_id = public.lucky_dice_global_room_id() AND game_type = 'lucky_dice'
     AND ((status = 'betting' AND ends_at + (v_grace || ' seconds')::interval > NOW())
       OR (status = 'settled' AND COALESCE((result->>'settled_at')::timestamptz, ends_at) + (v_display || ' seconds')::interval > NOW()))
   ORDER BY CASE WHEN status = 'settled' THEN 0 ELSE 1 END, started_at DESC LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO public.game_rounds (game_type, room_id, status, started_at, ends_at, bets, result, total_bet, win_amount)
    VALUES ('lucky_dice', public.lucky_dice_global_room_id(), 'betting', NOW(), NOW() + (v_duration || ' seconds')::interval,
      '{}'::jsonb, '{}'::jsonb, 0, 0) RETURNING id INTO v_created;
  END IF;
  RETURN json_build_object('success', true, 'created_round_id', v_created, 'last_resolve', v_resolved, 'server_now', NOW());
END;
$$;

CREATE OR REPLACE FUNCTION public.get_lucky_dice_state()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me UUID := auth.uid();
  v_settings public.game_settings%ROWTYPE;
  v_round public.game_rounds%ROWTYPE;
  v_grace INT; v_display INT;
  v_bets JSONB := '[]'::jsonb; v_my_bets JSONB := '[]'::jsonb;
  v_totals JSONB := '{}'::jsonb; v_history JSONB := '[]'::jsonb;
  v_balance BIGINT;
BEGIN
  PERFORM public.lucky_dice_tick();
  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'lucky_dice';
  v_grace := public.lucky_dice_bet_grace_seconds();
  v_display := GREATEST(3, LEAST(30, COALESCE(v_settings.result_display_s, 5)));
  SELECT * INTO v_round FROM public.game_rounds
   WHERE room_id = public.lucky_dice_global_room_id() AND game_type = 'lucky_dice'
     AND ((status = 'betting' AND ends_at + (v_grace || ' seconds')::interval > NOW())
       OR (status = 'settled' AND COALESCE((result->>'settled_at')::timestamptz, ends_at) + (v_display || ' seconds')::interval > NOW()))
   ORDER BY CASE WHEN status = 'settled' THEN 0 ELSE 1 END, started_at DESC LIMIT 1;
  IF FOUND THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(rows) ORDER BY created_at DESC), '[]'::jsonb) INTO v_bets FROM (
      SELECT b.id,b.round_id,b.user_id,COALESCE(p.full_name,'Player') name,p.avatar_url,b.position,b.amount,b.win_amount,b.created_at
      FROM public.game_round_bets b LEFT JOIN public.profiles p ON p.id=b.user_id WHERE b.round_id=v_round.id ORDER BY b.created_at DESC LIMIT 100
    ) rows;
    SELECT COALESCE(jsonb_object_agg(position, amount), '{}'::jsonb) INTO v_totals FROM (
      SELECT position,SUM(amount)::bigint amount FROM public.game_round_bets WHERE round_id=v_round.id GROUP BY position
    ) totals;
    IF me IS NOT NULL THEN
      SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY created_at), '[]'::jsonb) INTO v_my_bets
      FROM public.game_round_bets b WHERE round_id=v_round.id AND user_id=me;
    END IF;
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(history) ORDER BY settled_at DESC), '[]'::jsonb) INTO v_history FROM (
    SELECT id,winner_pos,result,total_bet,win_amount,COALESCE((result->>'settled_at')::timestamptz,ends_at,started_at) settled_at
    FROM public.game_rounds WHERE room_id=public.lucky_dice_global_room_id() AND game_type='lucky_dice' AND status='settled'
    ORDER BY COALESCE(ends_at,started_at,created_at) DESC LIMIT 20
  ) history;
  IF me IS NOT NULL THEN SELECT diamonds INTO v_balance FROM public.profiles WHERE id=me; END IF;
  RETURN json_build_object('success',true,'server_now',NOW(),'settings',to_jsonb(v_settings),
    'round',CASE WHEN v_round.id IS NULL THEN NULL ELSE to_jsonb(v_round) END,'bets',v_bets,'public_bets',v_bets,
    'my_bets',v_my_bets,'bet_totals',v_totals,'history',v_history,'my_balance',v_balance);
END;
$$;

CREATE OR REPLACE FUNCTION public.place_lucky_dice_bet(p_round_id UUID, p_position TEXT, p_amount BIGINT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN json_build_object('success', false, 'message', 'Use the atomic Lucky Dice bet batch');
END;
$$;

CREATE OR REPLACE FUNCTION public.place_lucky_dice_bet_batch(p_round_id UUID, p_client_batch_id TEXT, p_bets JSONB)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me UUID := auth.uid();
  v_round public.game_rounds%ROWTYPE; v_settings public.game_settings%ROWTYPE;
  v_batch public.game_bet_batches%ROWTYPE;
  v_total BIGINT := 0; v_existing BIGINT := 0; v_balance BIGINT; v_grace INT;
  v_item RECORD; v_chip BIGINT; v_remaining BIGINT; v_bet_id UUID;
  v_normalized JSONB := '[]'::jsonb; v_inserted JSONB := '[]'::jsonb; v_response JSONB; v_round_bets JSONB;
BEGIN
  IF me IS NULL THEN RETURN json_build_object('success',false,'message','Not authenticated'); END IF;
  IF p_round_id IS NULL OR p_client_batch_id IS NULL OR length(trim(p_client_batch_id)) NOT BETWEEN 8 AND 160
     OR jsonb_typeof(p_bets) <> 'array' OR jsonb_array_length(p_bets) NOT BETWEEN 1 AND 9 THEN
    RETURN json_build_object('success',false,'message','Invalid bet batch');
  END IF;
  SELECT * INTO v_batch FROM public.game_bet_batches WHERE game_type='lucky_dice' AND round_id=p_round_id AND user_id=me AND client_batch_id=p_client_batch_id;
  IF FOUND AND v_batch.response IS NOT NULL THEN RETURN v_batch.response::json; END IF;
  v_grace := public.lucky_dice_bet_grace_seconds();
  SELECT * INTO v_round FROM public.game_rounds WHERE id=p_round_id;
  IF NOT FOUND OR v_round.game_type<>'lucky_dice' OR v_round.room_id<>public.lucky_dice_global_room_id()
     OR v_round.status<>'betting' OR v_round.ends_at+(v_grace||' seconds')::interval<=NOW() THEN
    RETURN json_build_object('success',false,'message','Betting window closed');
  END IF;
  SELECT * INTO v_settings FROM public.game_settings WHERE id='lucky_dice';
  IF v_settings.is_active IS DISTINCT FROM TRUE OR v_settings.house_profile_id IS NULL
     OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=v_settings.house_profile_id) THEN
    RETURN json_build_object('success',false,'message','Payout owner account is not configured');
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_to_recordset(p_bets) x(position TEXT,amount NUMERIC)
    WHERE amount IS NULL OR amount<>trunc(amount) OR amount>9223372036854775807::numeric) THEN
    RETURN json_build_object('success',false,'message','Invalid bet amount');
  END IF;
  FOR v_item IN SELECT trim(position) position,SUM(amount)::bigint amount FROM jsonb_to_recordset(p_bets) x(position TEXT,amount NUMERIC) GROUP BY trim(position)
  LOOP
    IF v_item.amount<=0 OR v_item.amount<COALESCE(v_settings.min_bet,1000) OR v_item.amount%1000<>0
       OR public.lucky_dice_result_is_valid(v_item.position) IS DISTINCT FROM TRUE THEN
      RETURN json_build_object('success',false,'message','Invalid option or chip amount');
    END IF;
    v_total:=v_total+v_item.amount;
    v_normalized:=v_normalized||jsonb_build_array(jsonb_build_object('position',v_item.position,'amount',v_item.amount));
  END LOOP;
  SELECT COALESCE(SUM(amount),0) INTO v_existing FROM public.game_round_bets WHERE round_id=p_round_id AND user_id=me;
  IF v_settings.max_bet IS NOT NULL AND v_existing+v_total>v_settings.max_bet THEN RETURN json_build_object('success',false,'message','Round bet limit exceeded'); END IF;
  SELECT * INTO v_round FROM public.game_rounds WHERE id=p_round_id FOR UPDATE;
  IF v_round.status<>'betting' OR v_round.ends_at+(v_grace||' seconds')::interval<=NOW() THEN RETURN json_build_object('success',false,'message','Betting window closed'); END IF;
  SELECT diamonds INTO v_balance FROM public.profiles WHERE id=me FOR UPDATE;
  IF v_balance IS NULL OR v_balance<v_total THEN RETURN json_build_object('success',false,'message','Insufficient diamonds'); END IF;
  INSERT INTO public.game_bet_batches(game_type,round_id,user_id,client_batch_id,total_amount,bets)
  VALUES('lucky_dice',p_round_id,me,p_client_batch_id,v_total,v_normalized) ON CONFLICT DO NOTHING RETURNING * INTO v_batch;
  IF NOT FOUND THEN
    SELECT * INTO v_batch FROM public.game_bet_batches WHERE game_type='lucky_dice' AND round_id=p_round_id AND user_id=me AND client_batch_id=p_client_batch_id;
    IF v_batch.response IS NOT NULL THEN RETURN v_batch.response::json; END IF;
    RETURN json_build_object('success',false,'message','Bet batch is already processing');
  END IF;
  UPDATE public.profiles SET diamonds=diamonds-v_total WHERE id=me RETURNING diamonds INTO v_balance;
  v_round_bets:=COALESCE(v_round.bets,'{}'::jsonb);
  FOR v_item IN SELECT item->>'position' position,(item->>'amount')::bigint amount FROM jsonb_array_elements(v_normalized) item LOOP
    v_remaining:=v_item.amount;
    FOREACH v_chip IN ARRAY ARRAY[100000,50000,5000,1000]::bigint[] LOOP
      WHILE v_remaining>=v_chip LOOP
        INSERT INTO public.game_round_bets(round_id,user_id,position,amount) VALUES(p_round_id,me,v_item.position,v_chip) RETURNING id INTO v_bet_id;
        v_inserted:=v_inserted||jsonb_build_array(jsonb_build_object('betId',v_bet_id,'position',v_item.position,'amount',v_chip));
        v_remaining:=v_remaining-v_chip;
      END LOOP;
    END LOOP;
    v_round_bets:=jsonb_set(v_round_bets,ARRAY[v_item.position],to_jsonb(COALESCE((v_round_bets->>v_item.position)::bigint,0)+v_item.amount),true);
  END LOOP;
  UPDATE public.game_rounds SET total_bet=COALESCE(total_bet,0)+v_total,bets=v_round_bets WHERE id=p_round_id;
  INSERT INTO public.transactions(user_id,related_user_id,type,currency,amount,balance_after,related_entity_type,related_entity_id,status,notes)
  VALUES(me,v_settings.house_profile_id,'game_bet','diamond',-v_total,v_balance,'game_round',p_round_id,'completed','Lucky Dice atomic bet batch');
  v_response:=jsonb_build_object('success',true,'round_id',p_round_id,'client_batch_id',p_client_batch_id,'total_amount',v_total,'balance',v_balance,'bets',v_inserted);
  UPDATE public.game_bet_batches SET response=v_response WHERE id=v_batch.id;
  RETURN v_response::json;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_daily_game_ranking(p_game_type TEXT, p_limit INT DEFAULT 20)
RETURNS TABLE(user_id UUID,name TEXT,avatar_url TEXT,total_bet BIGINT,total_win BIGINT,score BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT b.user_id,COALESCE(NULLIF(BTRIM(p.full_name),''),'Player'),p.avatar_url,SUM(b.amount)::bigint,SUM(b.win_amount)::bigint,
    (SUM(b.amount)+SUM(b.win_amount))::bigint
  FROM public.game_round_bets b JOIN public.game_rounds r ON r.id=b.round_id LEFT JOIN public.profiles p ON p.id=b.user_id
  WHERE p_game_type IN('greedy_lion','tin_patti_pro','lucky_dice') AND r.game_type=p_game_type
    AND b.created_at >= (date_trunc('day',NOW() AT TIME ZONE 'Asia/Dhaka') AT TIME ZONE 'Asia/Dhaka')
  GROUP BY b.user_id,p.full_name,p.avatar_url ORDER BY 6 DESC,5 DESC,4 DESC,b.user_id LIMIT GREATEST(1,LEAST(COALESCE(p_limit,20),100));
$$;

CREATE OR REPLACE FUNCTION public.tick_authoritative_mini_games()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(1729,20260809) THEN RETURN; END IF;
  BEGIN PERFORM public.greedy_lion_tick(); EXCEPTION WHEN OTHERS THEN RAISE WARNING 'Greedy Lion coordinator tick failed: %',SQLERRM; END;
  BEGIN PERFORM public.tin_patti_pro_tick(); EXCEPTION WHEN OTHERS THEN RAISE WARNING 'Teen Patti coordinator tick failed: %',SQLERRM; END;
  BEGIN PERFORM public.lucky_dice_tick(); EXCEPTION WHEN OTHERS THEN RAISE WARNING 'Lucky Dice coordinator tick failed: %',SQLERRM; END;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_lucky_dice_round(UUID) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.place_lucky_dice_bet_batch(UUID,TEXT,JSONB) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.lucky_dice_global_room_id() TO anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.lucky_dice_options() TO anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.lucky_dice_result_is_valid(TEXT) TO anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.lucky_dice_bet_grace_seconds() TO anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.lucky_dice_tick() TO anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_lucky_dice_state() TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.place_lucky_dice_bet(UUID,TEXT,BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.place_lucky_dice_bet_batch(UUID,TEXT,JSONB) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.resolve_lucky_dice_round(UUID) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_daily_game_ranking(TEXT,INT) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.tick_authoritative_mini_games() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tick_authoritative_mini_games() TO service_role;
