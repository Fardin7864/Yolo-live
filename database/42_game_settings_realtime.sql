-- =====================================================================
-- 42_game_settings_realtime.sql
-- =====================================================================
-- The game RPCs already read win_chance_percent + is_active straight
-- from public.game_settings on every round, so server-side enforcement
-- is live already. What's missing is the MOBILE UI catching up: if an
-- admin disables Fruit Roulette from the panel, the broadcast room
-- still shows the game tile until the user restarts the app. The user
-- can press it and the RPC bounces them with "Game inactive", but it's
-- a poor UX.
--
-- This migration only adds game_settings to the realtime publication so
-- the mobile app can subscribe and live-hide disabled games. No schema
-- change.
--
-- Idempotent: re-runnable.
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='game_settings'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.game_settings;
  END IF;
END $$;