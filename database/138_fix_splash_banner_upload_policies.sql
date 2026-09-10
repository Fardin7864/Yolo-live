-- Fix dashboard uploads for remote splash media and home banners.
--
-- The original policies called public.is_admin(), whose meaning changed as
-- dashboard RBAC evolved. The dashboard now authorizes each module through
-- public.has_admin_permission(), so Storage and metadata writes must use the
-- same permission source. This migration is idempotent and safe to re-run.

-- Keep existing buckets but repair their public/read and upload constraints.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('splashes', 'splashes', TRUE, 5 * 1024 * 1024,
    ARRAY['image/png','image/jpeg','image/webp','application/json','text/json']),
  ('banners', 'banners', TRUE, 2 * 1024 * 1024,
    ARRAY['image/png','image/jpeg','image/webp'])
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Metadata is publicly readable, while only staff with Manage permission for
-- the corresponding dashboard module may create/update/delete it.
ALTER TABLE public.app_splashes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS app_splashes_read ON public.app_splashes;
DROP POLICY IF EXISTS app_splashes_admin_write ON public.app_splashes;
CREATE POLICY app_splashes_read ON public.app_splashes
  FOR SELECT USING (TRUE);
CREATE POLICY app_splashes_admin_write ON public.app_splashes
  FOR ALL TO authenticated
  USING (public.has_admin_permission(auth.uid(), 'splash', 'manage'))
  WITH CHECK (public.has_admin_permission(auth.uid(), 'splash', 'manage'));

ALTER TABLE public.home_banners ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS home_banners_read ON public.home_banners;
DROP POLICY IF EXISTS home_banners_admin_write ON public.home_banners;
CREATE POLICY home_banners_read ON public.home_banners
  FOR SELECT USING (TRUE);
CREATE POLICY home_banners_admin_write ON public.home_banners
  FOR ALL TO authenticated
  USING (public.has_admin_permission(auth.uid(), 'banners', 'manage'))
  WITH CHECK (public.has_admin_permission(auth.uid(), 'banners', 'manage'));

-- Storage objects are public-read because both assets are displayed by the
-- mobile app before/without authentication. Writes follow module RBAC.
DROP POLICY IF EXISTS splashes_public_read ON storage.objects;
DROP POLICY IF EXISTS splashes_admin_insert ON storage.objects;
DROP POLICY IF EXISTS splashes_admin_update ON storage.objects;
DROP POLICY IF EXISTS splashes_admin_delete ON storage.objects;
DROP POLICY IF EXISTS splashes_rbac_public_read ON storage.objects;
DROP POLICY IF EXISTS splashes_rbac_insert ON storage.objects;
DROP POLICY IF EXISTS splashes_rbac_update ON storage.objects;
DROP POLICY IF EXISTS splashes_rbac_delete ON storage.objects;

CREATE POLICY splashes_rbac_public_read ON storage.objects
  FOR SELECT USING (bucket_id = 'splashes');
CREATE POLICY splashes_rbac_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'splashes'
    AND public.has_admin_permission(auth.uid(), 'splash', 'manage')
  );
CREATE POLICY splashes_rbac_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'splashes'
    AND public.has_admin_permission(auth.uid(), 'splash', 'manage')
  )
  WITH CHECK (
    bucket_id = 'splashes'
    AND public.has_admin_permission(auth.uid(), 'splash', 'manage')
  );
CREATE POLICY splashes_rbac_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'splashes'
    AND public.has_admin_permission(auth.uid(), 'splash', 'manage')
  );

DROP POLICY IF EXISTS banners_public_read ON storage.objects;
DROP POLICY IF EXISTS banners_admin_insert ON storage.objects;
DROP POLICY IF EXISTS banners_admin_update ON storage.objects;
DROP POLICY IF EXISTS banners_admin_delete ON storage.objects;
DROP POLICY IF EXISTS banners_rbac_public_read ON storage.objects;
DROP POLICY IF EXISTS banners_rbac_insert ON storage.objects;
DROP POLICY IF EXISTS banners_rbac_update ON storage.objects;
DROP POLICY IF EXISTS banners_rbac_delete ON storage.objects;

CREATE POLICY banners_rbac_public_read ON storage.objects
  FOR SELECT USING (bucket_id = 'banners');
CREATE POLICY banners_rbac_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'banners'
    AND public.has_admin_permission(auth.uid(), 'banners', 'manage')
  );
CREATE POLICY banners_rbac_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'banners'
    AND public.has_admin_permission(auth.uid(), 'banners', 'manage')
  )
  WITH CHECK (
    bucket_id = 'banners'
    AND public.has_admin_permission(auth.uid(), 'banners', 'manage')
  );
CREATE POLICY banners_rbac_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'banners'
    AND public.has_admin_permission(auth.uid(), 'banners', 'manage')
  );

GRANT EXECUTE ON FUNCTION public.has_admin_permission(UUID, TEXT, TEXT) TO authenticated;
