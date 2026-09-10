-- Treat Teen Patti robot players as shared, server-authoritative table
-- accounts. Their bets affect the public pots and can appear in the normal
-- top-winner result list, but never debit or credit a real user wallet.

CREATE OR REPLACE FUNCTION public.bump_greedy_pro_robot_state_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  affected_round UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.round_id ELSE NEW.round_id END;
BEGIN
  UPDATE public.game_rounds
     SET state_version = state_version + 1,
         state_updated_at = NOW()
   WHERE id = affected_round
     AND game_type IN ('greedy_pro', 'tin_patti_pro');
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION public.tin_patti_pro_sync_robot_bets()
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
  positions CONSTANT TEXT[] := ARRAY['crown','coffee','cake'];
  names CONSTANT TEXT[] := ARRAY[
    '🌍world.com 🌍','Gamer king','PAGLA','সাদা পায়রা','শুটকি','🎭Mask🎭','Vk','.com',
    'Max','Jack sparrow','কাবিলা','শিকারী','ঐ কই তুমি','AV','👑BOSS👑','Fitness time',
    'Magician','Koi Tumi','Dollar','Koi go','Kala Manik','ZeeshaN','☠️Devil☠️','Rj Raj','অতঃপর হিমু'
  ];
BEGIN
  SELECT * INTO active_round
    FROM public.game_rounds
   WHERE game_type = 'tin_patti_pro'
     AND room_id = public.tin_patti_pro_global_room_id()
     AND status = 'betting'
     AND ends_at > NOW()
   ORDER BY started_at DESC
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  target_slot := GREATEST(0, FLOOR(
    EXTRACT(EPOCH FROM (LEAST(NOW(), active_round.ends_at) - active_round.started_at)) * 1000 / 700
  )::INTEGER);
  SELECT COALESCE(MAX(slot), 0) + 1 INTO next_slot
    FROM public.game_robot_bets
   WHERE round_id = active_round.id;

  WHILE next_slot <= target_slot LOOP
    hash_value := (('x' || substr(md5(active_round.id::text || ':teen:' || next_slot), 1, 8))::bit(32)::bigint);
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
      active_round.started_at + (next_slot * INTERVAL '700 milliseconds')
    )
    ON CONFLICT (round_id, slot) DO NOTHING;
    next_slot := next_slot + 1;
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF to_regprocedure('public.tin_patti_pro_tick_core_171()') IS NULL THEN
    ALTER FUNCTION public.tin_patti_pro_tick() RENAME TO tin_patti_pro_tick_core_171;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.tin_patti_pro_tick()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  tick_result JSON;
BEGIN
  tick_result := public.tin_patti_pro_tick_core_171();
  PERFORM public.tin_patti_pro_sync_robot_bets();
  RETURN tick_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_tin_patti_pro_state()
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.decorate_realtime_game_state(
    public.get_tin_patti_pro_state_core_169()::jsonb, TRUE
  )::json;
$$;

REVOKE ALL ON FUNCTION public.tin_patti_pro_sync_robot_bets() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tin_patti_pro_sync_robot_bets() TO service_role;
REVOKE ALL ON FUNCTION public.tin_patti_pro_tick_core_171() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tin_patti_pro_tick_core_171() TO service_role;
REVOKE ALL ON FUNCTION public.tin_patti_pro_tick() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tin_patti_pro_tick() TO authenticated, service_role;

COMMENT ON FUNCTION public.tin_patti_pro_sync_robot_bets() IS
  'Creates deterministic shared Teen Patti robot bets throughout the active round.';
