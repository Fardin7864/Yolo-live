-- Lock the daily host video reward to one cumulative hour per Bangladesh day.
-- live_stream_heartbeat() only records progress; claim_host_live_reward() is the
-- only function that credits beans and locks the daily row before payment.
INSERT INTO public.system_settings(key, value)
VALUES (
  'host_hour_reward',
  jsonb_build_object('enabled', TRUE, 'minutes', 60, 'beans', 5000)
)
ON CONFLICT(key) DO UPDATE
SET value = jsonb_set(
      jsonb_set(
        jsonb_set(COALESCE(public.system_settings.value, '{}'::JSONB), '{enabled}', 'true'::JSONB, TRUE),
        '{minutes}', '60'::JSONB, TRUE
      ),
      '{beans}', COALESCE(public.system_settings.value->'beans', '5000'::JSONB), TRUE
    ),
    updated_at = NOW();

CREATE OR REPLACE FUNCTION public.host_live_reward_config()
RETURNS TABLE (enabled BOOLEAN, required_seconds BIGINT, beans BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((value->>'enabled')::BOOLEAN, TRUE),
         3600::BIGINT,
         GREATEST(0, COALESCE((value->>'beans')::BIGINT, 5000))
    FROM public.system_settings
   WHERE key = 'host_hour_reward'
  UNION ALL
  SELECT TRUE, 3600::BIGINT, 5000::BIGINT
   WHERE NOT EXISTS (
     SELECT 1 FROM public.system_settings WHERE key = 'host_hour_reward'
   )
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.host_live_reward_config() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.host_live_reward_config() TO authenticated, service_role;

-- Force updater-capable direct APKs to download the signed production APK
-- inside the app after the v1.1.40 GitHub release is published.
INSERT INTO public.system_settings(key, value) VALUES
  ('latest_app_version', '"1.1.40"'::JSONB),
  ('min_supported_app_version', '"1.1.40"'::JSONB),
  ('store_url_android', '"https://github.com/Fardin7864/Yolo-live/releases/download/v1.1.40/Popular-Live-v1.1.40-production.apk"'::JSONB),
  ('app_update_notes', '"Daily Video Live Reward is now claimed manually from Task Center after 60 cumulative video-live minutes. It can be claimed once per Bangladesh day."'::JSONB)
ON CONFLICT(key) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = NOW();

