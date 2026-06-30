-- =====================================================================
-- 61_fix_start_game_round_column.sql
-- =====================================================================
-- Bug fix: migration 54's start_game_round() referenced
-- `live_streams.host_id`, but the actual column is `broadcaster_id`.
-- Every attempt to start a Teen Patti or Fruit Roulette round therefore
-- bombed with:
--   ERROR: column "host_id" does not exist
-- The Alert in the mobile client surfaced this as "Game unavailable,
-- column host_id does not exist", and the game phase got stuck on
-- "Connecting…" because no round id was ever returned.
--
-- This migration is the minimum change — replace the broken column
-- reference with broadcaster_id. Everything else from migration 54 is
-- preserved verbatim (signature, business logic, auth check, lock
-- semantics, return shape).
--
-- Idempotent: CREATE OR REPLACE so safe to re-run.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.start_game_round(
  p_room_id    UUID,
  p_game_type  TEXT,
  p_duration_s INT DEFAULT 15
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me           uuid := auth.uid();
  v_settings   public.game_settings%ROWTYPE;
  v_existing   public.game_rounds%ROWTYPE;
  v_round_id   uuid;
  v_dur        int;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF p_room_id IS NULL OR p_game_type IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Invalid args');
  END IF;

  -- The room URL maps 1:1 to the broadcaster's profile id; verify there
  -- is an active stream owned by that id so attackers can't spawn
  -- orphan game rounds for arbitrary UUIDs.
  --
  -- FIX (migration 61): live_streams uses `broadcaster_id`, NOT host_id.
  IF NOT EXISTS (
    SELECT 1 FROM public.live_streams
     WHERE broadcaster_id = p_room_id
       AND status         = 'live'
  ) THEN
    RETURN json_build_object('success', false, 'message', 'Room is not live');
  END IF;

  SELECT * INTO v_settings FROM public.game_settings WHERE id = p_game_type;
  IF NOT FOUND OR v_settings.is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Game disabled');
  END IF;

  v_dur := GREATEST(5, LEAST(60, COALESCE(p_duration_s, 15)));

  SELECT * INTO v_existing
    FROM public.game_rounds
    WHERE room_id = p_room_id
      AND game_type = p_game_type
      AND status = 'betting'
      AND ends_at > NOW()
    ORDER BY started_at DESC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

  IF FOUND THEN
    RETURN json_build_object(
      'success', true,
      'round_id', v_existing.id,
      'status',   v_existing.status,
      'started_at', v_existing.started_at,
      'ends_at',  v_existing.ends_at,
      'reused',   true
    );
  END IF;

  INSERT INTO public.game_rounds
    (game_type, room_id, status, started_at, ends_at, bets, result, total_bet)
  VALUES
    (p_game_type, p_room_id, 'betting', NOW(), NOW() + (v_dur || ' seconds')::interval,
     '{}'::jsonb, '{}'::jsonb, 0)
  RETURNING id INTO v_round_id;

  RETURN json_build_object(
    'success', true,
    'round_id', v_round_id,
    'status', 'betting',
    'started_at', NOW(),
    'ends_at', NOW() + (v_dur || ' seconds')::interval,
    'reused', false
  );
END $$;

GRANT EXECUTE ON FUNCTION public.start_game_round(uuid, text, int) TO authenticated;
