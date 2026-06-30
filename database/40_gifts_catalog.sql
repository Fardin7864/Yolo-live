-- =====================================================================
-- 40_gifts_catalog.sql
-- =====================================================================
-- Backs the in-app gift menu with a real catalog table so admins can
-- add / edit / price / disable / VIP-gate gifts without an app deploy.
--
-- Today every gift is hardcoded in app/broadcast/[id].js with diamond
-- cost passed to send_gift() by the client (i.e. trustable only because
-- the client is trustable — not for long-term safety). This migration:
--
--   1. Creates a `gifts` table with one row per gift template.
--   2. Seeds it from the existing in-app GIFT_ITEMS array so nothing
--      breaks the moment migration runs.
--   3. Allows admins full CRUD; everyone else gets read-only access to
--      active gifts.
--   4. Adds realtime publication so mobile picks up admin changes
--      instantly.
--   5. Tightens send_gift() to look up the AUTHORITATIVE cost from the
--      table (only if the row exists) and enforce VIP gating server-side.
--      Falls back to the client-passed cost for any gift not yet in the
--      table so this migration is backward-compatible with the current
--      client until it switches to DB-driven gifts.
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Drop incompatible legacy table (if any)
--
-- An older `public.gifts` table existed with `id` typed UUID, which is
-- incompatible with the text gift ids the mobile app uses ('1', '1b',
-- '2', ...). Since the catalog table holds only seed-able templates
-- (the real gifting transaction log lives in `gifts_log` — untouched),
-- dropping and recreating it loses no business data. We only drop when
-- the column type is the wrong one, so re-running this migration on a
-- correctly-typed table is a no-op.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'gifts'
       AND column_name  = 'id'
       AND data_type    = 'uuid'
  ) THEN
    DROP TABLE public.gifts CASCADE;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 1. Table — self-healing if a partial schema already exists
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gifts (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  diamond_cost       BIGINT NOT NULL CHECK (diamond_cost > 0),
  bean_value         BIGINT,                              -- earned by receiver; defaults to 50% if NULL
  category           TEXT NOT NULL CHECK (category IN ('Classic','Premium','Exclusive')),
  animation_path     TEXT,
  animation_url      TEXT,
  required_vip_type  TEXT CHECK (required_vip_type IS NULL OR required_vip_type IN ('VIP','SVIP','VVIP')),
  is_active          BOOLEAN DEFAULT true,
  display_order      INT DEFAULT 0,
  loop               BOOLEAN DEFAULT false,
  custom_duration    INT,                                 -- ms; NULL = play once
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- If a previous attempt created the table with a different shape, fill
-- in the missing columns instead of failing on the INSERT below. Each
-- ALTER is independently safe (no-op when the column is already there).
ALTER TABLE public.gifts ADD COLUMN IF NOT EXISTS name              TEXT;
ALTER TABLE public.gifts ADD COLUMN IF NOT EXISTS diamond_cost      BIGINT;
ALTER TABLE public.gifts ADD COLUMN IF NOT EXISTS bean_value        BIGINT;
ALTER TABLE public.gifts ADD COLUMN IF NOT EXISTS category          TEXT;
ALTER TABLE public.gifts ADD COLUMN IF NOT EXISTS animation_path    TEXT;
ALTER TABLE public.gifts ADD COLUMN IF NOT EXISTS animation_url     TEXT;
ALTER TABLE public.gifts ADD COLUMN IF NOT EXISTS required_vip_type TEXT;
ALTER TABLE public.gifts ADD COLUMN IF NOT EXISTS is_active         BOOLEAN DEFAULT true;
ALTER TABLE public.gifts ADD COLUMN IF NOT EXISTS display_order     INT DEFAULT 0;
ALTER TABLE public.gifts ADD COLUMN IF NOT EXISTS loop              BOOLEAN DEFAULT false;
ALTER TABLE public.gifts ADD COLUMN IF NOT EXISTS custom_duration   INT;
ALTER TABLE public.gifts ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.gifts ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_gifts_category_active ON public.gifts (category, is_active, display_order);

-- ---------------------------------------------------------------------
-- 2. Seed — matches the hardcoded GIFT_ITEMS array
-- ---------------------------------------------------------------------
INSERT INTO public.gifts (id, name, diamond_cost, category, animation_path, loop, custom_duration, display_order) VALUES
  ('1',  'Rose',        10,   'Classic',   'animation/Rose.json',                              true,  2500,  10),
  ('1b', 'Rose Flower', 20,   'Classic',   'animation/rose flower.json',                       true,  2500,  20),
  ('2',  'Clap',        50,   'Classic',   'animation/Pudgy Clap.json',                        true,  2500,  30),
  ('3',  'Lollipop',    100,  'Classic',   'animation/Lollipop candy.json',                    true,  2500,  40),
  ('4',  'Poop',        150,  'Premium',   'animation/the world is poop.json',                 true,  2500,  10),
  ('5',  'Love Blind',  200,  'Premium',   'animation/Love is blind.json',                     true,  2500,  20),
  ('6',  'Gaming',      300,  'Premium',   'animation/gaming.json',                            true,  2500,  30),
  ('7',  'Plane',       1000, 'Exclusive', 'animation/Plane.json',                             false, NULL,  10),
  ('8',  'Love Birds',  1500, 'Exclusive', 'animation/Bird pair love and flying sky.json',     false, NULL,  20),
  ('9',  'Wedding',     5000, 'Exclusive', 'animation/wedding.json',                           false, NULL,  30)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. RLS — public read for active gifts, admin full CRUD
-- ---------------------------------------------------------------------
ALTER TABLE public.gifts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gifts_read ON public.gifts;
CREATE POLICY gifts_read ON public.gifts
  FOR SELECT
  USING (is_active OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS gifts_admin_all ON public.gifts;
CREATE POLICY gifts_admin_all ON public.gifts
  FOR ALL
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------
-- 4. Realtime publication
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='gifts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.gifts;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 5. Auto-touch updated_at
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_gifts_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_gifts_updated_at ON public.gifts;
CREATE TRIGGER trg_gifts_updated_at
  BEFORE UPDATE ON public.gifts
  FOR EACH ROW EXECUTE FUNCTION public.touch_gifts_updated_at();

-- ---------------------------------------------------------------------
-- 6. Harden send_gift — server-side cost + VIP gating
--    Backward-compatible: if the gift is not in the catalog yet, falls
--    back to the client-passed cost (current behaviour).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.send_gift(
  p_sender_id     UUID,
  p_recipient_id  UUID,
  p_gift_id       TEXT,
  p_diamond_cost  BIGINT,
  p_room_id       UUID DEFAULT NULL,
  p_gift_name     TEXT DEFAULT NULL,
  p_count         INT  DEFAULT 1
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sender_balance BIGINT;
  v_bean_value     BIGINT;
  v_total_cost     BIGINT;
  v_total_beans    BIGINT;
  v_catalog        public.gifts%ROWTYPE;
  v_unit_cost      BIGINT;
  v_sender_vip     TEXT;
  v_vip_expires    TIMESTAMPTZ;
BEGIN
  IF p_sender_id IS NULL OR p_recipient_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Invalid sender or recipient');
  END IF;
  IF p_count IS NULL OR p_count <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'Count must be positive');
  END IF;

  -- Catalog lookup. Authoritative when present; advisory fallback otherwise.
  SELECT * INTO v_catalog FROM public.gifts WHERE id = p_gift_id;

  IF v_catalog.id IS NOT NULL THEN
    IF NOT v_catalog.is_active THEN
      RETURN json_build_object('success', false, 'message', 'Gift is disabled');
    END IF;

    -- VIP gating
    IF v_catalog.required_vip_type IS NOT NULL THEN
      SELECT vip_type, vip_expires_at INTO v_sender_vip, v_vip_expires
        FROM public.profiles WHERE id = p_sender_id;
      IF v_sender_vip IS NULL
         OR v_vip_expires IS NULL
         OR v_vip_expires < NOW()
         OR (
           v_catalog.required_vip_type = 'VVIP' AND v_sender_vip NOT IN ('VVIP')
         ) OR (
           v_catalog.required_vip_type = 'SVIP' AND v_sender_vip NOT IN ('SVIP','VVIP')
         ) OR (
           v_catalog.required_vip_type = 'VIP'  AND v_sender_vip NOT IN ('VIP','SVIP','VVIP')
         )
      THEN
        RETURN json_build_object('success', false, 'message',
          v_catalog.required_vip_type || ' tier required to send this gift');
      END IF;
    END IF;

    v_unit_cost  := v_catalog.diamond_cost;
    v_bean_value := COALESCE(v_catalog.bean_value, v_catalog.diamond_cost / 2);
  ELSE
    -- Not in catalog yet — fall back to the client-supplied cost. This
    -- keeps the migration safe to deploy before the app starts loading
    -- gifts from the table.
    v_unit_cost  := p_diamond_cost;
    v_bean_value := p_diamond_cost / 2;
  END IF;

  v_total_cost  := v_unit_cost  * p_count;
  v_total_beans := v_bean_value * p_count;

  SELECT diamonds INTO v_sender_balance
    FROM public.profiles WHERE id = p_sender_id FOR UPDATE;
  IF v_sender_balance IS NULL OR v_sender_balance < v_total_cost THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient diamonds');
  END IF;

  UPDATE public.profiles SET diamonds = diamonds - v_total_cost WHERE id = p_sender_id;
  UPDATE public.profiles SET beans    = beans    + v_total_beans WHERE id = p_recipient_id;

  INSERT INTO public.gifts_log
    (sender_id, receiver_id, gift_id, gift_name, diamond_cost, bean_value, count, room_id)
  VALUES
    (p_sender_id, p_recipient_id, p_gift_id,
     COALESCE(v_catalog.name, p_gift_name, p_gift_id),
     v_total_cost, v_total_beans, p_count, p_room_id);

  INSERT INTO public.transactions
    (user_id, related_user_id, type, currency, amount, related_entity_type, related_entity_id, status)
  VALUES
    (p_sender_id, p_recipient_id, 'gift_sent',     'diamond', -v_total_cost,
     'gift', NULL, 'completed'),
    (p_recipient_id, p_sender_id, 'gift_received', 'bean',     v_total_beans,
     'gift', NULL, 'completed');

  IF p_room_id IS NOT NULL THEN
    UPDATE public.live_streams
       SET total_gifts    = COALESCE(total_gifts, 0)    + p_count,
           total_earnings = COALESCE(total_earnings, 0) + v_total_beans
     WHERE id = p_room_id;
  END IF;

  RETURN json_build_object(
    'success',         true,
    'diamonds_spent',  v_total_cost,
    'beans_earned',    v_total_beans,
    'count',           p_count
  );
END $$;

GRANT EXECUTE ON FUNCTION public.send_gift(UUID, UUID, TEXT, BIGINT, UUID, TEXT, INT) TO authenticated;