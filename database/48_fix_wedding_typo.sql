-- =====================================================================
-- 48_fix_wedding_typo.sql
-- =====================================================================
-- Cosmetic cleanup: the seed in migration 40 wrote 'animation/weddibng.json'
-- because the bundled asset had a typo (weddibng). The file is now named
-- 'wedding.json'; this migration brings the existing DB row in line so
-- the admin panel and the mobile resolver don't have to keep the legacy
-- key alive forever.
--
-- Mobile still tolerates the old key via the resolver's BUNDLED map, so
-- this is safe to run regardless of whether the app has shipped yet.
--
-- Idempotent: re-runnable.
-- =====================================================================

UPDATE public.gifts
   SET animation_path = 'animation/wedding.json'
 WHERE animation_path = 'animation/weddibng.json';