-- =====================================================================
-- 50_level_system.sql
-- =====================================================================
-- Turns the long-dormant "My Level" screen into a real progression
-- system. Every diamond a user SPENDS on a gift becomes 1 EXP toward
-- their next level. The level cap stays at 100; the per-level EXP cost
-- comes from system_settings.level_exp_multiplier (default 1500).
--
-- Design — two thin triggers do all the work, send_gift is untouched:
--
--   1. AFTER INSERT on gifts_log → +diamond_cost to the sender's
--      lifetime_diamonds_spent. Single SQL UPDATE, no rewrite of
--      send_gift.
--   2. AFTER UPDATE OF lifetime_diamonds_spent on profiles → recalc
--      that user's `level`. Fires a level-up notification when the
--      number rises so the existing notifications screen + tab badge
--      celebrate the milestone.
--
-- The trigger split also means a manual admin adjustment (or future
-- "reward EXP" RPC) automatically updates the level — no caller has to
-- remember to call recalc_user_level themselves.
--
-- Backfill — fills lifetime_diamonds_spent for every existing user
-- from their gifts_log history, then recalculates their level once.
-- Subsequent gifts flow through the triggers from then on.
--
-- Idempotent: re-runnable. Backfill UPDATE is guarded so it doesn't
-- wipe progress on second runs.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Column
-- ---------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS lifetime_diamonds_spent BIGINT DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_profiles_lifetime_spent
  ON public.profiles (lifetime_diamonds_spent DESC);

-- ---------------------------------------------------------------------
-- 2. Backfill from gifts_log — only when value is still 0 so re-runs
--    don't blow away accumulated state.
-- ---------------------------------------------------------------------
UPDATE public.profiles p
   SET lifetime_diamonds_spent = sub.total
  FROM (
    SELECT sender_id AS uid, COALESCE(SUM(diamond_cost), 0) AS total
      FROM public.gifts_log
     GROUP BY sender_id
  ) sub
 WHERE p.id = sub.uid
   AND COALESCE(p.lifetime_diamonds_spent, 0) = 0
   AND sub.total > 0;

-- ---------------------------------------------------------------------
-- 3. Level recalc helper
--
--    Formula: level = FLOOR(exp / multiplier) + 1, clamped to [1, 100].
--    So a fresh user starts at level 1 with 0 EXP and reaches level 2
--    the moment they spend `multiplier` diamonds. Multiplier defaults
--    to 1500 (admin-tunable in system_settings.level_exp_multiplier).
--
--    On level-up: writes a notification so the user sees a celebration
--    in their inbox / notification tab badge.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recalc_user_level(p_user_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_multiplier int;
  v_exp        bigint;
  v_old_level  int;
  v_new_level  int;
BEGIN
  v_multiplier := public.get_setting_int('level_exp_multiplier', 1500);
  IF v_multiplier IS NULL OR v_multiplier <= 0 THEN
    v_multiplier := 1500;
  END IF;

  SELECT COALESCE(lifetime_diamonds_spent, 0), COALESCE(level, 1)
    INTO v_exp, v_old_level
    FROM public.profiles WHERE id = p_user_id;
  IF v_exp IS NULL THEN RETURN NULL; END IF;

  v_new_level := GREATEST(1, LEAST(100, (v_exp / v_multiplier)::int + 1));

  IF v_new_level <> v_old_level THEN
    UPDATE public.profiles SET level = v_new_level WHERE id = p_user_id;
    IF v_new_level > v_old_level THEN
      INSERT INTO public.notifications (user_id, type, title, body, payload)
      VALUES (
        p_user_id,
        'level_up',
        'Level up! 🎉',
        'You reached level ' || v_new_level || '. Keep gifting to climb higher.',
        jsonb_build_object('old_level', v_old_level, 'new_level', v_new_level)
      );
    END IF;
  END IF;

  RETURN v_new_level;
END $$;

GRANT EXECUTE ON FUNCTION public.recalc_user_level(uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 4. One-time recalc for everyone (run after the backfill above)
-- ---------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT id FROM public.profiles LOOP
    PERFORM public.recalc_user_level(r.id);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 5. Trigger: gifts_log INSERT → grow sender's EXP
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_gift_grants_exp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- diamond_cost on a gifts_log row already includes the bulk count
  -- multiplier (send_gift inserts the row with total cost), so we
  -- add it directly.
  UPDATE public.profiles
     SET lifetime_diamonds_spent = COALESCE(lifetime_diamonds_spent, 0) + COALESCE(NEW.diamond_cost, 0)
   WHERE id = NEW.sender_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_gift_exp ON public.gifts_log;
CREATE TRIGGER trg_gift_exp
  AFTER INSERT ON public.gifts_log
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_gift_grants_exp();

-- ---------------------------------------------------------------------
-- 6. Trigger: profiles.lifetime_diamonds_spent UPDATE → recalc level
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_on_exp_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- The recalc helper UPDATEs `level` (not lifetime_diamonds_spent),
  -- so this trigger cannot re-enter itself even though it runs an
  -- UPDATE on the same table.
  IF NEW.lifetime_diamonds_spent IS DISTINCT FROM OLD.lifetime_diamonds_spent THEN
    PERFORM public.recalc_user_level(NEW.id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_recalc_level ON public.profiles;
CREATE TRIGGER trg_recalc_level
  AFTER UPDATE OF lifetime_diamonds_spent ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_on_exp_change();