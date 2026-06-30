-- =====================================================================
-- 66_live_current_viewers_ranking.sql
-- =====================================================================
-- Adds proper "what's popular RIGHT NOW" tracking + ranking so the home
-- grid shows the most-watched lives at the top, matching Bigo / Tango /
-- Likee behaviour.
--
-- WHAT WAS WRONG
--   - live_streams.peak_viewers tracks the session MAX, not the current
--     viewer count. A 3-hour-old stream that briefly hit 200 viewers
--     and now has 5 would always rank above a brand-new one with 80
--     viewers right now.
--   - The home query ordered by started_at DESC — newest first — so
--     popularity didn't influence ranking at all.
--   - The heartbeat RPC only updated peak; we had nowhere to store
--     "current".
--
-- WHAT THIS MIGRATION CHANGES
--   1. New column live_streams.current_viewers (INT, default 0).
--      Overwritten on every heartbeat with the latest count, so it
--      reflects reality within ~30s (the heartbeat interval).
--   2. live_stream_heartbeat() RPC extended with an optional
--      p_current_viewers parameter. peak_viewers stays GREATEST()-ed
--      so historical max is preserved; current_viewers is overwritten.
--      DEFAULT NULL on the new param means existing clients calling
--      without it keep working (no current update happens, but old
--      app builds shouldn't break the RPC).
--   3. cleanup_stale_live_streams() now also zeroes current_viewers
--      on ended rows, so a ghost row marked ended doesn't leak its
--      last viewer count into any analytics.
--   4. Index on (status, current_viewers DESC) so the home query is
--      cheap even at thousands of concurrent lives.
--
-- Mobile side (NOT in this file):
--   - broadcast/[id].js will start passing roomViewers.length as
--     p_current_viewers on every heartbeat.
--   - app/main/(tabs)/index.js will switch its ORDER BY to use
--     current_viewers DESC and read current_viewers for display.
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------
ALTER TABLE public.live_streams
  ADD COLUMN IF NOT EXISTS current_viewers INT NOT NULL DEFAULT 0;

-- Index supporting the home-screen ORDER BY. Partial on status='live'
-- because the trending query only ever asks about live rooms — keeps
-- the index small even after months of ended streams accumulate.
CREATE INDEX IF NOT EXISTS idx_live_streams_trending
  ON public.live_streams (current_viewers DESC, total_gifts DESC, started_at DESC)
  WHERE status = 'live';

-- ---------------------------------------------------------------------
-- 2. Extend live_stream_heartbeat to write current_viewers.
--    Backwards-compatible: p_current_viewers DEFAULT NULL means an
--    older client that doesn't pass it keeps the previous behaviour
--    (only peak gets updated, current stays whatever it was).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.live_stream_heartbeat(
  p_stream_id       UUID,
  p_viewer_count    INT  DEFAULT 0,    -- peak signal (running max)
  p_current_viewers INT  DEFAULT NULL  -- current signal (overwrite)
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
         peak_viewers      = GREATEST(COALESCE(peak_viewers, 0), COALESCE(p_viewer_count, 0)),
         current_viewers   = COALESCE(p_current_viewers, current_viewers)
   WHERE id = p_stream_id AND status = 'live';

  RETURN json_build_object('success', true);
END $$;

GRANT EXECUTE ON FUNCTION public.live_stream_heartbeat(uuid, int, int) TO authenticated;

-- ---------------------------------------------------------------------
-- 3. cleanup_stale_live_streams — zero current_viewers on rows we mark
--    as ended so analytics + the home grid never see a stale count.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_stale_live_streams()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count INT;
BEGIN
  UPDATE public.live_streams
     SET status          = 'ended',
         ended_at        = COALESCE(ended_at, last_heartbeat_at, NOW()),
         current_viewers = 0
   WHERE status = 'live'
     AND last_heartbeat_at < NOW() - INTERVAL '90 seconds';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN json_build_object('success', true, 'cleaned', v_count);
END $$;

GRANT EXECUTE ON FUNCTION public.cleanup_stale_live_streams() TO authenticated;
