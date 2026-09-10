-- Greedy King is a table-isolated replica of Popular Greedy. Its RPC behavior
-- is cloned from the live Popular Greedy functions, while every round, bet,
-- and idempotency record is stored in dedicated Greedy King tables.

CREATE TABLE IF NOT EXISTS public.greedy_pro_rounds
  (LIKE public.game_rounds INCLUDING ALL);

CREATE TABLE IF NOT EXISTS public.greedy_pro_bets
  (LIKE public.game_round_bets INCLUDING ALL);

CREATE TABLE IF NOT EXISTS public.greedy_pro_bet_batches
  (LIKE public.game_bet_batches INCLUDING ALL);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'greedy_pro_bets_round_id_fkey'
  ) THEN
    ALTER TABLE public.greedy_pro_bets
      ADD CONSTRAINT greedy_pro_bets_round_id_fkey
      FOREIGN KEY (round_id) REFERENCES public.greedy_pro_rounds(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'greedy_pro_bets_user_id_fkey'
  ) THEN
    ALTER TABLE public.greedy_pro_bets
      ADD CONSTRAINT greedy_pro_bets_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'greedy_pro_bet_batches_round_id_fkey'
  ) THEN
    ALTER TABLE public.greedy_pro_bet_batches
      ADD CONSTRAINT greedy_pro_bet_batches_round_id_fkey
      FOREIGN KEY (round_id) REFERENCES public.greedy_pro_rounds(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'greedy_pro_bet_batches_user_id_fkey'
  ) THEN
    ALTER TABLE public.greedy_pro_bet_batches
      ADD CONSTRAINT greedy_pro_bet_batches_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS greedy_pro_rounds_room_started_idx
  ON public.greedy_pro_rounds(room_id, started_at DESC);
CREATE INDEX IF NOT EXISTS greedy_pro_bets_round_created_idx
  ON public.greedy_pro_bets(round_id, created_at DESC);
CREATE INDEX IF NOT EXISTS greedy_pro_bets_user_created_idx
  ON public.greedy_pro_bets(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS greedy_pro_bet_batches_request_idx
  ON public.greedy_pro_bet_batches(game_type, round_id, user_id, client_batch_id);

ALTER TABLE public.greedy_pro_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.greedy_pro_bets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.greedy_pro_bet_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS greedy_pro_rounds_read ON public.greedy_pro_rounds;
CREATE POLICY greedy_pro_rounds_read ON public.greedy_pro_rounds
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS greedy_pro_bets_read ON public.greedy_pro_bets;
CREATE POLICY greedy_pro_bets_read ON public.greedy_pro_bets
  FOR SELECT TO authenticated USING (TRUE);

REVOKE ALL ON TABLE public.greedy_pro_rounds FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.greedy_pro_bets FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.greedy_pro_bet_batches FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.greedy_pro_rounds, public.greedy_pro_bets TO authenticated, service_role;
GRANT ALL ON TABLE public.greedy_pro_rounds, public.greedy_pro_bets, public.greedy_pro_bet_batches TO service_role;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['greedy_pro_rounds', 'greedy_pro_bets'] LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = table_name
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', table_name);
    END IF;
  END LOOP;
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
    cloned_definition := replace(cloned_definition, 'public.game_round_bets', 'public.greedy_pro_bets');
    cloned_definition := replace(cloned_definition, 'public.game_bet_batches', 'public.greedy_pro_bet_batches');
    cloned_definition := replace(cloned_definition, 'public.game_rounds', 'public.greedy_pro_rounds');
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

DROP TRIGGER IF EXISTS validate_greedy_pro_bet_trigger ON public.greedy_pro_bets;
CREATE TRIGGER validate_greedy_pro_bet_trigger
BEFORE INSERT OR UPDATE OF position, round_id ON public.greedy_pro_bets
FOR EACH ROW EXECUTE FUNCTION public.validate_greedy_pro_bet();

CREATE OR REPLACE FUNCTION public.validate_greedy_pro_chip_denomination()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.amount <> ALL (ARRAY[1000, 5000, 50000, 100000]::BIGINT[]) THEN
    RAISE EXCEPTION 'Invalid chip amount. Use 1K, 5K, 50K, or 100K.' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_greedy_pro_chip_trigger ON public.greedy_pro_bets;
CREATE TRIGGER validate_greedy_pro_chip_trigger
BEFORE INSERT OR UPDATE OF amount ON public.greedy_pro_bets
FOR EACH ROW EXECUTE FUNCTION public.validate_greedy_pro_chip_denomination();

REVOKE ALL ON FUNCTION public.place_greedy_pro_bet(UUID, TEXT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_greedy_pro_bet(UUID, TEXT, BIGINT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.place_greedy_pro_bet_batch(UUID, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_greedy_pro_bet_batch(UUID, TEXT, JSONB) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_greedy_pro_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_greedy_pro_state() TO authenticated, service_role;

