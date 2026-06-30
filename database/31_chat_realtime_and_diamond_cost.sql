-- =====================================================================
-- 31_chat_realtime_and_diamond_cost.sql — Chat realtime + 1-diamond DM fee
-- =====================================================================
-- Two fixes bundled together because both touch the chat flow:
--   1. `chat_messages` was never added to the supabase_realtime publication,
--      so JS subscriptions never received INSERT/UPDATE events. Users had
--      to refresh the screen to see new DMs. Adding the table fixes it.
--
--   2. New `send_chat_message` SECURITY DEFINER RPC: atomically deducts
--      1 diamond from the sender, inserts the message, and logs the fee
--      as a transaction. Prevents misuse (eve-teasing) by adding a tiny
--      friction cost while keeping the UX simple.
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Enable Supabase realtime for chat_messages
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename  = 'chat_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. send_chat_message RPC — atomic diamond charge + insert
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
  me              uuid   := auth.uid();
  sender_balance  bigint;
  conv_id         text;
  msg_id          uuid;
  trimmed         text;
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

  -- Lock sender row + balance check.
  SELECT diamonds INTO sender_balance
    FROM public.profiles
    WHERE id = me
    FOR UPDATE;
  IF sender_balance IS NULL OR sender_balance < 1 THEN
    RETURN json_build_object('success', false, 'message', 'You need at least 1 diamond to send a message.');
  END IF;

  -- Deduct 1 diamond.
  UPDATE public.profiles SET diamonds = diamonds - 1 WHERE id = me;

  -- Conversation id = "minId__maxId" (matches buildConvId in JS).
  IF me::text < p_receiver_id::text THEN
    conv_id := me::text || '__' || p_receiver_id::text;
  ELSE
    conv_id := p_receiver_id::text || '__' || me::text;
  END IF;

  INSERT INTO public.chat_messages (conversation_id, sender_id, receiver_id, content, type)
    VALUES (conv_id, me, p_receiver_id, trimmed, COALESCE(p_type, 'text'))
    RETURNING id INTO msg_id;

  -- Audit trail.
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
    'new_balance', sender_balance - 1
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.send_chat_message(uuid, text, text) TO authenticated;