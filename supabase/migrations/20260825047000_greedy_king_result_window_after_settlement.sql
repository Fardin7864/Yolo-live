-- Start Greedy King's result-display window only after all payout work has
-- completed. The legacy wrapper captured NOW() before settlement, allowing a
-- busy round to consume its own popup window while payouts were still running.

CREATE OR REPLACE FUNCTION public.resolve_greedy_pro_round(p_round_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  resolved_round public.game_rounds%ROWTYPE;
  grace_seconds INT := public.greedy_pro_bet_grace_seconds();
  resolved_payload JSON;
  completed_at TIMESTAMPTZ;
BEGIN
  SELECT * INTO resolved_round
    FROM public.game_rounds
   WHERE id = p_round_id
   FOR UPDATE;

  IF NOT FOUND OR resolved_round.game_type <> 'greedy_pro' THEN
    RETURN json_build_object('success', false, 'message', 'Greedy King round not found');
  END IF;

  IF resolved_round.status <> 'settled'
     AND resolved_round.ends_at + (grace_seconds || ' seconds')::interval > clock_timestamp() THEN
    RETURN json_build_object('success', false, 'message', 'Round has not ended yet');
  END IF;

  resolved_payload := public.resolve_greedy_pro_round_without_grace_115(p_round_id);

  IF COALESCE((resolved_payload->>'success')::boolean, false)
     AND COALESCE((resolved_payload->>'already_settled')::boolean, false) IS DISTINCT FROM TRUE THEN
    -- Capture this after the resolver returns, never before it starts.
    completed_at := clock_timestamp();
    UPDATE public.game_rounds
       SET result = jsonb_set(
             COALESCE(result, '{}'::jsonb),
             '{settled_at}',
             to_jsonb(completed_at),
             true
           )
     WHERE id = p_round_id
       AND game_type = 'greedy_pro'
       AND status = 'settled';

    resolved_payload := jsonb_set(
      resolved_payload::jsonb,
      '{settled_at}',
      to_jsonb(completed_at),
      true
    )::json;
  END IF;

  RETURN resolved_payload;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_greedy_pro_round(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_greedy_pro_round(UUID) TO authenticated, service_role;
