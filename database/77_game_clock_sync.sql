-- =====================================================================
-- 77_game_clock_sync.sql
-- =====================================================================
-- Fixes a class of stuck-round bugs reported by users:
--   - "Timer reaches 0 but no result is shown"
--   - "Bet failed: Betting window closed" mid-round
--
-- Root cause: the previous start_game_round returned only `started_at`
-- (the time the round was first inserted). Clients used
-- `Date.now() - started_at` as a clock-skew offset. That works for a
-- FRESH round, where started_at ≈ server's NOW(), but breaks for
-- REUSED rounds (a viewer joining mid-round), where started_at is the
-- ORIGINAL start — minutes old. Clients computing offset from that
-- end up with a totally wrong skew and either (a) tick the countdown
-- too fast, or (b) fire resolve_game_round too early — at which point
-- the RPC's atomic UPDATE fails the `ends_at <= NOW()` check, no
-- claim happens, and the round sits in 'betting' state past its
-- actual expiry. The user sees 0:00 forever and any bet attempt
-- bounces with "Betting window closed" once another client (with a
-- correct clock) eventually settles it.
--
-- This migration changes start_game_round to return `server_now` in
-- every response. The mobile client uses that to compute the clock
-- offset for both fresh AND reused rounds. With the offset always
-- right, both the visible countdown and the resolve trigger fire on
-- the actual server beat.
--
-- A secondary safety net is implemented client-side in the same
-- patch: if the visible countdown reaches 0 but status is still
-- 'betting' a few seconds later, the client retries resolve. Together
-- the two changes eliminate the stuck-round path.
--
-- Idempotent.
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
  v_now        timestamptz := NOW();
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
      AND ends_at > v_now
    ORDER BY started_at DESC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

  IF FOUND THEN
    RETURN json_build_object(
      'success',    true,
      'round_id',   v_existing.id,
      'status',     v_existing.status,
      'started_at', v_existing.started_at,
      'ends_at',    v_existing.ends_at,
      'reused',     true,
      -- NEW: server's current wallclock at the moment of the RPC call.
      -- Client computes clockOffsetMs = Date.now() - server_now so the
      -- countdown is in lockstep with the server even when joining
      -- a round that started long ago.
      'server_now', v_now
    );
  END IF;

  INSERT INTO public.game_rounds
    (game_type, room_id, status, started_at, ends_at, bets, result, total_bet)
  VALUES
    (p_game_type, p_room_id, 'betting', v_now, v_now + (v_dur || ' seconds')::interval,
     '{}'::jsonb, '{}'::jsonb, 0)
  RETURNING id INTO v_round_id;

  RETURN json_build_object(
    'success',    true,
    'round_id',   v_round_id,
    'status',     'betting',
    'started_at', v_now,
    'ends_at',    v_now + (v_dur || ' seconds')::interval,
    'reused',     false,
    'server_now', v_now
  );
END $$;

GRANT EXECUTE ON FUNCTION public.start_game_round(uuid, text, int) TO authenticated;


-- =====================================================================
-- DONE
-- =====================================================================
