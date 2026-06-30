-- =====================================================================
-- 57_qa_followups.sql
-- =====================================================================
-- Two tightenings from the deep QA pass:
--
--   1. recalc_user_level was directly INSERTing the "Level up!" row
--      into notifications, bypassing the maybe_notify() helper that
--      migration 55 introduced to respect push_notifications_enabled.
--      Result: users who turned push notifications OFF still got a
--      level-up notification — a Play Store / GDPR compliance gap.
--      Fix: route the insert through public.maybe_notify().
--
--   2. log_app_error was granted to `anon` so very-early pre-login
--      crashes could still be logged. Without a rate limit that makes
--      the table a free anonymous write target — an attacker can flood
--      error_logs with garbage JSONB context payloads. Cost is small
--      per row but unbounded. Fix: require authenticated callers. We
--      lose pre-auth crashes, which are rare; the Phase B ErrorBoundary
--      runs inside GlobalStateProvider so by the time it fires the
--      Supabase session is already loaded.
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. recalc_user_level — route notification through maybe_notify()
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recalc_user_level(p_user_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_multiplier int;
  v_exp        bigint;
  v_old_level  int;
  v_new_level  int;
BEGIN
  v_multiplier := public.get_setting_int('level_exp_multiplier', 1500);
  IF v_multiplier IS NULL OR v_multiplier <= 0 THEN
    v_multiplier := 1500;
  END IF;

  SELECT COALESCE(lifetime_diamonds_spent, 0), COALESCE(level, 1)
    INTO v_exp, v_old_level
    FROM public.profiles WHERE id = p_user_id;
  IF v_exp IS NULL THEN RETURN NULL; END IF;

  v_new_level := GREATEST(1, LEAST(100, (v_exp / v_multiplier)::int + 1));

  IF v_new_level <> v_old_level THEN
    UPDATE public.profiles SET level = v_new_level WHERE id = p_user_id;
    IF v_new_level > v_old_level THEN
      -- maybe_notify() respects the recipient's push_notifications_enabled
      -- flag. If they opted out, the row is silently skipped. If they
      -- didn't, this writes the same notification the direct INSERT used
      -- to write.
      PERFORM public.maybe_notify(
        p_user_id,
        'level_up',
        'Level up! 🎉',
        'You reached level ' || v_new_level || '. Keep gifting to climb higher.',
        jsonb_build_object('old_level', v_old_level, 'new_level', v_new_level)
      );
    END IF;
  END IF;

  RETURN v_new_level;
END $$;

GRANT EXECUTE ON FUNCTION public.recalc_user_level(uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 2. log_app_error — drop anon grant, require auth
-- ---------------------------------------------------------------------
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
  me   uuid := auth.uid();
  v_id uuid;
BEGIN
  -- Authenticated callers only. The Phase B ErrorBoundary lives inside
  -- GlobalStateProvider so a session is in place before any crash that
  -- this RPC could log; the pre-auth window is microscopic and not
  -- worth opening up to anonymous spam.
  IF me IS NULL THEN
    RETURN NULL;
  END IF;

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

REVOKE EXECUTE ON FUNCTION public.log_app_error(text, text, text, text, text, jsonb) FROM anon;
GRANT  EXECUTE ON FUNCTION public.log_app_error(text, text, text, text, text, jsonb) TO authenticated;
