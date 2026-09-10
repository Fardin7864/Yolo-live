-- admin_set_live_pin wrote to admin_audit_log(details); the real column is
-- payload, so every pin/unpin raised 42703. Re-applied with the correct column.

CREATE OR REPLACE FUNCTION public.admin_set_live_pin(
  p_stream_id UUID,
  p_position INTEGER DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me        UUID := auth.uid();
  v_stream  public.live_streams%ROWTYPE;
  v_target  INTEGER;
  v_max     INTEGER;
BEGIN
  IF NOT public.is_admin(me) THEN
    RETURN json_build_object('success', FALSE, 'message', 'forbidden');
  END IF;

  SELECT * INTO v_stream FROM public.live_streams WHERE id = p_stream_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', FALSE, 'message', 'Stream not found');
  END IF;

  -- Unpin
  IF p_position IS NULL THEN
    UPDATE public.live_streams SET pinned_position = NULL WHERE id = p_stream_id;
    -- Close the gap so the remaining pins stay 1..n with no holes.
    WITH ordered AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY pinned_position, started_at DESC) AS rn
        FROM public.live_streams
       WHERE pinned_position IS NOT NULL
    )
    UPDATE public.live_streams s
       SET pinned_position = ordered.rn
      FROM ordered
     WHERE s.id = ordered.id AND s.pinned_position IS DISTINCT FROM ordered.rn;

    INSERT INTO public.admin_audit_log(admin_id, action, target_type, target_id, payload)
    VALUES (me, 'live_unpin', 'live_stream', p_stream_id,
            jsonb_build_object('previous_position', v_stream.pinned_position));

    RETURN json_build_object('success', TRUE, 'pinned_position', NULL);
  END IF;

  -- Clamp to the end of the current list so a request for position 99 lands at
  -- the bottom rather than leaving a gap.
  SELECT COUNT(*) INTO v_max
    FROM public.live_streams
   WHERE pinned_position IS NOT NULL AND id <> p_stream_id;
  v_target := LEAST(GREATEST(p_position, 1), v_max + 1);

  -- Take the row out of the ordering first, so re-ranking below is a clean
  -- insert rather than a swap with itself.
  UPDATE public.live_streams SET pinned_position = NULL WHERE id = p_stream_id;

  WITH ordered AS (
    SELECT id,
           ROW_NUMBER() OVER (ORDER BY pinned_position, started_at DESC) AS rn
      FROM public.live_streams
     WHERE pinned_position IS NOT NULL
  )
  UPDATE public.live_streams s
     SET pinned_position = CASE
           WHEN ordered.rn >= v_target THEN ordered.rn + 1
           ELSE ordered.rn
         END
    FROM ordered
   WHERE s.id = ordered.id;

  UPDATE public.live_streams SET pinned_position = v_target WHERE id = p_stream_id;

  INSERT INTO public.admin_audit_log(admin_id, action, target_type, target_id, payload)
  VALUES (me, 'live_pin', 'live_stream', p_stream_id,
          jsonb_build_object('position', v_target, 'requested', p_position));

  RETURN json_build_object('success', TRUE, 'pinned_position', v_target);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_live_pin(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_live_pin(UUID, INTEGER) TO authenticated, service_role;
