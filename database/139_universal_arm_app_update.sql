-- Publish the ARM-universal Android build. It supports both 32-bit
-- armeabi-v7a and 64-bit arm64-v8a Android devices.
INSERT INTO public.system_settings(key, value) VALUES
  ('latest_app_version', '"1.1.21"'::jsonb),
  ('min_supported_app_version', '"1.1.19"'::jsonb),
  ('store_url_android', '"https://github.com/Fardin7864/live-streaming-app/releases/download/v1.1.21/green-live-v1.1.21-universal-arm-production-20260722.apk"'::jsonb),
  ('app_update_notes', '"Improved APK installation compatibility for 32-bit and 64-bit ARM Android devices."'::jsonb)
ON CONFLICT(key) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = NOW();
