-- =====================================================================
-- MUSIC TRACKS — admin-curated background music for broadcasters.
-- Idempotent. Run in Supabase SQL Editor.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.music_tracks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  artist      TEXT,
  audio_url   TEXT NOT NULL,
  cover_url   TEXT,
  duration_sec INT,
  category    TEXT DEFAULT 'general',
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  created_by  UUID REFERENCES public.profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_music_active
  ON public.music_tracks(is_active, category, created_at DESC);

-- RLS — everyone reads active tracks, only admins write
ALTER TABLE public.music_tracks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS music_read ON public.music_tracks;
CREATE POLICY music_read ON public.music_tracks FOR SELECT
  USING (is_active = TRUE OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS music_admin_write ON public.music_tracks;
CREATE POLICY music_admin_write ON public.music_tracks FOR ALL
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- Storage bucket for audio files
INSERT INTO storage.buckets (id, name, public)
VALUES ('music', 'music', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "music_public_read" ON storage.objects;
CREATE POLICY "music_public_read" ON storage.objects FOR SELECT
  USING (bucket_id = 'music');

DROP POLICY IF EXISTS "music_admin_write" ON storage.objects;
CREATE POLICY "music_admin_write" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'music' AND public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "music_admin_delete" ON storage.objects;
CREATE POLICY "music_admin_delete" ON storage.objects FOR DELETE
  USING (bucket_id = 'music' AND public.is_admin(auth.uid()));

-- =====================================================================
-- DONE. Admins can upload tracks via the admin panel (or directly in
-- Supabase dashboard). Mobile broadcast screen will load + play them.
-- =====================================================================