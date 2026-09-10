-- Device unblock must restore the linked account in the same transaction.
-- Also repair accounts left banned by the previous split-unblock behavior.

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
    FROM public.app_device_users du
    JOIN public.app_devices d ON d.id = du.device_id
    WHERE du.user_id = p_user_id
      AND (p_device_hash IS NULL OR d.device_hash = p_device_hash)
    ON CONFLICT (device_id) WHERE unblocked_at IS NULL DO UPDATE
      SET reason = EXCLUDED.reason,
          source_user_id = EXCLUDED.source_user_id,
          blocked_by = EXCLUDED.blocked_by,
          blocked_at = now();
    GET DIAGNOSTICS v_count = ROW_COUNT;

    IF v_count = 0 THEN
      RETURN jsonb_build_object('success', false, 'message',
        'No registered device found. Ask the user to open the updated app once.');
    END IF;

    SELECT email INTO v_email FROM auth.users WHERE id = p_user_id;
    INSERT INTO public.account_blocks(user_id, email_snapshot, reason, blocked_by)
    VALUES (p_user_id, v_email, NULLIF(trim(p_reason), ''), auth.uid())
    ON CONFLICT (user_id) WHERE unblocked_at IS NULL DO UPDATE
      SET reason = EXCLUDED.reason,
          blocked_by = EXCLUDED.blocked_by,
          blocked_at = now(),
          email_snapshot = EXCLUDED.email_snapshot;

    UPDATE public.profiles
       SET is_banned = true, status = 'banned'
     WHERE id = p_user_id;
  ELSE
    UPDATE public.device_blocks db
       SET unblocked_at = now(), unblocked_by = auth.uid()
      FROM public.app_devices d, public.app_device_users du
     WHERE db.device_id = d.id
       AND du.device_id = d.id
       AND du.user_id = p_user_id
       AND db.unblocked_at IS NULL
       AND (p_device_hash IS NULL OR d.device_hash = p_device_hash);
    GET DIAGNOSTICS v_count = ROW_COUNT;

    IF v_count = 0 THEN
      RETURN jsonb_build_object('success', false, 'message', 'No matching active device block found.');
    END IF;

    -- A device block creates the linked account restriction. Removing that
    -- device block therefore restores the same account identity and Auth ban.
    UPDATE public.account_blocks
       SET unblocked_at = now(), unblocked_by = auth.uid()
     WHERE user_id = p_user_id
       AND unblocked_at IS NULL;

    UPDATE public.profiles
       SET is_banned = false, status = 'active'
     WHERE id = p_user_id;
  END IF;

  INSERT INTO public.admin_audit_log(admin_id, action, target_type, target_id, payload)
  VALUES (
    auth.uid(),
    CASE WHEN p_blocked THEN 'device_and_account_block' ELSE 'device_and_account_unblock' END,
    'profile',
    p_user_id,
    jsonb_build_object(
      'device_hash', p_device_hash,
      'device_count', v_count,
      'account_blocked', p_blocked,
      'reason', NULLIF(trim(p_reason), '')
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'blocked', p_blocked,
    'account_blocked', p_blocked,
    'device_count', v_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_device_block(UUID, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_device_block(UUID, TEXT, BOOLEAN, TEXT) TO authenticated;

-- Repair users whose latest access-control action was an unblock performed
-- by the old RPC. Do not touch users whose latest action is a deliberate
-- account block or a newer device block.
WITH latest_access_action AS (
  SELECT DISTINCT ON (target_id)
    target_id,
    action,
    created_at
  FROM public.admin_audit_log
  WHERE target_type = 'profile'
    AND action IN (
      'account_block',
      'account_unblock',
      'device_and_account_block',
      'device_unblock',
      'device_and_account_unblock'
    )
  ORDER BY target_id, created_at DESC
),
stale_accounts AS (
  SELECT target_id AS user_id
  FROM latest_access_action
  WHERE action = 'device_unblock'
)
UPDATE public.account_blocks ab
   SET unblocked_at = now(),
       unblocked_by = COALESCE(ab.unblocked_by, ab.blocked_by)
  FROM stale_accounts s
 WHERE ab.user_id = s.user_id
   AND ab.unblocked_at IS NULL;

WITH latest_access_action AS (
  SELECT DISTINCT ON (target_id)
    target_id,
    action,
    created_at
  FROM public.admin_audit_log
  WHERE target_type = 'profile'
    AND action IN (
      'account_block',
      'account_unblock',
      'device_and_account_block',
      'device_unblock',
      'device_and_account_unblock'
    )
  ORDER BY target_id, created_at DESC
)
UPDATE public.profiles p
   SET is_banned = false,
       status = 'active'
  FROM latest_access_action a
 WHERE p.id = a.target_id
   AND a.action = 'device_unblock'
   AND p.is_banned = true;

NOTIFY pgrst, 'reload schema';

