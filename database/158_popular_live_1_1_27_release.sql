-- Publish Popular Live 1.1.27 after its signed universal ARM APK is live.
-- Builds below 1.1.26 remain blocked; 1.1.26 receives an optional update notice.
INSERT INTO public.system_settings(key, value) VALUES
  ('latest_app_version', '"1.1.27"'::jsonb),
  ('min_supported_app_version', '"1.1.26"'::jsonb),
  ('store_url_android', '"https://github.com/Fardin7864/live-streaming-app/releases/download/v1.1.27/app-universal-release.apk"'::jsonb),
  ('app_update_notes', '"New Greedy Lion and Teen Patti Pro games, smoother live-room layouts, reliable result delivery, faster batched betting, and Android performance improvements."'::jsonb)
ON CONFLICT(key) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = NOW();
