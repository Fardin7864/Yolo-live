-- psql deployment wrapper for the canonical Supabase migration.
-- Run from this directory with: psql "$DATABASE_URL" -f 169_realtime_betting_consistency.sql
\ir ../supabase/migrations/20260824230000_realtime_betting_consistency.sql
