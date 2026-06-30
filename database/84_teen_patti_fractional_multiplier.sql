-- =====================================================================
-- 84_teen_patti_fractional_multiplier.sql
-- =====================================================================
-- Two changes:
--
--   1. Teen Patti's winning multiplier moves from 2x → 2.9x. A 100-
--      diamond bet on the winning chair now returns 290 diamonds
--      (original 100 returned + 190 profit).
--
--   2. resolve_game_round's multiplier arithmetic switches from INT to
--      NUMERIC so 2.9 doesn't get truncated to 2 on the `::int` cast.
--      The integer `v_payout` is computed by casting the
--      `amount * v_multiplier` product to BIGINT at the end (postgres
--      banker's rounding — fine at 1-diamond resolution).
--
-- The fruit_roulette ladder values are still whole integers (5,5,5,5,
-- 10,15,25,45 — see mig 82), but switching its lookup to ::numeric is
-- a no-op for whole numbers and future-proofs the resolver if anyone
-- ever wants fractional fruit multipliers.
--
-- INTERACTION WITH PRIOR MIGRATIONS — DO NOT BREAK
--   * Mig 54  — atomic claim w/ RETURNING + already_settled return shape.
--   * Mig 77  — start_game_round server_now. Untouched here.
--   * Mig 79  — game_rounds_read RLS USING(TRUE). Untouched.
--   * Mig 80  — protect_profile_columns trigger bypass. Untouched.
--   * Mig 82  — fruit_roulette top-slot rate limit (max 2/hr). PRESERVED.
--   * Mig 83  — resolve_game_round adds my_win_amount to return JSON.
--                PRESERVED — both branches still return it.
--
-- The CLIENT-side TeenPatti.js is updated in the same patch:
--   * Adds a `teenPattiMultiplier` state, fetched from game_settings
--     on mount + a realtime subscription so admin re-tunes are
--     reflected without an APK rebuild.
--   * The hardcoded `myWinBet * 2` in the WON message is replaced with
--     `myWinBet * teenPattiMultiplier`.
--
-- Idempotent.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Update the teen_patti row in game_settings to 2.9.
--    JSONB number literal — `2.9` not `'2.9'`. The resolver reads it
--    via `(v_settings.multipliers ->> 'win')::numeric` so any future
--    decimal tweak (2.95, 3.1, etc) works without code change.
-- ---------------------------------------------------------------------
UPDATE public.game_settings
   SET multipliers = '{"win": 2.9}'::jsonb
 WHERE id = 'teen_patti';


-- ---------------------------------------------------------------------
-- 2. resolve_game_round with NUMERIC multiplier handling.
--    Identical to mig 83 except:
--      * v_multiplier        INT     → NUMERIC
--      * `::int` casts on multiplier reads → `::numeric`
--      * v_payout calculation casts the product to BIGINT
--    All other behavior (mig 54 atomic claim, mig 82 rate limit,
--    mig 83 my_win_amount) preserved verbatim.
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
  v_multiplier      NUMERIC;     -- WIDENED from INT (mig 83) so 2.9 doesn't truncate
  v_slot_id         INT;
  v_covered         TEXT[];
  v_uncovered       TEXT[];
  v_all_pos         TEXT[];
  v_per_winner      RECORD;
  v_payout          BIGINT;
  v_claimed         BOOLEAN := FALSE;
  v_top_slot_type   TEXT;
  v_max_slot_count  INT;
  v_my_win_amount   BIGINT := 0;
BEGIN
  -- AuthN (mig 54).
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  -- Atomic claim (mig 54 — preserved).
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

    IF v_round.status = 'settled' THEN
      -- Late caller path: re-read the caller's own winning bets so we
      -- can hand back my_win_amount even on already_settled (mig 83).
      SELECT COALESCE(SUM(win_amount), 0)
        INTO v_my_win_amount
        FROM public.game_round_bets
        WHERE round_id = v_round.id
          AND user_id  = me;

      RETURN json_build_object(
        'success',         true,
        'round_id',        v_round.id,
        'winner_pos',      v_round.winner_pos,
        'result',          v_round.result,
        'already_settled', true,
        'my_win_amount',   v_my_win_amount
      );
    END IF;

    RETURN json_build_object(
      'success', true,
      'pending', true,
      'status',  v_round.status
    );
  END IF;

  -- We own the round. Load settings + run ONE server roll (mig 82).
  SELECT * INTO v_settings FROM public.game_settings WHERE id = v_round.game_type;
  v_should_win := (random() * 100) < COALESCE(v_settings.win_chance_percent, 30);

  -- Build position universe.
  IF v_round.game_type = 'teen_patti' THEN
    v_all_pos := ARRAY['A','B','C'];
  ELSIF v_round.game_type = 'fruit_roulette' THEN
    SELECT array_agg(slot ->> 'type') INTO v_all_pos
      FROM jsonb_array_elements(COALESCE(v_settings.multipliers, '[]'::jsonb)) slot;
  ELSE
    v_all_pos := ARRAY[]::TEXT[];
  END IF;

  -- Top-slot rate limit (mig 82 — preserved).
  IF v_round.game_type = 'fruit_roulette' AND v_settings.multipliers IS NOT NULL THEN
    SELECT slot ->> 'type'
      INTO v_top_slot_type
      FROM jsonb_array_elements(v_settings.multipliers) slot
      ORDER BY (slot ->> 'm')::numeric DESC
      LIMIT 1;

    SELECT COUNT(*)
      INTO v_max_slot_count
      FROM public.game_rounds
      WHERE game_type  = v_round.game_type
        AND winner_pos = v_top_slot_type
        AND started_at >= NOW() - INTERVAL '1 hour'
        AND status     = 'settled';

    IF v_max_slot_count >= 2 THEN
      v_all_pos := array_remove(v_all_pos, v_top_slot_type);
    END IF;
  END IF;

  -- Covered/uncovered split.
  SELECT
    COALESCE(array_agg(DISTINCT position) FILTER (WHERE position = ANY (v_all_pos)), ARRAY[]::TEXT[])
    INTO v_covered
    FROM public.game_round_bets
    WHERE round_id = v_round.id;

  v_uncovered := ARRAY(SELECT unnest(v_all_pos) EXCEPT SELECT unnest(v_covered));

  -- Three-branch winner selection (mig 54).
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

  -- Multiplier read — NOW reads as NUMERIC so 2.9 survives.
  IF v_round.game_type = 'teen_patti' THEN
    v_multiplier := COALESCE((v_settings.multipliers ->> 'win')::numeric, 2);
    v_slot_id    := NULL;
  ELSE
    SELECT (slot ->> 'm')::numeric, (slot ->> 'id')::int
      INTO v_multiplier, v_slot_id
      FROM jsonb_array_elements(COALESCE(v_settings.multipliers, '[]'::jsonb)) slot
      WHERE slot ->> 'type' = v_winner_pos
      LIMIT 1;
    v_multiplier := COALESCE(v_multiplier, 1);
  END IF;

  -- Payout loop. Cast the (bet * multiplier) product to BIGINT for the
  -- diamond column. With multipliers like 2.9 the product can be
  -- fractional; postgres rounds to nearest even on cast — fine at
  -- 1-diamond resolution and matches the existing economy spec.
  FOR v_per_winner IN
    SELECT id, user_id, amount FROM public.game_round_bets
      WHERE round_id = v_round.id AND position = v_winner_pos
  LOOP
    v_payout := (v_per_winner.amount * v_multiplier)::BIGINT;
    UPDATE public.profiles SET diamonds = diamonds + v_payout WHERE id = v_per_winner.user_id;
    UPDATE public.game_round_bets SET win_amount = v_payout WHERE id = v_per_winner.id;
    INSERT INTO public.transactions
      (user_id, type, currency, amount, related_entity_type, related_entity_id, status)
    VALUES (v_per_winner.user_id, 'game_win', 'diamond', v_payout, 'game_round', v_round.id, 'completed');
  END LOOP;

  -- Caller's own winnings for client self-heal (mig 83).
  SELECT COALESCE(SUM(win_amount), 0)
    INTO v_my_win_amount
    FROM public.game_round_bets
    WHERE round_id = v_round.id
      AND user_id  = me;

  -- Finalise.
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
    'success',       true,
    'round_id',      v_round.id,
    'winner_pos',    v_winner_pos,
    'multiplier',    v_multiplier,
    'slot_id',       v_slot_id,
    'my_win_amount', v_my_win_amount
  );
END $$;

GRANT EXECUTE ON FUNCTION public.resolve_game_round(uuid) TO authenticated;


-- =====================================================================
-- DONE
--
-- VERIFY
--   SELECT multipliers FROM public.game_settings WHERE id='teen_patti';
--   -- expect: {"win": 2.9}
--
--   SELECT pg_get_functiondef('public.resolve_game_round(uuid)'::regprocedure)::text
--          LIKE '%::numeric%';
--   -- expect: t
-- =====================================================================
