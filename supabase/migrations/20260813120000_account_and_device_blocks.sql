-- Authoritative account and device access controls.
-- Raw device identifiers never enter Postgres; the device-access Edge
-- Function hashes them before writing or checking these tables.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.app_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_hash TEXT NOT NULL UNIQUE CHECK (length(device_hash) = 64),
  installation_hash TEXT CHECK (installation_hash IS NULL OR length(installation_hash) = 64),
  platform TEXT NOT NULL DEFAULT 'unknown',
  device_model TEXT,
  os_version TEXT,
  app_version TEXT,
  first_ip INET,
  last_ip INET,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.app_device_users (
  device_id UUID NOT NULL REFERENCES public.app_devices(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, user_id)
);

CREATE INDEX IF NOT EXISTS app_device_users_user_idx
  ON public.app_device_users(user_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS public.account_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  email_snapshot TEXT,
  reason TEXT,
  blocked_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  unblocked_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  unblocked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS account_blocks_one_active_idx
  ON public.account_blocks(user_id) WHERE unblocked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.device_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES public.app_devices(id) ON DELETE CASCADE,
  source_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  reason TEXT,
  blocked_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  unblocked_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  unblocked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS device_blocks_one_active_idx
  ON public.device_blocks(device_id) WHERE unblocked_at IS NULL;

ALTER TABLE public.app_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_device_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_blocks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.app_devices, public.app_device_users,
  public.account_blocks, public.device_blocks FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.app_devices, public.app_device_users,
  public.account_blocks, public.device_blocks TO service_role;

CREATE OR REPLACE FUNCTION public.admin_get_user_access_controls(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT jsonb_build_object(
    'user_id', p.id,
    'display_id', p.display_id,
    'name', COALESCE(p.full_name, 'User'),
    'email', u.email,
    'account_blocked', COALESCE(p.is_banned, false),
    'account_block', (
      SELECT jsonb_build_object('reason', b.reason, 'blocked_at', b.blocked_at)
      FROM public.account_blocks b
      WHERE b.user_id = p.id AND b.unblocked_at IS NULL
      ORDER BY b.blocked_at DESC LIMIT 1
    ),
    'devices', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'device_hash', d.device_hash,
        'platform', d.platform,
        'device_model', d.device_model,
        'os_version', d.os_version,
        'app_version', d.app_version,
        'last_ip', host(d.last_ip),
        'first_seen_at', du.first_seen_at,
        'last_seen_at', du.last_seen_at,
        'blocked', (db.id IS NOT NULL),
        'block_reason', db.reason,
        'blocked_at', db.blocked_at
      ) ORDER BY du.last_seen_at DESC)
      FROM public.app_device_users du
      JOIN public.app_devices d ON d.id = du.device_id
      LEFT JOIN public.device_blocks db
        ON db.device_id = d.id AND db.unblocked_at IS NULL
      WHERE du.user_id = p.id
    ), '[]'::jsonb)
  ) INTO v_result
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE p.id = p_user_id;

  IF v_result IS NULL THEN RAISE EXCEPTION 'User not found'; END IF;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_account_block(
  p_user_id UUID,
  p_blocked BOOLEAN,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_email TEXT;
  v_role TEXT;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin(auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Not authorized');
  END IF;
  IF p_user_id = auth.uid() THEN
    RETURN jsonb_build_object('success', false, 'message', 'You cannot block your own account');
  END IF;

  SELECT p.role, u.email INTO v_role, v_email
  FROM public.profiles p LEFT JOIN auth.users u ON u.id = p.id
  WHERE p.id = p_user_id FOR UPDATE OF p;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'message', 'User not found'); END IF;
  IF v_role = 'super_admin' AND NOT public.is_super_admin(auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only a super admin can block this account');
  END IF;

  IF p_blocked THEN
    UPDATE public.profiles SET is_banned = true, status = 'banned' WHERE id = p_user_id;
    INSERT INTO public.account_blocks(user_id, email_snapshot, reason, blocked_by)
    VALUES (p_user_id, v_email, NULLIF(trim(p_reason), ''), auth.uid())
    ON CONFLICT (user_id) WHERE unblocked_at IS NULL DO UPDATE
      SET reason = EXCLUDED.reason, blocked_by = EXCLUDED.blocked_by,
          blocked_at = now(), email_snapshot = EXCLUDED.email_snapshot;
  ELSE
    UPDATE public.profiles SET is_banned = false, status = 'active' WHERE id = p_user_id;
    UPDATE public.account_blocks SET unblocked_at = now(), unblocked_by = auth.uid()
    WHERE user_id = p_user_id AND unblocked_at IS NULL;
  END IF;

  INSERT INTO public.admin_audit_log(admin_id, action, target_type, target_id, payload)
  VALUES (auth.uid(), CASE WHEN p_blocked THEN 'account_block' ELSE 'account_unblock' END,
    'profile', p_user_id, jsonb_build_object('reason', NULLIF(trim(p_reason), ''), 'email', v_email));
  RETURN jsonb_build_object('success', true, 'blocked', p_blocked);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_device_block(
  p_user_id UUID,
  p_device_hash TEXT DEFAULT NULL,
  p_blocked BOOLEAN DEFAULT true,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count INT := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin(auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Not authorized');
  END IF;
  IF p_user_id = auth.uid() THEN
    RETURN jsonb_build_object('success', false, 'message', 'You cannot device-block yourself');
  END IF;

  IF p_blocked THEN
    INSERT INTO public.device_blocks(device_id, source_user_id, reason, blocked_by)
    SELECT d.id, p_user_id, NULLIF(trim(p_reason), ''), auth.uid()
    FROM public.app_device_users du JOIN public.app_devices d ON d.id = du.device_id
    WHERE du.user_id = p_user_id AND (p_device_hash IS NULL OR d.device_hash = p_device_hash)
    ON CONFLICT (device_id) WHERE unblocked_at IS NULL DO UPDATE
      SET reason = EXCLUDED.reason, source_user_id = EXCLUDED.source_user_id,
          blocked_by = EXCLUDED.blocked_by, blocked_at = now();
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSE
    UPDATE public.device_blocks db SET unblocked_at = now(), unblocked_by = auth.uid()
    FROM public.app_devices d, public.app_device_users du
    WHERE db.device_id = d.id AND du.device_id = d.id AND du.user_id = p_user_id
      AND db.unblocked_at IS NULL AND (p_device_hash IS NULL OR d.device_hash = p_device_hash);
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  IF v_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'message',
      CASE WHEN p_blocked THEN 'No registered device found. Ask the user to open the updated app once.'
           ELSE 'No matching active device block found.' END);
  END IF;

  INSERT INTO public.admin_audit_log(admin_id, action, target_type, target_id, payload)
  VALUES (auth.uid(), CASE WHEN p_blocked THEN 'device_block' ELSE 'device_unblock' END,
    'profile', p_user_id, jsonb_build_object('device_hash', p_device_hash, 'device_count', v_count,
      'reason', NULLIF(trim(p_reason), '')));
  RETURN jsonb_build_object('success', true, 'blocked', p_blocked, 'device_count', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_user_access_controls(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_account_block(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_device_block(UUID, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_user_access_controls(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_account_block(UUID, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_device_block(UUID, TEXT, BOOLEAN, TEXT) TO authenticated;

-- Keep Supabase Auth itself in sync with the profile access flag. This
-- prevents a blocked identity from refreshing a cached session or signing
-- straight back in while the account block is active.
CREATE OR REPLACE FUNCTION public.sync_profile_account_block_to_auth()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  UPDATE auth.users
  SET banned_until = CASE WHEN NEW.is_banned THEN '2099-12-31 23:59:59+00'::timestamptz ELSE NULL END,
      updated_at = now()
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_sync_account_block_to_auth ON public.profiles;
CREATE TRIGGER profiles_sync_account_block_to_auth
AFTER INSERT OR UPDATE OF is_banned ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.sync_profile_account_block_to_auth();

UPDATE auth.users u
SET banned_until = '2099-12-31 23:59:59+00'::timestamptz, updated_at = now()
FROM public.profiles p
WHERE p.id = u.id AND p.is_banned = true;

NOTIFY pgrst, 'reload schema';
