-- Keep the database-backed app name aligned with the Popular Live release.
INSERT INTO public.system_settings (key, value)
VALUES ('platform_name', '"Popular Live"'::JSONB)
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value;
