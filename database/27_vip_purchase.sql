-- =====================================================================
-- 27_vip_purchase.sql — Atomic VIP / SVIP / VVIP purchase RPC
-- =====================================================================
-- The `profiles` table already has `vip_type` + `vip_expires_at`, but the
-- protect_profile_columns trigger (migration 13/20) prevents the client
-- from writing them directly. This migration adds a SECURITY DEFINER RPC
-- that runs server-side, atomically:
--   • validates tier + days + caller's diamond balance
--   • deducts the requested diamond cost
--   • upgrades vip_type if the new tier is higher than the current one
--   • extends vip_expires_at (stack remaining time onto the purchase)
--
-- Pricing is encoded in the RPC so the client cannot tamper with it. If
-- you want to change prices, update the CASE block + redeploy.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.purchase_vip(
    tier text,           -- 'VIP' | 'SVIP' | 'VVIP'
    days int             -- 7 | 15 | 30
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me           uuid := auth.uid();
  tier_rank    int;
  cur_rank     int := 0;
  cost         bigint;
  cur_balance  bigint;
  cur_expires  timestamptz;
  new_expires  timestamptz;
  cur_tier     text;
  new_tier     text;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF tier NOT IN ('VIP', 'SVIP', 'VVIP') THEN
    RAISE EXCEPTION 'Invalid tier: %', tier;
  END IF;
  IF days NOT IN (7, 15, 30) THEN
    RAISE EXCEPTION 'Invalid duration: % days', days;
  END IF;

  -- Price table — kept in the SECURITY DEFINER RPC so clients can't tamper.
  cost := CASE tier
    WHEN 'VIP'  THEN CASE days WHEN  7 THEN 15000  WHEN 15 THEN 28000  WHEN 30 THEN 50000  END
    WHEN 'SVIP' THEN CASE days WHEN  7 THEN 25000  WHEN 15 THEN 50000  WHEN 30 THEN 90000  END
    WHEN 'VVIP' THEN CASE days WHEN  7 THEN 40000  WHEN 15 THEN 80000  WHEN 30 THEN 150000 END
  END;

  IF cost IS NULL THEN
    RAISE EXCEPTION 'No price for tier=% days=%', tier, days;
  END IF;

  -- Lock the row so concurrent purchases can't double-spend or stack twice.
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

  -- Tier rank for comparing existing vs requested tier.
  tier_rank := CASE tier WHEN 'VIP' THEN 1 WHEN 'SVIP' THEN 2 WHEN 'VVIP' THEN 3 END;
  IF cur_tier IS NOT NULL THEN
    cur_rank := CASE cur_tier WHEN 'VIP' THEN 1 WHEN 'SVIP' THEN 2 WHEN 'VVIP' THEN 3 ELSE 0 END;
  END IF;

  -- New expiry: stack remaining time onto the new purchase if the user is
  -- already subscribed AND buying the same/lower tier. If upgrading tiers,
  -- the new period starts now (old lower-tier time is discarded — fair: the
  -- gap could be refunded later if the user complains).
  IF cur_expires IS NOT NULL AND cur_expires > now() AND tier_rank <= cur_rank THEN
    new_expires := cur_expires + make_interval(days => days);
  ELSE
    new_expires := now() + make_interval(days => days);
  END IF;

  -- Keep the highest tier ever held during the active window.
  IF tier_rank >= cur_rank THEN
    new_tier := tier;
  ELSE
    new_tier := cur_tier;
  END IF;

  UPDATE public.profiles
     SET diamonds       = diamonds - cost,
         vip_type       = new_tier,
         vip_expires_at = new_expires
   WHERE id = me;

  RETURN json_build_object(
    'tier',          new_tier,
    'expires_at',    new_expires,
    'cost',          cost,
    'new_balance',   cur_balance - cost
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.purchase_vip(text, int) TO authenticated;