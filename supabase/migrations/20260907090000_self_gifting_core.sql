-- Self-gifting for hosts: a host may send gifts to themselves during their own
-- live session, paid from their own diamond balance at the normal gift price.
--
-- Beans ARE credited to the host (product decision), but self-gifted beans must
-- not become real money: no agency income, no payout/withdrawal eligibility, no
-- salary target progress. Both request_payout and agency_host_earnings read
-- profiles.beans directly, so crediting beans there would silently make them
-- withdrawable. A `non_withdrawable_beans` bucket keeps the visible balance
-- honest while excluding that portion from anything that pays out.
--
-- Super Admin controls (system_settings.self_gifting):
--   enabled               - global on/off
--   daily_diamond_limit   - max diamonds a host may self-gift per Dhaka day (0 = unlimited)
--   daily_count_limit     - max self-gifts per host per Dhaka day (0 = unlimited)
--   count_toward_earnings - when true, self-gifts behave like normal gifts and
--                           the beans are withdrawable (default false)
--
-- Ranking exclusion lives in the follow-up migration; every ranking function
-- reads gifts_log, so they are patched together there.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS non_withdrawable_beans BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.gifts_log
  ADD COLUMN IF NOT EXISTS is_self_gift BOOLEAN NOT NULL DEFAULT FALSE;

-- Audit/report reads are always "this host, this day".
CREATE INDEX IF NOT EXISTS gifts_log_self_gift_idx
  ON public.gifts_log (sender_id, created_at DESC)
  WHERE is_self_gift;

INSERT INTO public.system_settings(key, value)
VALUES ('self_gifting', jsonb_build_object(
  'enabled', TRUE,
  'daily_diamond_limit', 0,
  'daily_count_limit', 0,
  'count_toward_earnings', FALSE
))
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.self_gift_config()
RETURNS TABLE (
  enabled BOOLEAN,
  daily_diamond_limit BIGINT,
  daily_count_limit BIGINT,
  count_toward_earnings BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((value->>'enabled')::BOOLEAN, FALSE),
         GREATEST(0, COALESCE((value->>'daily_diamond_limit')::BIGINT, 0)),
         GREATEST(0, COALESCE((value->>'daily_count_limit')::BIGINT, 0)),
         COALESCE((value->>'count_toward_earnings')::BOOLEAN, FALSE)
    FROM public.system_settings
   WHERE key = 'self_gifting'
  UNION ALL
  SELECT FALSE, 0, 0, FALSE
   WHERE NOT EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'self_gifting')
  LIMIT 1;
$$;

