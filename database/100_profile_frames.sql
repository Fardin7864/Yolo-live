-- Persistent Mall profile-frame ownership and active selection.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS owned_profile_frames TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS selected_profile_frame TEXT;

CREATE OR REPLACE FUNCTION public.purchase_profile_frame(p_frame_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_allowed CONSTANT TEXT[] := ARRAY['heart-fantasy', 'angel-wing', 'royal-gold'];
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT (p_frame_id = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'Unknown profile frame';
  END IF;

  -- These launch frames are free. Keep this RPC as the single purchase
  -- boundary so diamond pricing can be introduced atomically later.
  UPDATE public.profiles
  SET owned_profile_frames = CASE
        WHEN p_frame_id = ANY(owned_profile_frames) THEN owned_profile_frames
        ELSE array_append(owned_profile_frames, p_frame_id)
      END,
      selected_profile_frame = p_frame_id,
      updated_at = NOW()
  WHERE id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  RETURN jsonb_build_object(
    'success', TRUE,
    'frame_id', p_frame_id,
    'price', 0,
    'selected', TRUE
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purchase_profile_frame(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purchase_profile_frame(TEXT) TO authenticated;
