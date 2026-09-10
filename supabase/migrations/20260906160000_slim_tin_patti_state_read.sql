-- Teen Patti Pro: make the state read cheap enough to poll.
--
-- `get_tin_patti_pro_state` had accreted into a stack of wrappers:
--   get_tin_patti_pro_state -> decorate_realtime_game_state(get_tin_patti_pro_state_core_169())
--   core_169 -> first_cards over get_tin_patti_pro_state_base_154()
--   base_154 -> the original body (tick, settings, bets+profiles join, history)
--
-- Every client poll therefore paid for:
--   * an 80-row `game_round_bets` LEFT JOIN `profiles`, which the client throws
--     away - `loadPublicBets()` refetches the bets and resolves names itself via
--     `loadProfiles()`, so the join was pure waste on every enriched refresh;
--   * `authoritative_game_top_winners()`, a bets->profiles GROUP BY, recomputed
--     on *every* call including the whole betting phase when, by definition, no
--     winners exist yet.
--
-- Measured: 2-3s per call serially, and 6 concurrent callers all hit the 8s
-- statement timeout.
--
-- This collapses the chain into one function with the identical payload
-- contract, so no client change is required and builds already in the field
-- benefit immediately. The differences are only in what work is skipped:
--   * public bets are returned without the profiles join (client attaches names)
--   * top winners are computed only once the round is settled
--   * bet totals come from the materialised `game_round_position_totals`
--   * round/bets/history lookups ride the indexes added in 20260906150000
--
-- The guarded `tin_patti_pro_tick()` call is deliberately kept: it is a cheap
-- no-op for all but one caller now, and it keeps clients working as a fallback
-- clock if the cron coordinator is ever stopped.

CREATE INDEX IF NOT EXISTS game_rounds_room_game_status_ends_idx
  ON public.game_rounds (room_id, game_type, status, ends_at DESC);

DO $$
BEGIN
  IF to_regprocedure('public.tin_patti_pro_first_cards(uuid)') IS NULL
     OR to_regprocedure('public.tin_patti_pro_bet_grace_seconds()') IS NULL
     OR to_regprocedure('public.authoritative_game_bet_totals(uuid,boolean)') IS NULL
     OR to_regprocedure('public.authoritative_game_top_winners(uuid,integer)') IS NULL THEN
    RAISE EXCEPTION 'Teen Patti state prerequisites are missing';
  END IF;
END;
$$;

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
  PERFORM public.tin_patti_pro_tick();

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
  'Teen Patti Pro state. Flattened from the wrapper chain: no profiles join on '
  'public bets, top winners only once settled, totals from the materialised table.';
