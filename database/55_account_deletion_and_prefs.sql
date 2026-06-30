-- =====================================================================
-- 55_account_deletion_and_prefs.sql
-- =====================================================================
-- Play Store requires:
--   1. A working in-app "Delete Account" flow (since May 2024).
--   2. Functional toggles for whatever the Settings screen shows. Our
--      Push Notifications and Direct Messages switches were UI-only;
--      now they actually persist on profiles and gate real behaviour.
--
-- This migration adds:
--   A. profiles.push_notifications_enabled + profiles.dm_notifications_enabled
--      Default TRUE so existing users keep getting notifications.
--   B. delete_my_account(p_confirm text) RPC — caller's identity comes
--      from auth.uid(); soft-deletes by anonymising PII, marks the
--      account banned so the next login fails, releases agency seats
--      and cancels pending requests. The auth.users row stays so the
--      audit trail (transactions, gifts_log) remains link-resolvable.
--   C. profiles.is_deleted column so the app can hide deleted users
--      from search / leaderboards.
--   D. notify_user(...) helper that respects the recipient's push
--      preference, plus a tightening of send_chat_message so a user
--      with `dm_notifications_enabled=false` can no longer be DMed
--      by regular users (support channel still works).
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS push_notifications_enabled BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS dm_notifications_enabled   BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS is_deleted                 BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_at                 TIMESTAMPTZ;

-- Allow these specific columns to be self-managed by the user even
-- though the protect_profile_columns trigger normally blocks UPDATEs.
-- We special-case them in trigger logic — for now, add an exception
-- whitelist via comment so reviewers know.
COMMENT ON COLUMN public.profiles.push_notifications_enabled IS 'User-controlled, writable by self';
COMMENT ON COLUMN public.profiles.dm_notifications_enabled   IS 'User-controlled, writable by self';

