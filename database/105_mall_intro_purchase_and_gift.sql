-- Mall intro ownership, active selection, purchase and gifting.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS owned_mall_intros TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS selected_mall_intro TEXT,
  ADD COLUMN IF NOT EXISTS selected_mall_intro_video_url TEXT,
  ADD COLUMN IF NOT EXISTS selected_mall_intro_thumbnail_url TEXT;

CREATE TABLE IF NOT EXISTS public.user_mall_intros (
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  intro_id    TEXT NOT NULL REFERENCES public.mall_intro_items(id) ON DELETE CASCADE,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  gifted_by   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, intro_id)
);

ALTER TABLE public.user_mall_intros ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own mall intros" ON public.user_mall_intros;
CREATE POLICY "users read own mall intros" ON public.user_mall_intros
  FOR SELECT USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.sync_selected_mall_intro_urls()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.profiles
    SET selected_mall_intro = NULL,
        selected_mall_intro_video_url = NULL,
        selected_mall_intro_thumbnail_url = NULL
    WHERE selected_mall_intro = OLD.id;
    RETURN OLD;
  END IF;

  IF NEW.video_url IS DISTINCT FROM OLD.video_url OR NEW.thumbnail_url IS DISTINCT FROM OLD.thumbnail_url THEN
    UPDATE public.profiles
    SET selected_mall_intro_video_url = NEW.video_url,
        selected_mall_intro_thumbnail_url = NEW.thumbnail_url
    WHERE selected_mall_intro = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mall_intros_sync_selected_urls ON public.mall_intro_items;
CREATE TRIGGER mall_intros_sync_selected_urls
  AFTER UPDATE OF video_url, thumbnail_url OR DELETE ON public.mall_intro_items
  FOR EACH ROW EXECUTE FUNCTION public.sync_selected_mall_intro_urls();

CREATE OR REPLACE FUNCTION public.purchase_mall_intro(p_intro_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_intro public.mall_intro_items%ROWTYPE;
  v_balance BIGINT;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  SELECT * INTO v_intro FROM public.mall_intro_items
  WHERE id = p_intro_id AND is_active = TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Intro is unavailable'; END IF;

  SELECT diamonds INTO v_balance FROM public.profiles WHERE id = v_user_id FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_mall_intros
    WHERE user_id = v_user_id AND intro_id = p_intro_id
  ) THEN
    IF v_balance < v_intro.diamond_cost THEN RAISE EXCEPTION 'Insufficient diamonds'; END IF;
    UPDATE public.profiles
    SET diamonds = diamonds - v_intro.diamond_cost
    WHERE id = v_user_id;
    INSERT INTO public.user_mall_intros(user_id, intro_id)
    VALUES (v_user_id, p_intro_id);
  END IF;

  UPDATE public.profiles
  SET owned_mall_intros = CASE
        WHEN p_intro_id = ANY(owned_mall_intros) THEN owned_mall_intros
        ELSE array_append(owned_mall_intros, p_intro_id)
      END,
      selected_mall_intro = p_intro_id,
      selected_mall_intro_video_url = v_intro.video_url,
      selected_mall_intro_thumbnail_url = v_intro.thumbnail_url,
      updated_at = NOW()
  WHERE id = v_user_id;

  RETURN jsonb_build_object(
    'success', TRUE,
    'intro_id', p_intro_id,
    'video_url', v_intro.video_url,
    'thumbnail_url', v_intro.thumbnail_url,
    'price', v_intro.diamond_cost,
    'selected', TRUE
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.gift_mall_intro(p_intro_id TEXT, p_recipient_display_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sender UUID := auth.uid();
  v_recipient UUID;
  v_intro public.mall_intro_items%ROWTYPE;
  v_balance BIGINT;
BEGIN
  IF v_sender IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT id INTO v_recipient FROM public.profiles WHERE display_id = p_recipient_display_id AND is_banned = FALSE;
  IF v_recipient IS NULL THEN RAISE EXCEPTION 'Recipient not found'; END IF;
  IF v_recipient = v_sender THEN RAISE EXCEPTION 'You cannot send an intro to yourself'; END IF;

  SELECT * INTO v_intro FROM public.mall_intro_items WHERE id = p_intro_id AND is_active = TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Intro is unavailable'; END IF;
  IF EXISTS (SELECT 1 FROM public.user_mall_intros WHERE user_id = v_recipient AND intro_id = p_intro_id) THEN
    RAISE EXCEPTION 'Recipient already owns this intro';
  END IF;

  SELECT diamonds INTO v_balance FROM public.profiles WHERE id = v_sender FOR UPDATE;
  IF v_balance < v_intro.diamond_cost THEN RAISE EXCEPTION 'Insufficient diamonds'; END IF;
  UPDATE public.profiles SET diamonds = diamonds - v_intro.diamond_cost WHERE id = v_sender;
  INSERT INTO public.user_mall_intros(user_id, intro_id, gifted_by)
  VALUES (v_recipient, p_intro_id, v_sender);
  UPDATE public.profiles
  SET owned_mall_intros = CASE
        WHEN p_intro_id = ANY(owned_mall_intros) THEN owned_mall_intros
        ELSE array_append(owned_mall_intros, p_intro_id)
      END,
      selected_mall_intro = p_intro_id,
      selected_mall_intro_video_url = v_intro.video_url,
      selected_mall_intro_thumbnail_url = v_intro.thumbnail_url,
      updated_at = NOW()
  WHERE id = v_recipient;

  RETURN jsonb_build_object('success', TRUE, 'recipient_id', v_recipient, 'price', v_intro.diamond_cost);
END;
$$;

REVOKE ALL ON FUNCTION public.purchase_mall_intro(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gift_mall_intro(TEXT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purchase_mall_intro(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gift_mall_intro(TEXT, BIGINT) TO authenticated;
