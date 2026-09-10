-- The live goal is a room activity total, not withdrawable host income. A host's
-- self-gift must advance the goal even when its beans remain non-withdrawable and
-- the gift is excluded from host/gifter rankings.
DO $migration$
DECLARE
  v_signature REGPROCEDURE := 'public.send_gift_batch(jsonb,text,bigint,uuid,text,integer,uuid)'::REGPROCEDURE;
  v_definition TEXT;
  v_patched TEXT;
BEGIN
  SELECT pg_get_functiondef(v_signature) INTO v_definition;

  v_patched := regexp_replace(
    v_definition,
    'WHEN v_room_host_id = ANY\(v_recipients\)[[:space:]]+AND \(v_room_host_id IS DISTINCT FROM me OR v_self_counts\)[[:space:]]+THEN',
    'WHEN v_room_host_id = ANY(v_recipients) THEN'
  );
  v_patched := replace(
    v_patched,
    'IF v_host_earnings_delta > 0 THEN',
    'IF v_room_host_id = ANY(v_recipients) THEN'
  );

  IF strpos(v_patched, 'AND (v_room_host_id IS DISTINCT FROM me OR v_self_counts)') > 0
     OR strpos(v_patched, 'IF v_host_earnings_delta > 0 THEN') > 0 THEN
    RAISE EXCEPTION 'send_gift_batch self-gift live-goal branch was not patched';
  END IF;

  EXECUTE v_patched;
END;
$migration$;

-- Reconcile gifts already sent in currently running lives. gifts_log.diamond_cost
-- is quantity-adjusted, and one row exists per recipient, so filtering to the
-- broadcaster produces the exact host-directed goal total without double-counting
-- gifts sent to seated guests.
UPDATE public.live_streams AS stream
SET total_gifts = COALESCE((
      SELECT SUM(COALESCE(gift.count, 1))::INTEGER
      FROM public.gifts_log AS gift
      WHERE gift.room_id = stream.id
        AND gift.receiver_id = stream.broadcaster_id
    ), 0),
    total_earnings = COALESCE((
      SELECT SUM(COALESCE(gift.diamond_cost, 0))::BIGINT
      FROM public.gifts_log AS gift
      WHERE gift.room_id = stream.id
        AND gift.receiver_id = stream.broadcaster_id
    ), 0)
WHERE stream.status = 'live';

COMMENT ON FUNCTION public.send_gift_batch(jsonb, text, bigint, uuid, text, integer, uuid) IS
  'Atomically sends one catalog gift to 1-20 recipients. Host-directed gifts, including self-gifts, advance live goal totals; self-gift wallet and ranking policy remains separate.';
