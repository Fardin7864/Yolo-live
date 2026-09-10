-- Green Live media pipeline repair.
--
-- The dashboard and mobile app use wahnvplqftkqtvtpwztq.  All media added
-- from the dashboard must live in this project's public buckets; otherwise
-- a URL can save in the catalog but be invisible to mobile clients.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('profile-frames', 'profile-frames', TRUE, 1048576, ARRAY['image/webp']),
  ('mall-intros', 'mall-intros', TRUE, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp', 'video/mp4']),
  ('audio-templates', 'audio-templates', TRUE, 524288, ARRAY['image/jpeg', 'image/png', 'image/webp']),
  ('gift-animations', 'gift-animations', TRUE, 2097152, ARRAY['application/json']),
  ('gift-sounds', 'gift-sounds', TRUE, 2097152, ARRAY['audio/mpeg', 'audio/mp3', 'audio/wav'])
ON CONFLICT (id) DO UPDATE
  SET public = TRUE,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

INSERT INTO public.system_settings (key, value)
VALUES ('platform_name', '"Green Live"'::jsonb)
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = NOW();

-- Anyone using the app can read catalog media. Only super-admins can change
-- it through the dashboard.
DO $$
DECLARE bucket TEXT;
BEGIN
  FOREACH bucket IN ARRAY ARRAY['profile-frames', 'mall-intros', 'audio-templates', 'gift-animations', 'gift-sounds']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', bucket || '_green_live_public_read');
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', bucket || '_green_live_admin_insert');
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', bucket || '_green_live_admin_update');
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', bucket || '_green_live_admin_delete');
    EXECUTE format('CREATE POLICY %I ON storage.objects FOR SELECT USING (bucket_id = %L)', bucket || '_green_live_public_read', bucket);
    EXECUTE format('CREATE POLICY %I ON storage.objects FOR INSERT WITH CHECK (bucket_id = %L AND public.is_super_admin(auth.uid()))', bucket || '_green_live_admin_insert', bucket);
    EXECUTE format('CREATE POLICY %I ON storage.objects FOR UPDATE USING (bucket_id = %L AND public.is_super_admin(auth.uid()))', bucket || '_green_live_admin_update', bucket);
    EXECUTE format('CREATE POLICY %I ON storage.objects FOR DELETE USING (bucket_id = %L AND public.is_super_admin(auth.uid()))', bucket || '_green_live_admin_delete', bucket);
  END LOOP;
END $$;
