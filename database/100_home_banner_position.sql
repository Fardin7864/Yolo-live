-- =====================================================================
-- 100_home_banner_position.sql — banner placement on the home grid
-- =====================================================================
-- The home tab now has TWO banner slots:
--   * top    — the existing hero carousel above the live grid
--   * bottom — a smaller carousel between the live grid and the
--              bottom-nav, for announcements / "we are hiring" /
--              campaign promos like the reference design uses.
--
-- This migration adds a `position` text column to home_banners with
-- a CHECK constraint pinning it to one of those two values. All
-- existing rows default to 'top' (they were the only slot before),
-- so legacy banners keep showing exactly where they were before.
-- The admin panel banner page picks up the new column and lets the
-- admin choose where each banner goes.
--
-- Idempotent: column is added IF NOT EXISTS, default backfills
-- automatically on existing rows.
-- =====================================================================

ALTER TABLE public.home_banners
  ADD COLUMN IF NOT EXISTS position TEXT NOT NULL DEFAULT 'top'
    CHECK (position IN ('top', 'bottom'));

-- Index so the home loader can split top vs bottom cheaply when the
-- table grows. Composite with is_active because every read filters
-- on both.
CREATE INDEX IF NOT EXISTS idx_home_banners_position_active
  ON public.home_banners (position, is_active, display_order);
