-- Remove the retired Fruit Roulette and classic Teen Patti games from all
-- clients that still honor the server-side game_settings switches.
-- Historical rounds and transactions remain intact for accounting/audit.
UPDATE public.game_settings
   SET is_active = FALSE,
       updated_at = NOW()
 WHERE id IN ('fruit_roulette', 'teen_patti');
