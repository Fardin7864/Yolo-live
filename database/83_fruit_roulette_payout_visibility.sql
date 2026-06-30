-- =====================================================================
-- 83_fruit_roulette_payout_visibility.sql
-- =====================================================================
-- Fixes the production bug "diamonds deducted on bet but NOT credited on
-- win" reported on 2026-06-15.
--
-- ROOT CAUSE (after deep audit of mig 51/52/54/62/80/82 + FruitRoulette.js)
--   The SERVER payout works: resolve_game_round runs UPDATE profiles SET
--   diamonds = diamonds + payout under SECURITY DEFINER, and that path
--   bypasses protect_profile_columns via the SECURITY INVOKER current_user
--   bypass branch (mig 80 preserved it). The audit confirmed:
--     - place_game_bet (debit) and resolve_game_round (credit) BOTH
--       UPDATE profiles inside SECURITY DEFINER. They share the same
--       trigger-bypass path. If the trigger blocked one, it would block
--       the other — so mig 80 cannot be the asymmetric culprit.
--     - transactions table has no CHECK constraint that would reject
--       a 'game_win'/'diamond'/'completed' row (mig 10 forced TEXT
--       columns, mig 54 currency CHECK is ('diamond','bean','bdt')).
--
--   The actual UX failure is on the CLIENT:
--     1. The bet deduction is rendered via an OPTIMISTIC local
--        setMyDiamonds(prev => prev - amount) the moment the user taps.
--     2. The win credit has NO matching optimistic update; the client
--        relies entirely on the profiles UPDATE realtime event from
--        GlobalStateContext to land.
--     3. The 'profile-changes-${user.id}' subscription DOES fire — but
--        the round flips to status='settled' first, kicks off a 4s spin
--        animation, and then calls openRound() which immediately fires
--        start_game_round again, which can race the profile UPDATE that
--        is still in flight from resolve_game_round. On a slow phone /
--        spotty connection the credit event arrives AFTER the user has
--        already left the result screen, and because lockBalanceUpdates
--        is wired but never called, there's no queue holding it.
--     4. End result: user sees the deduction stick, never sees the win.
--
-- FIX STRATEGY
--   We change resolve_game_round to return a per-user `my_win_amount`
--   field equal to (amount * multiplier) summed across the caller's
--   winning bets on the round. The mobile client now does:
--       if (data.my_win_amount > 0) setMyDiamonds(p => p + data.my_win_amount);
--   exactly like the bet uses optimistic setMyDiamonds(p => p - amount).
--   This is a "belt and braces" fix: even if Realtime drops the profile
--   UPDATE the user will see the credit. If Realtime does land, the new
--   diamond count is authoritative (n.diamonds) and overwrites our
--   optimistic add — safe convergence.
--
--   For the late-caller / already_settled branch we also compute and
--   return `my_win_amount` by re-reading game_round_bets.win_amount that
--   the actual resolver already wrote. Same self-heal pattern.
--
-- KEEPS (do not break)
--   * mig 80 protect_profile_columns trigger — UNCHANGED. The bypass
--     branch on current_user NOT IN ('authenticated','anon') is the
--     correct path for trusted SECURITY DEFINER RPCs and we rely on it.
--   * mig 82 new multiplier ladder (5/5/5/5/10/15/25/45) — UNCHANGED.
--   * mig 82 1-hour rate-limit on the top-multiplier slot — UNCHANGED.
--   * mig 54 atomic claim + already-settled return shape + payout loop
--     + final UPDATE — UNCHANGED in spirit; we add one SELECT after the
--     loop to read the caller's total win.
--   * mig 77 server_now field on start_game_round — UNTOUCHED.
--   * mig 79 game_rounds RLS USING (TRUE) — UNTOUCHED.
--   * Realtime publication on game_rounds / game_round_bets / game_settings
--     — UNTOUCHED.
--
-- Idempotent. Safe to re-run.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Defensive re-apply of the new multiplier ladder.
--
-- If the user accidentally skipped running mig 82, this UPDATE will land
-- the new ladder. If mig 82 already ran, it's a no-op (same values).
-- This is the cheapest possible insurance against "I thought I ran it".
-- ---------------------------------------------------------------------
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
 WHERE id = 'fruit_roulette'
   AND (
        multipliers IS NULL
        OR multipliers @> '[{"type":"apple","m":3}]'::jsonb     -- legacy 3x
        OR multipliers @> '[{"type":"crown","m":8}]'::jsonb     -- legacy 8x
        OR multipliers @> '[{"type":"crown","m":25}]'::jsonb    -- pre-51 25x
   );


