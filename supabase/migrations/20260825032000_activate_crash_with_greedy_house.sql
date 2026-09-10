-- Explicit production activation requested by the owner: use the same funded
-- payout-owner profile as Greedy Lion and publish Crash in all game lists.
DO $$
DECLARE
  selected_house UUID;
  house_balance BIGINT;
BEGIN
  SELECT house_profile_id INTO selected_house
  FROM public.game_settings
  WHERE id='greedy_lion';

  IF selected_house IS NULL THEN
    RAISE EXCEPTION 'Greedy Lion does not have a configured house profile';
  END IF;

  SELECT diamonds INTO house_balance
  FROM public.profiles
  WHERE id=selected_house
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Greedy Lion house profile no longer exists';
  END IF;
  IF COALESCE(house_balance,0)<=0 THEN
    RAISE EXCEPTION 'Greedy Lion house profile is not funded';
  END IF;

  UPDATE public.crash_game_configs
  SET house_profile_id=selected_house,
      is_active=TRUE,
      maintenance=FALSE,
      config_version=config_version+1,
      updated_at=NOW()
  WHERE game_id='crash' AND table_id='global';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Crash configuration is missing';
  END IF;

  INSERT INTO public.game_settings(id,is_active,win_chance_percent,house_profile_id,updated_at)
  VALUES('crash',TRUE,100,selected_house,NOW())
  ON CONFLICT(id) DO UPDATE SET
    is_active=TRUE,
    house_profile_id=EXCLUDED.house_profile_id,
    updated_at=NOW();
END $$;

NOTIFY pgrst,'reload schema';
