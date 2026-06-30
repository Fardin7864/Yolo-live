-- =====================================================================
-- 26_bag_inventory.sql — Real backpack / inventory backend
-- =====================================================================
-- Replaces the mock dummy list in `app/main/bag.js` with two tables:
--   • bag_item_catalog : every item that can exist (admin-seeded)
--   • user_bag_items   : per-user inventory rows
--
-- Plus RPCs:
--   • get_my_bag()             — current user's inventory rows joined with the catalog
--   • use_bag_item(item, qty)  — decrement / spend; placeholder for effect application
--   • grant_bag_item(target,…) — server/admin-side grant (callable by service role only)
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.bag_item_catalog (
    id            text PRIMARY KEY,                 -- e.g. 'small_gift_box'
    name          text NOT NULL,
    item_type     text NOT NULL,                    -- consumable | effect | voucher | utility | frame
    icon_url      text,
    description   text,
    is_stackable  boolean NOT NULL DEFAULT true,
    rarity        text DEFAULT 'common',            -- common | rare | epic | legendary
    sort_order    int  NOT NULL DEFAULT 0,
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_bag_items (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    item_id      text NOT NULL REFERENCES public.bag_item_catalog(id) ON DELETE CASCADE,
    quantity     int  NOT NULL DEFAULT 1 CHECK (quantity >= 0),
    expires_at   timestamptz,
    acquired_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, item_id)
);

CREATE INDEX IF NOT EXISTS user_bag_items_user_idx ON public.user_bag_items (user_id);

ALTER TABLE public.bag_item_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_bag_items   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS catalog_read   ON public.bag_item_catalog;
CREATE POLICY catalog_read   ON public.bag_item_catalog FOR SELECT USING (true);

DROP POLICY IF EXISTS catalog_admin  ON public.bag_item_catalog;
CREATE POLICY catalog_admin  ON public.bag_item_catalog
    FOR ALL USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS bag_user_read  ON public.user_bag_items;
CREATE POLICY bag_user_read  ON public.user_bag_items FOR SELECT USING (user_id = auth.uid());

-- Direct writes locked — all mutation goes through RPCs.
DROP POLICY IF EXISTS bag_block_write ON public.user_bag_items;
CREATE POLICY bag_block_write ON public.user_bag_items FOR ALL USING (false) WITH CHECK (false);

-- =====================================================================
-- RPC: get_my_bag — current user's inventory joined with catalog
-- =====================================================================
CREATE OR REPLACE FUNCTION public.get_my_bag()
RETURNS TABLE (
  item_id      text,
  name         text,
  item_type    text,
  icon_url     text,
  description  text,
  rarity       text,
  quantity     int,
  expires_at   timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.id            AS item_id,
    c.name,
    c.item_type,
    c.icon_url,
    c.description,
    c.rarity,
    b.quantity,
    b.expires_at
  FROM public.user_bag_items b
  JOIN public.bag_item_catalog c ON c.id = b.item_id AND c.is_active = true
  WHERE b.user_id = auth.uid()
    AND (b.expires_at IS NULL OR b.expires_at > now())
    AND b.quantity > 0
  ORDER BY c.sort_order, c.name;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_bag() TO authenticated;

-- =====================================================================
-- RPC: use_bag_item — decrement qty by `qty` (default 1). Returns the new
-- quantity. Effect application is a separate concern handled per item.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.use_bag_item(item text, qty int DEFAULT 1)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
  cur int;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF qty <= 0 THEN RAISE EXCEPTION 'Quantity must be positive'; END IF;

  SELECT quantity INTO cur
    FROM public.user_bag_items
    WHERE user_id = me AND item_id = item
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'You do not own this item'; END IF;
  IF cur < qty THEN RAISE EXCEPTION 'Not enough quantity'; END IF;

  UPDATE public.user_bag_items
     SET quantity = quantity - qty
   WHERE user_id = me AND item_id = item
   RETURNING quantity INTO cur;
  RETURN cur;
END;
$$;

GRANT EXECUTE ON FUNCTION public.use_bag_item(text, int) TO authenticated;

-- =====================================================================
-- RPC: grant_bag_item — admin-only, hands an item to a user.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.grant_bag_item(target uuid, item text, qty int DEFAULT 1, expires timestamptz DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;
  IF qty <= 0 THEN RAISE EXCEPTION 'Quantity must be positive'; END IF;

  INSERT INTO public.user_bag_items (user_id, item_id, quantity, expires_at)
       VALUES (target, item, qty, expires)
       ON CONFLICT (user_id, item_id)
       DO UPDATE SET quantity = public.user_bag_items.quantity + EXCLUDED.quantity,
                     expires_at = COALESCE(EXCLUDED.expires_at, public.user_bag_items.expires_at);
END;
$$;

GRANT EXECUTE ON FUNCTION public.grant_bag_item(uuid, text, int, timestamptz) TO authenticated;

-- =====================================================================
-- Seed catalog with the items the mock screen used to show.
-- =====================================================================
INSERT INTO public.bag_item_catalog (id, name, item_type, icon_url, description, is_stackable, rarity, sort_order)
VALUES
  ('small_gift_box',     'Small Gift Box',     'consumable', 'https://cdn-icons-png.flaticon.com/512/2913/2913990.png', 'Contains 10-50 random diamonds.',     true,  'common',    10),
  ('double_exp_card',    'Double EXP Card',    'effect',     'https://cdn-icons-png.flaticon.com/512/1041/1041888.png', 'Doubles XP earned for the next hour.', true,  'rare',      20),
  ('vip_trial_1d',       'VIP Trial (1 day)',  'voucher',    'https://cdn-icons-png.flaticon.com/512/2583/2583344.png', 'Activates VIP status for 24 hours.',   false, 'epic',      30),
  ('name_change_card',   'Name Change Card',   'utility',    'https://cdn-icons-png.flaticon.com/512/1250/1250615.png', 'Lets you change your nickname once.',  true,  'rare',      40),
  ('diamond_shield',     'Diamond Shield',     'effect',     'https://cdn-icons-png.flaticon.com/512/3593/3593452.png', 'Protects your streak if you miss a day.', true, 'rare',   50)
ON CONFLICT (id) DO NOTHING;
