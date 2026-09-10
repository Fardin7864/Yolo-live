-- Expose every qualifying result winner needed by the global FIFO banner.
-- The game clients merge robot winners after this server-authoritative list,
-- so this function intentionally reads settled real-user payouts only.

DO $$
BEGIN
  IF to_regclass('public.game_round_bets') IS NULL
     OR to_regprocedure('public.decorate_realtime_game_state(jsonb,boolean)') IS NULL THEN
    RAISE EXCEPTION 'Realtime game state prerequisites are missing';
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS game_round_bets_round_winner_idx
  ON public.game_round_bets(round_id, user_id)
  WHERE win_amount > 0;

CREATE OR REPLACE FUNCTION public.authoritative_game_top_winners(
  p_round_id UUID,
  p_limit INTEGER DEFAULT 10
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    jsonb_agg(to_jsonb(winner_row) ORDER BY winner_row.win_amount DESC, winner_row.user_id),
    '[]'::jsonb
  )
  FROM (
    SELECT bets.user_id,
           COALESCE(NULLIF(profiles.full_name, ''), 'Player') AS name,
           profiles.avatar_url,
           SUM(bets.win_amount)::BIGINT AS win_amount
      FROM public.game_round_bets bets
      LEFT JOIN public.profiles profiles ON profiles.id = bets.user_id
     WHERE bets.round_id = p_round_id
       AND bets.win_amount > 0
     GROUP BY bets.user_id, profiles.full_name, profiles.avatar_url
     ORDER BY SUM(bets.win_amount) DESC, bets.user_id
     LIMIT LEAST(100, GREATEST(1, COALESCE(p_limit, 10)))
  ) winner_row;
$$;

CREATE OR REPLACE FUNCTION public.decorate_realtime_game_state(
  p_state JSONB,
  p_include_robot_bets BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  round_id UUID;
  round_version BIGINT;
  round_updated_at TIMESTAMPTZ;
  decorated_state JSONB;
BEGIN
  BEGIN
    round_id := NULLIF(p_state #>> '{round,id}', '')::UUID;
  EXCEPTION WHEN OTHERS THEN
    round_id := NULL;
  END;
  IF round_id IS NULL THEN
    RETURN p_state || jsonb_build_object('snapshot_at', clock_timestamp());
  END IF;

  SELECT state_version, state_updated_at
    INTO round_version, round_updated_at
    FROM public.game_rounds
   WHERE id = round_id;

  decorated_state := jsonb_set(
    p_state,
    '{bet_totals}',
    public.authoritative_game_bet_totals(round_id, p_include_robot_bets),
    true
  ) || jsonb_build_object(
    'state_version', COALESCE(round_version, 0),
    'state_updated_at', round_updated_at,
    'snapshot_at', clock_timestamp()
  );

  IF jsonb_typeof(decorated_state #> '{round,result}') = 'object' THEN
    decorated_state := jsonb_set(
      decorated_state,
      '{round,result,top_winners}',
      public.authoritative_game_top_winners(round_id, 10),
      true
    );
  END IF;

  RETURN decorated_state;
END;
$$;

REVOKE ALL ON FUNCTION public.authoritative_game_top_winners(UUID, INTEGER)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decorate_realtime_game_state(JSONB, BOOLEAN)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.authoritative_game_top_winners(UUID, INTEGER)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.authoritative_game_top_winners(UUID, INTEGER) IS
  'Returns an ordered, server-authoritative winner list for FIFO global notifications.';

NOTIFY pgrst, 'reload schema';
