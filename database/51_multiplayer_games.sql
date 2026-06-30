-- =====================================================================
-- 51_multiplayer_games.sql
-- =====================================================================
-- Converts Teen Patti + Fruit Roulette from single-player-with-fake-pot
-- to real room-wide multiplayer rounds.
--
-- WHAT WAS WRONG
--   - game_rounds had no room_id; every play was a private row for the
--     single user who called play_teen_patti() / play_fruit_roulette().
--   - The "pot" numbers viewers saw were `Math.random()` mock data added
--     to local state in TeenPatti.js / FruitRoulette.js, never written
--     to or read from the server.
--   - Each user got an independent random() roll, so two players in the
--     same room could see different "winning positions" for the same
--     round.
--
-- NEW MODEL
--   A round is a row in `game_rounds` keyed by `room_id + game_type` with
--   a state machine: 'betting' (15s) → 'resolving' (server picks winner)
--   → 'settled' (winners paid). Anyone in the room can bet during the
--   betting window via `place_game_bet`. When the window expires the
--   first caller to `resolve_game_round` flips it to 'resolving' and
--   runs ONE server RNG roll; that result is broadcast to everyone in
--   the room via realtime publication, and all winners are paid from
--   the same authoritative result.
--
-- ALSO IN THIS MIGRATION
--   - Fruit Roulette wheel redesigned: 8 unique fruit types instead of
--     repeats (apple×3, watermelon×2, ...). Each slot is its own fruit,
--     multipliers tuned down from the loose 5/10/15/25 to a more
--     sustainable 3-8x range.
--   - Old per-user RPCs (play_teen_patti, play_fruit_roulette) are
--     dropped; the new flow uses start_game_round / place_game_bet /
--     resolve_game_round.
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Schema changes
-- ---------------------------------------------------------------------
-- game_rounds becomes the room-level round record.
ALTER TABLE public.game_rounds
  ADD COLUMN IF NOT EXISTS room_id    UUID,
  ADD COLUMN IF NOT EXISTS status     TEXT DEFAULT 'settled' CHECK (status IN ('betting','resolving','settled')),
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ends_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS winner_pos TEXT;

-- user_id stays for backwards-compat with old per-user rows, but it
-- must be nullable now because new round rows belong to a room, not a
-- person. Old rows keep their user_id; new rows leave it NULL.
ALTER TABLE public.game_rounds ALTER COLUMN user_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_game_rounds_room_active
  ON public.game_rounds (room_id, game_type, status)
  WHERE status <> 'settled';

CREATE INDEX IF NOT EXISTS idx_game_rounds_room_recent
  ON public.game_rounds (room_id, game_type, started_at DESC);

-- Per-user bets against a round. Bets aggregate into the live pot the
-- whole room sees.
CREATE TABLE IF NOT EXISTS public.game_round_bets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id    UUID NOT NULL REFERENCES public.game_rounds(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES public.profiles(id)    ON DELETE CASCADE,
  position    TEXT NOT NULL,                  -- 'A'|'B'|'C' (Teen Patti) or fruit slug
  amount      BIGINT NOT NULL CHECK (amount > 0),
  win_amount  BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_game_round_bets_round    ON public.game_round_bets (round_id);
CREATE INDEX IF NOT EXISTS idx_game_round_bets_round_pos ON public.game_round_bets (round_id, position);

-- ---------------------------------------------------------------------
-- 2. RLS — viewers can read live rounds + bets in any room they can see;
--    writes only via the SECURITY DEFINER RPCs.
-- ---------------------------------------------------------------------
ALTER TABLE public.game_round_bets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS game_round_bets_read  ON public.game_round_bets;
CREATE POLICY game_round_bets_read  ON public.game_round_bets FOR SELECT USING (TRUE);
DROP POLICY IF EXISTS game_round_bets_block ON public.game_round_bets;
CREATE POLICY game_round_bets_block ON public.game_round_bets FOR ALL    USING (FALSE) WITH CHECK (FALSE);

-- ---------------------------------------------------------------------
-- 3. Realtime publication so mobile components can subscribe to round
--    state + bet aggregation without polling.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='game_rounds'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.game_rounds;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='game_round_bets'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.game_round_bets;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4. Update game_settings: redesign Fruit Roulette wheel.
--    8 unique fruits, tuned multipliers (3-8x instead of 5/10/15/25).
--    Teen Patti win multiplier left at 2 (already balanced for a 3-way
--    pick).
-- ---------------------------------------------------------------------
UPDATE public.game_settings
   SET multipliers = '[
        {"id":0,"type":"apple",     "label":"Apple",     "m":3},
        {"id":1,"type":"banana",    "label":"Banana",    "m":3},
        {"id":2,"type":"orange",    "label":"Orange",    "m":4},
        {"id":3,"type":"watermelon","label":"Watermelon","m":4},
        {"id":4,"type":"grapes",    "label":"Grapes",    "m":5},
        {"id":5,"type":"pineapple", "label":"Pineapple", "m":5},
        {"id":6,"type":"mango",     "label":"Mango",     "m":6},
        {"id":7,"type":"crown",     "label":"Lucky Crown","m":8}
      ]'::jsonb
 WHERE id = 'fruit_roulette';

