-- Greedy Lion round timing:
--   30 seconds betting -> 10 seconds spinning/settlement -> 10 seconds result.
-- The existing client treats the backend acceptance grace as the spin phase,
-- so the authoritative round engine and every client use the same clock.

UPDATE public.game_settings
   SET round_duration_s = 30,
       result_display_s = 10,
       special_result_rules = jsonb_set(
         jsonb_set(
           COALESCE(special_result_rules, '{}'::jsonb),
           '{bet_acceptance_grace_s}',
           '10'::jsonb,
           TRUE
         ),
         '{post_betting_block_s}',
         '10'::jsonb,
         TRUE
       )
 WHERE id = 'greedy_lion';
