-- =====================================================================
-- Auto-sync moments_posts.likes_count and comments_count via triggers
-- + create storage bucket for moments images
-- Idempotent. Run in Supabase SQL Editor.
-- =====================================================================

-- 1. Likes counter trigger
CREATE OR REPLACE FUNCTION public.moments_likes_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.moments_posts
       SET likes_count = COALESCE(likes_count, 0) + 1
     WHERE id = NEW.post_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.moments_posts
       SET likes_count = GREATEST(0, COALESCE(likes_count, 0) - 1)
     WHERE id = OLD.post_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS moments_likes_sync_trg ON public.moments_likes;
CREATE TRIGGER moments_likes_sync_trg
  AFTER INSERT OR DELETE ON public.moments_likes
  FOR EACH ROW
  EXECUTE FUNCTION public.moments_likes_sync();


-- 2. Comments counter trigger
CREATE OR REPLACE FUNCTION public.moments_comments_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.moments_posts
       SET comments_count = COALESCE(comments_count, 0) + 1
     WHERE id = NEW.post_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.moments_posts
       SET comments_count = GREATEST(0, COALESCE(comments_count, 0) - 1)
     WHERE id = OLD.post_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS moments_comments_sync_trg ON public.moments_comments;
CREATE TRIGGER moments_comments_sync_trg
  AFTER INSERT OR DELETE ON public.moments_comments
  FOR EACH ROW
  EXECUTE FUNCTION public.moments_comments_sync();


-- 3. Storage bucket for moments images (idempotent — Supabase allows
--    INSERT ON CONFLICT DO NOTHING on storage.buckets)
INSERT INTO storage.buckets (id, name, public)
VALUES ('moments', 'moments', true)
ON CONFLICT (id) DO NOTHING;

-- 4. Policies on the bucket: anyone signed in can upload their own files,
--    everyone can read.
DROP POLICY IF EXISTS "moments_public_read" ON storage.objects;
CREATE POLICY "moments_public_read" ON storage.objects FOR SELECT
  USING (bucket_id = 'moments');

DROP POLICY IF EXISTS "moments_owner_write" ON storage.objects;
CREATE POLICY "moments_owner_write" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'moments' AND auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "moments_owner_delete" ON storage.objects;
CREATE POLICY "moments_owner_delete" ON storage.objects FOR DELETE
  USING (bucket_id = 'moments' AND owner = auth.uid());

-- =====================================================================
-- DONE. After running this:
--   - Liking/unliking a moment auto-updates likes_count
--   - Posting/deleting a comment auto-updates comments_count
--   - Image uploads to `moments` bucket work from the app
-- =====================================================================