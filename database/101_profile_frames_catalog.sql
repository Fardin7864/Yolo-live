-- Admin-managed animated profile-frame catalog, ownership, purchase and gifting.

CREATE TABLE IF NOT EXISTS public.profile_frames (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  frame_url     TEXT NOT NULL,
  diamond_cost  BIGINT NOT NULL DEFAULT 0 CHECK (diamond_cost >= 0),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS owned_profile_frames TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS selected_profile_frame TEXT,
  ADD COLUMN IF NOT EXISTS selected_profile_frame_url TEXT;

CREATE TABLE IF NOT EXISTS public.user_profile_frames (
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  frame_id    TEXT NOT NULL REFERENCES public.profile_frames(id) ON DELETE CASCADE,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  gifted_by   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, frame_id)
);

CREATE OR REPLACE FUNCTION public.sync_selected_profile_frame_url()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.profiles
    SET selected_profile_frame = NULL, selected_profile_frame_url = NULL
    WHERE selected_profile_frame = OLD.id;
    RETURN OLD;
  END IF;

  IF NEW.frame_url IS DISTINCT FROM OLD.frame_url THEN
    UPDATE public.profiles
    SET selected_profile_frame_url = NEW.frame_url
    WHERE selected_profile_frame = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profile_frames_sync_selected_url ON public.profile_frames;
CREATE TRIGGER profile_frames_sync_selected_url
  AFTER UPDATE OF frame_url OR DELETE ON public.profile_frames
  FOR EACH ROW EXECUTE FUNCTION public.sync_selected_profile_frame_url();

ALTER TABLE public.profile_frames ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profile_frames ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profile frames public read" ON public.profile_frames;
CREATE POLICY "profile frames public read" ON public.profile_frames
  FOR SELECT USING (is_active OR public.is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "profile frames super admin insert" ON public.profile_frames;
CREATE POLICY "profile frames super admin insert" ON public.profile_frames
  FOR INSERT WITH CHECK (public.is_super_admin(auth.uid()));
DROP POLICY IF EXISTS "profile frames super admin update" ON public.profile_frames;
CREATE POLICY "profile frames super admin update" ON public.profile_frames
  FOR UPDATE USING (public.is_super_admin(auth.uid())) WITH CHECK (public.is_super_admin(auth.uid()));
DROP POLICY IF EXISTS "profile frames super admin delete" ON public.profile_frames;
CREATE POLICY "profile frames super admin delete" ON public.profile_frames
  FOR DELETE USING (public.is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "users read own profile frames" ON public.user_profile_frames;
CREATE POLICY "users read own profile frames" ON public.user_profile_frames
  FOR SELECT USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.purchase_profile_frame(p_frame_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_frame public.profile_frames%ROWTYPE;
  v_balance BIGINT;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  SELECT * INTO v_frame FROM public.profile_frames
  WHERE id = p_frame_id AND is_active = TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile frame is unavailable'; END IF;

  SELECT diamonds INTO v_balance FROM public.profiles WHERE id = v_user_id FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_profile_frames
    WHERE user_id = v_user_id AND frame_id = p_frame_id
  ) THEN
    IF v_balance < v_frame.diamond_cost THEN RAISE EXCEPTION 'Insufficient diamonds'; END IF;
    UPDATE public.profiles
    SET diamonds = diamonds - v_frame.diamond_cost
    WHERE id = v_user_id;
    INSERT INTO public.user_profile_frames(user_id, frame_id)
    VALUES (v_user_id, p_frame_id);
  END IF;

  UPDATE public.profiles
  SET owned_profile_frames = CASE
        WHEN p_frame_id = ANY(owned_profile_frames) THEN owned_profile_frames
        ELSE array_append(owned_profile_frames, p_frame_id)
      END,
      selected_profile_frame = p_frame_id,
      selected_profile_frame_url = v_frame.frame_url,
      updated_at = NOW()
  WHERE id = v_user_id;

  RETURN jsonb_build_object(
    'success', TRUE, 'frame_id', p_frame_id, 'frame_url', v_frame.frame_url,
    'price', v_frame.diamond_cost, 'selected', TRUE
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.gift_profile_frame(p_frame_id TEXT, p_recipient_display_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sender UUID := auth.uid();
  v_recipient UUID;
  v_frame public.profile_frames%ROWTYPE;
  v_balance BIGINT;
BEGIN
  IF v_sender IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT id INTO v_recipient FROM public.profiles WHERE display_id = p_recipient_display_id AND is_banned = FALSE;
  IF v_recipient IS NULL THEN RAISE EXCEPTION 'Recipient not found'; END IF;
  IF v_recipient = v_sender THEN RAISE EXCEPTION 'You cannot send a frame to yourself'; END IF;

  SELECT * INTO v_frame FROM public.profile_frames WHERE id = p_frame_id AND is_active = TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile frame is unavailable'; END IF;
  IF EXISTS (SELECT 1 FROM public.user_profile_frames WHERE user_id = v_recipient AND frame_id = p_frame_id) THEN
    RAISE EXCEPTION 'Recipient already owns this frame';
  END IF;

  SELECT diamonds INTO v_balance FROM public.profiles WHERE id = v_sender FOR UPDATE;
  IF v_balance < v_frame.diamond_cost THEN RAISE EXCEPTION 'Insufficient diamonds'; END IF;
  UPDATE public.profiles SET diamonds = diamonds - v_frame.diamond_cost WHERE id = v_sender;
  INSERT INTO public.user_profile_frames(user_id, frame_id, gifted_by)
  VALUES (v_recipient, p_frame_id, v_sender);
  UPDATE public.profiles
  SET owned_profile_frames = CASE
        WHEN p_frame_id = ANY(owned_profile_frames) THEN owned_profile_frames
        ELSE array_append(owned_profile_frames, p_frame_id)
      END
  WHERE id = v_recipient;

  RETURN jsonb_build_object('success', TRUE, 'recipient_id', v_recipient, 'price', v_frame.diamond_cost);
END;
$$;

REVOKE ALL ON FUNCTION public.purchase_profile_frame(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gift_profile_frame(TEXT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purchase_profile_frame(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gift_profile_frame(TEXT, BIGINT) TO authenticated;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('profile-frames', 'profile-frames', TRUE, 5242880, ARRAY['image/webp'])
ON CONFLICT (id) DO UPDATE SET
  public = TRUE,
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/webp'];

DROP POLICY IF EXISTS "profile frames public storage read" ON storage.objects;
CREATE POLICY "profile frames public storage read" ON storage.objects
  FOR SELECT USING (bucket_id = 'profile-frames');
DROP POLICY IF EXISTS "profile frames admin storage insert" ON storage.objects;
CREATE POLICY "profile frames admin storage insert" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'profile-frames' AND public.is_super_admin(auth.uid()));
DROP POLICY IF EXISTS "profile frames admin storage update" ON storage.objects;
CREATE POLICY "profile frames admin storage update" ON storage.objects
  FOR UPDATE USING (bucket_id = 'profile-frames' AND public.is_super_admin(auth.uid()));
DROP POLICY IF EXISTS "profile frames admin storage delete" ON storage.objects;
CREATE POLICY "profile frames admin storage delete" ON storage.objects
  FOR DELETE USING (bucket_id = 'profile-frames' AND public.is_super_admin(auth.uid()));

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.profile_frames;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
