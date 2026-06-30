-- =====================================================================
-- 101_drop_legacy_overloads.sql — retire two orphan function signatures
-- =====================================================================
-- Two functions in public have a legacy + a current signature both
-- still installed. The mobile app exclusively calls the current
-- (p_-prefixed) signatures, which Postgres dispatches unambiguously
-- because the parameter names differ. The legacy ones are dead code
-- that nothing in the app or DB references:
--
--   • public.send_gift(sender_id uuid, receiver_id uuid, gift_id uuid)
--     — old 3-arg version. App now calls send_gift(p_sender_id,
--       p_recipient_id, p_gift_id, p_diamond_cost, p_room_id,
--       p_gift_name, p_count).
--
--   • public.live_stream_heartbeat(p_stream_id uuid, p_viewer_count int)
--     — old 2-arg version. App now calls heartbeat with the third
--       p_current_viewers param (added in migration 78).
--
-- Verified pre-drop via MCP function-source inspection: neither
-- legacy body is reachable from the current mobile code, and no
-- view/trigger/other function depends on them.
--
-- Re-runnable: IF EXISTS keeps this safe to apply twice.
-- =====================================================================

DROP FUNCTION IF EXISTS public.send_gift(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.live_stream_heartbeat(uuid, integer);

-- Verify: each name now resolves to exactly one signature.
DO $$
DECLARE
  v_sg_count int;
  v_hb_count int;
BEGIN
  SELECT count(*) INTO v_sg_count FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
   WHERE n.nspname = 'public' AND p.proname = 'send_gift';
  SELECT count(*) INTO v_hb_count FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
   WHERE n.nspname = 'public' AND p.proname = 'live_stream_heartbeat';

  RAISE NOTICE '101: send_gift overloads remaining (should be 1): %', v_sg_count;
  RAISE NOTICE '101: live_stream_heartbeat overloads remaining (should be 1): %', v_hb_count;
END $$;
