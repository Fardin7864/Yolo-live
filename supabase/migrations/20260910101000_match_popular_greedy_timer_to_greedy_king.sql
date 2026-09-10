-- Popular Greedy uses its own rounds and settlement logic. Only copy the three
-- timing controls from Greedy King so both games present the same round cadence.
UPDATE public.game_settings AS popular
SET round_duration_s = king.round_duration_s,
    result_display_s = king.result_display_s,
    special_result_rules = jsonb_set(
      jsonb_set(
        COALESCE(popular.special_result_rules, '{}'::JSONB),
        '{bet_acceptance_grace_s}',
        COALESCE(king.special_result_rules->'bet_acceptance_grace_s', '3'::JSONB),
        TRUE
      ),
      '{post_betting_block_s}',
      COALESCE(king.special_result_rules->'post_betting_block_s', '3'::JSONB),
      TRUE
    ),
    updated_at = NOW()
FROM public.game_settings AS king
WHERE popular.id = 'greedy_lion'
  AND king.id = 'greedy_pro';
