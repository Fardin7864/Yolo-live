-- Wealth levels 1-110. Level progress is derived exclusively from valid
-- gifts sent to another user, never from purchases, games, top-ups or admin
-- balance changes.

ALTER TABLE public.level_thresholds
  DROP CONSTRAINT IF EXISTS level_thresholds_level_check;
ALTER TABLE public.level_thresholds
  ADD CONSTRAINT level_thresholds_level_check CHECK (level BETWEEN 1 AND 110);

INSERT INTO public.level_thresholds(level,min_exp) VALUES
  (1,0),(2,3000),(3,6000),(4,16000),(5,66000),(6,166000),(7,330000),(8,500000),(9,700000),
  (10,1000000),(11,1100000),(12,1300000),(13,1600000),(14,2000000),(15,2600000),(16,3400000),(17,4400000),
  (18,5600000),(19,7000000),(20,10000000),(21,10500000),(22,11500000),(23,13000000),(24,15000000),
  (25,18000000),(26,22000000),(27,27000000),(28,33000000),(29,40000000),(30,50000000),(31,52000000),
  (32,55000000),(33,60000000),(34,68000000),(35,79000000),(36,95000000),(37,114000000),(38,137000000),
  (39,163000000),(40,200000000),(41,204000000),(42,210000000),(43,220000000),(44,236000000),
  (45,258000000),(46,290000000),(47,328000000),(48,375000000),(49,428000000),(50,500000000),
  (51,506000000),(52,516000000),(53,535000000),(54,560000000),(55,598000000),(56,648000000),
  (57,710000000),(58,785000000),(59,870000000),(60,1000000000),(61,1020000000),(62,1060000000),
  (63,1120000000),(64,1220000000),(65,1360000000),(66,1560000000),(67,1800000000),(68,2100000000),
  (69,2440000000),(70,3000000000),(71,3020000000),(72,3060000000),(73,3120000000),(74,3220000000),
  (75,3360000000),(76,3560000000),(77,3800000000),(78,4100000000),(79,4440000000),(80,5000000000),
  (81,5050000000),(82,5150000000),(83,5300000000),(84,5550000000),(85,5900000000),(86,6400000000),
  (87,7000000000),(88,7750000000),(89,8600000000),(90,10000000000),(91,10100000000),(92,10300000000),
  (93,10600000000),(94,11100000000),(95,11800000000),(96,12800000000),(97,14000000000),(98,15500000000),
  (99,17200000000),(100,20600000000),(101,20710000000),(102,20930000000),(103,21260000000),
  (104,21810000000),(105,22420000000),(106,23100000000),(107,23920000000),(108,24900000000),
  (109,26050000000),(110,27400000000)
ON CONFLICT(level) DO UPDATE SET min_exp=EXCLUDED.min_exp;

-- Remove any obsolete rows above the supported chart range.
DELETE FROM public.level_thresholds WHERE level > 110;

CREATE OR REPLACE FUNCTION public.recalc_user_level(p_user_id UUID)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_exp BIGINT;
  v_old_level INT;
  v_new_level INT;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_user_id) THEN RETURN NULL; END IF;

  -- gifts_log is the authority. Self-gifts, zero/negative rows and malformed
  -- rows never contribute even if they exist in legacy data.
  SELECT COALESCE(SUM(g.diamond_cost),0)::BIGINT INTO v_exp
  FROM public.gifts_log g
  WHERE g.sender_id=p_user_id
    AND g.receiver_id IS DISTINCT FROM p_user_id
    AND COALESCE(g.diamond_cost,0)>0
    AND COALESCE(g.count,1)>0;

  SELECT COALESCE(level,1) INTO v_old_level FROM public.profiles WHERE id=p_user_id FOR UPDATE;
  SELECT COALESCE(MAX(level),1) INTO v_new_level FROM public.level_thresholds WHERE min_exp<=v_exp;
  v_new_level:=GREATEST(1,LEAST(110,v_new_level));

  PERFORM set_config('green_live.level_recalc','1',TRUE);
  UPDATE public.profiles
  SET lifetime_diamonds_spent=v_exp, level=v_new_level
  WHERE id=p_user_id
    AND (lifetime_diamonds_spent IS DISTINCT FROM v_exp OR level IS DISTINCT FROM v_new_level);
  PERFORM set_config('green_live.level_recalc','0',TRUE);

  IF v_new_level>v_old_level THEN
    PERFORM public.maybe_notify(
      p_user_id,'level_up','Wealth level increased! 🎉',
      'You reached wealth level '||v_new_level||' by sending gifts.',
      jsonb_build_object('old_level',v_old_level,'new_level',v_new_level,'gifted_diamonds',v_exp)
    );
  END IF;
  RETURN v_new_level;