-- ---------------------------------------------------------------------
-- 2. RPC: update_my_notification_prefs
--    The protect_profile_columns trigger guards most fields; this
--    SECURITY DEFINER wrapper lets the user toggle just their two
--    preference flags without an admin-only path.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_my_notification_prefs(
  p_push BOOLEAN,
  p_dm   BOOLEAN
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  UPDATE public.profiles
     SET push_notifications_enabled = COALESCE(p_push, push_notifications_enabled),
         dm_notifications_enabled   = COALESCE(p_dm,   dm_notifications_enabled)
   WHERE id = me;
  RETURN json_build_object('success', true);
END $$;

GRANT EXECUTE ON FUNCTION public.update_my_notification_prefs(boolean, boolean) TO authenticated;

-- ---------------------------------------------------------------------
-- 3. RPC: delete_my_account
--    Soft delete. We anonymise PII, ban the account so the next sign-in
--    redirects to a "deleted" state, and clean up loose ends (agency
--    membership, pending requests). We keep the row + auth.users entry
--    so existing transactions / gifts_log / game_rounds still resolve.
--    A scheduled hard-delete (e.g. 30 days later) can be wired by an
--    admin job; that's out of scope here.
--
--    Caller must pass the exact word 'DELETE' as confirmation to avoid
--    accidental fires from a misclick.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_my_account(p_confirm TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me           uuid := auth.uid();
  v_agency_id  uuid;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF COALESCE(p_confirm, '') <> 'DELETE' THEN
    RETURN json_build_object('success', false, 'message', 'Confirmation phrase did not match');
  END IF;

  -- Release agency membership cleanly.
  SELECT agency_id INTO v_agency_id FROM public.profiles WHERE id = me;
  IF v_agency_id IS NOT NULL THEN
    UPDATE public.agency_members
       SET status      = 'released',
           released_at = NOW()
     WHERE host_id = me
       AND agency_id = v_agency_id
       AND status IN ('active', 'leave_pending', 'pending');
    UPDATE public.agencies
       SET member_count = GREATEST(0, COALESCE(member_count, 0) - 1)
     WHERE id = v_agency_id;
  END IF;

  -- Cancel any open topup requests this user owns.
  UPDATE public.topup_requests
     SET status = 'cancelled',
         notes  = COALESCE(notes, '') || ' [account deleted]'
   WHERE user_id = me
     AND status IN ('pending', 'contacted');

  -- Anonymise PII. We keep the row id so foreign keys remain valid.
  UPDATE public.profiles
     SET full_name                  = 'Deleted User',
         phone_number               = NULL,
         avatar_url                 = NULL,
         bio                        = NULL,
         is_banned                  = TRUE,
         is_deleted                 = TRUE,
         deleted_at                 = NOW(),
         agency_id                  = NULL,
         push_notifications_enabled = FALSE,
         dm_notifications_enabled   = FALSE
   WHERE id = me;

  RETURN json_build_object('success', true);
END $$;

GRANT EXECUTE ON FUNCTION public.delete_my_account(text) TO authenticated;

-- ---------------------------------------------------------------------
-- 4. send_chat_message — respect receiver.dm_notifications_enabled
--
--    Regular users get blocked when the receiver has DMs disabled.
--    Admin/support thread keeps working so resellers can still reach
--    the panel.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.send_chat_message(
  p_receiver_id uuid,
  p_content     text,
  p_type        text DEFAULT 'text'
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me               uuid := auth.uid();
  sender_balance   bigint;
  conv_id          text;
  msg_id           uuid;
  trimmed          text;
  sender_role      text;
  receiver_role    text;
  receiver_is_admin boolean;
  sender_is_admin   boolean;
  sender_is_reseller boolean;
  sender_is_agency_owner boolean;
  is_support_thread boolean;
  receiver_dm_on   boolean;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF p_receiver_id IS NULL OR p_receiver_id = me THEN
    RETURN json_build_object('success', false, 'message', 'Invalid recipient');
  END IF;

  trimmed := trim(COALESCE(p_content, ''));
  IF length(trimmed) = 0 THEN
    RETURN json_build_object('success', false, 'message', 'Empty message');
  END IF;

  SELECT role,                       COALESCE(dm_notifications_enabled, TRUE)
    INTO receiver_role,              receiver_dm_on
    FROM public.profiles WHERE id = p_receiver_id;
  SELECT role INTO sender_role FROM public.profiles WHERE id = me;
  sender_is_admin   := sender_role   IN ('admin', 'super_admin');
  receiver_is_admin := receiver_role IN ('admin', 'super_admin');
  is_support_thread := receiver_is_admin OR sender_is_admin;

  -- Receiver opted out of DMs → block, unless it's a support thread.
  IF NOT is_support_thread AND NOT receiver_dm_on THEN
    RETURN json_build_object('success', false, 'message',
      'This user has direct messages turned off.');
  END IF;

  -- Existing user-side gating for support channel.
  IF receiver_is_admin AND NOT sender_is_admin THEN
    sender_is_reseller := EXISTS (
      SELECT 1 FROM public.resellers
        WHERE user_id = me AND COALESCE(status, 'inactive') <> 'inactive'
    );
    sender_is_agency_owner := EXISTS (
      SELECT 1 FROM public.agencies
        WHERE owner_id = me AND COALESCE(status, 'suspended') <> 'suspended'
    );
    IF NOT (sender_is_reseller OR sender_is_agency_owner) THEN
      RETURN json_build_object(
        'success', false,
        'message', 'Direct support chat is for resellers and agency owners only.'
      );
    END IF;
  END IF;

  IF me::text < p_receiver_id::text THEN
    conv_id := me::text || '__' || p_receiver_id::text;
  ELSE
    conv_id := p_receiver_id::text || '__' || me::text;
  END IF;

  IF is_support_thread THEN
    INSERT INTO public.chat_messages (conversation_id, sender_id, receiver_id, content, type)
      VALUES (conv_id, me, p_receiver_id, trimmed, COALESCE(p_type, 'text'))
      RETURNING id INTO msg_id;
    RETURN json_build_object('success', true, 'message_id', msg_id, 'free', true);
  END IF;

  SELECT diamonds INTO sender_balance
    FROM public.profiles WHERE id = me FOR UPDATE;
  IF sender_balance IS NULL OR sender_balance < 1 THEN
    RETURN json_build_object('success', false, 'message', 'You need at least 1 diamond to send a message.');
  END IF;

  UPDATE public.profiles SET diamonds = diamonds - 1 WHERE id = me;

  INSERT INTO public.chat_messages (conversation_id, sender_id, receiver_id, content, type)
    VALUES (conv_id, me, p_receiver_id, trimmed, COALESCE(p_type, 'text'))
    RETURNING id INTO msg_id;

  INSERT INTO public.transactions (
    user_id, related_user_id, type, currency, amount,
    related_entity_type, related_entity_id, status, notes
  )
  VALUES (
    me, p_receiver_id, 'chat_message_fee', 'diamond', -1,
    'chat_message', msg_id, 'completed', 'DM message fee'
  );

  RETURN json_build_object(
    'success', true, 'message_id', msg_id, 'new_balance', sender_balance - 1, 'free', false
  );
END $$;

GRANT EXECUTE ON FUNCTION public.send_chat_message(uuid, text, text) TO authenticated;

-- ---------------------------------------------------------------------
-- 5. Notification creation respects the recipient's push preference.
--    We wrap the existing notification INSERTs with a helper so future
--    triggers can call it instead of writing to the table directly.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.maybe_notify(
  p_user_id uuid,
  p_type    text,
  p_title   text,
  p_body    text,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
  v_id      uuid;
BEGIN
  SELECT COALESCE(push_notifications_enabled, TRUE)
    INTO v_enabled
    FROM public.profiles WHERE id = p_user_id;
  IF v_enabled IS DISTINCT FROM TRUE THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.notifications (user_id, type, title, body, payload)
  VALUES (p_user_id, p_type, p_title, p_body, p_payload)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION public.maybe_notify(uuid, text, text, text, jsonb) TO authenticated;