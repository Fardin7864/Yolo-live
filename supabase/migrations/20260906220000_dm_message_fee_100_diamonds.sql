-- Raise the direct-message fee from 1 diamond to 100.
--
-- The fee was hardcoded in three places inside send_chat_message (the balance
-- check, the deduction and the ledger row), which is why it could drift. It now
-- reads `system_settings.dm_message_fee_diamonds`, defaulting to 100, so the
-- price is tunable from the admin panel instead of needing a migration.
--
-- Support threads (either side an admin) stay free, and the reseller/agency
-- gating, DM opt-out and conversation-id rules are unchanged.

INSERT INTO public.system_settings(key, value)
VALUES ('dm_message_fee_diamonds', '100'::jsonb)
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = NOW();

CREATE OR REPLACE FUNCTION public.send_chat_message(
  p_receiver_id uuid,
  p_content text,
  p_type text DEFAULT 'text'::text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  me                     uuid := auth.uid();
  sender_balance         bigint;
  conv_id                text;
  msg_id                 uuid;
  trimmed                text;
  sender_role            text;
  receiver_role          text;
  receiver_is_admin      boolean;
  sender_is_admin        boolean;
  sender_is_reseller     boolean;
  sender_is_agency_owner boolean;
  is_support_thread      boolean;
  receiver_dm_on         boolean;
  message_fee            bigint;
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

  SELECT role,          COALESCE(dm_notifications_enabled, TRUE)
    INTO receiver_role, receiver_dm_on
    FROM public.profiles WHERE id = p_receiver_id;
  SELECT role INTO sender_role FROM public.profiles WHERE id = me;
  sender_is_admin   := sender_role   IN ('admin', 'super_admin');
  receiver_is_admin := receiver_role IN ('admin', 'super_admin');
  is_support_thread := receiver_is_admin OR sender_is_admin;

  -- Receiver opted out of DMs -> block, unless it's a support thread.
  IF NOT is_support_thread AND NOT receiver_dm_on THEN
    RETURN json_build_object('success', false, 'message',
      'This user has direct messages turned off.');
  END IF;

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

  SELECT GREATEST(0, COALESCE((value #>> '{}')::bigint, 100))
    INTO message_fee
    FROM public.system_settings
   WHERE key = 'dm_message_fee_diamonds';
  message_fee := COALESCE(message_fee, 100);

  SELECT diamonds INTO sender_balance
    FROM public.profiles WHERE id = me FOR UPDATE;
  IF sender_balance IS NULL OR sender_balance < message_fee THEN
    RETURN json_build_object(
      'success', false,
      'message', 'You need at least ' || message_fee || ' diamonds to send a message.'
    );
  END IF;

  IF message_fee > 0 THEN
    UPDATE public.profiles SET diamonds = diamonds - message_fee WHERE id = me;
  END IF;

  INSERT INTO public.chat_messages (conversation_id, sender_id, receiver_id, content, type)
    VALUES (conv_id, me, p_receiver_id, trimmed, COALESCE(p_type, 'text'))
    RETURNING id INTO msg_id;

  IF message_fee > 0 THEN
    INSERT INTO public.transactions (
      user_id, related_user_id, type, currency, amount,
      related_entity_type, related_entity_id, status, notes
    )
    VALUES (
      me, p_receiver_id, 'chat_message_fee', 'diamond', -message_fee,
      'chat_message', msg_id, 'completed', 'DM message fee'
    );
  END IF;

  RETURN json_build_object(
    'success', true,
    'message_id', msg_id,
    'new_balance', sender_balance - message_fee,
    'fee', message_fee,
    'free', message_fee = 0
  );
END $function$;

REVOKE ALL ON FUNCTION public.send_chat_message(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_chat_message(uuid, text, text) TO authenticated, service_role;