UPDATE public.game_settings
   SET multipliers = '{"win": 2}'::jsonb
 WHERE id = 'teen_patti' AND (multipliers IS NULL OR multipliers = '{}'::jsonb);

-- ---------------------------------------------------------------------
-- 5. RPC: start_game_round
--
--    Idempotent: if there's already an active 'betting' round in this
--    room for this game, return it. Otherwise create a new one with a
--    15s betting window. Anyone in the room can call this; the first
--    caller opens the round and everyone else just attaches to it.
-- ---------------------------------------------------------------------
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

  SELECT * INTO v_settings FROM public.game_settings WHERE id = p_game_type;
  IF NOT FOUND OR v_settings.is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Game disabled');
  END IF;

  v_dur := GREATEST(5, LEAST(60, COALESCE(p_duration_s, 15)));

  -- Look up an active betting round we can re-use.
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

  -- No active round → create one.
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

-- ---------------------------------------------------------------------
-- 6. RPC: place_game_bet
--
--    Deducts the bet from the user's diamonds and inserts a row in
--    game_round_bets. Enforces min/max + daily-loss cap from
--    game_settings just like the old per-user RPCs did.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.place_game_bet(
  p_round_id UUID,
  p_position TEXT,
  p_amount   BIGINT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me             uuid := auth.uid();
  v_round        public.game_rounds%ROWTYPE;
  v_settings     public.game_settings%ROWTYPE;
  v_balance      bigint;
  v_loss_today   bigint;
  v_user_round_total bigint;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'Amount must be positive');
  END IF;
  IF p_position IS NULL OR length(trim(p_position)) = 0 THEN
    RETURN json_build_object('success', false, 'message', 'Position required');
  END IF;

  SELECT * INTO v_round
    FROM public.game_rounds WHERE id = p_round_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'Round not found');
  END IF;
  IF v_round.status <> 'betting' THEN
    RETURN json_build_object('success', false, 'message', 'Betting window closed');
  END IF;
  IF v_round.ends_at <= NOW() THEN
    RETURN json_build_object('success', false, 'message', 'Round expired');
  END IF;

  SELECT * INTO v_settings FROM public.game_settings WHERE id = v_round.game_type;
  IF v_settings.is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Game disabled');
  END IF;

  -- Per-bet min/max (game_settings.min_bet / max_bet).
  IF p_amount < COALESCE(v_settings.min_bet, 1) THEN
    RETURN json_build_object('success', false, 'message',
      'Minimum bet is ' || COALESCE(v_settings.min_bet, 1));
  END IF;
  -- Sum of this user's bets on this round vs. max_bet:
  SELECT COALESCE(SUM(amount), 0) INTO v_user_round_total
    FROM public.game_round_bets
    WHERE round_id = p_round_id AND user_id = me;
  IF (v_user_round_total + p_amount) > COALESCE(v_settings.max_bet, 100000000) THEN
    RETURN json_build_object('success', false, 'message',
      'Round bet limit is ' || COALESCE(v_settings.max_bet, 100000000));
  END IF;

  -- Daily loss cap.
  IF v_settings.daily_loss_cap IS NOT NULL THEN
    v_loss_today := public.user_24h_game_loss(me);
    IF v_loss_today + p_amount > v_settings.daily_loss_cap THEN
      RETURN json_build_object('success', false, 'message',
        'Daily loss cap reached. Come back tomorrow.');
    END IF;
  END IF;

  -- Balance check + atomic deduction.
  SELECT diamonds INTO v_balance FROM public.profiles WHERE id = me FOR UPDATE;
  IF v_balance IS NULL OR v_balance < p_amount THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient diamonds');
  END IF;

  UPDATE public.profiles SET diamonds = diamonds - p_amount WHERE id = me;

  INSERT INTO public.game_round_bets (round_id, user_id, position, amount)
    VALUES (p_round_id, me, p_position, p_amount);

  -- Keep the round's running total in sync so subscribers don't have to
  -- aggregate on every render. The bets JSONB is kept for backward-compat.
  UPDATE public.game_rounds
     SET total_bet = COALESCE(total_bet, 0) + p_amount,
         bets      = jsonb_set(
                       COALESCE(bets, '{}'::jsonb),
                       ARRAY[p_position],
                       to_jsonb(COALESCE((bets ->> p_position)::bigint, 0) + p_amount)
                     )
   WHERE id = p_round_id;

  INSERT INTO public.transactions
    (user_id, type, currency, amount, related_entity_type, related_entity_id, status)
  VALUES (me, 'game_bet', 'diamond', -p_amount, 'game_round', p_round_id, 'completed');

  RETURN json_build_object(
    'success', true,
    'round_id', p_round_id,
    'position', p_position,
    'my_round_total', v_user_round_total + p_amount
  );
