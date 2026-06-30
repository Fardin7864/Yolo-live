-- =====================================================================
-- 67_report_dead_stream.sql
-- =====================================================================
-- Fast cleanup path for ghost lives that force-quit / Metro-reload /
-- network-died without running the React unmount cleanup.
--
-- THE GAP IT FILLS
--   cleanup_stale_live_streams() runs every ~60s via pg_cron and only
--   ends rows whose last heartbeat is older than 90 seconds. That's
--   the right ceiling for tolerance to network blips, but it means
--   that for up to ~90s after a host crashes, the live_streams row
--   still says 'live' and the home grid still surfaces it. Other
--   viewers click in, get stuck on "Joining" while Layer B of the
--   client-side detection waits 8s, then bail. Bandwidth + UX waste.
--
-- WHAT THIS RPC DOES
--   Any authenticated viewer who finds themselves staring at a
--   non-publishing host can call report_dead_stream(stream_id). The
--   server independently verifies the stream is genuinely stale
--   (status='live' AND heartbeat older than 30s OR no heartbeat) and
--   flips it to 'ended'. The realtime UPDATE then fires for everyone
--   subscribed (including the Layer A listener in broadcast/[id].js),
--   so all viewers exit cleanly within milliseconds of the report.
--
--   Crucially the server-side staleness check stops a buggy / malicious
--   client from ending a healthy live just by calling this. If the
--   host's heartbeat is fresh, the call is a no-op.
--
-- WHY 30s NOT 60s
--   The client-side Layer B grace is 8s. Adding 22s of margin gives
--   us 30s — comfortably longer than the host's 30s heartbeat
--   interval, so a host who heartbeated 25s ago can't be force-ended
--   by a paranoid viewer.
--
-- Idempotent: re-runnable.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.report_dead_stream(p_stream_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me        uuid := auth.uid();
  v_row     public.live_streams%ROWTYPE;
  v_stale   boolean;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  SELECT * INTO v_row FROM public.live_streams WHERE id = p_stream_id;
  IF NOT FOUND THEN
    -- Row already gone — treat as a successful no-op.
    RETURN json_build_object('success', true, 'ended', false, 'message', 'Stream not found');
  END IF;

  -- Idempotent — if someone else already ended it, just return.
  IF v_row.status <> 'live' THEN
    RETURN json_build_object('success', true, 'ended', false, 'message', 'Already ended');
  END IF;

  -- Server-side staleness check. The client's 8s presence grace + this
  -- 30s heartbeat threshold add up to a comfortable margin against
  -- racing a healthy host who heartbeated 25s ago.
  v_stale := v_row.last_heartbeat_at IS NULL
          OR v_row.last_heartbeat_at < (NOW() - INTERVAL '30 seconds');

  IF NOT v_stale THEN
    RETURN json_build_object(
      'success', false,
      'ended',   false,
      'message', 'Stream still has a fresh heartbeat — refusing to end.'
    );
  END IF;

  UPDATE public.live_streams
     SET status          = 'ended',
         ended_at        = COALESCE(ended_at, NOW()),
         current_viewers = 0
   WHERE id = p_stream_id;

  RETURN json_build_object('success', true, 'ended', true);
END $$;

GRANT EXECUTE ON FUNCTION public.report_dead_stream(uuid) TO authenticated;
