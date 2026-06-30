-- =====================================================================
-- 28_notification_triggers.sql — Auto-create notifications on real events
-- =====================================================================
-- The `notifications` table (yolo_schema.sql §2.18) + the screen at
-- app/main/notifications.js were already wired up, but nothing actually
-- inserted rows into the table, so users always saw the empty state.
--
-- This migration adds trigger-based inserts for the two highest-impact
-- events without touching existing RPCs:
--   1. Someone follows you             → `follow`         notification
--   2. Someone sends you a gift in a room → `gift_received` notification
--
-- Other notification types (topup_confirmed, agency_invite, agency_release,
-- payout_paid, system) can be added later by extending their respective
-- RPCs to write a notifications row inline. Keeping this migration focused
-- on the two most user-visible flows.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. FOLLOW NOTIFICATIONS
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_on_follow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  follower_name text;
BEGIN
  -- Don't bother on self-follow (the CHECK in follows blocks this, but
  -- guard anyway).
  IF NEW.follower_id = NEW.following_id THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO follower_name
    FROM public.profiles
    WHERE id = NEW.follower_id;

  INSERT INTO public.notifications (user_id, type, title, body, payload)
  VALUES (
    NEW.following_id,
    'follow',
    'New follower',
    COALESCE(follower_name, 'Someone') || ' started following you.',
    jsonb_build_object('follower_id', NEW.follower_id)
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_on_follow ON public.follows;
CREATE TRIGGER trg_notify_on_follow
AFTER INSERT ON public.follows
FOR EACH ROW
EXECUTE FUNCTION public.notify_on_follow();

-- ---------------------------------------------------------------------
-- 2. GIFT-RECEIVED NOTIFICATIONS
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_on_gift()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  sender_name text;
  pretty_gift text;
BEGIN
  IF NEW.sender_id = NEW.receiver_id THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO sender_name
    FROM public.profiles
    WHERE id = NEW.sender_id;

  pretty_gift := COALESCE(
    CASE WHEN NEW.count IS NULL OR NEW.count <= 1
      THEN NEW.gift_name
      ELSE NEW.count || 'x ' || NEW.gift_name
    END,
    'a gift'
  );

  INSERT INTO public.notifications (user_id, type, title, body, payload)
  VALUES (
    NEW.receiver_id,
    'gift_received',
    'Gift received',
    COALESCE(sender_name, 'Someone') || ' sent you ' || pretty_gift || '.',
    jsonb_build_object(
      'sender_id',   NEW.sender_id,
      'gift_id',     NEW.gift_id,
      'gift_name',   NEW.gift_name,
      'count',       NEW.count,
      'bean_value',  NEW.bean_value,
      'room_id',     NEW.room_id
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_on_gift ON public.gifts_log;
CREATE TRIGGER trg_notify_on_gift
AFTER INSERT ON public.gifts_log
FOR EACH ROW
EXECUTE FUNCTION public.notify_on_gift();

-- ---------------------------------------------------------------------
-- 3. UNREAD COUNT HELPER (cheap query for the home badge)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_unread_notification_count()
RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::int
    FROM public.notifications
   WHERE user_id = auth.uid()
     AND is_read = false;
$$;

GRANT EXECUTE ON FUNCTION public.get_unread_notification_count() TO authenticated;