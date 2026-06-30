-- =====================================================================
-- 63_app_splashes.sql
-- =====================================================================
-- Remote-controlled splash screen system.
--
-- The native splash (assets/splash-icon.png + background_color in
-- app.json) shows for ~800ms while the JS bundle loads — that one is
-- baked into the binary and can't change without a rebuild. THIS system
-- is the second-stage overlay that runs AFTER the JS bundle boots,
-- which the admin can swap whenever a season changes (Eid, Pohela
-- Boishakh, Winter, promo campaigns, etc.) without touching the app
-- code.
--
-- How it works at runtime:
--   1. On cold app start, the mobile RemoteSplashGate hits
--      get_active_splash().
--   2. The RPC returns the highest-priority `is_active=true` row whose
--      date window contains NOW(). NULL active_from / active_until are
--      treated as open-ended ("always" on that side).
--   3. The mobile component caches the response in AsyncStorage so a
--      cold start with no network still gets the last splash, and the
--      next start picks up admin changes within ~1s.
--   4. After `duration_ms`, the overlay fades out and the home screen
--      takes over.
--
-- Storage:
--   The actual image / Lottie JSON lives in the `splashes` Supabase
--   Storage bucket. Public read so any signed-out user can fetch the
--   splash before logging in; admin-only writes.
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_splashes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title             TEXT NOT NULL,
  media_url         TEXT NOT NULL,                       -- Supabase Storage URL
  media_type        TEXT NOT NULL CHECK (media_type IN ('image','lottie')),
  -- How long the overlay stays on screen. 800ms minimum (anything shorter
  -- and the user just sees a flash); 6s ceiling so a misconfigured row
  -- can't strand someone on the splash forever.
  duration_ms       INT  NOT NULL DEFAULT 2000 CHECK (duration_ms BETWEEN 500 AND 6000),
  -- Background colour behind the media — relevant for transparent Lotties
  -- and PNGs with alpha. Hex string, e.g. '#0F091E'.
  background_color  TEXT DEFAULT '#0F091E',
  -- Date window. Either side NULL = unbounded on that side. So a
  -- "default fallback" splash uses NULL/NULL and a "Eid 2026" splash
  -- uses concrete from/until timestamps.
  active_from       TIMESTAMPTZ,
  active_until      TIMESTAMPTZ,
  is_active         BOOLEAN DEFAULT TRUE,
  -- When several rows match (e.g. seasonal + default), the higher
  -- priority wins. Default 0 so a fallback row doesn't accidentally
  -- override an Eid row.
  priority          INT DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  created_by        UUID REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_app_splashes_active
  ON public.app_splashes (is_active, priority DESC, active_from, active_until);

-- Auto-touch updated_at on any UPDATE so admin sees fresh timestamps.
CREATE OR REPLACE FUNCTION public.touch_app_splashes_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_app_splashes_touch_updated_at ON public.app_splashes;
CREATE TRIGGER trg_app_splashes_touch_updated_at
  BEFORE UPDATE ON public.app_splashes
  FOR EACH ROW EXECUTE FUNCTION public.touch_app_splashes_updated_at();

-- ---------------------------------------------------------------------
-- 2. RLS — anyone can read active splashes (the app fetches one BEFORE
--    login so we can't gate this behind auth). Admin-only writes.
-- ---------------------------------------------------------------------
ALTER TABLE public.app_splashes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_splashes_read ON public.app_splashes;
CREATE POLICY app_splashes_read ON public.app_splashes
  FOR SELECT
  USING (TRUE);

DROP POLICY IF EXISTS app_splashes_admin_write ON public.app_splashes;
CREATE POLICY app_splashes_admin_write ON public.app_splashes
  FOR ALL
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------
-- 3. RPC — return the splash to show right now.
--
-- Picked the highest-priority is_active row where NOW() is inside the
-- (possibly open-ended) date window. Returns NULL when nothing matches
-- so the mobile component knows to skip the overlay entirely.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_active_splash()
RETURNS TABLE (
  id                UUID,
  title             TEXT,
  media_url         TEXT,
  media_type        TEXT,
  duration_ms       INT,
  background_color  TEXT,
  priority          INT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT s.id, s.title, s.media_url, s.media_type, s.duration_ms,
         s.background_color, s.priority
    FROM public.app_splashes s
   WHERE s.is_active = TRUE
     AND (s.active_from  IS NULL OR s.active_from  <= NOW())
     AND (s.active_until IS NULL OR s.active_until >= NOW())
   ORDER BY s.priority DESC, s.created_at DESC
   LIMIT 1;
$$;

-- anon needs to call this BEFORE the user has logged in
GRANT EXECUTE ON FUNCTION public.get_active_splash() TO anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Storage bucket — public read for the splash media. Admin-only
--    write enforced via Storage policies below.
--
-- IMPORTANT: storage.buckets / storage.objects policies live in the
-- `storage` schema, not `public`. The DO block lets us re-run safely.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  -- Create bucket if it doesn't exist yet.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'splashes') THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'splashes',
      'splashes',
      TRUE,
      5 * 1024 * 1024,                       -- 5 MB cap per upload
      ARRAY['image/png','image/jpeg','image/webp','application/json']
    );
  END IF;
END $$;

-- Policies on storage.objects. Public can read, only admins can write.
DROP POLICY IF EXISTS "splashes_public_read"   ON storage.objects;
DROP POLICY IF EXISTS "splashes_admin_insert"  ON storage.objects;
DROP POLICY IF EXISTS "splashes_admin_update"  ON storage.objects;
DROP POLICY IF EXISTS "splashes_admin_delete"  ON storage.objects;

CREATE POLICY "splashes_public_read"   ON storage.objects FOR SELECT
  USING  (bucket_id = 'splashes');

CREATE POLICY "splashes_admin_insert"  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'splashes' AND public.is_admin(auth.uid()));

CREATE POLICY "splashes_admin_update"  ON storage.objects FOR UPDATE
  USING      (bucket_id = 'splashes' AND public.is_admin(auth.uid()))
  WITH CHECK (bucket_id = 'splashes' AND public.is_admin(auth.uid()));

CREATE POLICY "splashes_admin_delete"  ON storage.objects FOR DELETE
  USING      (bucket_id = 'splashes' AND public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------
-- 5. Seed a "default" fallback row so the very first mobile fetch has
--    something to return. Uses the bundled splash-icon as a stable URL
--    placeholder (admin should replace this with a real Storage URL).
-- ---------------------------------------------------------------------
-- Skipped intentionally — the mobile RemoteSplashGate handles
-- "no rows returned" gracefully by skipping the overlay entirely.
-- Admin will create the first row from the /splash page.
