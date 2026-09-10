-- Greedy King queues local bets and commits one aggregate at the betting
-- boundary. Repair live databases where the cloned batch core still rejects
-- aggregates that contain the visible 500 chip, or where the post-countdown
-- commit grace has not been applied.

DO $$
DECLARE
  function_definition TEXT;
BEGIN
  IF to_regprocedure('public.place_greedy_pro_bet_batch_core_169(uuid,text,jsonb)') IS NOT NULL THEN
    SELECT pg_get_functiondef('public.place_greedy_pro_bet_batch_core_169(uuid,text,jsonb)'::regprocedure)
      INTO function_definition;

    IF position('ARRAY[100000, 50000, 5000, 1000, 500]::bigint[]' IN function_definition) = 0 THEN
      function_definition := replace(
        function_definition,
        'ARRAY[100000, 50000, 5000, 1000]::bigint[]',
        'ARRAY[100000, 50000, 5000, 1000, 500]::bigint[]'
      );

      IF position('ARRAY[100000, 50000, 5000, 1000, 500]::bigint[]' IN function_definition) = 0 THEN
        RAISE EXCEPTION 'Could not safely patch Greedy King batch chip decomposition';
      END IF;

      EXECUTE function_definition;
    END IF;
  ELSIF to_regprocedure('public.place_greedy_pro_bet_batch(uuid,text,jsonb)') IS NOT NULL THEN
    SELECT pg_get_functiondef('public.place_greedy_pro_bet_batch(uuid,text,jsonb)'::regprocedure)
      INTO function_definition;

    IF position('ARRAY[100000, 50000, 5000, 1000, 500]::bigint[]' IN function_definition) = 0
       AND position('ARRAY[100000, 50000, 5000, 1000]::bigint[]' IN function_definition) > 0 THEN
      function_definition := replace(
        function_definition,
        'ARRAY[100000, 50000, 5000, 1000]::bigint[]',
        'ARRAY[100000, 50000, 5000, 1000, 500]::bigint[]'
      );
      EXECUTE function_definition;
    END IF;
  ELSE
    RAISE EXCEPTION 'Greedy King batch function is not installed';
  END IF;
END;
$$;

UPDATE public.game_settings
   SET special_result_rules = jsonb_set(
         COALESCE(special_result_rules, '{}'::JSONB),
         '{bet_acceptance_grace_s}',
         '5'::JSONB,
         TRUE
       ),
       updated_at = NOW()
 WHERE id = 'greedy_pro';
