-- =====================================================================
-- 72_home_banners.sql
-- =====================================================================
-- Admin-controllable home-screen banner carousel above the live grid.
-- Up to 3 active banners at any time; admin can swap them whenever a
-- new promo / event / partnership goes live and the mobile app picks
-- up the change in realtime — no rebuild, no app update.
--
-- Architecture
--   home_banners (DB)           — metadata: image_url, link_url, order, active
--   storage.buckets 'banners'   — actual image files
--   realtime publication        — mobile auto-refreshes when admin saves
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.home_banners (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_url     TEXT NOT NULL,
  link_url      TEXT,                              -- NULL = banner is non-tappable
  display_order INT NOT NULL DEFAULT 0,            -- ASC sort — slot 1/2/3
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_home_banners_active_order
  ON public.home_banners (is_active, display_order)
  WHERE is_active = TRUE;

-- Touch updated_at automatically so the admin UI shows accurate
-- "last edited" timestamps without the client having to send NOW().
CREATE OR REPLACE FUNCTION public.touch_home_banners_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_home_banners_touch_updated_at ON public.home_banners;
CREATE TRIGGER trg_home_banners_touch_updated_at
  BEFORE UPDATE ON public.home_banners
  FOR EACH ROW EXECUTE FUNCTION public.touch_home_banners_updated_at();

-- ---------------------------------------------------------------------
-- 2. RLS — public can read (the home screen runs pre-login too),
--    only admins can write.
-- ---------------------------------------------------------------------
ALTER TABLE public.home_banners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS home_banners_read ON public.home_banners;
CREATE POLICY home_banners_read ON public.home_banners
  FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS home_banners_admin_write ON public.home_banners;
CREATE POLICY home_banners_admin_write ON public.home_banners
  FOR ALL
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------
-- 3. Realtime publication so the mobile home screen reflects admin
--    edits within a second, without a refresh.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname='supabase_realtime'
       AND schemaname='public'
       AND tablename='home_banners'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.home_banners;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4. Storage bucket — public read for the banner images. Admin-only
--    writes via Storage policies (mirror of the splashes bucket
--    pattern from migration 63).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'banners') THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'banners',
      'banners',
      TRUE,
      2 * 1024 * 1024,                            -- 2 MB cap per upload
      ARRAY['image/png','image/jpeg','image/webp']
    );
  END IF;
END $$;

DROP POLICY IF EXISTS "banners_public_read"  ON storage.objects;
DROP POLICY IF EXISTS "banners_admin_insert" ON storage.objects;
DROP POLICY IF EXISTS "banners_admin_update" ON storage.objects;
DROP POLICY IF EXISTS "banners_admin_delete" ON storage.objects;

CREATE POLICY "banners_public_read"  ON storage.objects FOR SELECT
  USING  (bucket_id = 'banners');

CREATE POLICY "banners_admin_insert" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'banners' AND public.is_admin(auth.uid()));

CREATE POLICY "banners_admin_update" ON storage.objects FOR UPDATE
  USING      (bucket_id = 'banners' AND public.is_admin(auth.uid()))
  WITH CHECK (bucket_id = 'banners' AND public.is_admin(auth.uid()));

CREATE POLICY "banners_admin_delete" ON storage.objects FOR DELETE
  USING      (bucket_id = 'banners' AND public.is_admin(auth.uid()));
