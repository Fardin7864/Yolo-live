-- Restore display-only bot betting for Popular Greedy and Greedy King.
-- Bot rows never touch profiles, wallets, real bets, or settlement.

CREATE TABLE IF NOT EXISTS public.greedy_pro_robot_bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES public.greedy_pro_rounds(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL CHECK (slot > 0),
  position TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount IN (1000, 5000, 50000, 100000)),
  robot_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (round_id, slot)
);

CREATE INDEX IF NOT EXISTS greedy_pro_robot_bets_round_created_idx
  ON public.greedy_pro_robot_bets(round_id, created_at DESC);

ALTER TABLE public.greedy_pro_robot_bets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS greedy_pro_robot_bets_read ON public.greedy_pro_robot_bets;
CREATE POLICY greedy_pro_robot_bets_read ON public.greedy_pro_robot_bets
  FOR SELECT TO authenticated USING (TRUE);

REVOKE ALL ON TABLE public.greedy_pro_robot_bets FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.greedy_pro_robot_bets FROM authenticated;
GRANT SELECT ON TABLE public.greedy_pro_robot_bets TO authenticated, service_role;
GRANT ALL ON TABLE public.greedy_pro_robot_bets TO service_role;

DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['game_robot_bets', 'greedy_pro_robot_bets'] LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = v_table
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.greedy_lion_sync_robot_bets()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_round public.game_rounds%ROWTYPE;
  v_target_slot INTEGER;
  v_next_slot INTEGER;
  v_hash BIGINT;
  v_roll INTEGER;
  v_positions CONSTANT TEXT[] := ARRAY['chicken','shrimp','ham','fish','tomato','corn','pepper','carrot'];
  v_names CONSTANT TEXT[] := ARRAY['Gamer King','PAGLA','Mask','Max','Jack Sparrow','Boss','Magician','Dollar','Kala Manik','Zeeshan','Devil','Raj'];
BEGIN
  SELECT * INTO v_round
    FROM public.game_rounds
   WHERE game_type = 'greedy_lion'
     AND room_id = public.greedy_lion_global_room_id()
     AND status = 'betting'
     AND ends_at > clock_timestamp()
   ORDER BY started_at DESC
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  v_target_slot := GREATEST(0, FLOOR(
    EXTRACT(EPOCH FROM (LEAST(clock_timestamp(), v_round.ends_at) - v_round.started_at)) * 1000 / 900
  )::INTEGER);
  SELECT COALESCE(MAX(slot), 0) + 1 INTO v_next_slot
    FROM public.game_robot_bets
   WHERE round_id = v_round.id;

  WHILE v_next_slot <= v_target_slot LOOP
    v_hash := (('x' || substr(md5(v_round.id::TEXT || ':lion:' || v_next_slot), 1, 8))::BIT(32)::BIGINT);
    v_roll := (v_hash % 100)::INTEGER;
    INSERT INTO public.game_robot_bets(round_id, slot, position, amount, robot_name, created_at)
    VALUES (
      v_round.id,
      v_next_slot,
      v_positions[1 + (v_hash % array_length(v_positions, 1))::INTEGER],
      CASE WHEN v_roll < 58 THEN 1000 WHEN v_roll < 84 THEN 5000 WHEN v_roll < 96 THEN 50000 ELSE 100000 END,
      v_names[1 + ((v_hash / 101) % array_length(v_names, 1))::INTEGER],
      v_round.started_at + (v_next_slot * INTERVAL '900 milliseconds')
    )
    ON CONFLICT (round_id, slot) DO NOTHING;
    v_next_slot := v_next_slot + 1;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.greedy_pro_sync_robot_bets()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_round public.greedy_pro_rounds%ROWTYPE;
  v_target_slot INTEGER;
  v_next_slot INTEGER;
  v_hash BIGINT;
  v_roll INTEGER;
  v_positions CONSTANT TEXT[] := ARRAY['chicken','shrimp','ham','fish','tomato','corn','pepper','carrot'];
  v_names CONSTANT TEXT[] := ARRAY['Gamer King','PAGLA','Mask','Max','Jack Sparrow','Boss','Magician','Dollar','Kala Manik','Zeeshan','Devil','Raj'];
BEGIN
  SELECT * INTO v_round
    FROM public.greedy_pro_rounds
   WHERE game_type = 'greedy_pro'
     AND room_id = public.greedy_pro_global_room_id()
     AND status = 'betting'
     AND ends_at > clock_timestamp()
   ORDER BY started_at DESC
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  v_target_slot := GREATEST(0, FLOOR(
    EXTRACT(EPOCH FROM (LEAST(clock_timestamp(), v_round.ends_at) - v_round.started_at)) * 1000 / 900
  )::INTEGER);
  SELECT COALESCE(MAX(slot), 0) + 1 INTO v_next_slot
    FROM public.greedy_pro_robot_bets
   WHERE round_id = v_round.id;

  WHILE v_next_slot <= v_target_slot LOOP
    v_hash := (('x' || substr(md5(v_round.id::TEXT || ':king:' || v_next_slot), 1, 8))::BIT(32)::BIGINT);
    v_roll := (v_hash % 100)::INTEGER;
    INSERT INTO public.greedy_pro_robot_bets(round_id, slot, position, amount, robot_name, created_at)
    VALUES (
      v_round.id,
      v_next_slot,
      v_positions[1 + (v_hash % array_length(v_positions, 1))::INTEGER],
      CASE WHEN v_roll < 58 THEN 1000 WHEN v_roll < 84 THEN 5000 WHEN v_roll < 96 THEN 50000 ELSE 100000 END,
      v_names[1 + ((v_hash / 101) % array_length(v_names, 1))::INTEGER],
      v_round.started_at + (v_next_slot * INTERVAL '900 milliseconds')
    )
    ON CONFLICT (round_id, slot) DO NOTHING;
    v_next_slot := v_next_slot + 1;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.greedy_lion_sync_robot_bets() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.greedy_pro_sync_robot_bets() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.greedy_lion_sync_robot_bets() TO service_role;
GRANT EXECUTE ON FUNCTION public.greedy_pro_sync_robot_bets() TO service_role;

CREATE OR REPLACE FUNCTION public.greedy_lion_tick()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result JSON;
BEGIN
  PERFORM pg_advisory_xact_lock(1729, 1);
  v_result := public.greedy_lion_tick_unlocked_149();
  PERFORM public.greedy_lion_sync_robot_bets();
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.greedy_pro_tick()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result JSON;
BEGIN
  PERFORM pg_advisory_xact_lock(1729, 4);
  v_result := public.greedy_pro_tick_unlocked_149();
  PERFORM public.greedy_pro_sync_robot_bets();
  RETURN v_result;
END;
$$;

COMMENT ON TABLE public.greedy_pro_robot_bets IS
  'Display-only Greedy King bot activity; excluded from wallets, real bets, and settlement.';
COMMENT ON FUNCTION public.greedy_lion_sync_robot_bets() IS
  'Creates deterministic display-only Popular Greedy bot bets for the active round.';
COMMENT ON FUNCTION public.greedy_pro_sync_robot_bets() IS
  'Creates deterministic display-only Greedy King bot bets for the active dedicated round.';
