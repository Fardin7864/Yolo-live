-- Keep Greedy King's authoritative betting window open for its complete
-- five-second visual spin. The client commits the main aggregate shortly
-- before countdown zero and uses this window only for genuine final taps,
-- retries with the same idempotency key, and slow-network delivery.
UPDATE public.game_settings
   SET special_result_rules = jsonb_set(
         COALESCE(special_result_rules, '{}'::JSONB),
         '{bet_acceptance_grace_s}',
         '5'::JSONB,
         TRUE
       ),
       updated_at = NOW()
 WHERE id = 'greedy_pro';
