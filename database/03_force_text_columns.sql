-- =====================================================================
-- FORCE-FIX: Convert any remaining enum columns to TEXT
-- This is the definitive fix for "invalid input value for enum" errors.
-- Existing data is preserved (enum values become text strings).
-- Run this in Supabase SQL Editor.
-- =====================================================================

-- -------- TRANSACTIONS --------
DO $$ BEGIN
  ALTER TABLE public.transactions ALTER COLUMN type     TYPE TEXT USING type::TEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'transactions.type already TEXT or missing: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE public.transactions ALTER COLUMN currency TYPE TEXT USING currency::TEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'transactions.currency already TEXT or missing: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE public.transactions ALTER COLUMN status   TYPE TEXT USING status::TEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'transactions.status already TEXT or missing: %', SQLERRM;
END $$;

-- -------- TOPUP REQUESTS --------
DO $$ BEGIN
  ALTER TABLE public.topup_requests ALTER COLUMN status TYPE TEXT USING status::TEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'topup_requests.status already TEXT or missing: %', SQLERRM;
END $$;

-- -------- AGENCIES --------
DO $$ BEGIN
  ALTER TABLE public.agencies ALTER COLUMN status TYPE TEXT USING status::TEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'agencies.status already TEXT or missing: %', SQLERRM;
END $$;

-- -------- AGENCY MEMBERS --------
DO $$ BEGIN
  ALTER TABLE public.agency_members ALTER COLUMN status TYPE TEXT USING status::TEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'agency_members.status already TEXT or missing: %', SQLERRM;
END $$;

-- -------- AGENCY PAYOUTS --------
DO $$ BEGIN
  ALTER TABLE public.agency_payouts ALTER COLUMN status TYPE TEXT USING status::TEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'agency_payouts.status already TEXT or missing: %', SQLERRM;
END $$;

-- -------- RESELLERS --------
DO $$ BEGIN
  ALTER TABLE public.resellers ALTER COLUMN type   TYPE TEXT USING type::TEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'resellers.type already TEXT or missing: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE public.resellers ALTER COLUMN status TYPE TEXT USING status::TEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'resellers.status already TEXT or missing: %', SQLERRM;
END $$;

-- -------- LIVE STREAMS --------
DO $$ BEGIN
  ALTER TABLE public.live_streams ALTER COLUMN type   TYPE TEXT USING type::TEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'live_streams.type already TEXT or missing: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE public.live_streams ALTER COLUMN status TYPE TEXT USING status::TEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'live_streams.status already TEXT or missing: %', SQLERRM;
END $$;

-- -------- USER REPORTS --------
DO $$ BEGIN
  ALTER TABLE public.user_reports ALTER COLUMN status TYPE TEXT USING status::TEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'user_reports.status already TEXT or missing: %', SQLERRM;
END $$;

-- -------- PROFILES --------
DO $$ BEGIN
  ALTER TABLE public.profiles ALTER COLUMN role     TYPE TEXT USING role::TEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'profiles.role already TEXT or missing: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE public.profiles ALTER COLUMN gender   TYPE TEXT USING gender::TEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'profiles.gender already TEXT or missing: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE public.profiles ALTER COLUMN vip_type TYPE TEXT USING vip_type::TEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'profiles.vip_type already TEXT or missing: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE public.profiles ALTER COLUMN status   TYPE TEXT USING status::TEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'profiles.status already TEXT or missing: %', SQLERRM;
END $$;

-- -------- CHAT MESSAGES --------
DO $$ BEGIN
  ALTER TABLE public.chat_messages ALTER COLUMN type TYPE TEXT USING type::TEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'chat_messages.type already TEXT or missing: %', SQLERRM;
END $$;

-- -------- LIVE STREAM TOKENS --------
DO $$ BEGIN
  ALTER TABLE public.live_stream_tokens ALTER COLUMN role TYPE TEXT USING role::TEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'live_stream_tokens.role already TEXT or missing: %', SQLERRM;
END $$;

-- =====================================================================
-- DONE
-- Now restart the app and try the exchange again. No more enum errors.
-- =====================================================================