-- =====================================================================
-- 45_vip_tiers_table.sql
-- =====================================================================
-- Pulls VIP pricing out of the purchase_vip RPC's inline CASE block and
-- into a `vip_tiers` table that admins can edit from the panel. Same
-- prices are seeded so behaviour is identical until the admin tweaks
-- something.
--
-- The price grid is 3 tiers × 3 durations (7/15/30 days). We model it
-- as one row per tier with a JSONB `pricing` object keyed by days, so
-- adding new durations (e.g. 90) is a single UPDATE rather than a
-- schema change.
--
-- Idempotent: re-runnable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vip_tiers (
  id             TEXT PRIMARY KEY,                  -- 'VIP' | 'SVIP' | 'VVIP'
  name           TEXT NOT NULL,
  rank           INT  NOT NULL,                     -- 1, 2, 3 (used for upgrade comparison)
  badge_color    TEXT,                              -- hex used in UI
  pricing        JSONB NOT NULL,                    -- { "7": 15000, "15": 28000, "30": 50000 }
  perks          JSONB DEFAULT '[]'::jsonb,         -- ['Custom badge', 'Pinned chat color', ...]
  is_active      BOOLEAN DEFAULT TRUE,
  display_order  INT DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the three tiers with the existing prices from migration 27.
INSERT INTO public.vip_tiers (id, name, rank, badge_color, pricing, perks, display_order) VALUES
  ('VIP',  'VIP',  1, '#FBBF24',
   '{"7": 15000, "15": 28000, "30": 50000}'::jsonb,
   '["Entry banner", "Color name"]'::jsonb,
   10),
  ('SVIP', 'SVIP', 2, '#A78BFA',
   '{"7": 25000, "15": 50000, "30": 90000}'::jsonb,
   '["Entry banner", "Color name", "Gift menu access"]'::jsonb,
   20),
  ('VVIP', 'VVIP', 3, '#F43F5E',
   '{"7": 40000, "15": 80000, "30": 150000}'::jsonb,
   '["Entry banner", "Custom theme", "Gift menu", "Exclusive emojis"]'::jsonb,
   30)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. RLS
-- ---------------------------------------------------------------------
ALTER TABLE public.vip_tiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vip_tiers_read ON public.vip_tiers;
CREATE POLICY vip_tiers_read ON public.vip_tiers FOR SELECT
  USING (is_active OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS vip_tiers_admin_all ON public.vip_tiers;
CREATE POLICY vip_tiers_admin_all ON public.vip_tiers FOR ALL
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------
-- 3. Realtime
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='vip_tiers') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.vip_tiers;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4. purchase_vip — reads pricing + rank from the table
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purchase_vip(
    tier text,
    days int
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me           uuid := auth.uid();
  v_tier       public.vip_tiers%ROWTYPE;
  cost         bigint;
  cur_balance  bigint;
  cur_expires  timestamptz;
  new_expires  timestamptz;
  cur_tier     text;
  cur_rank     int := 0;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_tier FROM public.vip_tiers WHERE id = tier AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or disabled tier: %', tier;
  END IF;

  cost := (v_tier.pricing ->> days::text)::bigint;
  IF cost IS NULL OR cost <= 0 THEN
    RAISE EXCEPTION 'No price configured for tier=% days=%', tier, days;
  END IF;

  SELECT diamonds, vip_type, vip_expires_at
    INTO cur_balance, cur_tier, cur_expires
    FROM public.profiles
    WHERE id = me
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  IF cur_balance < cost THEN
    RAISE EXCEPTION 'Insufficient diamonds: have %, need %', cur_balance, cost;
  END IF;

  IF cur_tier IS NOT NULL THEN
    SELECT rank INTO cur_rank FROM public.vip_tiers WHERE id = cur_tier;
    cur_rank := COALESCE(cur_rank, 0);
  END IF;

  -- Stack remaining time if user already has same-or-lower tier and not
  -- expired; otherwise reset from now. Upgrade always resets duration.
  IF cur_expires IS NOT NULL
     AND cur_expires > NOW()
     AND cur_rank <= v_tier.rank
     AND cur_tier = tier
  THEN
    new_expires := cur_expires + (days || ' days')::interval;
  ELSE
    new_expires := NOW() + (days || ' days')::interval;
  END IF;

  UPDATE public.profiles
     SET diamonds       = diamonds - cost,
         vip_type       = tier,
         vip_expires_at = new_expires
   WHERE id = me;

  INSERT INTO public.transactions
    (user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
  VALUES
    (me, 'vip_purchase', 'diamond', -cost, 'vip', NULL, 'completed',
     'VIP ' || tier || ' x ' || days || 'd');

  RETURN json_build_object(
    'success',      true,
    'tier',         tier,
    'expires_at',   new_expires,
    'diamonds_spent', cost
  );
END $$;

GRANT EXECUTE ON FUNCTION public.purchase_vip(text, int) TO authenticated;