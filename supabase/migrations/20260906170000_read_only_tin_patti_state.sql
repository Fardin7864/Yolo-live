-- Make the Teen Patti state read genuinely read-only.
--
-- 20260906140000 made tin_patti_pro_tick() self-guarding so concurrent callers
-- skip instead of blocking, which stopped the timeouts. But one caller per moment
-- still paid the full engine cost inside what is supposed to be a read, and that
-- was the bulk of the remaining latency (12 concurrent readers still took ~5s).
--
-- The cron coordinator has now been verified running:
--   jobname 'authoritative-mini-game-clock', schedule '1 second', active = true
-- with the superseded 10-second jobs inactive. The read no longer needs to drive
-- the clock, so drop the tick from it.
--
-- This is not a single point of failure: place_tin_patti_pro_bet still calls the
-- (guarded) tick, so any betting activity nudges the clock forward even if cron
-- were ever stopped. Reads simply stop doing writes.
CREATE OR REPLACE FUNCTION public.get_tin_patti_pro_state()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me           UUID := auth.uid();
  v_room       UUID := public.tin_patti_pro_global_room_id();
  v_settings   public.game_settings%ROWTYPE;
  v_round      public.game_rounds%ROWTYPE;
  v_display    INT;
  v_grace      INT;
  v_public     JSONB := '[]'::jsonb;
  v_my_bets    JSONB := '[]'::jsonb;
  v_totals     JSONB := '{}'::jsonb;
  v_history    JSONB := '[]'::jsonb;
  v_result     JSONB := '{}'::jsonb;
  v_first      JSONB := 'null'::jsonb;
  v_balance    BIGINT;
  v_my_bet     BIGINT := 0;
BEGIN
  -- No tick here: the cron coordinator owns the clock (verified active at 1s).
  -- place_tin_patti_pro_bet still ticks, so betting remains a fallback clock.

  SELECT * INTO v_settings FROM public.game_settings gs WHERE gs.id = 'tin_patti_pro';
  IF NOT FOUND THEN
    RETURN json_build_object(
      'success', false,
      'message', 'Tin Patti Pro settings not found',
      'server_now', NOW()
    );
  END IF;

  v_display := GREATEST(3, LEAST(60, COALESCE(v_settings.result_display_s, 15)));
  v_grace   := public.tin_patti_pro_bet_grace_seconds();

  SELECT * INTO v_round
    FROM public.game_rounds
   WHERE room_id = v_room
     AND game_type = 'tin_patti_pro'
     AND (
       (status = 'betting'
          AND ends_at + (v_grace || ' seconds')::interval > NOW())
       OR
       (status = 'settled'
          AND COALESCE(
                (result->>'settled_at')::timestamptz,
                ends_at + (v_grace || ' seconds')::interval
              ) + (v_display || ' seconds')::interval > NOW())
     )
   ORDER BY CASE WHEN status = 'settled' THEN 0 ELSE 1 END, started_at DESC
   LIMIT 1;

  IF v_round.id IS NOT NULL THEN
    -- No profiles join: the client resolves names through loadProfiles().
    SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb)
      INTO v_public
      FROM (
        SELECT b.id, b.round_id, b.user_id, b.position,
               b.amount, b.win_amount, b.created_at
          FROM public.game_round_bets b
         WHERE b.round_id = v_round.id
         ORDER BY b.created_at DESC
         LIMIT 80
      ) t;

    v_totals := public.authoritative_game_bet_totals(v_round.id, TRUE);

    IF me IS NOT NULL THEN
      SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.created_at ASC), '[]'::jsonb),
             COALESCE(SUM(b.amount), 0)
        INTO v_my_bets, v_my_bet
        FROM public.game_round_bets b
       WHERE b.round_id = v_round.id
         AND b.user_id = me;
    END IF;

    v_result := COALESCE(to_jsonb(v_round) -> 'result', '{}'::jsonb);
    IF jsonb_typeof(v_result) <> 'object' THEN
      v_result := '{}'::jsonb;
    END IF;

    v_first := COALESCE(
      NULLIF(v_result -> 'first_cards', 'null'::jsonb),
      public.tin_patti_pro_first_cards(v_round.id)
    );
    v_result := jsonb_set(v_result, '{first_cards}', v_first, true);

    -- Only settled rounds have winners; skip the profiles GROUP BY otherwise.
    IF v_round.status = 'settled' THEN
      v_result := jsonb_set(
        v_result, '{top_winners}',
        public.authoritative_game_top_winners(v_round.id, 10), true
      );
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.settled_at DESC), '[]'::jsonb)
    INTO v_history
    FROM (
      SELECT gr.id, gr.winner_pos, gr.result, gr.total_bet, gr.win_amount,
             COALESCE(
               (gr.result->>'settled_at')::timestamptz,
               gr.ends_at + (v_grace || ' seconds')::interval,
               gr.started_at, gr.created_at
             ) AS settled_at
        FROM public.game_rounds gr
       WHERE gr.room_id = v_room
         AND gr.game_type = 'tin_patti_pro'
         AND gr.status = 'settled'
       ORDER BY gr.ends_at DESC
       LIMIT 15
    ) h;

  IF me IS NOT NULL THEN
    SELECT p.diamonds INTO v_balance FROM public.profiles p WHERE p.id = me;
  END IF;

  RETURN json_build_object(
    'success',          true,
    'server_now',       NOW(),
    'settings',         to_jsonb(v_settings),
    'round',            CASE
                          WHEN v_round.id IS NULL THEN NULL
                          ELSE to_jsonb(v_round) || jsonb_build_object('result', v_result)
                        END,
    'bets',             v_public,
    'public_bets',      v_public,
    'my_bets',          v_my_bets,
    'bet_totals',       v_totals,
    'history',          v_history,
    'my_balance',       v_balance,
    'my_round_bet',     v_my_bet,
    'first_cards',      v_first,
    'state_version',    COALESCE(v_round.state_version, 0),
    'state_updated_at', v_round.state_updated_at,
    'snapshot_at',      clock_timestamp()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_tin_patti_pro_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tin_patti_pro_state() TO authenticated, service_role;

COMMENT ON FUNCTION public.get_tin_patti_pro_state() IS
  'Teen Patti Pro state. Read-only: the cron coordinator owns the round clock.';

REVOKE ALL ON FUNCTION public.get_tin_patti_pro_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tin_patti_pro_state() TO authenticated, service_role;
