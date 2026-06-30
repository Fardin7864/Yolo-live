-- =====================================================================
-- ENUM FIX: Add missing values to existing PostgreSQL enums
-- Run this in Supabase SQL Editor whenever an "invalid input value for enum"
-- error appears. Safe to run multiple times.
-- =====================================================================

-- ---- transaction_type enum ----
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transaction_type') THEN
    ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'topup';
    ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'gift_sent';
    ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'gift_received';
    ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'game_bet';
    ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'game_win';
    ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'bean_convert';
    ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'agency_payout';
    ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'agency_transfer';
  END IF;
END $$;

-- ---- transaction_status enum (if exists) ----
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transaction_status') THEN
    ALTER TYPE transaction_status ADD VALUE IF NOT EXISTS 'pending';
    ALTER TYPE transaction_status ADD VALUE IF NOT EXISTS 'completed';
    ALTER TYPE transaction_status ADD VALUE IF NOT EXISTS 'failed';
    ALTER TYPE transaction_status ADD VALUE IF NOT EXISTS 'reversed';
  END IF;
END $$;

-- ---- transaction_currency / currency_type enum (if exists) ----
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transaction_currency') THEN
    ALTER TYPE transaction_currency ADD VALUE IF NOT EXISTS 'diamond';
    ALTER TYPE transaction_currency ADD VALUE IF NOT EXISTS 'bean';
    ALTER TYPE transaction_currency ADD VALUE IF NOT EXISTS 'bdt';
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'currency_type') THEN
    ALTER TYPE currency_type ADD VALUE IF NOT EXISTS 'diamond';
    ALTER TYPE currency_type ADD VALUE IF NOT EXISTS 'bean';
    ALTER TYPE currency_type ADD VALUE IF NOT EXISTS 'bdt';
  END IF;
END $$;

-- ---- topup_status enum (if exists) ----
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'topup_status') THEN
    ALTER TYPE topup_status ADD VALUE IF NOT EXISTS 'pending';
    ALTER TYPE topup_status ADD VALUE IF NOT EXISTS 'contacted';
    ALTER TYPE topup_status ADD VALUE IF NOT EXISTS 'confirmed';
    ALTER TYPE topup_status ADD VALUE IF NOT EXISTS 'cancelled';
  END IF;
END $$;

-- ---- agency_status enum (if exists) ----
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agency_status') THEN
    ALTER TYPE agency_status ADD VALUE IF NOT EXISTS 'verified';
    ALTER TYPE agency_status ADD VALUE IF NOT EXISTS 'pending';
    ALTER TYPE agency_status ADD VALUE IF NOT EXISTS 'suspended';
  END IF;
END $$;

-- ---- agency_member_status enum (if exists) ----
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agency_member_status') THEN
    ALTER TYPE agency_member_status ADD VALUE IF NOT EXISTS 'active';
    ALTER TYPE agency_member_status ADD VALUE IF NOT EXISTS 'pending';
    ALTER TYPE agency_member_status ADD VALUE IF NOT EXISTS 'released';
  END IF;
END $$;

-- ---- agency_payout_status enum (if exists) ----
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agency_payout_status') THEN
    ALTER TYPE agency_payout_status ADD VALUE IF NOT EXISTS 'pending';
    ALTER TYPE agency_payout_status ADD VALUE IF NOT EXISTS 'paid';
    ALTER TYPE agency_payout_status ADD VALUE IF NOT EXISTS 'rejected';
  END IF;
END $$;

-- ---- reseller_status / reseller_type enum (if exists) ----
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reseller_status') THEN
    ALTER TYPE reseller_status ADD VALUE IF NOT EXISTS 'active';
    ALTER TYPE reseller_status ADD VALUE IF NOT EXISTS 'busy';
    ALTER TYPE reseller_status ADD VALUE IF NOT EXISTS 'inactive';
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reseller_type') THEN
    ALTER TYPE reseller_type ADD VALUE IF NOT EXISTS 'official';
    ALTER TYPE reseller_type ADD VALUE IF NOT EXISTS 'agency';
  END IF;
END $$;

-- ---- live_stream_status enum (if exists) ----
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'live_stream_status') THEN
    ALTER TYPE live_stream_status ADD VALUE IF NOT EXISTS 'live';
    ALTER TYPE live_stream_status ADD VALUE IF NOT EXISTS 'ended';
    ALTER TYPE live_stream_status ADD VALUE IF NOT EXISTS 'banned';
  END IF;
END $$;

-- ---- live_stream_type enum (if exists) ----
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'live_stream_type') THEN
    ALTER TYPE live_stream_type ADD VALUE IF NOT EXISTS 'video';
    ALTER TYPE live_stream_type ADD VALUE IF NOT EXISTS 'audio';
  END IF;
END $$;

-- ---- user_role enum (if exists) ----
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'user';
    ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'host';
    ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'agency_owner';
    ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'admin';
    ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'super_admin';
  END IF;
END $$;

-- ---- vip_type enum (if exists) ----
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vip_type') THEN
    ALTER TYPE vip_type ADD VALUE IF NOT EXISTS 'VIP';
    ALTER TYPE vip_type ADD VALUE IF NOT EXISTS 'VVIP';
    ALTER TYPE vip_type ADD VALUE IF NOT EXISTS 'SVIP';
  END IF;
END $$;

-- ---- user_status enum (if exists) ----
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_status') THEN
    ALTER TYPE user_status ADD VALUE IF NOT EXISTS 'Active';
    ALTER TYPE user_status ADD VALUE IF NOT EXISTS 'Banned';
    ALTER TYPE user_status ADD VALUE IF NOT EXISTS 'Suspended';
  END IF;
END $$;

-- ---- gender enum (if exists) ----
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gender_type') THEN
    ALTER TYPE gender_type ADD VALUE IF NOT EXISTS 'male';
    ALTER TYPE gender_type ADD VALUE IF NOT EXISTS 'female';
    ALTER TYPE gender_type ADD VALUE IF NOT EXISTS 'other';
  END IF;
END $$;

-- =====================================================================
-- DIAGNOSTIC: Run this to see ALL enums currently in your DB
-- =====================================================================
-- SELECT t.typname AS enum_name,
--        array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
-- FROM pg_type t
-- JOIN pg_enum e ON e.enumtypid = t.oid
-- JOIN pg_namespace n ON n.oid = t.typnamespace
-- WHERE n.nspname = 'public'
-- GROUP BY t.typname
-- ORDER BY t.typname;

-- =====================================================================
-- DONE
-- =====================================================================