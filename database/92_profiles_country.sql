-- =====================================================================
-- 92_profiles_country.sql — User profile country (display label)
-- =====================================================================
-- Adds a free-form `country` text column to the profiles table so a
-- user can pick their country once in the edit-profile screen and have
-- it surface on both their own profile tab and on the public profile
-- screen other viewers open from the live room.
--
-- Previously the public profile screen hard-coded "Bangladesh" for
-- every user (and the own-profile tab silently hid the label since
-- nothing populated it). The mobile fix conditionally renders the
-- label only when set; this migration provides the column to set it.
--
-- Distinct from `country_code` (the phone dialing prefix like '+880')
-- which exists for E.164-formatted phone normalisation — keeping them
-- separate so a user living in UAE with a BD phone number can pick
-- their actual country independently.
--
-- Idempotent: re-runnable. NOT NULL deferred — we let it default to
-- NULL so existing rows don't need a backfill and the conditional
-- render still works (the mobile code shows the country pill only
-- when truthy).
-- =====================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS country TEXT;
