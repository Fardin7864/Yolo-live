-- A block must become visible immediately to an open app and must stop an
-- active hosted room. Profile Realtime is the primary push signal; auth
-- session cleanup and the app's periodic device check are recovery layers.

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

  IF NEW.is_banned THEN
    UPDATE public.live_streams
    SET status = 'banned', ended_at = COALESCE(ended_at, now()), current_viewers = 0
    WHERE broadcaster_id = NEW.id AND status = 'live';

    -- Remove refresh credentials immediately. The profile UPDATE remains the
    -- realtime signal that tells the currently connected app to unmount live,
    -- game, chat, and other authenticated screens.
    DELETE FROM auth.sessions WHERE user_id = NEW.id;
    DELETE FROM auth.refresh_tokens WHERE user_id = NEW.id::text;
  END IF;
  RETURN NEW;
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
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_count INT := 0;
  v_email TEXT;
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

    IF v_count = 0 THEN
      RETURN jsonb_build_object('success', false, 'message',
        'No registered device found. Ask the user to open the updated app once.');
    END IF;

    SELECT email INTO v_email FROM auth.users WHERE id = p_user_id;
    INSERT INTO public.account_blocks(user_id, email_snapshot, reason, blocked_by)
    VALUES (p_user_id, v_email, NULLIF(trim(p_reason), ''), auth.uid())
    ON CONFLICT (user_id) WHERE unblocked_at IS NULL DO UPDATE
      SET reason = EXCLUDED.reason, blocked_by = EXCLUDED.blocked_by,
          blocked_at = now(), email_snapshot = EXCLUDED.email_snapshot;

    -- This UPDATE triggers immediate Auth/session/live cleanup and emits the
    -- profile realtime event consumed by DeviceAccessGate.
    UPDATE public.profiles SET is_banned = true, status = 'banned' WHERE id = p_user_id;
  ELSE
    UPDATE public.device_blocks db SET unblocked_at = now(), unblocked_by = auth.uid()
    FROM public.app_devices d, public.app_device_users du
    WHERE db.device_id = d.id AND du.device_id = d.id AND du.user_id = p_user_id
      AND db.unblocked_at IS NULL AND (p_device_hash IS NULL OR d.device_hash = p_device_hash);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count = 0 THEN
      RETURN jsonb_build_object('success', false, 'message', 'No matching active device block found.');
    END IF;
    -- Device unblock is deliberately separate from account unblock. An admin
    -- must explicitly restore both controls after a permanent device action.
  END IF;

  INSERT INTO public.admin_audit_log(admin_id, action, target_type, target_id, payload)
  VALUES (auth.uid(), CASE WHEN p_blocked THEN 'device_and_account_block' ELSE 'device_unblock' END,
    'profile', p_user_id, jsonb_build_object('device_hash', p_device_hash, 'device_count', v_count,
      'account_blocked', p_blocked, 'reason', NULLIF(trim(p_reason), '')));
  RETURN jsonb_build_object('success', true, 'blocked', p_blocked,
    'account_blocked', p_blocked, 'device_count', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_device_block(UUID, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_device_block(UUID, TEXT, BOOLEAN, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
