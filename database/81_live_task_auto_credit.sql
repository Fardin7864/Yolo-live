-- =====================================================================
-- 81_live_task_auto_credit.sql
-- =====================================================================
-- Product spec: "Every time a host opens a live and streams for 1 hour
-- straight, 5,000 beans land in their wallet automatically. No 30-min
-- tier, no 2-hour tier, no daily cap — it's strictly PER LIVE SESSION."
--
-- This intentionally REPLACES the tiered daily task that migrations 70
-- and 71 set up (host_live_30 / host_live_60 / host_live_120). The
-- product owner decided one flat per-session reward beats a daily
-- staircase that would let a host max out their bean payout by
-- streaming once per day. With per-session, a host who streams 3
-- separate 1-hour lives in a day earns 15,000 beans; the staircase
-- model would have capped them at the daily 5,000.
--
-- WHAT THIS MIGRATION DOES
--
--   1. Disables the three host_live_X tasks (is_active=FALSE) so they
--      no longer show in the Tasks UI. Their progress data is left
--      intact for audit / history.
--   2. Adds live_streams.hour_reward_credited BOOLEAN — one flag per
--      stream row, default FALSE. Set to TRUE the first time the host
--      crosses the 60-minute mark on that stream so the heartbeat can
--      never re-pay.
--   3. Extends live_stream_heartbeat: if the stream has been live
--      ≥ 60 minutes and the flag is still false, grant 5,000 beans via
--      grant_reward() and set the flag. Also fires a notification so
--      the host sees a toast.
--
-- The grant function from migration 71 (`grant_reward(uid, amount,
-- currency, source, meta)`) does all the heavy lifting (balance bump
-- + transactions row + currency routing).
--
-- A fresh live_streams row is created on every go-live (see
-- `start_live_stream` in yolo_schema.sql), so "per live session"
-- means exactly "per row in live_streams" — no extra session table
-- needed.
--
-- Idempotent.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Disable the old tiered host-live tasks. is_active=FALSE removes
--    them from the Tasks UI; the rows + any existing user_task_progress
--    are kept for audit. If product later wants to revive the tiers
--    they can flip the flag back without losing history.
-- ---------------------------------------------------------------------
UPDATE public.tasks
   SET is_active = FALSE
 WHERE id IN ('host_live_30', 'host_live_60', 'host_live_120');


-- ---------------------------------------------------------------------
-- 2. Per-stream credit flag. Default FALSE so the very next heartbeat
--    on an existing 'live' row (a host already streaming when this
--    migration runs) is eligible to award once 60 minutes have passed.
-- ---------------------------------------------------------------------
ALTER TABLE public.live_streams
  ADD COLUMN IF NOT EXISTS hour_reward_credited BOOLEAN NOT NULL DEFAULT FALSE;


-- ---------------------------------------------------------------------
-- 3. Heartbeat — extend with the per-session 1-hour reward.
--
--    Preserves the original signature (16_live_heartbeat.sql) and the
--    migration-66 extension that added p_current_viewers, so the
--    mobile client doesn't need a code change.
--
--    The 3600-second threshold is checked from the row's started_at,
--    not from app-side accumulators — so a host who backgrounds the
--    app and comes back still gets the reward at the wall-clock hour
--    mark of the stream's existence.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.live_stream_heartbeat(
  p_stream_id        UUID,
  p_viewer_count     INT DEFAULT NULL,
  p_current_viewers  INT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcaster  UUID;
  v_started_at   TIMESTAMPTZ;
  v_credited     BOOLEAN;
  v_elapsed_sec  BIGINT;
  v_new_bal      BIGINT;
BEGIN
  SELECT broadcaster_id, started_at, COALESCE(hour_reward_credited, FALSE)
    INTO v_broadcaster, v_started_at, v_credited
    FROM public.live_streams
   WHERE id = p_stream_id;

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

  -- Award once when the live has been running for an hour straight.
  -- Atomic via the `hour_reward_credited = FALSE` predicate in the
  -- UPDATE — a second concurrent heartbeat sees the flag flipped and
  -- skips.
  v_elapsed_sec := EXTRACT(EPOCH FROM (NOW() - v_started_at))::BIGINT;
  IF NOT v_credited AND v_elapsed_sec >= 3600 THEN
    UPDATE public.live_streams
       SET hour_reward_credited = TRUE
     WHERE id = p_stream_id
       AND hour_reward_credited = FALSE;
    IF FOUND THEN
      v_new_bal := public.grant_reward(
        v_broadcaster, 5000, 'bean', 'live_hour_reward',
        jsonb_build_object('stream_id', p_stream_id, 'hours', 1)
      );

      -- In-app toast / notif so the host sees the beans land without
      -- pulling down to refresh. Free to fail — the wallet was
      -- already updated above.
      BEGIN
        INSERT INTO public.notifications (user_id, type, title, body, payload)
        VALUES (
          v_broadcaster,
          'task_reward',
          '🎉 1 Hour Live!',
          '+5,000 beans added to your wallet',
          jsonb_build_object(
            'reward',      5000,
            'currency',    'bean',
            'new_balance', v_new_bal,
            'stream_id',   p_stream_id
          )
        );
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;
  END IF;

  RETURN json_build_object('success', true);
END $$;

GRANT EXECUTE ON FUNCTION public.live_stream_heartbeat(UUID, INT, INT) TO authenticated;


-- =====================================================================
-- DONE
-- =====================================================================
