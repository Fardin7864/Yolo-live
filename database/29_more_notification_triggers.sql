-- =====================================================================
-- 29_more_notification_triggers.sql — All remaining notification types
-- =====================================================================
-- Migration 28 covered: follow + gift_received.
-- This migration covers everything else the notifications screen knows
-- how to render:
--   • topup_confirmed   — admin confirms a top-up request
--   • topup_confirmed   — admin manually grants diamonds/beans via
--                         admin_update_user (positive deltas only)
--   • agency_invite     — host added to an agency (invite created)
--   • agency_release    — host removed from / left an agency
--   • payout_paid       — agency payout marked 'paid'
--   • topup_confirmed   — agency owner transfers diamonds to a host
--                         (uses the wallet icon — same flavour as a topup)
--
-- Idempotent: each function uses CREATE OR REPLACE; each trigger is
-- DROP IF EXISTS + CREATE so re-running this file is safe.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TOPUP CONFIRMED — topup_requests UPDATE trigger
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_on_topup_confirm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Fire only on transition INTO 'confirmed'.
  IF NEW.status = 'confirmed' AND COALESCE(OLD.status, '') <> 'confirmed' THEN
    INSERT INTO public.notifications (user_id, type, title, body, payload)
    VALUES (
      NEW.user_id,
      'topup_confirmed',
      'Top-up confirmed',
      'Your top-up of ' || NEW.package_amount || ' diamonds has been added to your balance.',
      jsonb_build_object(
        'topup_request_id', NEW.id,
        'amount',           NEW.package_amount,
        'bdt_value',        NEW.bdt_value
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_on_topup_confirm ON public.topup_requests;
CREATE TRIGGER trg_notify_on_topup_confirm
AFTER UPDATE ON public.topup_requests
FOR EACH ROW
EXECUTE FUNCTION public.notify_on_topup_confirm();

-- ---------------------------------------------------------------------
-- 2. ADMIN BALANCE GRANT — admin_audit_log INSERT trigger
--    Positive changes only (reductions stay silent so corrections /
--    sanctions can be communicated separately).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_on_admin_grant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  diamond_old  bigint := 0;
  diamond_new  bigint := 0;
  diamond_diff bigint := 0;
  bean_old     bigint := 0;
  bean_new     bigint := 0;
  bean_diff    bigint := 0;
  body_text    text   := '';
BEGIN
  IF NEW.action <> 'admin_update_user' OR NEW.target_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.payload ? 'diamonds' THEN
    diamond_old  := COALESCE((NEW.payload -> 'diamonds' ->> 0)::bigint, 0);
    diamond_new  := COALESCE((NEW.payload -> 'diamonds' ->> 1)::bigint, 0);
    diamond_diff := diamond_new - diamond_old;
  END IF;

  IF NEW.payload ? 'beans' THEN
    bean_old  := COALESCE((NEW.payload -> 'beans' ->> 0)::bigint, 0);
    bean_new  := COALESCE((NEW.payload -> 'beans' ->> 1)::bigint, 0);
    bean_diff := bean_new - bean_old;
  END IF;

  IF diamond_diff > 0 THEN
    body_text := body_text || 'You received ' || diamond_diff || ' diamonds. ';
  END IF;
  IF bean_diff > 0 THEN
    body_text := body_text || 'You received ' || bean_diff || ' beans. ';
  END IF;

  IF length(trim(body_text)) > 0 THEN
    INSERT INTO public.notifications (user_id, type, title, body, payload)
    VALUES (
      NEW.target_id,
      'topup_confirmed',          -- reuse wallet icon
      'Balance updated',
      trim(body_text),
      jsonb_build_object(
        'diamond_diff', diamond_diff,
        'bean_diff',    bean_diff,
        'source',       'admin'
      )
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_on_admin_grant ON public.admin_audit_log;
CREATE TRIGGER trg_notify_on_admin_grant
AFTER INSERT ON public.admin_audit_log
FOR EACH ROW
EXECUTE FUNCTION public.notify_on_admin_grant();

-- ---------------------------------------------------------------------
-- 3. AGENCY INVITE — agency_members INSERT trigger (status='pending')
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_on_agency_invite()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  agency_name text;
BEGIN
  -- Only when the row lands in 'pending' (i.e. an invitation is created).
  IF NEW.status <> 'pending' THEN
    RETURN NEW;
  END IF;

  SELECT name INTO agency_name FROM public.agencies WHERE id = NEW.agency_id;

  INSERT INTO public.notifications (user_id, type, title, body, payload)
  VALUES (
    NEW.host_id,
    'agency_invite',
    'Agency invitation',
    COALESCE(agency_name, 'An agency') || ' invited you to join.',
    jsonb_build_object(
      'agency_id',         NEW.agency_id,
      'agency_member_id',  NEW.id
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_on_agency_invite ON public.agency_members;
CREATE TRIGGER trg_notify_on_agency_invite
AFTER INSERT ON public.agency_members
FOR EACH ROW
EXECUTE FUNCTION public.notify_on_agency_invite();

-- ---------------------------------------------------------------------
-- 4. AGENCY RELEASE — agency_members UPDATE to 'released'
--    Covers both self-leave (leave_agency RPC) and owner-side release.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_on_agency_release()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  agency_name text;
BEGIN
  IF NEW.status = 'released' AND COALESCE(OLD.status, '') <> 'released' THEN
    SELECT name INTO agency_name FROM public.agencies WHERE id = NEW.agency_id;

    INSERT INTO public.notifications (user_id, type, title, body, payload)
    VALUES (
      NEW.host_id,
      'agency_release',
      'Agency membership ended',
      'Your membership in ' || COALESCE(agency_name, 'the agency') || ' has ended.',
      jsonb_build_object('agency_id', NEW.agency_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_on_agency_release ON public.agency_members;
CREATE TRIGGER trg_notify_on_agency_release
AFTER UPDATE ON public.agency_members
FOR EACH ROW
EXECUTE FUNCTION public.notify_on_agency_release();

-- ---------------------------------------------------------------------
-- 5. AGENCY PAYOUT PAID — agency_payouts UPDATE to 'paid'
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_on_payout_paid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'paid' AND COALESCE(OLD.status, '') <> 'paid' THEN
    INSERT INTO public.notifications (user_id, type, title, body, payload)
    VALUES (
      NEW.host_id,
      'payout_paid',
      'Payout sent',
      'Your payout of ' || NEW.beans_amount || ' beans (≈ BDT ' || NEW.bdt_value || ') has been marked as paid.',
      jsonb_build_object(
        'payout_id',    NEW.id,
        'agency_id',    NEW.agency_id,
        'beans_amount', NEW.beans_amount,
        'bdt_value',    NEW.bdt_value
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_on_payout_paid ON public.agency_payouts;
CREATE TRIGGER trg_notify_on_payout_paid
AFTER UPDATE ON public.agency_payouts
FOR EACH ROW
EXECUTE FUNCTION public.notify_on_payout_paid();

-- ---------------------------------------------------------------------
-- 6. AGENCY TRANSFER TO HOST — transactions INSERT (type='agency_transfer')
--    Filters by transaction type so the gift_sent / gift_received /
--    topup rows don't trigger noise. Direct diamond gifts from agency
--    owner to host land here.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_on_agency_transfer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  owner_name text;
BEGIN
  IF NEW.type <> 'agency_transfer' OR NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO owner_name
    FROM public.profiles
    WHERE id = NEW.related_user_id;

  INSERT INTO public.notifications (user_id, type, title, body, payload)
  VALUES (
    NEW.user_id,
    'topup_confirmed',                    -- wallet icon
    'Diamonds received',
    COALESCE(owner_name, 'Your agency') || ' sent you ' || NEW.amount || ' diamonds.',
    jsonb_build_object(
      'transaction_id', NEW.id,
      'amount',         NEW.amount,
      'sender_id',      NEW.related_user_id,
      'agency_id',      NEW.related_entity_id
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_on_agency_transfer ON public.transactions;
CREATE TRIGGER trg_notify_on_agency_transfer
AFTER INSERT ON public.transactions
FOR EACH ROW
EXECUTE FUNCTION public.notify_on_agency_transfer();