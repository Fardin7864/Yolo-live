-- Keep Greedy King's settlement duration independent of repeated/high-value
-- taps. One aggregate row per player and item is enough for authoritative
-- totals and payouts; batch response ids are only reconciliation hints.

CREATE OR REPLACE FUNCTION public.compact_greedy_pro_bet_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  existing_bet_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.game_rounds
     WHERE id = NEW.round_id
       AND game_type = 'greedy_pro'
  ) THEN
    RETURN NULL;
  END IF;

  SELECT id INTO existing_bet_id
    FROM public.game_round_bets
   WHERE round_id = NEW.round_id
     AND user_id = NEW.user_id
     AND position = NEW.position
     AND id <> NEW.id
   ORDER BY created_at, id
   LIMIT 1
   FOR UPDATE;

  IF existing_bet_id IS NOT NULL THEN
    UPDATE public.game_round_bets
       SET amount = amount + NEW.amount
     WHERE id = existing_bet_id;
    DELETE FROM public.game_round_bets WHERE id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS compact_greedy_pro_bet_row_trigger ON public.game_round_bets;
CREATE TRIGGER compact_greedy_pro_bet_row_trigger
AFTER INSERT ON public.game_round_bets
FOR EACH ROW EXECUTE FUNCTION public.compact_greedy_pro_bet_row();

UPDATE public.game_settings
   SET result_display_s = 7,
       special_result_rules = jsonb_set(
         jsonb_set(
           COALESCE(special_result_rules, '{}'::jsonb),
           '{bet_acceptance_grace_s}',
           '3'::jsonb,
           true
         ),
         '{post_betting_block_s}',
         '3'::jsonb,
         true
       ),
       updated_at = NOW()
 WHERE id = 'greedy_pro';

REVOKE ALL ON FUNCTION public.compact_greedy_pro_bet_row() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compact_greedy_pro_bet_row() TO service_role;
