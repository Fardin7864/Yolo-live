-- Greedy King commits one total per position at the betting boundary. That
-- total is a sum of visible 500/1K/5K/50K/100K chips, so it can be larger than
-- a single denomination while still being a valid chip aggregate.

CREATE OR REPLACE FUNCTION public.validate_game_chip_denomination()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  round_game_type TEXT;
BEGIN
  SELECT game_type INTO round_game_type
    FROM public.game_rounds
   WHERE id = NEW.round_id;

  IF round_game_type = 'greedy_lion'
     AND NEW.amount <> ALL (ARRAY[1000, 5000, 50000, 100000]::BIGINT[]) THEN
    RAISE EXCEPTION 'Invalid chip amount. Use 1K, 5K, 50K, or 100K.' USING ERRCODE = '22023';
  END IF;

  IF round_game_type = 'tin_patti_pro'
     AND NEW.amount <> ALL (ARRAY[500, 1000, 5000, 50000, 100000]::BIGINT[]) THEN
    RAISE EXCEPTION 'Invalid real-time game chip amount.' USING ERRCODE = '22023';
  END IF;

  IF round_game_type = 'greedy_pro'
     AND (NEW.amount <= 0 OR NEW.amount % 500 <> 0) THEN
    RAISE EXCEPTION 'Invalid Greedy King chip aggregate.' USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

