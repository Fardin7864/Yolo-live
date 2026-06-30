-- =====================================================================
-- 44_tasks_badges_levels.sql
-- =====================================================================
-- Backs the three "progression" surfaces with admin-editable tables:
--
--   * tasks         — daily/recurring missions shown on /main/tasks
--   * badges        — collectible badges shown on /main/badges
--   * level_tiers   — tier definitions (Bronze, Silver, …) used by /main/level
--
-- Today every one of these is hardcoded in the mobile client; this
-- migration seeds the same data into tables and adds RLS so super_admin
-- can re-tune everything without an app deploy.
--
-- User progress (which badge a user has unlocked, claim status of a
-- specific task) gets a single child table per row: `user_badges`. Task
-- claim tracking already requires a daily_login_claims table per a
-- comment in the mobile code; that's out of scope for this migration.
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TASKS  — admin-editable mission list
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tasks (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  reward        BIGINT NOT NULL CHECK (reward >= 0),
  action        TEXT NOT NULL,                     -- watch | gift | live | share | custom
  audience      TEXT NOT NULL DEFAULT 'all',       -- all | host | viewer
  description   TEXT,
  is_active     BOOLEAN DEFAULT TRUE,
  display_order INT DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO public.tasks (id, title, reward, action, audience, display_order) VALUES
  ('viewer_watch_5',   'Watch Live for 5 mins', 10,   'watch', 'viewer', 10),
  ('viewer_gift_50',   'Send 50 Diamonds',      20,   'gift',  'viewer', 20),
  ('viewer_share_1',   'Share a stream',        5,    'share', 'viewer', 30),
  ('host_live_30',     'Live for 30 mins',      100,  'live',  'host',   10),
  ('host_live_60',     'Live for 1 hour',       300,  'live',  'host',   20),
  ('host_live_120',    'Live for 2 hours',      1000, 'live',  'host',   30)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. BADGES  — collectible badge catalogue
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.badges (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT,
  icon_url       TEXT,
  criteria       TEXT,         -- human description of how to unlock
  is_active      BOOLEAN DEFAULT TRUE,
  display_order  INT DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO public.badges (id, name, description, icon_url, criteria, display_order) VALUES
  ('first_streamer', 'First Streamer', 'Completed your first live stream.',
     'https://cdn-icons-png.flaticon.com/512/3112/3112946.png',
     'Go live once.', 10),
  ('millionaire',    'Millionaire',    'Earned 1,000,000 beans.',
     'https://cdn-icons-png.flaticon.com/512/9181/9181081.png',
     'Total earned beans >= 1,000,000.', 20),
  ('top_supporter',  'Top Supporter',  'Gifted over 10k diamonds.',
     'https://cdn-icons-png.flaticon.com/512/190/190411.png',
     'Total gifted diamonds >= 10,000.', 30),
  ('popular_star',   'Popular Star',   'Reached 10k followers.',
     'https://cdn-icons-png.flaticon.com/512/1828/1828884.png',
     'Followers >= 10,000.', 40),
  ('loyal_user',     'Loyal User',     'Used app for 30 consecutive days.',
     'https://cdn-icons-png.flaticon.com/512/616/616490.png',
     '30-day login streak.', 50),
  ('level_50',       'Level 50',       'Reached profile level 50.',
     'https://cdn-icons-png.flaticon.com/512/473/473405.png',
     'Profile level >= 50.', 60)
ON CONFLICT (id) DO NOTHING;

-- Per-user unlock state.
CREATE TABLE IF NOT EXISTS public.user_badges (
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  badge_id    TEXT NOT NULL REFERENCES public.badges(id)   ON DELETE CASCADE,
  unlocked_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, badge_id)
);

CREATE INDEX IF NOT EXISTS idx_user_badges_user ON public.user_badges (user_id);

-- ---------------------------------------------------------------------
-- 3. LEVEL TIERS — tier ranges shown on /main/level
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.level_tiers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  color         TEXT NOT NULL,                      -- hex code e.g. '#CD7F32'
  icon          TEXT,                               -- ion-icon name
  min_level     INT NOT NULL CHECK (min_level >= 1),
  max_level     INT NOT NULL CHECK (max_level >= min_level),
  display_order INT DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO public.level_tiers (id, name, color, icon, min_level, max_level, display_order) VALUES
  ('bronze',    'Bronze',           '#CD7F32', 'star-outline',       1,  19,  10),
  ('silver',    'Silver',           '#9CA3AF', 'star-half-outline', 20,  39,  20),
  ('gold',      'Gold',             '#FBBF24', 'star',              40,  59,  30),
  ('platinum',  'Platinum',         '#60A5FA', 'diamond-outline',   60,  79,  40),
  ('diamond',   'Diamond',          '#00E5FF', 'diamond',           80,  99,  50),
  ('supreme',   'Supreme Legend',   '#D946EF', 'flame',            100, 100,  60)
ON CONFLICT (id) DO NOTHING;

-- EXP-per-level multiplier (mobile currently uses 1500 in JS).
INSERT INTO public.system_settings (key, value)
VALUES ('level_exp_multiplier', '1500'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- 4. RLS — public read for active rows; admin full CRUD
-- ---------------------------------------------------------------------
ALTER TABLE public.tasks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.badges       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_badges  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.level_tiers  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tasks_read ON public.tasks;
CREATE POLICY tasks_read ON public.tasks FOR SELECT
  USING (is_active OR public.is_admin(auth.uid()));
DROP POLICY IF EXISTS tasks_admin_all ON public.tasks;
CREATE POLICY tasks_admin_all ON public.tasks FOR ALL
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS badges_read ON public.badges;
CREATE POLICY badges_read ON public.badges FOR SELECT
  USING (is_active OR public.is_admin(auth.uid()));
DROP POLICY IF EXISTS badges_admin_all ON public.badges;
CREATE POLICY badges_admin_all ON public.badges FOR ALL
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS user_badges_self_read ON public.user_badges;
CREATE POLICY user_badges_self_read ON public.user_badges FOR SELECT
  USING (user_id = auth.uid() OR public.is_admin(auth.uid()));
DROP POLICY IF EXISTS user_badges_admin_all ON public.user_badges;
CREATE POLICY user_badges_admin_all ON public.user_badges FOR ALL
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS level_tiers_read ON public.level_tiers;
CREATE POLICY level_tiers_read ON public.level_tiers FOR SELECT USING (TRUE);
DROP POLICY IF EXISTS level_tiers_admin_all ON public.level_tiers;
CREATE POLICY level_tiers_admin_all ON public.level_tiers FOR ALL
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------
-- 5. Realtime publication — admins flip a switch, app picks it up
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='tasks') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='badges') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.badges;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='level_tiers') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.level_tiers;
  END IF;
END $$;