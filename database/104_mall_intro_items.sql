-- Admin-managed Mall Intro catalogue.

CREATE TABLE IF NOT EXISTS public.mall_intro_items (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  thumbnail_url TEXT NOT NULL,
  video_url     TEXT NOT NULL,
  diamond_cost  BIGINT NOT NULL DEFAULT 0 CHECK (diamond_cost >= 0),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.mall_intro_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mall intro public read" ON public.mall_intro_items;
CREATE POLICY "mall intro public read" ON public.mall_intro_items
  FOR SELECT USING (is_active OR public.is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "mall intro super admin insert" ON public.mall_intro_items;
CREATE POLICY "mall intro super admin insert" ON public.mall_intro_items
  FOR INSERT WITH CHECK (public.is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "mall intro super admin update" ON public.mall_intro_items;
CREATE POLICY "mall intro super admin update" ON public.mall_intro_items
  FOR UPDATE USING (public.is_super_admin(auth.uid())) WITH CHECK (public.is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "mall intro super admin delete" ON public.mall_intro_items;
CREATE POLICY "mall intro super admin delete" ON public.mall_intro_items
  FOR DELETE USING (public.is_super_admin(auth.uid()));

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'mall-intros',
  'mall-intros',
  TRUE,
  52428800,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v']
)
ON CONFLICT (id) DO UPDATE SET
  public = TRUE,
  file_size_limit = 52428800,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v'];

DROP POLICY IF EXISTS "mall intro public storage read" ON storage.objects;
CREATE POLICY "mall intro public storage read" ON storage.objects
  FOR SELECT USING (bucket_id = 'mall-intros');

DROP POLICY IF EXISTS "mall intro admin storage insert" ON storage.objects;
CREATE POLICY "mall intro admin storage insert" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'mall-intros' AND public.is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "mall intro admin storage update" ON storage.objects;
CREATE POLICY "mall intro admin storage update" ON storage.objects
  FOR UPDATE USING (bucket_id = 'mall-intros' AND public.is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "mall intro admin storage delete" ON storage.objects;
CREATE POLICY "mall intro admin storage delete" ON storage.objects
  FOR DELETE USING (bucket_id = 'mall-intros' AND public.is_super_admin(auth.uid()));

INSERT INTO public.mall_intro_items (
  id,
  name,
  thumbnail_url,
  video_url,
  diamond_cost,
  is_active,
  display_order,
  updated_at
)
VALUES
  ('football-cup', 'Football Champions Cup', 'bundled://football-cup.webp', 'bundled://football-cup.m4v', 90000, TRUE, 1, NOW()),
  ('blue-roses',   'Blue Rose Bouquet',      'bundled://blue-roses.webp',   'bundled://blue-roses.m4v',   75000, TRUE, 2, NOW())
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  thumbnail_url = EXCLUDED.thumbnail_url,
  video_url = EXCLUDED.video_url,
  diamond_cost = EXCLUDED.diamond_cost,
  is_active = EXCLUDED.is_active,
  display_order = EXCLUDED.display_order,
  updated_at = NOW();

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.mall_intro_items;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
