-- Admin-managed live-comment tags and per-user assignment.
-- Run once in Supabase SQL Editor before using the dashboard page.

CREATE TABLE IF NOT EXISTS public.comment_tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  image_url TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.comment_tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS comment_tags_public_read ON public.comment_tags;
DROP POLICY IF EXISTS comment_tags_admin_insert ON public.comment_tags;
DROP POLICY IF EXISTS comment_tags_admin_update ON public.comment_tags;
DROP POLICY IF EXISTS comment_tags_admin_delete ON public.comment_tags;

CREATE POLICY comment_tags_public_read ON public.comment_tags
  FOR SELECT USING (TRUE);

CREATE POLICY comment_tags_admin_insert ON public.comment_tags
  FOR INSERT WITH CHECK (public.is_super_admin(auth.uid()));

CREATE POLICY comment_tags_admin_update ON public.comment_tags
  FOR UPDATE
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));

CREATE POLICY comment_tags_admin_delete ON public.comment_tags
  FOR DELETE USING (public.is_super_admin(auth.uid()));

GRANT SELECT ON public.comment_tags TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.comment_tags TO authenticated;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS comment_tag_id TEXT
  REFERENCES public.comment_tags(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS profiles_comment_tag_id_idx
  ON public.profiles(comment_tag_id)
  WHERE comment_tag_id IS NOT NULL;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'comment-tags',
  'comment-tags',
  TRUE,
  2 * 1024 * 1024,
  ARRAY['image/png', 'image/webp', 'image/jpeg']
)
ON CONFLICT (id) DO UPDATE
SET public = TRUE,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS comment_tags_storage_public_read ON storage.objects;
DROP POLICY IF EXISTS comment_tags_storage_admin_insert ON storage.objects;
DROP POLICY IF EXISTS comment_tags_storage_admin_update ON storage.objects;
DROP POLICY IF EXISTS comment_tags_storage_admin_delete ON storage.objects;

CREATE POLICY comment_tags_storage_public_read ON storage.objects
  FOR SELECT USING (bucket_id = 'comment-tags');

CREATE POLICY comment_tags_storage_admin_insert ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'comment-tags' AND public.is_super_admin(auth.uid())
  );

CREATE POLICY comment_tags_storage_admin_update ON storage.objects
  FOR UPDATE
  USING (bucket_id = 'comment-tags' AND public.is_super_admin(auth.uid()))
  WITH CHECK (bucket_id = 'comment-tags' AND public.is_super_admin(auth.uid()));

CREATE POLICY comment_tags_storage_admin_delete ON storage.objects
  FOR DELETE USING (
    bucket_id = 'comment-tags' AND public.is_super_admin(auth.uid())
  );

CREATE OR REPLACE FUNCTION public.admin_set_user_comment_tag(
  p_user_id UUID,
  p_tag_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tag_id TEXT := NULLIF(BTRIM(p_tag_id), '');
BEGIN
  IF NOT public.is_super_admin(auth.uid()) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Super admin access required');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'User not found');
  END IF;

  IF v_tag_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.comment_tags WHERE id = v_tag_id
  ) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Comment tag not found');
  END IF;

  UPDATE public.profiles
  SET comment_tag_id = v_tag_id,
      updated_at = NOW()
  WHERE id = p_user_id;

  RETURN jsonb_build_object(
    'success', TRUE,
    'user_id', p_user_id,
    'comment_tag_id', v_tag_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_user_comment_tag(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_user_comment_tag(UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
