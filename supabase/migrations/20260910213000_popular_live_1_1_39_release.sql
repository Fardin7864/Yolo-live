-- Force every updater-capable earlier APK to download the signed universal
-- production APK directly inside the app. The URL targets a public GitHub
-- release asset, not a repository or profile page.
INSERT INTO public.system_settings(key, value) VALUES
  ('latest_app_version', '"1.1.39"'::JSONB),
  ('min_supported_app_version', '"1.1.39"'::JSONB),
  ('store_url_android', '"https://github.com/Fardin7864/Yolo-live/releases/download/v1.1.39/Popular-Live-v1.1.39-production.apk"'::JSONB),
  ('app_update_notes', '"Bot betting is restored in Greedy King and Popular Greedy. New live viewers now see only messages, gifts, and entry events that happen after they join."'::JSONB)
ON CONFLICT(key) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = NOW();
