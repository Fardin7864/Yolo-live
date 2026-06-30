-- =====================================================================
-- FIX: Drop duplicate game function overloads
-- Error: "could not choose the best candidate function between:
--         play_teen_patti(..., bigint, bigint, bigint),
--         play_teen_patti(..., integer, integer, integer)"
--
-- Cause: An earlier version of the schema created these functions with
-- INTEGER params. The current schema recreates them with BIGINT, but
-- PostgreSQL treats different parameter types as DISTINCT functions
-- (overloads), so both exist. PostgREST cannot pick one when called.
--
-- Fix: Drop the INTEGER-typed overloads. Keep only the BIGINT versions.
-- Idempotent — IF EXISTS guards every DROP.
-- Run in Supabase SQL Editor.
-- =====================================================================

-- 1. Drop the INTEGER overloads (if they exist)
DROP FUNCTION IF EXISTS public.play_teen_patti(uuid, integer, integer, integer);
DROP FUNCTION IF EXISTS public.play_fruit_roulette(uuid, integer, integer, integer, integer);

-- 2. Sanity check: list remaining overloads so you can verify
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('play_teen_patti', 'play_fruit_roulette')
  LOOP
    RAISE NOTICE '% (%)', r.proname, r.args;
  END LOOP;
END $$;

-- Expected output:
--   play_teen_patti     (p_user_id uuid, p_bet_a bigint, p_bet_b bigint, p_bet_c bigint)
--   play_fruit_roulette (p_user_id uuid, p_apple_bet bigint, ... bigint)
--
-- If you still see INTEGER overloads, drop them by name with their exact
-- argument signature shown above.

-- =====================================================================
-- DONE. Retry placing a Teen Patti or Fruit Roulette bet.
-- =====================================================================