-- Reserve one second for the authoritative card reveal followed by the same
-- five-second result popup used by Greedy Lion.

UPDATE public.game_settings
   SET result_display_s = 6,
       updated_at = NOW()
 WHERE id = 'tin_patti_pro';
