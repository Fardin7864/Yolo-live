-- =====================================================================
-- System Settings — key/value config persisted in DB so the admin
-- panel Settings page actually saves.
-- Idempotent. Run in Supabase SQL Editor.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.system_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID REFERENCES public.profiles(id)
);

-- Seed defaults
INSERT INTO public.system_settings (key, value) VALUES
  ('platform_name',    '"Care Live"'::JSONB),
  ('support_email',    '"support@yolo.live"'::JSONB),
  ('signup_enabled',   'true'::JSONB),
  ('live_enabled',     'true'::JSONB),
  ('gifting_enabled',  'true'::JSONB),
  ('games_enabled',    'true'::JSONB),
  ('maintenance_mode', 'false'::JSONB),
  ('maintenance_message', '"We''ll be right back. Maintenance in progress."'::JSONB),
  ('maintenance_bypass_user_ids', '[]'::JSONB)
ON CONFLICT (key) DO NOTHING;

-- RLS — read open to all, write only by admins
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sys_settings_read ON public.system_settings;
CREATE POLICY sys_settings_read ON public.system_settings FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS sys_settings_admin ON public.system_settings;
CREATE POLICY sys_settings_admin ON public.system_settings FOR ALL
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- RPC: bulk-save settings + audit log
CREATE OR REPLACE FUNCTION public.update_system_settings(
  p_admin_id UUID,
  p_updates  JSONB
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  k TEXT;
  v JSONB;
BEGIN
  IF NOT public.is_admin(p_admin_id) THEN
    RETURN json_build_object('success', false, 'message', 'Not an admin');
  END IF;

  FOR k, v IN SELECT * FROM jsonb_each(p_updates) LOOP
    INSERT INTO public.system_settings (key, value, updated_at, updated_by)
    VALUES (k, v, NOW(), p_admin_id)
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = NOW(),
          updated_by = p_admin_id;
  END LOOP;

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (p_admin_id, 'update_system_settings', 'system_settings', NULL, p_updates);

  RETURN json_build_object('success', true);
END $$;

-- =====================================================================
-- DONE.
-- =====================================================================
