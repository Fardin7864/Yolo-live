-- =====================================================================
-- Maintenance bypass list
-- Adds a system setting containing user UUIDs or display IDs that should
-- continue using the app while maintenance mode is enabled.
-- =====================================================================

INSERT INTO public.system_settings (key, value)
VALUES ('maintenance_bypass_user_ids', '[]'::JSONB)
ON CONFLICT (key) DO NOTHING;

-- =====================================================================
-- DONE.
-- =====================================================================
