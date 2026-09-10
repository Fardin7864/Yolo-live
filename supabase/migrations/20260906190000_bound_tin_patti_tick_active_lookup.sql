-- Same full-history scan as 20260906180000, but in the settlement path.
--
-- 20260906180000 bounded the "which round is live" lookup inside the *read*.
-- The identical query also sits inside tin_patti_pro_tick_unlocked_149, which
-- pg_cron runs every second, and it was never bounded. Measured on production:
--
--   Rows Removed by Filter: 125058
--   Buffers: shared hit=91944 read=2813
--   Execution Time: 741 ms
--
-- So every tick spent ~0.75s walking every Teen Patti round ever played, while
-- holding the blocking pg_advisory_xact_lock(1729, 2) taken by its caller. A
-- 1-second clock could not keep up with a >1s tick, so ticks queued behind each
-- other and settlement drifted 4-7s past the end of betting. Rounds whose payout
-- work is heavier - a big pot, many bet rows to settle - drift furthest, which is
-- why results went missing "especially when the amount is big": the result
-- arrived after the client's display window had already passed.
--
-- The bound is the same reasoning as the read path: to satisfy either branch a
-- round needs ends_at + grace + display > NOW(), so it started within roughly the
-- last 30 seconds. Ten minutes is generous by two orders of magnitude and cannot
-- change which round is selected.
--
-- Everything else in this function is reproduced verbatim from the deployed
-- definition; only the started_at bound is added.

CREATE OR REPLACE FUNCTION public.tin_patti_pro_tick_unlocked_149()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_settings public.game_settings%ROWTYPE;
  v_round public.game_rounds%ROWTYPE;
  v_active public.game_rounds%ROWTYPE;
  v_duration INT;
  v_display INT;
  v_grace INT;
  v_resolved JSON;
  v_created_id UUID;
BEGIN
  SELECT * INTO v_settings FROM public.game_settings gs WHERE gs.id = 'tin_patti_pro';
  IF NOT FOUND OR v_settings.is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Tin Patti Pro is offline', 'server_now', NOW());
  END IF;

  v_duration := GREATEST(5, LEAST(120, COALESCE(v_settings.round_duration_s, 30)));
  v_display := GREATEST(3, LEAST(60, COALESCE(v_settings.result_display_s, 15)));
  v_grace := public.tin_patti_pro_bet_grace_seconds();

  FOR v_round IN
    SELECT *
      FROM public.game_rounds
     WHERE room_id = public.tin_patti_pro_global_room_id()
       AND game_type = 'tin_patti_pro'
       AND status IN ('betting', 'resolving')
       AND ends_at + (v_grace || ' seconds')::interval <= NOW()
     ORDER BY started_at ASC
     FOR UPDATE SKIP LOCKED
  LOOP
    v_resolved := public.resolve_tin_patti_pro_round(v_round.id);
  END LOOP;

  SELECT * INTO v_active
    FROM public.game_rounds
   WHERE room_id = public.tin_patti_pro_global_room_id()
     AND game_type = 'tin_patti_pro'
     -- Only recent rounds can satisfy either branch below; this bound keeps the
     -- index range scan from walking the whole history table on every tick.
     AND started_at > NOW() - INTERVAL '10 minutes'
     AND (
       (status = 'betting' AND ends_at + (v_grace || ' seconds')::interval > NOW())
       OR
       (status = 'settled' AND COALESCE((result->>'settled_at')::timestamptz, ends_at + (v_grace || ' seconds')::interval) + (v_display || ' seconds')::interval > NOW())
     )
   ORDER BY
     CASE WHEN status = 'betting' THEN 0 ELSE 1 END,
     started_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    INSERT INTO public.game_rounds
      (game_type, room_id, status, started_at, ends_at, bets, result, total_bet, win_amount)
    VALUES
      ('tin_patti_pro', public.tin_patti_pro_global_room_id(), 'betting', NOW(), NOW() + (v_duration || ' seconds')::interval, '{}'::jsonb, '{}'::jsonb, 0, 0)
    RETURNING id INTO v_created_id;
  END IF;

  RETURN json_build_object('success', true, 'created_round_id', v_created_id, 'last_resolve', v_resolved, 'server_now', NOW());
END $function$;
