-- =====================================================================
-- 54_security_hardening.sql
-- =====================================================================
-- Closes three critical authentication holes uncovered in the deep
-- security audit. Idempotent — same RPC signatures, only behaviour is
-- tightened so existing callers keep working unchanged.
--
-- WHAT'S FIXED:
--
--   1. resolve_game_round
--      - Was callable WITHOUT auth.uid(). Anonymous / service-key
--        callers could resolve any room's round.
--      - Race condition: the atomic `status='resolving'` UPDATE was
--        followed by an unlocked re-read. Two concurrent callers could
--        both pass the post-read state check and run the payout loop,
--        double-crediting winners.
--      Fix: explicit auth check + use the UPDATE's RETURNING clause so
--      ONLY the row-claiming caller enters the payout path.
--
--   2. start_game_round
--      - Was callable with ANY UUID as p_room_id. An attacker could
--        spawn orphan game rounds for non-existent rooms.
--      Fix: require an active live_streams row owned by the room's
--      host (p_room_id must equal the broadcaster's profile id, which
--      is the room's URL parameter pattern).
--
--   3. confirm_topup_request
--      - Trusted the client-supplied p_admin_id parameter as the
--        caller's identity. An attacker with a normal user token could
--        call the RPC with another admin's UUID as p_admin_id and:
--          - Drain that admin's agency / reseller stock to the
--            attacker's wallet
--          - Forge the admin_audit_log entry, blaming the named admin
--      Fix: ignore p_admin_id for authorisation; use auth.uid() as the
--      caller identity. The parameter is kept in the signature so the
--      admin panel doesn't have to redeploy; it's just no longer trusted.
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. resolve_game_round — auth + race-safe claim
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_game_round(p_round_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me             uuid := auth.uid();
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
  v_claimed      BOOLEAN := FALSE;
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
    -- the same animation that the actual resolver saw.
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

  IF v_round.game_type = 'teen_patti' THEN
    v_all_pos := ARRAY['A','B','C'];
  ELSIF v_round.game_type = 'fruit_roulette' THEN
    SELECT array_agg(slot ->> 'type') INTO v_all_pos
      FROM jsonb_array_elements(COALESCE(v_settings.multipliers, '[]'::jsonb)) slot;
  ELSE
    v_all_pos := ARRAY[]::TEXT[];
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
-- 2. start_game_round — require an actually-live broadcast
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

-- ---------------------------------------------------------------------
-- 3. confirm_topup_request — use auth.uid() instead of trusting
--    the client-supplied p_admin_id.
--
-- The admin panel keeps passing p_admin_id (no client redeploy needed);
-- we just no longer believe it. All authorisation, audit-log identity
-- and confirmed_by attribution now come from auth.uid().
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_topup_request(
  p_request_id UUID,
  p_admin_id   UUID   -- kept for backward-compat, ignored
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me                uuid := auth.uid();
  v_request         public.topup_requests%ROWTYPE;
  v_agency          public.agencies%ROWTYPE;
  v_reseller        public.resellers%ROWTYPE;
  v_is_admin        BOOLEAN;
  v_is_agency_owner BOOLEAN;
  v_is_reseller     BOOLEAN;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  SELECT * INTO v_request FROM public.topup_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'Request not found');
  END IF;
  IF v_request.status = 'confirmed' THEN
    RETURN json_build_object('success', false, 'message', 'Already confirmed');
  END IF;

  -- AuthZ — checked against THE CALLER (auth.uid()), not the supplied
  -- p_admin_id. p_admin_id is left in the signature for backward
  -- compatibility but the function ignores it.
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = me AND role IN ('admin','super_admin'))
    INTO v_is_admin;

  v_is_agency_owner := FALSE;
  v_is_reseller     := FALSE;

  IF v_request.agency_id IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.agencies WHERE id = v_request.agency_id AND owner_id = me)
      INTO v_is_agency_owner;
  END IF;

  IF v_request.reseller_id IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.resellers WHERE id = v_request.reseller_id AND user_id = me)
      INTO v_is_reseller;
  END IF;

  IF NOT (v_is_admin OR v_is_agency_owner OR v_is_reseller) THEN
    RETURN json_build_object('success', false, 'message', 'Not authorized');
  END IF;

  -- Agency-based: deduct from agency stock
  IF v_request.agency_id IS NOT NULL THEN
    SELECT * INTO v_agency FROM public.agencies WHERE id = v_request.agency_id FOR UPDATE;
    IF v_agency.diamond_balance < v_request.package_amount THEN
      RETURN json_build_object('success', false, 'message', 'Insufficient agency stock');
    END IF;
    UPDATE public.agencies SET diamond_balance = diamond_balance - v_request.package_amount
      WHERE id = v_request.agency_id;
  END IF;

  -- Reseller-based: deduct from reseller stock with admin-override window.
  IF v_request.reseller_id IS NOT NULL THEN
    SELECT * INTO v_reseller FROM public.resellers WHERE id = v_request.reseller_id FOR UPDATE;

    IF v_reseller.diamond_stock < v_request.package_amount THEN
      IF v_is_admin THEN
        INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
        VALUES (me, 'override_low_stock', 'reseller', v_reseller.id,
                jsonb_build_object('request_id', p_request_id,
                                   'shortfall', v_request.package_amount - v_reseller.diamond_stock));
      ELSE
        RETURN json_build_object('success', false, 'message', 'Insufficient reseller stock. Request bulk diamonds first.');
      END IF;
    ELSE
      UPDATE public.resellers
         SET diamond_stock = diamond_stock - v_request.package_amount,
             total_sold    = total_sold + v_request.package_amount
       WHERE id = v_request.reseller_id;
    END IF;
  END IF;

  -- Credit user
  UPDATE public.profiles SET diamonds = diamonds + v_request.package_amount
    WHERE id = v_request.user_id;

  UPDATE public.topup_requests
     SET status = 'confirmed', confirmed_by = me, confirmed_at = NOW()
   WHERE id = p_request_id;

  INSERT INTO public.transactions
    (user_id, related_user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
  VALUES (v_request.user_id, me, 'topup', 'diamond', v_request.package_amount,
          'topup_request', p_request_id, 'completed',
          CASE WHEN v_request.agency_id IS NOT NULL THEN 'Via agency stock' ELSE 'Via reseller' END);

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (me, 'confirm_topup', 'topup_request', p_request_id,
          jsonb_build_object('user_id', v_request.user_id,
                             'amount', v_request.package_amount,
                             'source', CASE WHEN v_request.agency_id IS NOT NULL THEN 'agency' ELSE 'reseller' END));

  RETURN json_build_object('success', true);
END $$;

GRANT EXECUTE ON FUNCTION public.confirm_topup_request(uuid, uuid) TO authenticated;