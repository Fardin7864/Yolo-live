-- =====================================================================
-- 113_greedy_lion_show_empty_history.sql
-- Keep marking empty Greedy Lion rounds, but show them in result history.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.get_greedy_lion_state()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  v_settings public.game_settings%ROWTYPE;
  v_round public.game_rounds%ROWTYPE;
  v_display INT;
  v_bets JSONB := '[]'::jsonb;
  v_history JSONB := '[]'::jsonb;
  v_my_balance BIGINT;
  v_my_bet BIGINT := 0;
BEGIN
  PERFORM public.greedy_lion_tick();
  SELECT * INTO v_settings FROM public.game_settings WHERE id = 'greedy_lion';
  v_display := GREATEST(3, LEAST(60, COALESCE(v_settings.result_display_s, 15)));

  SELECT * INTO v_round
    FROM public.game_rounds
   WHERE room_id = public.greedy_lion_global_room_id()
     AND game_type = 'greedy_lion'
     AND (
       (status = 'betting' AND ends_at > NOW())
       OR
       (status = 'settled' AND ends_at + (v_display || ' seconds')::interval > NOW())
     )
   ORDER BY
     CASE WHEN status = 'betting' THEN 0 ELSE 1 END,
     started_at DESC
   LIMIT 1;

  IF FOUND THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.created_at ASC), '[]'::jsonb)
      INTO v_bets
      FROM public.game_round_bets b
     WHERE b.round_id = v_round.id;

    IF me IS NOT NULL THEN
      SELECT COALESCE(SUM(amount), 0)
        INTO v_my_bet
        FROM public.game_round_bets
       WHERE round_id = v_round.id AND user_id = me;
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.settled_at DESC), '[]'::jsonb)
    INTO v_history
  FROM (
    SELECT gr.id,
           gr.winner_pos,
           gr.result,
           gr.total_bet,
           gr.win_amount,
           COALESCE(gr.ends_at, gr.started_at, gr.created_at) AS settled_at
      FROM public.game_rounds gr
     WHERE gr.room_id = public.greedy_lion_global_room_id()
       AND gr.game_type = 'greedy_lion'
       AND gr.status = 'settled'
     ORDER BY COALESCE(gr.ends_at, gr.started_at, gr.created_at) DESC
     LIMIT 15
  ) h;

  IF me IS NOT NULL THEN
    SELECT diamonds INTO v_my_balance FROM public.profiles WHERE id = me;
  END IF;

  RETURN json_build_object(
    'success', true,
    'server_now', NOW(),
    'settings', to_jsonb(v_settings),
    'round', CASE WHEN v_round.id IS NULL THEN NULL ELSE to_jsonb(v_round) END,
    'bets', v_bets,
    'history', v_history,
    'my_balance', v_my_balance,
    'my_round_bet', v_my_bet
  );
END $$;

CREATE OR REPLACE FUNCTION public.get_greedy_lion_history(
  p_limit INT DEFAULT 15
)
RETURNS TABLE (
  id UUID,
  winner_pos TEXT,
  result JSONB,
  settled_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT gr.id, gr.winner_pos, gr.result, COALESCE(gr.ends_at, gr.started_at, gr.created_at) AS settled_at
    FROM public.game_rounds gr
   WHERE gr.room_id = public.greedy_lion_global_room_id()
     AND gr.game_type = 'greedy_lion'
     AND gr.status = 'settled'
   ORDER BY COALESCE(gr.ends_at, gr.started_at, gr.created_at) DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 15), 1), 15);
$$;

GRANT EXECUTE ON FUNCTION public.get_greedy_lion_state() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_greedy_lion_history(INT) TO authenticated, service_role;
