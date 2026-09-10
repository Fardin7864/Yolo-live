-- Fail deployment if Greedy King's active runtime ever points back to Popular
-- Greedy's shared storage.

DO $$
DECLARE
  tick_payload JSONB;
  state_payload JSONB;
  active_round_id UUID;
  function_definition TEXT;
  function_name TEXT;
BEGIN
  tick_payload := public.greedy_pro_tick()::JSONB;
  IF COALESCE((tick_payload->>'success')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Greedy King dedicated tick failed: %', tick_payload;
  END IF;

  state_payload := public.get_greedy_pro_state()::JSONB;
  IF COALESCE((state_payload->>'success')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Greedy King dedicated state failed: %', state_payload;
  END IF;

  active_round_id := NULLIF(state_payload->'round'->>'id', '')::UUID;
  IF active_round_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.greedy_pro_rounds WHERE id = active_round_id) THEN
    RAISE EXCEPTION 'Greedy King state did not return a dedicated-table round';
  END IF;
  IF EXISTS (SELECT 1 FROM public.game_rounds WHERE id = active_round_id) THEN
    RAISE EXCEPTION 'Greedy King round leaked into the shared Popular Greedy table';
  END IF;

  FOREACH function_name IN ARRAY ARRAY[
    'public.greedy_pro_tick()',
    'public.get_greedy_pro_state()',
    'public.place_greedy_pro_bet(uuid,text,bigint)',
    'public.place_greedy_pro_bet_batch(uuid,text,jsonb)'
  ] LOOP
    SELECT pg_get_functiondef(function_name::REGPROCEDURE) INTO function_definition;
    IF position('public.game_rounds' IN function_definition) > 0
       OR position('public.game_round_bets' IN function_definition) > 0
       OR position('public.game_bet_batches' IN function_definition) > 0 THEN
      RAISE EXCEPTION '% still references shared game storage', function_name;
    END IF;
  END LOOP;
END;
$$;

