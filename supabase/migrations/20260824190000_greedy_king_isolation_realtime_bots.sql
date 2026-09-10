-- Greedy King is a separate game, not a second skin over Greedy Lion.
-- Clone the currently deployed Greedy Lion engine under greedy_pro so the
-- payout behavior stays equivalent while rooms, rounds, bets and settings
-- become completely independent.

INSERT INTO public.game_settings
SELECT (jsonb_populate_record(
  NULL::public.game_settings,
  to_jsonb(source_setting) || jsonb_build_object('id', 'greedy_pro')
)).*
FROM public.game_settings source_setting
WHERE source_setting.id = 'greedy_lion'
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  source_function RECORD;
  cloned_definition TEXT;
BEGIN
  FOR source_function IN
    SELECT p.oid, p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname LIKE '%greedy\_lion%' ESCAPE '\'
     ORDER BY
       CASE p.proname
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
         ELSE 12
       END,
       p.proname,
       pg_get_function_identity_arguments(p.oid)
  LOOP
    cloned_definition := pg_get_functiondef(source_function.oid);
    cloned_definition := replace(cloned_definition, 'greedy_lion', 'greedy_pro');
    cloned_definition := replace(cloned_definition, 'Greedy Lion', 'Greedy King');
    cloned_definition := replace(
      cloned_definition,
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000004'
    );
    cloned_definition := replace(cloned_definition, 'pg_advisory_xact_lock(1729, 1)', 'pg_advisory_xact_lock(1729, 4)');

    IF source_function.proname = 'greedy_lion_tick' THEN
      cloned_definition := replace(
        cloned_definition,
        'FUNCTION public.greedy_pro_tick()',
        'FUNCTION public.greedy_pro_tick_core_168()'
      );
    END IF;

    IF source_function.proname = 'get_greedy_lion_state' THEN
      cloned_definition := replace(
        cloned_definition,
        'FUNCTION public.get_greedy_pro_state()',
        'FUNCTION public.get_greedy_pro_state_core_168()'
      );
    END IF;

    IF source_function.proname = 'place_greedy_lion_bet_batch' THEN
      cloned_definition := replace(
        cloned_definition,
        'ARRAY[100000, 50000, 5000, 1000]::bigint[]',
        'ARRAY[100000, 50000, 5000, 1000, 500]::bigint[]'
      );
    END IF;

    EXECUTE cloned_definition;
  END LOOP;
END;
$$;

-- Robot bets are shared display events. They never touch a real wallet and
-- never participate in payout settlement, but every client reads the same
-- rows and receives the same realtime inserts.
CREATE TABLE IF NOT EXISTS public.game_robot_bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES public.game_rounds(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL CHECK (slot > 0),
  position TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount IN (500, 1000, 5000, 50000, 100000)),
  robot_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (round_id, slot)
);

CREATE INDEX IF NOT EXISTS idx_game_robot_bets_round_created
  ON public.game_robot_bets(round_id, created_at DESC);

ALTER TABLE public.game_robot_bets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS game_robot_bets_read ON public.game_robot_bets;
CREATE POLICY game_robot_bets_read
  ON public.game_robot_bets FOR SELECT
  USING (TRUE);
REVOKE INSERT, UPDATE, DELETE ON public.game_robot_bets FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.game_robot_bets TO anon, authenticated, service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'game_robot_bets'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.game_robot_bets;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.greedy_pro_sync_robot_bets()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  active_round public.game_rounds%ROWTYPE;
  target_slot INTEGER;
  next_slot INTEGER;
  hash_value BIGINT;
  amount_roll INTEGER;
  positions CONSTANT TEXT[] := ARRAY['chicken','shrimp','ham','fish','tomato','corn','pepper','carrot'];
  names CONSTANT TEXT[] := ARRAY[
    '🌍world.com 🌍','Gamer king','PAGLA','সাদা পায়রা','শুটকি','🎭Mask🎭','Vk','.com',
    'Max','Jack sparrow','কাবিলা','শিকারী','ঐ কই তুমি','AV','👑BOSS👑','Fitness time',
    'Magician','Koi Tumi','Dollar','Koi go','Kala Manik','ZeeshaN','☠️Devil☠️','Rj Raj','অতঃপর হিমু'
  ];
