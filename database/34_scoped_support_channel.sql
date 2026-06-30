-- =====================================================================
-- 34_scoped_support_channel.sql — Make admin DM a dedicated, gated channel
-- =====================================================================
-- Two tightenings on top of `send_chat_message` so the admin <-> reseller
-- conversation is clearly a *support* channel rather than a generic DM:
--
--   1. FREE FOR SUPPORT: when the receiver is an admin / super_admin, OR
--      when the sender is one, the 1-diamond DM fee is skipped. Bulk
--      diamond commerce conversations should never cost the operator
--      money.
--
--   2. GATED FOR USERS: a regular user can no longer DM an admin. Only
--      active resellers + agency owners can reach support. Admins can
--      always reply to anyone (they need to be able to answer).
--
-- Idempotent: re-runnable.
-- =====================================================================

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

  SELECT role INTO sender_role   FROM public.profiles WHERE id = me;
  SELECT role INTO receiver_role FROM public.profiles WHERE id = p_receiver_id;
  sender_is_admin   := sender_role   IN ('admin', 'super_admin');
  receiver_is_admin := receiver_role IN ('admin', 'super_admin');
  is_support_thread := receiver_is_admin OR sender_is_admin;

  -- Gating: regular users may NOT initiate a chat with an admin. Only
  -- active resellers + agency owners can reach the support channel.
  -- Admins themselves can reply to anyone — that's how support works.
  IF receiver_is_admin AND NOT sender_is_admin THEN
    sender_is_reseller     := EXISTS (
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

  -- Conversation id ("minId__maxId") same as JS buildConvId.
  IF me::text < p_receiver_id::text THEN
    conv_id := me::text || '__' || p_receiver_id::text;
  ELSE
    conv_id := p_receiver_id::text || '__' || me::text;
  END IF;

  -- Fee logic — support threads are always free, regular DMs still 1💎.
  IF is_support_thread THEN
    INSERT INTO public.chat_messages (conversation_id, sender_id, receiver_id, content, type)
      VALUES (conv_id, me, p_receiver_id, trimmed, COALESCE(p_type, 'text'))
      RETURNING id INTO msg_id;
    RETURN json_build_object(
      'success',    true,
      'message_id', msg_id,
      'free',       true
    );
  END IF;

  -- Standard DM — keep the existing 1💎 fee to prevent eve-teasing.
  SELECT diamonds INTO sender_balance
    FROM public.profiles
    WHERE id = me
    FOR UPDATE;
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
    'success',     true,
    'message_id',  msg_id,
    'new_balance', sender_balance - 1,
    'free',        false
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.send_chat_message(uuid, text, text) TO authenticated;