-- Teen Patti Pro: keep the locked/dealing phase brief. Four seconds leaves
-- enough time for authoritative bet settlement while staying within the
-- requested three-to-five-second reveal window.

UPDATE public.game_settings
   SET special_result_rules = jsonb_set(
         COALESCE(special_result_rules, '{}'::jsonb),
         '{bet_acceptance_grace_s}',
         '4'::jsonb,
         true
       ),
       updated_at = NOW()
 WHERE id = 'tin_patti_pro';