-- What the host has already self-gifted today, for the limit check and the UI.
CREATE OR REPLACE FUNCTION public.self_gift_today(p_host_id UUID DEFAULT NULL)
RETURNS TABLE (diamonds_spent BIGINT, gift_count BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(SUM(diamond_cost), 0)::BIGINT,
         COALESCE(SUM("count"), 0)::BIGINT
    FROM public.gifts_log
   WHERE sender_id = COALESCE(p_host_id, auth.uid())
     AND is_self_gift
     AND (created_at AT TIME ZONE 'Asia/Dhaka')::DATE
         = (NOW() AT TIME ZONE 'Asia/Dhaka')::DATE;
$$;

CREATE OR REPLACE FUNCTION public.send_gift(
  p_sender_id uuid,
  p_recipient_id uuid,
  p_gift_id text,
  p_diamond_cost bigint,
  p_room_id uuid DEFAULT NULL::uuid,
  p_gift_name text DEFAULT NULL::text,
  p_count integer DEFAULT 1
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sender_balance BIGINT;
  v_balance_after  BIGINT;
  v_unit_cost      BIGINT;
  v_bean_value     BIGINT;
  v_total_cost     BIGINT;
  v_total_beans    BIGINT;
  v_gift_name      TEXT;
  v_is_active      BOOLEAN;
  v_required_vip   TEXT;
  v_sender_vip     TEXT;
  v_vip_expires    TIMESTAMPTZ;
  v_is_self        BOOLEAN := FALSE;
  v_cfg            RECORD;
  v_today          RECORD;
BEGIN
  IF auth.uid() IS DISTINCT FROM p_sender_id THEN
    RETURN json_build_object('success', FALSE, 'message', 'You may only spend your own diamonds');
  END IF;
  IF p_sender_id IS NULL OR p_recipient_id IS NULL THEN
    RETURN json_build_object('success', FALSE, 'message', 'Choose another valid gift recipient');
  END IF;
  IF p_count IS NULL OR p_count < 1 OR p_count > 1000 THEN
    RETURN json_build_object('success', FALSE, 'message', 'Invalid gift quantity');
  END IF;

  v_is_self := p_sender_id = p_recipient_id;

  IF v_is_self THEN
    SELECT * INTO v_cfg FROM public.self_gift_config();
    IF NOT v_cfg.enabled THEN
      RETURN json_build_object('success', FALSE, 'message', 'Self-gifting is currently turned off');
    END IF;

    -- Only inside the host's own running live session.
    IF p_room_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.live_streams
       WHERE id = p_room_id
         AND broadcaster_id = p_sender_id
         AND status = 'live'
    ) THEN
      RETURN json_build_object('success', FALSE, 'message', 'You can only gift yourself during your own live');
    END IF;
  END IF;

  SELECT diamond_cost, COALESCE(bean_value, diamond_cost / 2), name, is_active, required_vip_type
    INTO v_unit_cost, v_bean_value, v_gift_name, v_is_active, v_required_vip
  FROM public.gifts
  WHERE id = p_gift_id;

  IF NOT FOUND THEN
    v_unit_cost := p_diamond_cost;
    v_bean_value := p_diamond_cost / 2;
    v_gift_name := COALESCE(NULLIF(BTRIM(p_gift_name), ''), p_gift_id);
  ELSIF NOT COALESCE(v_is_active, TRUE) THEN
    RETURN json_build_object('success', FALSE, 'message', 'This gift is unavailable');
  END IF;

  IF v_unit_cost IS NULL OR v_unit_cost <= 0 THEN
    RETURN json_build_object('success', FALSE, 'message', 'Invalid gift price');
  END IF;

  IF v_required_vip IS NOT NULL THEN
    SELECT vip_type, vip_expires_at INTO v_sender_vip, v_vip_expires
    FROM public.profiles WHERE id = p_sender_id;
    IF v_vip_expires IS NULL OR v_vip_expires <= NOW()
       OR (v_required_vip = 'VIP'  AND v_sender_vip NOT IN ('VIP', 'SVIP', 'VVIP'))
       OR (v_required_vip = 'SVIP' AND v_sender_vip NOT IN ('SVIP', 'VVIP'))
       OR (v_required_vip = 'VVIP' AND v_sender_vip <> 'VVIP') THEN
      RETURN json_build_object('success', FALSE, 'message', v_required_vip || ' membership is required');
    END IF;
  END IF;

  v_total_cost := v_unit_cost * p_count;
  v_total_beans := v_bean_value * p_count;

  -- Daily self-gift ceilings, evaluated on the Dhaka day.
  IF v_is_self AND (v_cfg.daily_diamond_limit > 0 OR v_cfg.daily_count_limit > 0) THEN
    SELECT * INTO v_today FROM public.self_gift_today(p_sender_id);
    IF v_cfg.daily_diamond_limit > 0
       AND v_today.diamonds_spent + v_total_cost > v_cfg.daily_diamond_limit THEN
      RETURN json_build_object(
        'success', FALSE,
        'message', 'Daily self-gift limit reached. Try again tomorrow.',
        'limit_reached', TRUE,
        'daily_diamond_limit', v_cfg.daily_diamond_limit,
        'diamonds_spent_today', v_today.diamonds_spent
      );
    END IF;
    IF v_cfg.daily_count_limit > 0
       AND v_today.gift_count + p_count > v_cfg.daily_count_limit THEN
      RETURN json_build_object(
        'success', FALSE,
        'message', 'Daily self-gift limit reached. Try again tomorrow.',
        'limit_reached', TRUE,
        'daily_count_limit', v_cfg.daily_count_limit,
        'gift_count_today', v_today.gift_count
      );
    END IF;
  END IF;

  SELECT diamonds INTO v_sender_balance
  FROM public.profiles
  WHERE id = p_sender_id AND NOT COALESCE(is_banned, FALSE)
  FOR UPDATE;
  IF NOT FOUND OR COALESCE(v_sender_balance, 0) < v_total_cost THEN
    RETURN json_build_object('success', FALSE, 'message', 'Insufficient diamonds');
  END IF;

  IF NOT v_is_self AND NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = p_recipient_id AND NOT COALESCE(is_banned, FALSE)
  ) THEN
    RETURN json_build_object('success', FALSE, 'message', 'Gift recipient is unavailable');
  END IF;

  UPDATE public.profiles
  SET diamonds = diamonds - v_total_cost,
      updated_at = NOW()
  WHERE id = p_sender_id
  RETURNING diamonds INTO v_balance_after;

  -- Beans are credited either way. For a self-gift that does not count toward
  -- earnings the same amount is also parked as non-withdrawable, so the balance
  -- rises but payouts and agency income ignore it.
  UPDATE public.profiles
  SET beans = COALESCE(beans, 0) + v_total_beans,
      non_withdrawable_beans = COALESCE(non_withdrawable_beans, 0)
        + CASE WHEN v_is_self AND NOT v_cfg.count_toward_earnings THEN v_total_beans ELSE 0 END,
      updated_at = NOW()
  WHERE id = p_recipient_id;

  INSERT INTO public.gifts_log
    (sender_id, receiver_id, gift_id, gift_name, diamond_cost, bean_value, count, room_id, is_self_gift)
  VALUES
    (p_sender_id, p_recipient_id, p_gift_id, v_gift_name, v_total_cost, v_total_beans, p_count, p_room_id, v_is_self);

  INSERT INTO public.transactions
    (user_id, related_user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
  VALUES
    (p_sender_id, p_recipient_id,
     CASE WHEN v_is_self THEN 'self_gift_sent' ELSE 'gift_sent' END,
     'diamond', -v_total_cost, 'gift', NULL, 'completed',
     CASE WHEN v_is_self THEN 'Self gift: ' || v_gift_name ELSE NULL END),
    (p_recipient_id, p_sender_id,
     CASE WHEN v_is_self THEN 'self_gift_received' ELSE 'gift_received' END,
     'bean', v_total_beans, 'gift', NULL, 'completed',
     CASE WHEN v_is_self THEN 'Self gift: ' || v_gift_name ELSE NULL END);

  IF p_room_id IS NOT NULL THEN
    UPDATE public.live_streams
    SET total_gifts = COALESCE(total_gifts, 0) + p_count,
        total_earnings = COALESCE(total_earnings, 0)
          + CASE WHEN v_is_self AND NOT v_cfg.count_toward_earnings THEN 0 ELSE v_total_beans END
    WHERE id = p_room_id;
  END IF;

  RETURN json_build_object(
    'success', TRUE,
    'diamonds_spent', v_total_cost,
    'diamond_balance', v_balance_after,
    'beans_earned', v_total_beans,
    'count', p_count,
    'self_gift', v_is_self
  );
END;
$function$;

-- Payouts may only draw on beans that were actually earned from other people.
CREATE OR REPLACE FUNCTION public.request_payout(p_host_id uuid, p_beans_amount bigint)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_agency_id   UUID;
  v_rate        NUMERIC;
  v_balance     BIGINT;
  v_locked      BIGINT;
  v_withdrawable BIGINT;
  v_bdt         NUMERIC;
  v_id          UUID;
BEGIN
  SELECT agency_id INTO v_agency_id FROM public.profiles WHERE id = p_host_id;
  IF v_agency_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not in any agency');
  END IF;

  SELECT COALESCE((value #>> '{}')::numeric, 9)
    INTO v_rate
    FROM public.system_settings
    WHERE key = 'host_payout_bdt_per_1000';
  IF v_rate IS NULL THEN v_rate := 9; END IF;

  SELECT beans, COALESCE(non_withdrawable_beans, 0)
    INTO v_balance, v_locked
    FROM public.profiles WHERE id = p_host_id FOR UPDATE;

  v_withdrawable := GREATEST(0, COALESCE(v_balance, 0) - v_locked);
  IF v_withdrawable < p_beans_amount THEN
    RETURN json_build_object(
      'success', false,
      'message', CASE
        WHEN v_locked > 0 THEN 'Insufficient beans. Self-gifted beans cannot be withdrawn.'
        ELSE 'Insufficient beans'
      END,
      'withdrawable_beans', v_withdrawable,
      'locked_beans', v_locked
    );
  END IF;

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
END $function$;

REVOKE ALL ON FUNCTION public.self_gift_config() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.self_gift_today(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.self_gift_config() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.self_gift_today(UUID) TO authenticated, service_role;

COMMENT ON COLUMN public.profiles.non_withdrawable_beans IS
  'Beans credited from self-gifts (or other non-earning sources). Counted in the visible balance, excluded from payouts and agency income.';
COMMENT ON COLUMN public.gifts_log.is_self_gift IS
  'True when a host gifted themselves. Excluded from rankings and earnings; reported separately in the admin panel.';
