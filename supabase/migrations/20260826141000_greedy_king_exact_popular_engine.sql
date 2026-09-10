-- Greedy King uses the working Popular Greedy engine without realtime,
-- durable-outbox, robot-state, or custom settlement wrappers. Only the game
-- identifier and isolated room UUID differ.

DO $$
DECLARE
  assignments TEXT;
BEGIN
  SELECT string_agg(format('%1$I = source.%1$I', attribute.attname), ', ' ORDER BY attribute.attnum)
    INTO assignments
    FROM pg_attribute attribute
   WHERE attribute.attrelid = 'public.game_settings'::regclass
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
     AND attribute.attname <> 'id';

  EXECUTE format(
    'UPDATE public.game_settings target SET %s FROM public.game_settings source WHERE target.id = %L AND source.id = %L',
    assignments,
    'greedy_pro',
    'greedy_lion'
  );
END;
$$;

DO $$
DECLARE
  source_function RECORD;
  cloned_definition TEXT;
BEGIN
  FOR source_function IN
    SELECT procedure.oid, procedure.proname
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = 'public'
       AND procedure.proname LIKE '%greedy\_lion%' ESCAPE '\'
     ORDER BY
       CASE procedure.proname
         WHEN 'greedy_lion_global_room_id' THEN 1
         WHEN 'greedy_lion_multiplier' THEN 2
         WHEN 'validate_greedy_lion_bet' THEN 2
         WHEN 'greedy_lion_bet_grace_seconds' THEN 3
         WHEN 'greedy_lion_post_betting_block_seconds' THEN 3
         WHEN 'greedy_lion_result_is_valid' THEN 4
         WHEN 'resolve_greedy_lion_round_without_grace_115' THEN 5
         WHEN 'resolve_greedy_lion_round' THEN 6
         WHEN 'greedy_lion_tick_unlocked_149' THEN 7
         WHEN 'greedy_lion_tick' THEN 8
         WHEN 'get_greedy_lion_history' THEN 9
         WHEN 'get_greedy_lion_state_filtered_152' THEN 10
         WHEN 'get_greedy_lion_state' THEN 11
         WHEN 'place_greedy_lion_bet' THEN 12
         WHEN 'place_greedy_lion_bet_batch' THEN 13
         ELSE 14
       END,
       procedure.proname,
       pg_get_function_identity_arguments(procedure.oid)
  LOOP
    cloned_definition := pg_get_functiondef(source_function.oid);
    cloned_definition := replace(cloned_definition, 'greedy_lion', 'greedy_pro');
    cloned_definition := replace(cloned_definition, 'Greedy Lion', 'Greedy King');
    cloned_definition := replace(
      cloned_definition,
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000004'
    );
    cloned_definition := replace(
      cloned_definition,
      'pg_advisory_xact_lock(1729, 1)',
      'pg_advisory_xact_lock(1729, 4)'
    );
    EXECUTE cloned_definition;
  END LOOP;
END;
$$;

-- Popular Greedy stores one database row per physical chip denomination.
CREATE OR REPLACE FUNCTION public.validate_game_chip_denomination()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  round_game_type TEXT;
BEGIN
  SELECT game_type INTO round_game_type
    FROM public.game_rounds
   WHERE id = NEW.round_id;

  IF round_game_type IN ('greedy_lion', 'greedy_pro')
     AND NEW.amount <> ALL (ARRAY[1000, 5000, 50000, 100000]::BIGINT[]) THEN
    RAISE EXCEPTION 'Invalid chip amount. Use 1K, 5K, 50K, or 100K.' USING ERRCODE = '22023';
  END IF;

  IF round_game_type = 'tin_patti_pro'
     AND NEW.amount <> ALL (ARRAY[500, 1000, 5000, 50000, 100000]::BIGINT[]) THEN
    RAISE EXCEPTION 'Invalid real-time game chip amount.' USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.place_greedy_pro_bet(UUID, TEXT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_greedy_pro_bet(UUID, TEXT, BIGINT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.place_greedy_pro_bet_batch(UUID, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_greedy_pro_bet_batch(UUID, TEXT, JSONB) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_greedy_pro_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_greedy_pro_state() TO authenticated, service_role;

