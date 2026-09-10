-- Match Popular Greedy's backend-only allowance for the one round-boundary
-- batch. The visible betting countdown still ends normally; this window gives
-- the aggregate RPC time to arrive before Greedy King reveals the winner.

UPDATE public.game_settings
   SET special_result_rules = jsonb_set(
         COALESCE(special_result_rules, '{}'::JSONB),
         '{bet_acceptance_grace_s}',
         '10'::JSONB,
         TRUE
       ),
       updated_at = NOW()
 WHERE id = 'greedy_pro';

