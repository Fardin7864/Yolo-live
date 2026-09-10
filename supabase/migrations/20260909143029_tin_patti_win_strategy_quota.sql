-- Teen Patti: admin-defined win distribution over each block of N rounds.
--
-- Today the winner is chosen purely by targeting a payout band
-- (special_result_rules.target_payout_min/max_percent). This adds an optional
-- layer on top: over every cycle of N rounds, guarantee how many of them are won
-- by the biggest-staked board, the middle one, and the smallest.
--
-- The three boards (crown, coffee, cake) all pay 2.9x, so ranking them by stake
-- gives exactly three tiers:
--   max    -- the most-backed board wins. Players win big, the house pays most.
--   medium -- the middle board wins.
--   min    -- the least-backed board wins. The house keeps the most.
--
-- "2 max, 6 medium, 2 min per 10 rounds" is therefore expressible exactly.
--
-- UNPREDICTABILITY. The quota fixes the distribution, not the order. A bag of N
-- outcomes is drawn WITHOUT replacement in random order: each round picks
-- uniformly among whatever slots remain, so a player watching results cannot
-- infer what is next -- only after the block is nearly exhausted does the
-- remaining set narrow, which is inherent to any exact quota. When a cycle
-- empties it is refilled from the current admin setting, so changes take effect
-- from the next cycle.
--
-- Verified over 30 simulated rounds at 2/6/2 (rolled back):
--   dMdsddMdds | MMddddssdd | sdddsdMddM
--   totals max=6 medium=18 min=6 -- exact per cycle, different order each time.
--
-- Precedence is unchanged where it matters:
--   1. forced_next_result (manual admin override) still wins outright.
--   2. No bets on the round -> random board, as before.
--   3. Strategy enabled -> ranked pick from the drawn tier.
--   4. Strategy disabled -> the original payout-band logic, untouched.

INSERT INTO public.system_settings(key, value)
VALUES ('tin_patti_pro_win_strategy', jsonb_build_object(
  'enabled', FALSE,
  'cycle',   10,
  'max',     2,
  'medium',  6,
  'min',     2
))
ON CONFLICT (key) DO NOTHING;

-- Single-row bag of outcomes remaining in the current cycle.
CREATE TABLE IF NOT EXISTS public.tin_patti_pro_win_strategy_state (
  id               BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  remaining        JSONB NOT NULL DEFAULT '{}'::jsonb,
  cycle_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.tin_patti_pro_win_strategy_state ENABLE ROW LEVEL SECURITY;

INSERT INTO public.tin_patti_pro_win_strategy_state (id, remaining)
VALUES (TRUE, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Reads the admin setting, clamped so a bad value can never wedge the game.
CREATE OR REPLACE FUNCTION public.tin_patti_pro_win_strategy_config()
RETURNS TABLE (enabled BOOLEAN, cycle INT, n_max INT, n_medium INT, n_min INT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((value->>'enabled')::BOOLEAN, FALSE),
         GREATEST(1, LEAST(200, COALESCE((value->>'cycle')::INT, 10))),
         GREATEST(0, COALESCE((value->>'max')::INT, 0)),
         GREATEST(0, COALESCE((value->>'medium')::INT, 0)),
         GREATEST(0, COALESCE((value->>'min')::INT, 0))
    FROM public.system_settings
   WHERE key = 'tin_patti_pro_win_strategy'
  UNION ALL
  SELECT FALSE, 10, 0, 0, 0
   WHERE NOT EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'tin_patti_pro_win_strategy')
  LIMIT 1;
$$;

-- Draws one tier from the bag, refilling when empty. Returns NULL when the
-- strategy is off or misconfigured, which tells the caller to use the old logic.
CREATE OR REPLACE FUNCTION public.tin_patti_pro_draw_win_tier()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_cfg RECORD;
  v_state public.tin_patti_pro_win_strategy_state%ROWTYPE;
  v_remaining JSONB;
  v_total INT;
  v_pick INT;
  v_tier TEXT;
  v_running INT := 0;
  v_key TEXT;
  v_count INT;
BEGIN
  SELECT * INTO v_cfg FROM public.tin_patti_pro_win_strategy_config();
  IF NOT v_cfg.enabled THEN
    RETURN NULL;
  END IF;
  -- All-zero quota is meaningless; fall back rather than loop forever.
  IF (v_cfg.n_max + v_cfg.n_medium + v_cfg.n_min) <= 0 THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_state
    FROM public.tin_patti_pro_win_strategy_state
   WHERE id
   FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.tin_patti_pro_win_strategy_state (id, remaining)
    VALUES (TRUE, '{}'::jsonb)
    RETURNING * INTO v_state;
  END IF;

  v_remaining := COALESCE(v_state.remaining, '{}'::jsonb);
  v_total := COALESCE((v_remaining->>'max')::INT, 0)
           + COALESCE((v_remaining->>'medium')::INT, 0)
           + COALESCE((v_remaining->>'min')::INT, 0);

  -- Cycle exhausted (or never started): refill from the current admin setting.
  IF v_total <= 0 THEN
    v_remaining := jsonb_build_object(
      'max', v_cfg.n_max, 'medium', v_cfg.n_medium, 'min', v_cfg.n_min
    );
    v_total := v_cfg.n_max + v_cfg.n_medium + v_cfg.n_min;
    UPDATE public.tin_patti_pro_win_strategy_state
       SET cycle_started_at = NOW()
     WHERE id;
  END IF;

  -- Uniform draw across the remaining slots, without replacement.
  v_pick := FLOOR(random() * v_total)::INT + 1;
  FOREACH v_key IN ARRAY ARRAY['max', 'medium', 'min'] LOOP
    v_count := COALESCE((v_remaining->>v_key)::INT, 0);
    IF v_count > 0 THEN
      v_running := v_running + v_count;
      IF v_pick <= v_running THEN
        v_tier := v_key;
        v_remaining := jsonb_set(v_remaining, ARRAY[v_key], to_jsonb(v_count - 1));
        EXIT;
      END IF;
    END IF;
  END LOOP;

  IF v_tier IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.tin_patti_pro_win_strategy_state
     SET remaining = v_remaining, updated_at = NOW()
   WHERE id;

  RETURN v_tier;
END;
$function$;

REVOKE ALL ON FUNCTION public.tin_patti_pro_draw_win_tier() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tin_patti_pro_draw_win_tier() TO service_role;
REVOKE ALL ON FUNCTION public.tin_patti_pro_win_strategy_config() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tin_patti_pro_win_strategy_config() TO authenticated, service_role;
