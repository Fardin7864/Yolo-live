-- =====================================================================
-- 88_audio_room_templates.sql
-- =====================================================================
-- Audio Room Backgrounds — let an audio-live host pick a static
-- background image template for their room. Every participant in the
-- room sees it (mirrors Bigo / StreamKar).
--
-- Architecture
--   audio_templates           — admin-managed catalogue (id, name,
--                               background_url, preview_url,
--                               diamond_cost, is_active, display_order)
--   user_audio_templates      — per-user ownership ledger. One row per
--                               (user, paid template) the user has
--                               bought. Free templates do NOT create an
--                               ownership row — every host implicitly
--                               owns them (see user_owns_audio_template).
--   live_streams.active_template_id
--                             — nullable FK; the room's currently-applied
--                               background. Realtime UPDATE event on
--                               live_streams already published, so
--                               viewers pick up changes instantly.
--   purchase_audio_template() — SECURITY DEFINER RPC; atomically deducts
--                               diamonds, inserts ownership, writes a
--                               'audio_template_purchase' transactions
--                               row.
--   apply_audio_template()    — SECURITY DEFINER RPC; sets the room's
--                               active_template_id. Validates ownership
--                               for paid templates (or super_admin
--                               override). NULL clears the background.
--   user_owns_audio_template()— Helper. TRUE for free templates OR if
--                               an ownership row exists.
--
-- Idempotent: re-runnable. CREATE TABLE IF NOT EXISTS / ADD COLUMN IF
-- NOT EXISTS / CREATE OR REPLACE FUNCTION / DROP POLICY IF EXISTS then
-- CREATE POLICY / ON CONFLICT DO NOTHING throughout.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. audio_templates — admin-managed catalog
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audio_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  background_url  TEXT NOT NULL,                      -- public Storage URL (full-room background)
  preview_url     TEXT,                               -- optional thumbnail; falls back to background_url
  diamond_cost    BIGINT NOT NULL DEFAULT 0 CHECK (diamond_cost >= 0),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  display_order   INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Self-heal partial schemas from prior attempts.
ALTER TABLE public.audio_templates ADD COLUMN IF NOT EXISTS name           TEXT;
ALTER TABLE public.audio_templates ADD COLUMN IF NOT EXISTS background_url TEXT;
ALTER TABLE public.audio_templates ADD COLUMN IF NOT EXISTS preview_url    TEXT;
ALTER TABLE public.audio_templates ADD COLUMN IF NOT EXISTS diamond_cost   BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.audio_templates ADD COLUMN IF NOT EXISTS is_active      BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.audio_templates ADD COLUMN IF NOT EXISTS display_order  INT NOT NULL DEFAULT 0;
ALTER TABLE public.audio_templates ADD COLUMN IF NOT EXISTS created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.audio_templates ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_audio_templates_active_order
  ON public.audio_templates (is_active, display_order, created_at);

-- ---------------------------------------------------------------------
-- 2. user_audio_templates — ownership ledger
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_audio_templates (
  user_id            UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  template_id        UUID NOT NULL REFERENCES public.audio_templates(id) ON DELETE CASCADE,
  diamond_cost_paid  BIGINT NOT NULL DEFAULT 0,
  purchased_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, template_id)
);

CREATE INDEX IF NOT EXISTS idx_user_audio_templates_user
  ON public.user_audio_templates (user_id);

-- ---------------------------------------------------------------------
-- 3. live_streams.active_template_id — the room's currently-applied bg
-- ---------------------------------------------------------------------
ALTER TABLE public.live_streams
  ADD COLUMN IF NOT EXISTS active_template_id UUID
    REFERENCES public.audio_templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_live_streams_active_template
  ON public.live_streams (active_template_id);

-- ---------------------------------------------------------------------
-- 4. updated_at trigger for audio_templates
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gen_audio_template_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS audio_templates_set_updated_at ON public.audio_templates;
CREATE TRIGGER audio_templates_set_updated_at
  BEFORE UPDATE ON public.audio_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.gen_audio_template_set_updated_at();

