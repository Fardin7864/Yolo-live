-- =====================================================================
-- 65_revert_splash_video_support.sql
-- =====================================================================
-- Reverts migration 64. Product decision: only image + Lottie splashes
-- — no video. Reasoning was that videos blow up first-launch download
-- on weak networks and the bundle-size tradeoff wasn't worth it for
-- the seasonal hero moments we were planning.
--
-- This file is idempotent and safe to run whether or not migration 64
-- was previously applied:
--
--   1. Delete any rows that snuck in with media_type='video' so the
--      CHECK constraint reinstate below doesn't fail on existing data.
--      (None should exist in practice — we never shipped a video — but
--       we guard anyway.)
--   2. Drop whatever media_type CHECK is currently on the table.
--   3. Recreate it with just ('image','lottie').
--   4. Roll storage bucket cap back to 5 MB and drop the video mime
--      types from the allowlist.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Purge any 'video' rows so the CHECK below applies cleanly.
-- ---------------------------------------------------------------------
DELETE FROM public.app_splashes WHERE media_type = 'video';

-- ---------------------------------------------------------------------
-- 2. Drop the existing media_type CHECK (whatever name it has — auto
--    or our explicit one from migration 64) and re-add the image+lottie
--    one matching the original migration 63.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_constraint TEXT;
BEGIN
  SELECT conname INTO v_constraint
    FROM pg_constraint
    WHERE conrelid = 'public.app_splashes'::regclass
      AND contype  = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%media_type%';
  IF v_constraint IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.app_splashes DROP CONSTRAINT ' || quote_ident(v_constraint);
  END IF;
END $$;

ALTER TABLE public.app_splashes
  ADD CONSTRAINT app_splashes_media_type_check
  CHECK (media_type IN ('image','lottie'));

-- ---------------------------------------------------------------------
-- 3. Roll the storage bucket back to the original 5 MB cap and the
--    image+lottie mime types only.
-- ---------------------------------------------------------------------
UPDATE storage.buckets
   SET file_size_limit    = 5 * 1024 * 1024,
       allowed_mime_types = ARRAY['image/png','image/jpeg','image/webp','application/json']
 WHERE id = 'splashes';
