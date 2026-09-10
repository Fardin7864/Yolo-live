-- Preserve the deployed state RPC and replace only its legacy history filter.
-- Empty rounds have real authoritative winners and must appear in V2 history.

DO $$
BEGIN
  IF to_regprocedure('public.get_greedy_lion_state_filtered_152()') IS NULL THEN
    ALTER FUNCTION public.get_greedy_lion_state()
      RENAME TO get_greedy_lion_state_filtered_152;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.get_greedy_lion_state_filtered_152()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_greedy_lion_state()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_state JSONB;
  v_history JSONB;
BEGIN
  v_state := public.get_greedy_lion_state_filtered_152()::jsonb;
  IF COALESCE((v_state->>'success')::boolean, false) IS DISTINCT FROM TRUE THEN
    RETURN v_state::json;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.settled_at DESC), '[]'::jsonb)
    INTO v_history
    FROM (
      SELECT gr.id,
             gr.winner_pos,
             gr.result,
             gr.total_bet,
             gr.win_amount,
             COALESCE(
               (gr.result->>'settled_at')::timestamptz,
               gr.ends_at + (public.greedy_lion_bet_grace_seconds() || ' seconds')::interval,
               gr.started_at,
               gr.created_at
             ) AS settled_at
        FROM public.game_rounds gr
       WHERE gr.room_id = public.greedy_lion_global_room_id()
         AND gr.game_type = 'greedy_lion'
         AND gr.status = 'settled'
       ORDER BY COALESCE(gr.ends_at, gr.started_at, gr.created_at) DESC
       LIMIT 15
    ) h;

  RETURN jsonb_set(v_state, '{history}', v_history, true)::json;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_greedy_lion_state()
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_greedy_lion_state() IS
  'Greedy Lion authoritative state including settled empty-round history.';
