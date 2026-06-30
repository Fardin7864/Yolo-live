-- =====================================================================
-- 76_pricing_settings.sql
-- =====================================================================
-- Central, admin-tunable pricing for the three diamond/bean exchange
-- legs. Until this migration the rates were either hardcoded in the
-- mobile app (wallet.js PACKAGES), spread across per-agency rows
-- (agencies.payout_rate), or set to an out-of-line default in
-- system_settings (bulk_diamond_bdt_per_1000 = 1000, way too high).
-- Super admin now has one place to tune all three:
--
--   bulk_diamond_bdt_per_1000   — BDT a reseller / agency owner pays
--                                 super admin per 1000 diamonds when
--                                 they buy bulk stock.
--                                 Default 10  →  1000 BDT per 1 lakh.
--
--   sell_diamond_bdt_per_1000   — BDT a normal user pays a reseller /
--                                 agency owner per 1000 diamonds.
--                                 Default 11  →  1100 BDT per 1 lakh.
--                                 The 1-BDT spread per 1000 = the
--                                 reseller / agency's gross margin.
--
--   host_payout_bdt_per_1000    — BDT a host receives from their agency
--                                 owner per 1000 beans when they
--                                 request a payout.
--                                 Default 9   →  900 BDT per 1 lakh.
--                                 This replaces per-agency
--                                 payout_rate as the source of truth.
--
-- All three are stored as JSONB scalars; the JS side reads them via
--   (value #>> '{}')::numeric.
--
-- system_settings is also added to the realtime publication so the
-- mobile app sees rate changes propagate immediately — no app update,
-- no rebuild.
--
-- Idempotent: re-runnable. Existing rows preserved unless the value is
-- our seed-default.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. SEED / UPDATE THE THREE PRICING KEYS
-- ---------------------------------------------------------------------
-- For the legacy `bulk_diamond_bdt_per_1000` we overwrite if and only
-- if the value is still the old default of 1000 (a known-wrong setup).
-- If an admin has already changed it post-deploy, leave their choice
-- alone — we don't want to clobber a deliberate override.
UPDATE public.system_settings
   SET value      = '10'::JSONB,
       updated_at = NOW()
 WHERE key = 'bulk_diamond_bdt_per_1000'
   AND value = '1000'::JSONB;

-- Then the three are seeded ON CONFLICT DO NOTHING so a re-run never
-- overwrites a value the admin set deliberately from the panel.
INSERT INTO public.system_settings (key, value) VALUES
  ('bulk_diamond_bdt_per_1000', '10'::JSONB),
  ('sell_diamond_bdt_per_1000', '11'::JSONB),
  ('host_payout_bdt_per_1000',  '9'::JSONB)
ON CONFLICT (key) DO NOTHING;


-- ---------------------------------------------------------------------
-- 2. request_payout — read host_payout_bdt_per_1000 instead of the
--    per-agency payout_rate column. We keep agencies.payout_rate on
--    the table for backwards-compat / historical records but no longer
--    consult it on the hot path.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_payout(
  p_host_id      UUID,
  p_beans_amount BIGINT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agency_id UUID;
  v_rate      NUMERIC;
  v_balance   BIGINT;
  v_bdt       NUMERIC;
  v_id        UUID;
BEGIN
  SELECT agency_id INTO v_agency_id FROM public.profiles WHERE id = p_host_id;
  IF v_agency_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not in any agency');
  END IF;

  -- Global rate from system_settings. Fall back to 9 if the row is
  -- missing for some reason (e.g. migration not yet seeded).
  SELECT COALESCE((value #>> '{}')::numeric, 9)
    INTO v_rate
    FROM public.system_settings
    WHERE key = 'host_payout_bdt_per_1000';
  IF v_rate IS NULL THEN v_rate := 9; END IF;

  SELECT beans INTO v_balance FROM public.profiles WHERE id = p_host_id FOR UPDATE;
  IF v_balance < p_beans_amount THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient beans');
  END IF;

  -- (beans / 1000) × rate. e.g. 1,000,000 beans × 9 = 9,000 BDT.
  v_bdt := ROUND((p_beans_amount::NUMERIC / 1000.0) * v_rate, 2);

  UPDATE public.profiles SET beans = beans - p_beans_amount WHERE id = p_host_id;
  UPDATE public.agencies SET accumulated_beans = accumulated_beans + p_beans_amount WHERE id = v_agency_id;

  INSERT INTO public.agency_payouts (agency_id, host_id, beans_amount, bdt_value)
  VALUES (v_agency_id, p_host_id, p_beans_amount, v_bdt)
  RETURNING id INTO v_id;

  INSERT INTO public.transactions (user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
  VALUES (p_host_id, 'agency_payout', 'bean', -p_beans_amount, 'agency_payout', v_id, 'pending',
          'Payout requested from agency');

  RETURN json_build_object('success', true, 'payout_id', v_id, 'bdt_value', v_bdt);
END $$;


-- ---------------------------------------------------------------------
-- 3. REALTIME — mobile app subscribes so rate changes propagate live.
-- ---------------------------------------------------------------------
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.system_settings;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ---------------------------------------------------------------------
-- 4. RLS — public read is required so the mobile client (anon role
--    after sign-in is "authenticated") can read the rates without an
--    RPC. Updates remain admin-only via update_system_settings.
-- ---------------------------------------------------------------------
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  DROP POLICY IF EXISTS sys_settings_read ON public.system_settings;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE POLICY sys_settings_read ON public.system_settings
  FOR SELECT
  USING (TRUE);


-- =====================================================================
-- DONE
-- =====================================================================
