-- Leave a small server-authoritative delivery margin around the five-second
-- client result presentation. This prevents the next global round from
-- replacing a result while Realtime or a boundary bet batch is still arriving.

UPDATE public.game_settings
   SET result_display_s = CASE id
         WHEN 'greedy_lion' THEN 6
         WHEN 'tin_patti_pro' THEN 7
         ELSE result_display_s
       END,
       updated_at = NOW()
 WHERE id IN ('greedy_lion', 'tin_patti_pro');
