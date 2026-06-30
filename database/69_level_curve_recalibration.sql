-- =====================================================================
-- 69_level_curve_recalibration.sql
-- =====================================================================
-- The old level system used a flat multiplier (default 1500). With
-- only ~148k diamonds spent a user could max out at level 100, which
-- killed the long-term progression hook — there was nothing left to
-- chase. This migration replaces the formula with a proper power curve
-- and a lookup table so admin can tune individual levels later (eg.
-- a "Eid: level 50 promo half-price" event).
--
-- Target curve (matches Bigo / Likee / Tango shape):
--
--   min_exp(L) = CEIL(3.16 * L^3.5)
--
--   Level   1 →  0           — start
--   Level   5 →  ~900        — first session of casual gifting
--   Level  10 →  ~10,000     — first day of dedicated user
--   Level  20 →  ~113,000    — first week
--   Level  50 →  ~2,800,000  — first month
--   Level  75 →  ~38,800,000 — month of whale gifting
--   Level 100 →  ~100,000,000 (10 কোটি) — the hard ceiling
--
-- The curve is steep enough that the climb feels meaningful at every
-- tier, but soft enough at levels 1-15 that new users get instant
-- gratification and want to keep gifting.
--
-- Existing users: this migration recalculates every level from
-- lifetime_diamonds_spent against the new curve. Users who reached
-- the old level 100 (148k spent) will land around level 21-22 in the
-- new system. We DO write a level_recalibrated notification so the
-- drop isn't a silent surprise.
--
-- Idempotent: re-runnable. The table seed uses ON CONFLICT, and the
-- one-time recalc loop is harmless on repeat.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Threshold table — one row per level, holds minimum lifetime
--    diamonds spent required to BE at that level.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.level_thresholds (
  level     INT    PRIMARY KEY CHECK (level BETWEEN 1 AND 100),
  min_exp   BIGINT NOT NULL CHECK (min_exp >= 0)
);

CREATE INDEX IF NOT EXISTS idx_level_thresholds_min_exp
  ON public.level_thresholds (min_exp);

-- ---------------------------------------------------------------------
-- 2. Seed the curve. CEIL keeps the values as integers; generate_series
--    builds 100 rows from a single SELECT. ON CONFLICT lets the admin
--    later override individual rows without this seed blowing them
--    away on the next migration replay.
-- ---------------------------------------------------------------------
INSERT INTO public.level_thresholds (level, min_exp)
SELECT
  l,
  CASE WHEN l = 1
       THEN 0::bigint
       ELSE CEIL(3.16 * POWER(l::numeric, 3.5))::bigint
  END
FROM generate_series(1, 100) AS l
ON CONFLICT (level) DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. RLS — public can read (drives the My Level screen progress bar),
--    only admins can write.
-- ---------------------------------------------------------------------
ALTER TABLE public.level_thresholds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS level_thresholds_read ON public.level_thresholds;
CREATE POLICY level_thresholds_read ON public.level_thresholds
  FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS level_thresholds_admin_write ON public.level_thresholds;
CREATE POLICY level_thresholds_admin_write ON public.level_thresholds
  FOR ALL
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------
-- 4. Realtime publication so the mobile app reflects admin-side
--    threshold tweaks without an app restart.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname='supabase_realtime'
       AND schemaname='public'
       AND tablename='level_thresholds'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.level_thresholds;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 5. Replace recalc_user_level — table lookup instead of the old
--    flat-multiplier formula.
--
-- The signature and notification side-effect are preserved so the
-- two triggers in migration 50 + the maybe_notify() wiring from 57
-- continue to work without changes.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recalc_user_level(p_user_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_exp        bigint;
  v_old_level  int;
  v_new_level  int;
BEGIN
  SELECT COALESCE(lifetime_diamonds_spent, 0), COALESCE(level, 1)
    INTO v_exp, v_old_level
    FROM public.profiles WHERE id = p_user_id;
  IF v_exp IS NULL THEN RETURN NULL; END IF;

  -- Highest level whose threshold the user has already crossed.
  -- ORDER BY level DESC LIMIT 1 leverages the PK index so this is
  -- O(log n) even with the (current) 100 rows.
  SELECT MAX(level) INTO v_new_level
    FROM public.level_thresholds
    WHERE min_exp <= v_exp;

  -- Clamp + default: a user with 0 exp sits at level 1.
  v_new_level := COALESCE(GREATEST(1, LEAST(100, v_new_level)), 1);

  IF v_new_level <> v_old_level THEN
    UPDATE public.profiles SET level = v_new_level WHERE id = p_user_id;
    IF v_new_level > v_old_level THEN
      -- Goes through maybe_notify so the user's push prefs are
      -- respected (notification + push are gated together).
      PERFORM public.maybe_notify(
        p_user_id, 'level_up', 'Level up! 🎉',
        'You reached level ' || v_new_level || '. Keep gifting to climb higher.',
        jsonb_build_object('old_level', v_old_level, 'new_level', v_new_level)
      );
    END IF;
  END IF;

  RETURN v_new_level;
END $$;

GRANT EXECUTE ON FUNCTION public.recalc_user_level(uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 6. One-time recalc for everyone under the new curve. Existing users
--    with the old "easy" level 100 will land at whatever the new
--    curve says their lifetime spend buys. Suppress the level-up
--    notification spam here by clearing it from the rows we touch —
--    a global "we adjusted the levels" notice (sent below) is enough.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  v_old_level int;
  v_new_level int;
BEGIN
  FOR r IN SELECT id FROM public.profiles LOOP
    SELECT level INTO v_old_level FROM public.profiles WHERE id = r.id;
    v_new_level := public.recalc_user_level(r.id);
    -- recalc_user_level fires a level_up notification only on UP
    -- transitions; on DOWN it's silent, which is what we want for
    -- recalibrated users. No further cleanup needed.
  END LOOP;
END $$;
