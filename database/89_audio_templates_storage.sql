-- =====================================================================
-- 89_audio_templates_storage.sql
-- =====================================================================
-- Super-admin-uploadable storage for the audio-room background catalogue.
-- The admin /audio-templates page drops a file directly into this bucket
-- and writes the public URL back to audio_templates.background_url /
-- preview_url — so new backgrounds ship live without an APK build,
-- exactly like the gift-animations / gift-sounds flow from migration 85.
--
-- Architecture
--   storage.buckets 'audio-templates' — static background images
--                                       (JPG / PNG / WebP, public read)
--   storage.objects RLS              — public read; writes gated on
--                                       is_super_admin(auth.uid())
--
-- Manager-tier admins are intentionally NOT allowed to mutate this
-- bucket — template content affects monetisation (cost) and the same
-- gate (is_super_admin) already protects the audio_templates rows
-- themselves via the RLS policy in migration 88.
--
-- 3 MB cap is generous for a single 1080×1920 JPG (typical room canvas)
-- while keeping the mobile download tight on a flaky 4G connection.
-- Allowed MIME types are deliberately narrow — animated formats (GIF /
-- WEBM / Lottie) are out of scope for v1 (static images only).
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Bucket
--
-- Public bucket so the React Native <Image source={{ uri }} /> resolver
-- can fetch the background without auth headers. file_size_limit +
-- allowed_mime_types are enforced server-side by Storage at upload time.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'audio-templates') THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'audio-templates',
      'audio-templates',
      TRUE,
      3 * 1024 * 1024,                            -- 3 MB cap per upload
      ARRAY['image/jpeg','image/png','image/webp']
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. RLS policies on storage.objects
--
-- DROP-then-CREATE pattern mirrors migration 85 so re-runs are safe
-- across older PG versions. Each policy is bucket-scoped so it never
-- bleeds onto gift / banner / splash buckets.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "audio_templates_public_read"  ON storage.objects;
DROP POLICY IF EXISTS "audio_templates_admin_insert" ON storage.objects;
DROP POLICY IF EXISTS "audio_templates_admin_update" ON storage.objects;
DROP POLICY IF EXISTS "audio_templates_admin_delete" ON storage.objects;

CREATE POLICY "audio_templates_public_read" ON storage.objects FOR SELECT
  USING (bucket_id = 'audio-templates');

CREATE POLICY "audio_templates_admin_insert" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'audio-templates' AND public.is_super_admin(auth.uid()));

CREATE POLICY "audio_templates_admin_update" ON storage.objects FOR UPDATE
  USING      (bucket_id = 'audio-templates' AND public.is_super_admin(auth.uid()))
  WITH CHECK (bucket_id = 'audio-templates' AND public.is_super_admin(auth.uid()));

CREATE POLICY "audio_templates_admin_delete" ON storage.objects FOR DELETE
  USING      (bucket_id = 'audio-templates' AND public.is_super_admin(auth.uid()));
