-- =====================================================================
-- 82_fruit_multipliers_and_rate_limit.sql
-- =====================================================================
-- Two related changes to the Fruit Roulette game:
--
--   1. New multiplier ladder for the 8 slots:
--        apple/banana/orange/watermelon = 5x
--        grapes                         = 10x
--        pineapple                      = 15x
--        mango                          = 25x
--        crown                          = 45x
--      (was 3/3/4/4/5/5/6/8 — see the original row in game_settings.)
--      The top slot is now much spicier, so we need (2) below.
--
--   2. Globally rate-limit the TOP multiplier slot to at most 2 wins per
--      rolling 1-hour window. This keeps the highest payout slot rare so
--      the economy doesn't hemorrhage diamonds when a hot streak hits.
--
--      Implementation choice: we do NOT touch win_chance_percent. The
--      house-edge dial stays at 30%. Instead, when the cap is hit we
--      remove the capped slot's `type` from `v_all_pos` (and therefore
--      from v_covered/v_uncovered) BEFORE the three-branch random
--      selection runs. That way:
--        - players betting on the capped slot during the cooldown lose
--          (because that slot can't be selected as winner)
--        - the empty-covered / should_win / not should_win branches all
--          behave identically — they just see a smaller pool of slots
--        - the existing multiplier lookup at the end still works
--          because the chosen winner is always a member of v_all_pos
--
--      The capped slot is identified DYNAMICALLY as the one with the
--      maximum `m` in v_settings.multipliers. That way, if migration 99
--      reshuffles the ladder again, this resolver still rate-limits
--      whichever slot ends up at the top — no code change needed.
--
-- Interaction with prior migrations (DO NOT BREAK):
--   * Mig 54 — atomic claim w/ RETURNING + already-settled return shape
--     + payout loop + final UPDATE. All preserved verbatim below.
--   * Mig 77 — adds server_now to start_game_round. We don't touch
--     start_game_round.
--   * Mig 79 — game_rounds_read RLS is USING (TRUE). We don't touch RLS.
--   * Mobile clients (FruitRoulette.js / TeenPatti.js) self-heal off the
--     RPC return value. The JSON we return must keep these fields:
--       success, winner_pos, multiplier, slot_id, already_settled, result
--     All preserved.
--
-- Index strategy: the existing idx_game_rounds_game is on
-- (game_type, created_at DESC). Our rate-limit query filters by
-- (game_type, winner_pos, started_at, status='settled'), so we add a
-- purpose-built PARTIAL index. ~95% of rounds at any moment are settled,
-- so the partial filter shaves little, but it keeps the index focused on
-- the column set we actually scan and is cheap to maintain.
--
-- Idempotent.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. New multiplier ladder for fruit_roulette
-- ---------------------------------------------------------------------
-- The row already exists (seeded by base schema), so a plain UPDATE is
-- enough — no INSERT / ON CONFLICT needed.
UPDATE public.game_settings
   SET multipliers = '[
        {"m":5,  "id":0, "type":"apple",      "label":"Apple"},
        {"m":5,  "id":1, "type":"banana",     "label":"Banana"},
        {"m":5,  "id":2, "type":"orange",     "label":"Orange"},
        {"m":5,  "id":3, "type":"watermelon", "label":"Watermelon"},
        {"m":10, "id":4, "type":"grapes",     "label":"Grapes"},
        {"m":15, "id":5, "type":"pineapple",  "label":"Pineapple"},
        {"m":25, "id":6, "type":"mango",      "label":"Mango"},
        {"m":45, "id":7, "type":"crown",      "label":"Lucky Crown"}
      ]'::jsonb,
       updated_at  = NOW()
 WHERE id = 'fruit_roulette';


