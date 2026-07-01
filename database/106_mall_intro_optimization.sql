-- Mall intro playback optimization metadata and storage limits.

ALTER TABLE public.mall_intro_items
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER NOT NULL DEFAULT 8000 CHECK (duration_ms > 0),
  ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  ADD COLUMN IF NOT EXISTS video_width INTEGER CHECK (video_width IS NULL OR video_width > 0),
  ADD COLUMN IF NOT EXISTS video_height INTEGER CHECK (video_height IS NULL OR video_height > 0),
  ADD COLUMN IF NOT EXISTS video_mime_type TEXT;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'mall-intros',
  'mall-intros',
  TRUE,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'video/mp4']
)
ON CONFLICT (id) DO UPDATE SET
  public = TRUE,
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'video/mp4'];
