-- =====================================================================
-- 78_room_seat_earnings.sql
-- =====================================================================
-- Per-user "diamonds received this session" aggregation for the audio
-- room's seat badges. The mobile UI renders a tiny "💎 1.2k" pill
-- under each seat-holder's name showing how many diamonds-worth of
-- gifts they've received in the CURRENT live session.
--
-- Data source: gifts_log.diamond_cost (per gift), filtered to the
-- CURRENT live_streams row's id (gifts_log.room_id stores the
-- stream-row id, not the host's profile id — that's why we look up
-- the active stream inside the RPC). When the host ends and
-- restarts the stream, a new live_streams row is created so the
-- room_id changes and counts naturally reset to zero — matches the
-- product expectation that "this stream's hot moment" is what's on
-- display, not lifetime gifting.
--
-- The RPC returns one row per receiver who has gotten anything at
-- all this session. The client merges it into its local state map,
-- then incrementally updates that map from the realtime gift
-- broadcast events for instant visual feedback.
--
-- Access: any authenticated user can call this for any room — the
-- numbers are public information visible to everyone in the room.
--
-- Idempotent.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.get_room_seat_earnings(p_host_id UUID)
RETURNS TABLE (
  receiver_id        UUID,
  diamonds_received  BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stream_id    UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    -- Not authenticated → empty result rather than an error. Avoids
    -- a noisy splash of red on cold start before the session lands.
    RETURN;
  END IF;
  IF p_host_id IS NULL THEN
    RETURN;
  END IF;

  -- Anchor to the host's CURRENT live session. If they aren't live
  -- right now, fall back to their most recent session so the badge
  -- can still settle to a final count for a viewer who's looking at
  -- the post-stream "live ended" overlay.
  SELECT id INTO v_stream_id
    FROM public.live_streams
   WHERE broadcaster_id = p_host_id
     AND status = 'live'
   ORDER BY started_at DESC
   LIMIT 1;

  IF v_stream_id IS NULL THEN
    SELECT id INTO v_stream_id
      FROM public.live_streams
     WHERE broadcaster_id = p_host_id
     ORDER BY started_at DESC
     LIMIT 1;
  END IF;

  -- If the host has never streamed, return empty.
  IF v_stream_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT
      g.receiver_id,
      SUM(g.diamond_cost * COALESCE(g.count, 1))::BIGINT AS diamonds_received
    FROM public.gifts_log g
    WHERE g.room_id = v_stream_id
    GROUP BY g.receiver_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_room_seat_earnings(UUID) TO authenticated;


-- =====================================================================
-- DONE
-- =====================================================================
