-- VIP-only subscription packages with bundled frame + intro rewards.

CREATE TABLE IF NOT EXISTS public.vip_subscriptions (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  price               BIGINT NOT NULL DEFAULT 0 CHECK (price >= 0),
  duration_days       INTEGER NOT NULL DEFAULT 30 CHECK (duration_days > 0),
  features            JSONB NOT NULL DEFAULT '[]'::jsonb,
  intro_name          TEXT NOT NULL DEFAULT '',
  intro_thumbnail_url TEXT NOT NULL,
  intro_video_url     TEXT NOT NULL,
  frame_name          TEXT NOT NULL DEFAULT '',
  frame_url           TEXT NOT NULL,
  accent_color        TEXT NOT NULL DEFAULT '#FBBF24',
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  display_order       INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS owned_profile_frames TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS selected_profile_frame TEXT,
  ADD COLUMN IF NOT EXISTS selected_profile_frame_url TEXT,
  ADD COLUMN IF NOT EXISTS owned_mall_intros TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS selected_mall_intro TEXT,
  ADD COLUMN IF NOT EXISTS selected_mall_intro_video_url TEXT,
  ADD COLUMN IF NOT EXISTS selected_mall_intro_thumbnail_url TEXT;

ALTER TABLE public.vip_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vip subscriptions public read" ON public.vip_subscriptions;
CREATE POLICY "vip subscriptions public read" ON public.vip_subscriptions
  FOR SELECT USING (is_active OR public.is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "vip subscriptions super admin insert" ON public.vip_subscriptions;
CREATE POLICY "vip subscriptions super admin insert" ON public.vip_subscriptions
  FOR INSERT WITH CHECK (public.is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "vip subscriptions super admin update" ON public.vip_subscriptions;
CREATE POLICY "vip subscriptions super admin update" ON public.vip_subscriptions
  FOR UPDATE USING (public.is_super_admin(auth.uid())) WITH CHECK (public.is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "vip subscriptions super admin delete" ON public.vip_subscriptions;
CREATE POLICY "vip subscriptions super admin delete" ON public.vip_subscriptions
  FOR DELETE USING (public.is_super_admin(auth.uid()));

INSERT INTO public.vip_subscriptions (
  id,
  name,
  price,
  duration_days,
  features,
  intro_name,
  intro_thumbnail_url,
  intro_video_url,
  frame_name,
  frame_url,
  accent_color,
  is_active,
  display_order,
  updated_at
)
VALUES
  (
    'vip-royal-entry',
    'Royal Entry VIP',
    50000,
    30,
    '["VIP badge", "Color name", "Entrance effect", "VIP-only frame"]'::jsonb,
    'Football Champions Cup',
    'bundled://football-cup.webp',
    'bundled://football-cup.m4v',
    'Royal Gold',
    'bundled://royal-gold',
    '#FBBF24',
    TRUE,
    1,
    NOW()
  ),
  (
    'vip-blue-rose',
    'Blue Rose VIP',
    42000,
    30,
    '["VIP badge", "Priority room entrance", "Blue Rose intro", "VIP-only profile frame"]'::jsonb,
    'Blue Rose Bouquet',
    'bundled://blue-roses.webp',
    'bundled://blue-roses.m4v',
    'Heart Fantasy',
    'bundled://heart-fantasy',
    '#38BDF8',
    TRUE,
    2,
    NOW()
  )
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.purchase_vip_subscription(p_subscription_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id       UUID := auth.uid();
  v_package       public.vip_subscriptions%ROWTYPE;
  v_balance       BIGINT;
  v_current_type  TEXT;
  v_current_until TIMESTAMPTZ;
  v_current_rank  INTEGER := 0;
  v_expires_at    TIMESTAMPTZ;
  v_frame_id      TEXT;
  v_intro_id      TEXT;
  v_next_type     TEXT := 'VIP';
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_package
  FROM public.vip_subscriptions
  WHERE id = p_subscription_id AND is_active = TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VIP package is unavailable';
  END IF;

  SELECT diamonds, vip_type, vip_expires_at
    INTO v_balance, v_current_type, v_current_until
    FROM public.profiles
    WHERE id = v_user_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  IF v_balance < v_package.price THEN
    RAISE EXCEPTION 'Insufficient diamonds';
  END IF;

  IF v_current_type IS NOT NULL THEN
    SELECT rank INTO v_current_rank FROM public.vip_tiers WHERE id = v_current_type;
    v_current_rank := COALESCE(v_current_rank, 0);
  END IF;

  IF v_current_until IS NOT NULL
     AND v_current_until > NOW()
     AND v_current_rank > 1
  THEN
    v_next_type := v_current_type;
    v_expires_at := v_current_until + (v_package.duration_days || ' days')::interval;
  ELSIF v_current_until IS NOT NULL
        AND v_current_until > NOW()
        AND v_current_type = 'VIP'
  THEN
    v_expires_at := v_current_until + (v_package.duration_days || ' days')::interval;
  ELSE
    v_expires_at := NOW() + (v_package.duration_days || ' days')::interval;
  END IF;

  v_frame_id := 'vip:' || v_package.id || ':frame';
  v_intro_id := 'vip:' || v_package.id || ':intro';

  UPDATE public.profiles
  SET diamonds = diamonds - v_package.price,
      vip_type = v_next_type,
      vip_expires_at = v_expires_at,
      owned_profile_frames = CASE
        WHEN v_frame_id = ANY(owned_profile_frames) THEN owned_profile_frames
        ELSE array_append(owned_profile_frames, v_frame_id)
      END,
      selected_profile_frame = v_frame_id,
      selected_profile_frame_url = v_package.frame_url,
      owned_mall_intros = CASE
        WHEN v_intro_id = ANY(owned_mall_intros) THEN owned_mall_intros
        ELSE array_append(owned_mall_intros, v_intro_id)
      END,
      selected_mall_intro = v_intro_id,
      selected_mall_intro_video_url = v_package.intro_video_url,
      selected_mall_intro_thumbnail_url = v_package.intro_thumbnail_url,
      updated_at = NOW()
  WHERE id = v_user_id;

  INSERT INTO public.transactions
    (user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
  VALUES
    (v_user_id, 'vip_purchase', 'diamond', -v_package.price, 'vip_subscription', NULL, 'completed',
     'VIP subscription: ' || v_package.name || ' (' || v_package.id || ') x ' || v_package.duration_days || 'd');

  RETURN jsonb_build_object(
    'success', TRUE,
    'subscription_id', v_package.id,
    'name', v_package.name,
    'expires_at', v_expires_at,
    'frame_id', v_frame_id,
    'intro_id', v_intro_id,
    'diamonds_spent', v_package.price
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purchase_vip_subscription(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purchase_vip_subscription(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.use_vip_subscription(p_subscription_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_package  public.vip_subscriptions%ROWTYPE;
  v_frame_id TEXT;
  v_intro_id TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_package
  FROM public.vip_subscriptions
  WHERE id = p_subscription_id AND is_active = TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VIP package is unavailable';
  END IF;

  v_frame_id := 'vip:' || v_package.id || ':frame';
  v_intro_id := 'vip:' || v_package.id || ':intro';

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = v_user_id
      AND (v_frame_id = ANY(owned_profile_frames) OR v_intro_id = ANY(owned_mall_intros))
  ) THEN
    RAISE EXCEPTION 'Purchase this VIP package first';
  END IF;

  UPDATE public.profiles
  SET selected_profile_frame = v_frame_id,
      selected_profile_frame_url = v_package.frame_url,
      selected_mall_intro = v_intro_id,
      selected_mall_intro_video_url = v_package.intro_video_url,
      selected_mall_intro_thumbnail_url = v_package.intro_thumbnail_url,
      updated_at = NOW()
  WHERE id = v_user_id;

  RETURN jsonb_build_object(
    'success', TRUE,
    'subscription_id', v_package.id,
    'frame_id', v_frame_id,
    'intro_id', v_intro_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.use_vip_subscription(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.use_vip_subscription(TEXT) TO authenticated;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.vip_subscriptions;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
