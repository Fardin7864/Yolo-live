-- Keep both active games on the same four chip denominations. Enforce this
-- in the database as well as the app so outdated or modified clients cannot
-- submit arbitrary bet amounts.

CREATE OR REPLACE FUNCTION public.validate_game_chip_denomination()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_game_type TEXT;
BEGIN
  SELECT gr.game_type
    INTO v_game_type
    FROM public.game_rounds gr
   WHERE gr.id = NEW.round_id;

  IF v_game_type IN ('greedy_lion', 'tin_patti_pro')
     AND NEW.amount <> ALL (ARRAY[1000, 5000, 50000, 100000]::BIGINT[]) THEN
    RAISE EXCEPTION 'Invalid chip amount. Use 1K, 5K, 50K, or 100K.'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS validate_game_chip_denomination_trigger
  ON public.game_round_bets;
CREATE TRIGGER validate_game_chip_denomination_trigger
  BEFORE INSERT OR UPDATE OF amount, round_id ON public.game_round_bets
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_game_chip_denomination();

