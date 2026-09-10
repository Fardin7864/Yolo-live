-- Daily mini-game ranking, reset at midnight in Asia/Dhaka.
-- Score is authoritative settled data: total bets + total wins.
CREATE OR REPLACE FUNCTION public.get_daily_game_ranking(
  p_game_type TEXT,
  p_limit INT DEFAULT 20
)
RETURNS TABLE (
  user_id UUID,
  name TEXT,
  avatar_url TEXT,
  total_bet BIGINT,
  total_win BIGINT,
  score BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    b.user_id,
    COALESCE(NULLIF(BTRIM(p.full_name), ''), 'Player') AS name,
    p.avatar_url,
    SUM(b.amount)::BIGINT AS total_bet,
    SUM(b.win_amount)::BIGINT AS total_win,
    (SUM(b.amount) + SUM(b.win_amount))::BIGINT AS score
  FROM public.game_round_bets b
  JOIN public.game_rounds r ON r.id = b.round_id
  LEFT JOIN public.profiles p ON p.id = b.user_id
  WHERE p_game_type IN ('greedy_lion', 'tin_patti_pro')
    AND r.game_type = p_game_type
    AND b.created_at >= (
      date_trunc('day', NOW() AT TIME ZONE 'Asia/Dhaka')
      AT TIME ZONE 'Asia/Dhaka'
    )
  GROUP BY b.user_id, p.full_name, p.avatar_url
  ORDER BY score DESC, total_win DESC, total_bet DESC, b.user_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100));
$$;

REVOKE ALL ON FUNCTION public.get_daily_game_ranking(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_daily_game_ranking(TEXT, INT) TO authenticated, service_role;
