-- A host's self-gift may be excluded from earnings, but it is still a gift sent
-- in this live and must increment live_streams.total_gifts.
DO $migration$
DECLARE
  v_signature REGPROCEDURE := 'public.send_gift_batch(jsonb,text,bigint,uuid,text,integer,uuid)'::REGPROCEDURE;
  v_definition TEXT;
  v_patched TEXT;
BEGIN
  SELECT pg_get_functiondef(v_signature) INTO v_definition;
  v_patched := replace(
    v_definition,
    'IF v_host_earnings_delta > 0 THEN',
    'IF v_room_host_id = ANY(v_recipients) THEN'
  );

  IF v_patched = v_definition THEN
    IF strpos(v_definition, 'IF v_room_host_id = ANY(v_recipients) THEN') > 0 THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'send_gift_batch live total branch was not found';
  END IF;

  EXECUTE v_patched;
END;
$migration$;

COMMENT ON FUNCTION public.send_gift_batch(jsonb, text, bigint, uuid, text, integer, uuid) IS
  'Atomically sends one catalog gift to 1-20 recipients. Live gift count includes self-gifts; live earnings follow self-gift earning policy.';