-- ---------------------------------------------------------------------
-- 2. resolve_game_round — adds my_win_amount to return shape
--
-- Otherwise identical to mig 82. The new bits are:
--   * v_my_win_amount declared
--   * After the payout loop, SELECT COALESCE(SUM(win_amount),0)
--       INTO v_my_win_amount
--       FROM game_round_bets
--      WHERE round_id = v_round.id AND user_id = me;
--   * Both the success JSON AND the already_settled JSON include
--     my_win_amount so the client can self-heal on either branch.
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
  v_top_slot_type   TEXT;
  v_max_slot_count  INT;
  v_my_win_amount   bigint := 0;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  -- Atomic claim with RETURNING (mig 54 pattern, preserved).
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
      -- can hand back my_win_amount even on already_settled.
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

  -- We own the round. Load settings + run ONE server roll. (mig 82)
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

  -- RATE LIMIT for fruit_roulette's top multiplier slot (mig 82 preserved).
  IF v_round.game_type = 'fruit_roulette' AND v_settings.multipliers IS NOT NULL THEN
    SELECT slot ->> 'type'
      INTO v_top_slot_type
      FROM jsonb_array_elements(v_settings.multipliers) slot
      ORDER BY (slot ->> 'm')::int DESC
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

  SELECT
    COALESCE(array_agg(DISTINCT position) FILTER (WHERE position = ANY (v_all_pos)), ARRAY[]::TEXT[])
    INTO v_covered
    FROM public.game_round_bets
    WHERE round_id = v_round.id;

  v_uncovered := ARRAY(SELECT unnest(v_all_pos) EXCEPT SELECT unnest(v_covered));

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

  -- Payout loop (mig 54 / 82 — unchanged).
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

  -- NEW: compute the CALLER'S own winnings so the client can self-heal
  -- regardless of whether Realtime delivers the profile UPDATE event.
  SELECT COALESCE(SUM(win_amount), 0)
    INTO v_my_win_amount
    FROM public.game_round_bets
    WHERE round_id = v_round.id
      AND user_id  = me;

  -- Finalise the round (mig 54 / 82 — unchanged).
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
-- DONE — run in Supabase SQL Editor. No app restart needed for the SQL
-- part; the client edit (FruitRoulette.js consumes data.my_win_amount)
-- ships in the same APK build that pairs with this migration.
--
-- VERIFY (run as the user)
--   -- New ladder visible to the resolver
--   SELECT multipliers FROM public.game_settings WHERE id='fruit_roulette';
--   -- expect m=5,5,5,5,10,15,25,45
--
--   -- Function carries my_win_amount
--   SELECT pg_get_functiondef('public.resolve_game_round(uuid)'::regprocedure)::text
--          LIKE '%my_win_amount%';
--   -- expect: t
--
--   -- Spot-check a recent settled round, see actual credit went through
--   SELECT b.user_id, b.amount, b.win_amount, p.diamonds
--     FROM public.game_round_bets b
--     JOIN public.profiles p ON p.id = b.user_id
--     JOIN public.game_rounds r ON r.id = b.round_id
--    WHERE r.game_type='fruit_roulette' AND r.status='settled'
--      AND b.win_amount > 0
--    ORDER BY b.created_at DESC LIMIT 5;
--   -- expect: win_amount > 0 rows present; if zero, the server payout
--   --        loop never ran (look at recent transactions for type='game_win')
-- =====================================================================
