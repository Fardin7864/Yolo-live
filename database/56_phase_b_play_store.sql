-- =====================================================================
-- 56_phase_b_play_store.sql
-- =====================================================================
-- Phase B groundwork for the Play Store launch:
--
--   1. Force-update gating. We need an admin-controllable
--      `min_supported_app_version` so we can lock out older clients
--      after a breaking change (e.g. a new RPC signature). Store URLs
--      live next to it so the blocking modal can deep-link straight to
--      the install page.
--   2. Age confirmation. Add `age_confirmed` + `age_confirmed_at` on
--      profiles so the signup flow can record the user ticking the
--      "I am 18 or older" box. Default FALSE on the column means
--      pre-existing accounts (signed up before this change) won't be
--      retroactively blocked, but the new signup flow always sets it.
--   3. Crash / error logging. A simple `error_logs` table + a
--      `log_app_error` SECURITY DEFINER RPC so the mobile error
--      boundary can phone home when something unhandled escapes. Cheap
--      first-party crash reporting that doesn't bind us to a vendor.
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. App version gates + store URLs (system_settings keys)
-- ---------------------------------------------------------------------
INSERT INTO public.system_settings (key, value)
VALUES
  ('min_supported_app_version', '"1.0.0"'::jsonb),
  ('latest_app_version',        '"1.0.0"'::jsonb),
  ('store_url_android',         '"https://play.google.com/store/apps/details?id=com.yoloteam.Yololive"'::jsonb),
  ('store_url_ios',             '""'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. Age confirmation columns
-- ---------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS age_confirmed    BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS age_confirmed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.profiles.age_confirmed IS 'User self-confirmed 18+ at signup';

-- Lightweight RPC the signup screen calls right after auth.signUp so
-- the column gets set even when the protect_profile_columns trigger
-- would normally block client UPDATEs.
CREATE OR REPLACE FUNCTION public.confirm_my_age()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE me uuid := auth.uid();
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  UPDATE public.profiles
     SET age_confirmed    = TRUE,
         age_confirmed_at = COALESCE(age_confirmed_at, NOW())
   WHERE id = me;
  RETURN json_build_object('success', true);
END $$;

GRANT EXECUTE ON FUNCTION public.confirm_my_age() TO authenticated;

-- ---------------------------------------------------------------------
-- 3. Error / crash log
--
--    Self-hosted crash reporting. The mobile ErrorBoundary calls
--    log_app_error() when an exception escapes. Admin panel can read
--    this table (RLS gives admins SELECT) to triage in-the-wild crashes
--    without paying a SaaS vendor.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.error_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  app_version  TEXT,
  platform     TEXT,
  screen       TEXT,
  error_message TEXT NOT NULL,
  stack         TEXT,
  context       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_error_logs_recent ON public.error_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_user   ON public.error_logs (user_id, created_at DESC);

ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;

-- Admins read everything; everyone else is locked out.
DROP POLICY IF EXISTS error_logs_admin_read ON public.error_logs;
CREATE POLICY error_logs_admin_read ON public.error_logs
  FOR SELECT
  USING (public.is_admin(auth.uid()));

-- Writes only via the RPC.
DROP POLICY IF EXISTS error_logs_no_direct_write ON public.error_logs;
CREATE POLICY error_logs_no_direct_write ON public.error_logs
  FOR ALL USING (FALSE) WITH CHECK (FALSE);

CREATE OR REPLACE FUNCTION public.log_app_error(
  p_message     TEXT,
  p_stack       TEXT DEFAULT NULL,
  p_screen      TEXT DEFAULT NULL,
  p_platform    TEXT DEFAULT NULL,
  p_app_version TEXT DEFAULT NULL,
  p_context     JSONB DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
  v_id uuid;
BEGIN
  -- We accept unauthenticated logs too (very first launch, pre-login
  -- crash). Just stamp user_id NULL in that case.
  INSERT INTO public.error_logs
    (user_id, app_version, platform, screen, error_message, stack, context)
  VALUES
    (me, p_app_version, p_platform, p_screen,
     COALESCE(LEFT(p_message, 4000), 'unknown'),
     LEFT(COALESCE(p_stack, ''), 8000),
     p_context)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION public.log_app_error(text, text, text, text, text, jsonb) TO anon, authenticated;