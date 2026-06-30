-- =====================================================================
-- LIVE STREAM HEARTBEAT — detect app-kill / crash and auto-end live streams
--
-- Problem: if a host force-kills the app or it crashes, the live_streams
-- row stays `status = 'live'` forever. The home feed then shows ghost
-- streams that viewers can't actually join.
--
-- Solution: host pings every ~30s. A cleanup RPC marks any 'live' row
-- whose last_heartbeat_at is older than 90s as 'ended'. Run the cleanup
-- on home-feed load + via Supabase scheduled cron for safety.
-- Idempotent. Run in Supabase SQL Editor.
-- =====================================================================

-- 1. Heartbeat column
ALTER TABLE public.live_streams
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_live_streams_heartbeat
  ON public.live_streams(status, last_heartbeat_at);

-- 2. RPC: host pings every 30s
CREATE OR REPLACE FUNCTION public.live_stream_heartbeat(
  p_stream_id UUID,
  p_viewer_count INT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_broadcaster UUID;
BEGIN
  -- Confirm caller is the broadcaster (only they should heartbeat their stream)
  SELECT broadcaster_id INTO v_broadcaster
  FROM public.live_streams WHERE id = p_stream_id;

  IF v_broadcaster IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Stream not found');
  END IF;
  IF v_broadcaster <> auth.uid() THEN
    RETURN json_build_object('success', false, 'message', 'Not your stream');
  END IF;

  UPDATE public.live_streams
     SET last_heartbeat_at = NOW(),
         peak_viewers = GREATEST(COALESCE(peak_viewers, 0), COALESCE(p_viewer_count, 0))
   WHERE id = p_stream_id AND status = 'live';

  RETURN json_build_object('success', true);
END $$;

-- 3. RPC: cleanup stale streams (anyone can call — it only marks expired ones)
CREATE OR REPLACE FUNCTION public.cleanup_stale_live_streams()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count INT;
BEGIN
  UPDATE public.live_streams
     SET status = 'ended',
         ended_at = COALESCE(ended_at, last_heartbeat_at, NOW())
   WHERE status = 'live'
     AND last_heartbeat_at < NOW() - INTERVAL '90 seconds';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN json_build_object('success', true, 'cleaned', v_count);
END $$;

-- 4. Schedule the cleanup every minute via pg_cron (if available)
-- If pg_cron isn't installed in your Supabase project, this block silently
-- skips. You can still call cleanup_stale_live_streams() manually or from
-- the client's home-feed loader as a safety net.
DO $$ BEGIN
  PERFORM cron.schedule(
    'cleanup-stale-live-streams',
    '* * * * *',  -- every minute
    $cron$ SELECT public.cleanup_stale_live_streams(); $cron$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available — skipping scheduled cleanup. Client-side fallback will handle it.';
END $$;

-- =====================================================================
-- DONE. After this:
--   - Host app calls `live_stream_heartbeat(stream_id, viewer_count)` every 30s
--   - Stale streams auto-mark as `ended` after 90s of no heartbeat
-- =====================================================================