END $$;

-- Keep the existing editable profile fields, while protecting both cached
-- wealth fields from direct client updates. recalc_user_level marks only its
-- own derived UPDATE as trusted.
CREATE OR REPLACE FUNCTION public.protect_profile_columns()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE trusted_level_update BOOLEAN := COALESCE(current_setting('green_live.level_recalc',TRUE),'0')='1';
BEGIN
  IF public.is_admin(auth.uid()) THEN RETURN NEW; END IF;

  IF NEW.diamonds IS DISTINCT FROM OLD.diamonds THEN RAISE EXCEPTION 'You cannot change diamonds directly' USING ERRCODE='42501'; END IF;
  IF NEW.beans IS DISTINCT FROM OLD.beans THEN RAISE EXCEPTION 'You cannot change beans directly' USING ERRCODE='42501'; END IF;
  IF NEW.role IS DISTINCT FROM OLD.role THEN RAISE EXCEPTION 'You cannot change your role' USING ERRCODE='42501'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN RAISE EXCEPTION 'You cannot change your account status' USING ERRCODE='42501'; END IF;
  IF NEW.is_banned IS DISTINCT FROM OLD.is_banned THEN RAISE EXCEPTION 'You cannot change ban status' USING ERRCODE='42501'; END IF;
  IF NEW.display_id IS DISTINCT FROM OLD.display_id THEN RAISE EXCEPTION 'You cannot change your display ID' USING ERRCODE='42501'; END IF;
  IF NEW.agency_id IS DISTINCT FROM OLD.agency_id THEN RAISE EXCEPTION 'Use an approved agency RPC to change agency' USING ERRCODE='42501'; END IF;
  IF NEW.vip_type IS DISTINCT FROM OLD.vip_type THEN RAISE EXCEPTION 'You cannot change VIP type' USING ERRCODE='42501'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'You cannot change your id' USING ERRCODE='42501'; END IF;
  IF NEW.phone_number IS DISTINCT FROM OLD.phone_number THEN RAISE EXCEPTION 'You cannot change your phone number directly' USING ERRCODE='42501'; END IF;
  IF NOT trusted_level_update AND NEW.level IS DISTINCT FROM OLD.level THEN RAISE EXCEPTION 'Your level is calculated from sent gifts' USING ERRCODE='42501'; END IF;
  IF NOT trusted_level_update AND NEW.lifetime_diamonds_spent IS DISTINCT FROM OLD.lifetime_diamonds_spent THEN RAISE EXCEPTION 'Gift progress cannot be changed directly' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.trg_gift_grants_exp()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.sender_id IS NOT NULL
     AND NEW.receiver_id IS DISTINCT FROM NEW.sender_id
     AND COALESCE(NEW.diamond_cost,0)>0
     AND COALESCE(NEW.count,1)>0 THEN
    PERFORM public.recalc_user_level(NEW.sender_id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_gift_exp ON public.gifts_log;
CREATE TRIGGER trg_gift_exp
  AFTER INSERT ON public.gifts_log
  FOR EACH ROW EXECUTE FUNCTION public.trg_gift_grants_exp();

-- If a client attempts to edit cached progress directly, immediately restore
-- it from gift history. The nested update settles because the corrected value
-- no longer differs from the authoritative sum.
CREATE OR REPLACE FUNCTION public.trg_on_exp_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.lifetime_diamonds_spent IS DISTINCT FROM OLD.lifetime_diamonds_spent
     AND pg_trigger_depth()<2 THEN
    PERFORM public.recalc_user_level(NEW.id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_recalc_level ON public.profiles;
CREATE TRIGGER trg_recalc_level
  AFTER UPDATE OF lifetime_diamonds_spent ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.trg_on_exp_change();

-- Correct every existing account from real gift history and apply the chart.
DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT id FROM public.profiles LOOP
    PERFORM public.recalc_user_level(r.id);
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.recalc_user_level(UUID) TO authenticated;
