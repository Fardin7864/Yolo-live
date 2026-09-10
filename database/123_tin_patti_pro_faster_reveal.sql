-- Tin Patti Pro: shorten the post-bet resolution window.
-- The client shows a blinking board-frame animation during this window.

UPDATE public.game_settings
SET special_result_rules = jsonb_set(
  COALESCE(special_result_rules, '{}'::jsonb),
  '{bet_acceptance_grace_s}',
  '5'::jsonb,
  true
)
WHERE id = 'tin_patti_pro';
