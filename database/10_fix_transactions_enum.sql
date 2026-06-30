-- =====================================================================
-- FIX: transactions.type must be TEXT (not transaction_type enum)
-- Error seen: invalid input value for enum transaction_type: "reseller_stock"
-- Reason: the previous force-text migration's EXCEPTION block silently
-- swallowed the conversion failure (same issue as profiles.role had).
--
-- This file fails LOUDLY if anything goes wrong. Idempotent.
-- Run in Supabase SQL Editor.
-- =====================================================================

-- 1. Drop any CHECK constraint we might re-add later
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;

-- 2. Drop the column default (an enum-typed DEFAULT blocks ALTER TYPE)
ALTER TABLE public.transactions ALTER COLUMN type DROP DEFAULT;

-- 3. Convert column to TEXT (preserves existing values as strings)
ALTER TABLE public.transactions
  ALTER COLUMN type TYPE TEXT USING type::TEXT;

-- 4. Also force currency and status to TEXT while we're here (same risk)
DO $$ BEGIN
  ALTER TABLE public.transactions ALTER COLUMN currency DROP DEFAULT;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

ALTER TABLE public.transactions
  ALTER COLUMN currency TYPE TEXT USING currency::TEXT;

ALTER TABLE public.transactions ALTER COLUMN currency SET DEFAULT 'diamond';

DO $$ BEGIN
  ALTER TABLE public.transactions ALTER COLUMN status DROP DEFAULT;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

ALTER TABLE public.transactions
  ALTER COLUMN status TYPE TEXT USING status::TEXT;

ALTER TABLE public.transactions ALTER COLUMN status SET DEFAULT 'completed';

-- 5. Sanity check
DO $$
DECLARE v_type TEXT;
BEGIN
  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='transactions' AND column_name='type';
  RAISE NOTICE 'transactions.type is now: %', v_type;
  IF v_type <> 'text' THEN
    RAISE EXCEPTION 'transactions.type is still %, expected text', v_type;
  END IF;
END $$;

-- 6. Drop the now-unused enum type if nothing else references it
DO $$ BEGIN
  DROP TYPE IF EXISTS public.transaction_type;
  RAISE NOTICE 'Dropped transaction_type enum.';
EXCEPTION WHEN dependent_objects_still_exist THEN
  RAISE NOTICE 'transaction_type enum still used elsewhere — leaving it.';
END $$;

-- =====================================================================
-- DONE. Retry confirming the reseller request.
-- =====================================================================