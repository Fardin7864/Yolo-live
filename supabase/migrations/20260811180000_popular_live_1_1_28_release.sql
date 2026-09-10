-- Publish Popular Live 1.1.28 only after its signed universal ARM APK is live.
-- Supported older builds receive the update modal; builds below 1.1.26 remain blocked.
INSERT INTO public.system_settings(key, value) VALUES
  ('latest_app_version', '"1.1.28"'::jsonb),
  ('min_supported_app_version', '"1.1.26"'::jsonb),
  ('store_url_android', '"https://github.com/Fardin7864/live-streaming-app/releases/download/v1.1.28/app-universal-release.apk"'::jsonb),
  ('app_update_notes', '"New Lucky Dice Royale game, improved Greedy Lion and Teen Patti Pro live-room layouts, smoother result animations, clearer game rules and rankings, and reliability improvements."'::jsonb)
ON CONFLICT(key) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = NOW();