-- ---------------------------------------------------------------------
-- 5. Helper — user_owns_audio_template
--
-- Returns TRUE when:
--   * the template is free (diamond_cost = 0), OR
--   * an ownership row exists in user_audio_templates.
--
-- The apply RPC calls this to decide whether to refuse a paid template
-- the caller doesn't own. A separate helper (not inlined) so the same
-- "is this owned?" check stays in one place if business rules change
-- later (e.g. timed rentals, gift unlocks).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.user_owns_audio_template(
  p_user      UUID,
  p_template  UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM public.audio_templates
       WHERE id = p_template AND diamond_cost = 0
    )
    OR EXISTS (
      SELECT 1 FROM public.user_audio_templates
       WHERE user_id = p_user AND template_id = p_template
    );
$$;

-- ---------------------------------------------------------------------
-- 6. RPC — purchase_audio_template
--
-- SECURITY DEFINER. Runs as the function owner so the UPDATE on
-- profiles.diamonds sails through protect_profile_columns (migration 80
-- bypasses on `current_user NOT IN ('authenticated','anon')`).
--
-- Validation:
--   * authenticated (auth.uid() not null)
--   * template exists + is_active
--   * not already owned
--   * paid template (free templates don't create an ownership row —
--     they're implicitly owned by everyone via user_owns_audio_template)
--   * sufficient diamonds
--
-- Side effects (all in one transaction):
--   * UPDATE profiles SET diamonds = diamonds - cost
--   * INSERT INTO user_audio_templates
--   * INSERT INTO transactions (type='audio_template_purchase')
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purchase_audio_template(
  p_template_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user        UUID := auth.uid();
  v_template    public.audio_templates%ROWTYPE;
  v_balance     BIGINT;
  v_new_balance BIGINT;
BEGIN
  IF v_user IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  SELECT * INTO v_template FROM public.audio_templates WHERE id = p_template_id;
  IF v_template.id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Template not found');
  END IF;
  IF NOT v_template.is_active THEN
    RETURN json_build_object('success', false, 'message', 'Template is disabled');
  END IF;

  -- Free templates are implicitly owned by everyone — refuse to create
  -- a redundant ownership row that would never be read.
  IF v_template.diamond_cost = 0 THEN
    RETURN json_build_object('success', false, 'message', 'Template is free — no purchase needed');
  END IF;

  -- Already-owned guard. Idempotent for the caller (so a double-tap on
  -- the Buy button doesn't double-charge).
  IF EXISTS (
    SELECT 1 FROM public.user_audio_templates
     WHERE user_id = v_user AND template_id = p_template_id
  ) THEN
    RETURN json_build_object('success', false, 'message', 'Already owned');
  END IF;

  -- Lock the profile row for the duration of the deduction so two
  -- concurrent purchases can't both pass the balance check.
  SELECT diamonds INTO v_balance
    FROM public.profiles
   WHERE id = v_user
   FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Profile not found');
  END IF;
  IF v_balance < v_template.diamond_cost THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient diamonds');
  END IF;

  v_new_balance := v_balance - v_template.diamond_cost;

  UPDATE public.profiles
     SET diamonds = v_new_balance
   WHERE id = v_user;

  INSERT INTO public.user_audio_templates
    (user_id, template_id, diamond_cost_paid)
  VALUES
    (v_user, p_template_id, v_template.diamond_cost)
  ON CONFLICT (user_id, template_id) DO NOTHING;

  INSERT INTO public.transactions
    (user_id, type, currency, amount, balance_after,
     related_entity_type, related_entity_id, status)
  VALUES
    (v_user, 'audio_template_purchase', 'diamond',
     -v_template.diamond_cost, v_new_balance,
     'audio_template', p_template_id, 'completed');

  RETURN json_build_object(
    'success',      true,
    'new_balance',  v_new_balance,
    'template_id',  p_template_id,
    'cost',         v_template.diamond_cost
  );
END $$;

GRANT EXECUTE ON FUNCTION public.purchase_audio_template(UUID) TO authenticated;

-- ---------------------------------------------------------------------
-- 7. RPC — apply_audio_template
--
-- SECURITY DEFINER. The caller must be the broadcaster of the named
-- live_stream. NULL p_template_id clears the background.
--
-- Validation:
--   * authenticated
--   * stream exists and caller is broadcaster
--   * stream is 'live' (cleared / ended streams shouldn't be retargeted)
--   * template (when not NULL) is is_active
--   * paid template requires ownership OR super_admin
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_audio_template(
  p_stream_id    UUID,
  p_template_id  UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user      UUID := auth.uid();
  v_stream    public.live_streams%ROWTYPE;
  v_template  public.audio_templates%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  IF p_stream_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Missing stream id');
  END IF;

  SELECT * INTO v_stream FROM public.live_streams WHERE id = p_stream_id;
  IF v_stream.id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Stream not found');
  END IF;
  IF v_stream.broadcaster_id <> v_user THEN
    RETURN json_build_object('success', false, 'message', 'Only the broadcaster can change the background');
  END IF;
  IF v_stream.status <> 'live' THEN
    RETURN json_build_object('success', false, 'message', 'Stream is not live');
  END IF;

  IF p_template_id IS NOT NULL THEN
    SELECT * INTO v_template FROM public.audio_templates WHERE id = p_template_id;
    IF v_template.id IS NULL THEN
      RETURN json_build_object('success', false, 'message', 'Template not found');
    END IF;
    IF NOT v_template.is_active THEN
      RETURN json_build_object('success', false, 'message', 'Template is disabled');
    END IF;

    -- Paid template? Caller must own it (or be super_admin, which
    -- short-circuits ownership for QA / promo-test paths).
    IF v_template.diamond_cost > 0
       AND NOT public.user_owns_audio_template(v_user, p_template_id)
       AND NOT public.is_super_admin(v_user) THEN
      RETURN json_build_object('success', false, 'message', 'Purchase required before applying this template');
    END IF;
  END IF;

  UPDATE public.live_streams
     SET active_template_id = p_template_id
   WHERE id = p_stream_id;

  RETURN json_build_object(
    'success',             true,
    'active_template_id',  p_template_id
  );
END $$;

GRANT EXECUTE ON FUNCTION public.apply_audio_template(UUID, UUID) TO authenticated;

-- ---------------------------------------------------------------------
-- 8. RLS
--
-- audio_templates: public SELECT (every host needs to browse the
-- catalog). Writes only via super_admin.
--
-- user_audio_templates: users read their own rows; super_admin reads
-- all. Direct INSERTs are blocked — the purchase RPC bypasses RLS via
-- SECURITY DEFINER, which is the only sanctioned write path.
-- ---------------------------------------------------------------------
ALTER TABLE public.audio_templates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_audio_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audio_templates_read       ON public.audio_templates;
DROP POLICY IF EXISTS audio_templates_admin_all  ON public.audio_templates;

CREATE POLICY audio_templates_read ON public.audio_templates
  FOR SELECT
  USING (TRUE);

CREATE POLICY audio_templates_admin_all ON public.audio_templates
  FOR ALL
  USING      (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));

DROP POLICY IF EXISTS user_audio_templates_read  ON public.user_audio_templates;
DROP POLICY IF EXISTS user_audio_templates_write ON public.user_audio_templates;

CREATE POLICY user_audio_templates_read ON public.user_audio_templates
  FOR SELECT
  USING (
    user_id = auth.uid()
    OR public.is_super_admin(auth.uid())
  );

-- Block every direct write path — the RPC is the only sanctioned door.
-- SECURITY DEFINER on purchase_audio_template means it runs as the
-- function owner and is exempt from RLS.
CREATE POLICY user_audio_templates_write ON public.user_audio_templates
  FOR ALL
  USING (FALSE)
  WITH CHECK (FALSE);

-- ---------------------------------------------------------------------
-- 9. Realtime publication
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='audio_templates'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.audio_templates;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='user_audio_templates'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_audio_templates;
  END IF;
END $$;

-- =====================================================================
-- DONE.
-- After running this:
--   * audio_templates + user_audio_templates + helper exist.
--   * live_streams.active_template_id is nullable, FK to audio_templates.
--   * purchase_audio_template + apply_audio_template RPCs grant-able to
--     `authenticated`; both are SECURITY DEFINER and sail through the
--     migration-80 profile column protector.
--   * Realtime publication updated so mobile picks up catalog changes
--     and ownership additions instantly.
-- =====================================================================