END $$;

GRANT EXECUTE ON FUNCTION public.place_game_bet(uuid, text, bigint) TO authenticated;

-- ---------------------------------------------------------------------
-- 7. RPC: resolve_game_round
--
--    First caller after the round's ends_at flips it 'betting' →
--    'resolving' atomically, runs ONE server random() roll, picks the
--    winning position (biased by win_chance + covered/uncovered like
--    the old per-user RPCs), pays every winning bet, and marks the
--    round 'settled'. Late callers see the existing settled state
--    and just return it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_game_round(p_round_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_round        public.game_rounds%ROWTYPE;
  v_settings     public.game_settings%ROWTYPE;
  v_should_win   BOOLEAN;
  v_winner_pos   TEXT;
  v_multiplier   INT;
  v_slot_id      INT;
  v_covered      TEXT[];
  v_uncovered    TEXT[];
  v_all_pos      TEXT[];
  v_per_winner   RECORD;
  v_payout       bigint;
BEGIN
  -- Atomic claim: only the first caller flips betting → resolving.
  UPDATE public.game_rounds
     SET status = 'resolving'
   WHERE id = p_round_id
     AND status = 'betting'
     AND ends_at <= NOW();

  -- Re-read to see latest state regardless of whether we won the race.
  SELECT * INTO v_round FROM public.game_rounds WHERE id = p_round_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'Round not found');
  END IF;

  -- Already settled by an earlier caller → return the result so the
  -- client renders the same animation.
  IF v_round.status = 'settled' THEN
    RETURN json_build_object(
      'success', true,
      'round_id', v_round.id,
      'winner_pos', v_round.winner_pos,
      'result', v_round.result,
      'already_settled', true
    );
  END IF;

  -- We're the resolver. Load settings + compute the winning position.
  SELECT * INTO v_settings FROM public.game_settings WHERE id = v_round.game_type;
  v_should_win := (random() * 100) < COALESCE(v_settings.win_chance_percent, 30);

  IF v_round.game_type = 'teen_patti' THEN
    v_all_pos := ARRAY['A','B','C'];
  ELSIF v_round.game_type = 'fruit_roulette' THEN
    SELECT array_agg(slot ->> 'type') INTO v_all_pos
      FROM jsonb_array_elements(COALESCE(v_settings.multipliers, '[]'::jsonb)) slot;
  ELSE
    v_all_pos := ARRAY[]::TEXT[];
  END IF;

  -- Split positions into covered (someone bet) vs uncovered (no bets).
  SELECT
    COALESCE(array_agg(DISTINCT position) FILTER (WHERE position = ANY (v_all_pos)), ARRAY[]::TEXT[])
    INTO v_covered
    FROM public.game_round_bets
    WHERE round_id = v_round.id;

  v_uncovered := ARRAY(SELECT unnest(v_all_pos) EXCEPT SELECT unnest(v_covered));

  -- Pick a winner position. We bias against covered if win_chance roll
  -- failed (house edge) AND there's an uncovered position to land on.
  IF array_length(v_covered, 1) IS NULL OR array_length(v_covered, 1) = 0 THEN
    -- Nobody bet — just spin a position fairly so the wheel still feels
    -- alive for spectators.
    v_winner_pos := v_all_pos[1 + floor(random() * array_length(v_all_pos, 1))::int];
  ELSIF v_should_win THEN
    v_winner_pos := v_covered[1 + floor(random() * array_length(v_covered, 1))::int];
  ELSE
    IF array_length(v_uncovered, 1) > 0 THEN
      v_winner_pos := v_uncovered[1 + floor(random() * array_length(v_uncovered, 1))::int];
    ELSE
      v_winner_pos := v_covered[1 + floor(random() * array_length(v_covered, 1))::int];
    END IF;
  END IF;

  -- Resolve multiplier + slot id.
  IF v_round.game_type = 'teen_patti' THEN
    v_multiplier := COALESCE((v_settings.multipliers ->> 'win')::int, 2);
    v_slot_id    := NULL;
  ELSE
    SELECT (slot ->> 'm')::int, (slot ->> 'id')::int
      INTO v_multiplier, v_slot_id
      FROM jsonb_array_elements(COALESCE(v_settings.multipliers, '[]'::jsonb)) slot
      WHERE slot ->> 'type' = v_winner_pos
      LIMIT 1;
    v_multiplier := COALESCE(v_multiplier, 1);
  END IF;

  -- Pay every bet on the winning position, log the win on the row.
  FOR v_per_winner IN
    SELECT id, user_id, amount FROM public.game_round_bets
      WHERE round_id = v_round.id AND position = v_winner_pos
  LOOP
    v_payout := v_per_winner.amount * v_multiplier;
    UPDATE public.profiles SET diamonds = diamonds + v_payout WHERE id = v_per_winner.user_id;
    UPDATE public.game_round_bets SET win_amount = v_payout WHERE id = v_per_winner.id;
    INSERT INTO public.transactions
      (user_id, type, currency, amount, related_entity_type, related_entity_id, status)
    VALUES (v_per_winner.user_id, 'game_win', 'diamond', v_payout, 'game_round', v_round.id, 'completed');
  END LOOP;

  -- Finalise the round.
  UPDATE public.game_rounds
     SET status     = 'settled',
         winner_pos = v_winner_pos,
         result     = jsonb_build_object(
                        'winner_pos', v_winner_pos,
                        'multiplier', v_multiplier,
                        'slot_id',    v_slot_id
                      )
   WHERE id = v_round.id;

  RETURN json_build_object(
    'success',    true,
    'round_id',   v_round.id,
    'winner_pos', v_winner_pos,
    'multiplier', v_multiplier,
    'slot_id',    v_slot_id
  );
END $$;

GRANT EXECUTE ON FUNCTION public.resolve_game_round(uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 8. Drop the legacy per-user RPCs so old clients can't keep playing
--    the isolated game. Comment them out instead if a rollback is
--    needed.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.play_teen_patti(uuid, bigint, bigint, bigint);
DROP FUNCTION IF EXISTS public.play_fruit_roulette(uuid, bigint, bigint, bigint, bigint);