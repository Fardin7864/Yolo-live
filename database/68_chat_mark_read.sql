-- =====================================================================
-- 68_chat_mark_read.sql
-- =====================================================================
-- Bug fix: the Messages tab was showing stale unread badges (e.g.
-- "8 unread" even after the user opened the chat and read everything).
--
-- Root cause: chat_messages had only SELECT + INSERT RLS policies. The
-- client-side `UPDATE chat_messages SET is_read = true WHERE id IN
-- (...)` in chat/[id].js was silently rejected by RLS — no UPDATE
-- policy meant Postgres said "0 rows updated" with no error you'd
-- see in production. The unread count never decremented.
--
-- This migration ships a SECURITY DEFINER RPC the client calls in
-- place of the raw UPDATE:
--
--   mark_chat_messages_read(p_message_ids UUID[])
--     • Only updates rows where the caller is the receiver
--     • Only flips is_read TRUE — sender / content / etc. are untouched
--     • Returns the count actually updated so the client can verify
--
-- We deliberately do NOT also add a raw FOR UPDATE policy on the
-- table. Going through the RPC keeps the privilege narrow (one column,
-- one direction) and the audit story clean.
--
-- Idempotent: re-runnable.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.mark_chat_messages_read(p_message_ids UUID[])
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me        uuid := auth.uid();
  v_count   int;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF p_message_ids IS NULL OR array_length(p_message_ids, 1) IS NULL THEN
    RETURN json_build_object('success', true, 'updated', 0);
  END IF;

  -- Only flips messages the caller is genuinely the receiver of, and
  -- only when they're not already marked read. Both filters together
  -- mean a malicious client can't:
  --   - mark someone else's read receipts true (receiver_id check)
  --   - re-flip a sender's own message (receiver_id check)
  --   - cause unnecessary realtime UPDATE storms for already-read rows
  --     (is_read = FALSE filter — no-op rows produce no UPDATE event)
  UPDATE public.chat_messages
     SET is_read = TRUE
   WHERE id = ANY (p_message_ids)
     AND receiver_id = me
     AND is_read = FALSE;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN json_build_object('success', true, 'updated', v_count);
END $$;

GRANT EXECUTE ON FUNCTION public.mark_chat_messages_read(uuid[]) TO authenticated;