BEGIN
  SELECT * INTO active_round
    FROM public.game_rounds
   WHERE game_type = 'greedy_pro'
     AND room_id = public.greedy_pro_global_room_id()
     AND status = 'betting'
     AND ends_at > NOW()
   ORDER BY started_at DESC
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  target_slot := GREATEST(0, FLOOR(
    EXTRACT(EPOCH FROM (LEAST(NOW(), active_round.ends_at) - active_round.started_at)) * 1000 / 650
  )::INTEGER);
  SELECT COALESCE(MAX(slot), 0) + 1 INTO next_slot
    FROM public.game_robot_bets
   WHERE round_id = active_round.id;

  WHILE next_slot <= target_slot LOOP
    hash_value := (('x' || substr(md5(active_round.id::text || ':' || next_slot), 1, 8))::bit(32)::bigint);
    amount_roll := (hash_value % 100)::INTEGER;
    INSERT INTO public.game_robot_bets(round_id, slot, position, amount, robot_name, created_at)
    VALUES (
      active_round.id,
      next_slot,
      positions[1 + (hash_value % array_length(positions, 1))::INTEGER],
      CASE
        WHEN amount_roll < 28 THEN 500
        WHEN amount_roll < 62 THEN 1000
        WHEN amount_roll < 84 THEN 5000
        WHEN amount_roll < 96 THEN 50000
        ELSE 100000
      END,
      names[1 + ((hash_value / 101) % array_length(names, 1))::INTEGER],
      active_round.started_at + (next_slot * INTERVAL '650 milliseconds')
    )
    ON CONFLICT (round_id, slot) DO NOTHING;
    next_slot := next_slot + 1;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.greedy_pro_tick()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  tick_result JSON;
BEGIN
  tick_result := public.greedy_pro_tick_core_168();
  PERFORM public.greedy_pro_sync_robot_bets();
  RETURN tick_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_greedy_pro_state()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  state_payload JSONB;
  active_round_id UUID;
  merged_totals JSONB;
  robot_total RECORD;
BEGIN
  state_payload := public.get_greedy_pro_state_core_168()::jsonb;
  IF COALESCE((state_payload->>'success')::BOOLEAN, false) IS DISTINCT FROM TRUE THEN
    RETURN state_payload::JSON;
  END IF;

  active_round_id := NULLIF(state_payload #>> '{round,id}', '')::UUID;
  merged_totals := CASE
    WHEN jsonb_typeof(state_payload->'bet_totals') = 'object' THEN state_payload->'bet_totals'
    ELSE '{}'::JSONB
  END;
  IF active_round_id IS NOT NULL THEN
    FOR robot_total IN
      SELECT position, SUM(amount)::BIGINT AS amount
        FROM public.game_robot_bets
       WHERE round_id = active_round_id
       GROUP BY position
    LOOP
      merged_totals := jsonb_set(
        merged_totals,
        ARRAY[robot_total.position],
        to_jsonb(COALESCE((merged_totals->>robot_total.position)::BIGINT, 0) + robot_total.amount),
        true
      );
    END LOOP;
  END IF;

  RETURN jsonb_set(state_payload, '{bet_totals}', merged_totals, true)::JSON;
END;
$$;

-- The global coordinator remains independent: a failure in one game cannot
-- stop another game's clock.
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid)
      FROM cron.job
     WHERE jobname = 'greedy-king-authoritative-clock';
    PERFORM cron.schedule(
      'greedy-king-authoritative-clock',
      '1 second',
      $cron$ SELECT public.greedy_pro_tick(); $cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule Greedy King clock: %', SQLERRM;
END;
$$;

-- Extend the global denomination guard without changing Old Greedy's chips.
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

  IF round_game_type IN ('greedy_lion', 'tin_patti_pro')
     AND NEW.amount <> ALL (ARRAY[1000, 5000, 50000, 100000]::BIGINT[]) THEN
    RAISE EXCEPTION 'Invalid chip amount. Use 1K, 5K, 50K, or 100K.' USING ERRCODE = '22023';
  END IF;
  IF round_game_type = 'greedy_pro'
     AND NEW.amount <> ALL (ARRAY[500, 1000, 5000, 50000, 100000]::BIGINT[]) THEN
    RAISE EXCEPTION 'Invalid Greedy King chip amount.' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  cloned_function REGPROCEDURE;
BEGIN
  FOR cloned_function IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname LIKE '%greedy\_pro%' ESCAPE '\'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', cloned_function);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', cloned_function);
  END LOOP;
END;
$$;

COMMENT ON TABLE public.game_robot_bets IS
  'Authoritative shared robot chip events for Greedy King display pots.';
COMMENT ON FUNCTION public.greedy_pro_tick() IS
  'Independent Greedy King round coordinator and robot-event producer.';