-- ---------------------------------------------------------------------
-- 2. Supporting partial index for the rate-limit lookup
-- ---------------------------------------------------------------------
-- Query shape:
--   SELECT count(*) FROM game_rounds
--    WHERE game_type   = $1
--      AND winner_pos  = $2
--      AND started_at >= NOW() - INTERVAL '1 hour'
--      AND status      = 'settled';
-- This index lets Postgres pick the matching (game_type, winner_pos)
-- bucket and then do a range scan on started_at to count the last hour.
CREATE INDEX IF NOT EXISTS idx_game_rounds_type_winner_settled
  ON public.game_rounds (game_type, winner_pos, started_at DESC)
  WHERE status = 'settled';


-- ---------------------------------------------------------------------
-- 3. resolve_game_round — same shape as mig 54, with rate-limit added
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_game_round(p_round_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me                uuid := auth.uid();
  v_round           public.game_rounds%ROWTYPE;
  v_settings        public.game_settings%ROWTYPE;
  v_should_win      BOOLEAN;
  v_winner_pos      TEXT;
  v_multiplier      INT;
  v_slot_id         INT;
  v_covered         TEXT[];
  v_uncovered       TEXT[];
  v_all_pos         TEXT[];
  v_per_winner      RECORD;
  v_payout          bigint;
  v_claimed         BOOLEAN := FALSE;
  v_top_slot_type   TEXT;    -- highest-multiplier slot's type (e.g. 'crown')
  v_max_slot_count  INT;     -- recent wins for v_top_slot_type
BEGIN
  -- AuthN — must be a real signed-in user.
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  -- Atomic claim with RETURNING. Only the caller whose UPDATE actually
  -- mutated a row enters the payout path. Late callers see NOT FOUND
  -- here and fall through to read the already-settled state instead
  -- of running the payout loop twice.
  UPDATE public.game_rounds
     SET status = 'resolving'
   WHERE id = p_round_id
     AND status = 'betting'
     AND ends_at <= NOW()
   RETURNING * INTO v_round;
  v_claimed := FOUND;

  IF NOT v_claimed THEN
    SELECT * INTO v_round FROM public.game_rounds WHERE id = p_round_id;
    IF NOT FOUND THEN
      RETURN json_build_object('success', false, 'message', 'Round not found');
    END IF;
    -- Already finished → return the canonical result so the client renders
    -- the same animation that the actual resolver saw. Mobile clients
    -- (FruitRoulette.js line ~205) self-heal off these exact fields.
    IF v_round.status = 'settled' THEN
      RETURN json_build_object(
        'success', true,
        'round_id', v_round.id,
        'winner_pos', v_round.winner_pos,
        'result', v_round.result,
        'already_settled', true
      );
    END IF;
    -- Still 'resolving' (another caller is mid-payout) or 'betting' (we
    -- got here too early). Either way it's not ours to settle.
    RETURN json_build_object(
      'success', true,
      'pending', true,
      'status', v_round.status
    );
  END IF;

  -- We own the round now. Load settings + run ONE server roll.
  SELECT * INTO v_settings FROM public.game_settings WHERE id = v_round.game_type;
  v_should_win := (random() * 100) < COALESCE(v_settings.win_chance_percent, 30);

  -- Build the universe of valid winning positions for this game type.
  IF v_round.game_type = 'teen_patti' THEN
    v_all_pos := ARRAY['A','B','C'];
  ELSIF v_round.game_type = 'fruit_roulette' THEN
    SELECT array_agg(slot ->> 'type') INTO v_all_pos
      FROM jsonb_array_elements(COALESCE(v_settings.multipliers, '[]'::jsonb)) slot;
  ELSE
    v_all_pos := ARRAY[]::TEXT[];
  END IF;

  -- -------------------------------------------------------------
  -- RATE LIMIT for fruit_roulette's top multiplier slot.
  --
  -- We do this BEFORE computing v_covered / v_uncovered so that the
  -- three-branch random selection below sees a uniformly trimmed
  -- universe. If we tried to filter after the random pick, we'd have
  -- to loop / retry, which is harder to reason about and biases the
  -- distribution.
  --
  -- WHY HERE specifically:
  --   * Before v_covered build → covered set never includes the
  --     capped slot, so should_win branch can't pick it.
  --   * Before v_uncovered derivation → uncovered set never includes
  --     it either, so the not-should_win branch can't pick it.
  --   * Before the empty-covered fallback → can't pick it there
  --     either.
  -- One filter point, no edge cases.
  --
  -- The "top slot" is determined dynamically from v_settings — this
  -- code keeps working if a future migration reshuffles the ladder.
  -- -------------------------------------------------------------
  IF v_round.game_type = 'fruit_roulette' AND v_settings.multipliers IS NOT NULL THEN
    -- Find the slot type with the highest `m`. ORDER BY DESC + LIMIT 1
    -- gives one row deterministically even if two slots tied at the top.
    SELECT slot ->> 'type'
      INTO v_top_slot_type
      FROM jsonb_array_elements(v_settings.multipliers) slot
      ORDER BY (slot ->> 'm')::int DESC
      LIMIT 1;

    -- Count recent wins of that slot globally (not per-room) within the
    -- rolling 1-hour window. Uses idx_game_rounds_type_winner_settled.
    SELECT COUNT(*)
      INTO v_max_slot_count
      FROM public.game_rounds
      WHERE game_type  = v_round.game_type
        AND winner_pos = v_top_slot_type
        AND started_at >= NOW() - INTERVAL '1 hour'
        AND status     = 'settled';

    -- Cap: 2 wins per hour. If we're at-or-over the cap, scrub the top
    -- slot out of v_all_pos so none of the three branches can land on
    -- it. array_remove preserves ordering of the remaining slots.
    IF v_max_slot_count >= 2 THEN
      v_all_pos := array_remove(v_all_pos, v_top_slot_type);
    END IF;
  END IF;

  -- Covered positions = those at least one player bet on AND that are
  -- still in the (possibly trimmed) v_all_pos universe.
  SELECT
    COALESCE(array_agg(DISTINCT position) FILTER (WHERE position = ANY (v_all_pos)), ARRAY[]::TEXT[])
    INTO v_covered
    FROM public.game_round_bets
    WHERE round_id = v_round.id;

  v_uncovered := ARRAY(SELECT unnest(v_all_pos) EXCEPT SELECT unnest(v_covered));

  -- Three-branch winner selection — preserved from migration 54:
  --   * Nobody bet covered anything in v_all_pos → uniform random.
  --   * should_win roll passed → favor the house's "let them win" path,
  --     pick from positions players bet on.
  --   * should_win roll failed → pick an uncovered position so the
  --     house wins; fall back to covered if every slot has a bet.
  IF array_length(v_covered, 1) IS NULL OR array_length(v_covered, 1) = 0 THEN
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

  -- Resolve multiplier + slot_id for the chosen winner.
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

  -- Payout loop — credit each winner's diamonds, record the win on the
  -- bet row, and write a transaction. Preserved verbatim from mig 54.
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

  -- Finalize the round. Same column set + result JSON shape as mig 54
  -- so the Realtime UPDATE event keeps the structure mobile listens for.
  UPDATE public.game_rounds
     SET status     = 'settled',
         winner_pos = v_winner_pos,
         result     = jsonb_build_object(
                        'winner_pos', v_winner_pos,
                        'multiplier', v_multiplier,
                        'slot_id',    v_slot_id
                      )
   WHERE id = v_round.id;

  -- Return shape identical to mig 54. FruitRoulette.js reads
  -- data.success / data.already_settled / data.winner_pos /
  -- data.result?.winner_pos for self-heal.
  RETURN json_build_object(
    'success',    true,
    'round_id',   v_round.id,
    'winner_pos', v_winner_pos,
    'multiplier', v_multiplier,
    'slot_id',    v_slot_id
  );
END $$;

GRANT EXECUTE ON FUNCTION public.resolve_game_round(uuid) TO authenticated;


-- =====================================================================
-- DONE — run in Supabase SQL Editor. No app restart needed; the next
-- round to expire will pick up the new multipliers and rate limit.
-- =====================================================================
