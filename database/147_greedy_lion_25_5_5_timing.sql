-- Greedy Lion authoritative cycle:
--   25 seconds betting -> 5 seconds settlement/item spin -> 5 seconds result.
UPDATE public.game_settings
   SET round_duration_s = 25,
       result_display_s = 5,
       special_result_rules = jsonb_set(
         jsonb_set(
           COALESCE(special_result_rules, '{}'::jsonb),
           '{bet_acceptance_grace_s}',
           '5'::jsonb,
           TRUE
         ),
         '{post_betting_block_s}',
         '5'::jsonb,
         TRUE
       )
 WHERE id = 'greedy_lion';
