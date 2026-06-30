-- =====================================================================
-- 85_gift_storage_buckets.sql
-- =====================================================================
-- Super-admin-uploadable storage for the gifts catalog. Until now the
-- only way to publish a new gift animation / SFX was to drop a file
-- into the mobile bundle and ship a build. The admin gifts page now
-- offers a file picker that uploads straight into these two buckets
-- and writes the public URL back to `gifts.animation_url` /
-- `gifts.sound_url`, which the mobile resolvers (giftAnimations.js,
-- giftSounds.js) already prefer over the bundled paths. End result:
-- new gifts ship live without an APK build.
--
-- Architecture
--   storage.buckets 'gift-animations' — Lottie JSON files (public read)
--   storage.buckets 'gift-sounds'     — MP3/WAV files     (public read)
--   storage.objects RLS               — public read; writes gated on
--                                       is_super_admin(auth.uid())
--
-- Manager-tier admins are intentionally NOT allowed to mutate these
-- buckets — gift content affects monetisation (cost vs. visual) and
-- is reserved to the owner, the same gate that already protects the
-- `gifts` catalog rows themselves via send_gift / admin_update_user.
--
-- Mirrors the policy shape from migration 72 (banners), with the
-- following differences:
--   * write gate is is_super_admin (not is_admin) — see above
--   * separate buckets per asset family so the MIME allowlist is tight
--   * 2 MB cap matches Lottie's practical upper bound and the existing
--     mobile bundle sizes; oversize uploads fail at Storage layer
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Buckets
-- ---------------------------------------------------------------------
-- Public buckets so mobile clients can fetch the asset without auth
-- headers (the resolvers in giftAnimations.js / giftSounds.js do a
-- plain fetch off { uri }). file_size_limit is enforced by Storage at
-- upload time; allowed_mime_types is enforced by Storage on the way in.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'gift-animations') THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'gift-animations',
      'gift-animations',
      TRUE,
      2 * 1024 * 1024,                            -- 2 MB cap per upload
      ARRAY['application/json']
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'gift-sounds') THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'gift-sounds',
      'gift-sounds',
      TRUE,
      2 * 1024 * 1024,                            -- 2 MB cap per upload
      ARRAY['audio/mpeg','audio/wav','audio/x-wav','audio/mp3']
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. RLS policies on storage.objects
--
-- DROP-then-CREATE pattern (rather than CREATE POLICY IF NOT EXISTS)
-- matches migration 72 and keeps re-runs safe across older PG versions.
-- Each policy is bucket-scoped so it never bleeds onto banners /
-- splashes / any other Storage bucket.
-- ---------------------------------------------------------------------

-- --- gift-animations ------------------------------------------------
DROP POLICY IF EXISTS "gift_animations_public_read"  ON storage.objects;
DROP POLICY IF EXISTS "gift_animations_admin_insert" ON storage.objects;
DROP POLICY IF EXISTS "gift_animations_admin_update" ON storage.objects;
DROP POLICY IF EXISTS "gift_animations_admin_delete" ON storage.objects;

CREATE POLICY "gift_animations_public_read" ON storage.objects FOR SELECT
  USING (bucket_id = 'gift-animations');

CREATE POLICY "gift_animations_admin_insert" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'gift-animations' AND public.is_super_admin(auth.uid()));

CREATE POLICY "gift_animations_admin_update" ON storage.objects FOR UPDATE
  USING      (bucket_id = 'gift-animations' AND public.is_super_admin(auth.uid()))
  WITH CHECK (bucket_id = 'gift-animations' AND public.is_super_admin(auth.uid()));

CREATE POLICY "gift_animations_admin_delete" ON storage.objects FOR DELETE
  USING      (bucket_id = 'gift-animations' AND public.is_super_admin(auth.uid()));

-- --- gift-sounds ----------------------------------------------------
DROP POLICY IF EXISTS "gift_sounds_public_read"  ON storage.objects;
DROP POLICY IF EXISTS "gift_sounds_admin_insert" ON storage.objects;
DROP POLICY IF EXISTS "gift_sounds_admin_update" ON storage.objects;
DROP POLICY IF EXISTS "gift_sounds_admin_delete" ON storage.objects;

CREATE POLICY "gift_sounds_public_read" ON storage.objects FOR SELECT
  USING (bucket_id = 'gift-sounds');

CREATE POLICY "gift_sounds_admin_insert" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'gift-sounds' AND public.is_super_admin(auth.uid()));

CREATE POLICY "gift_sounds_admin_update" ON storage.objects FOR UPDATE
  USING      (bucket_id = 'gift-sounds' AND public.is_super_admin(auth.uid()))
  WITH CHECK (bucket_id = 'gift-sounds' AND public.is_super_admin(auth.uid()));

CREATE POLICY "gift_sounds_admin_delete" ON storage.objects FOR DELETE
  USING      (bucket_id = 'gift-sounds' AND public.is_super_admin(auth.uid()));
