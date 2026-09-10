-- The app opens postgres_changes subscriptions on 34 tables, but
-- `supabase_realtime` only ever contained 10, and just 4 of them overlapped.
-- Every other subscription was silently dead: it connected, reported
-- SUBSCRIBED, and then never received a row.
--
-- The visible symptom was money. send_gift_batch and every game settlement
-- credit profiles inside the same transaction as the log row, so the balance is
-- correct in the database immediately -- but `profiles` was not replicated, so
-- GlobalStateContext's balance listener never fired. The number on screen only
-- moved when something called fetchProfile() again: app foreground, or leaving
-- the screen. That is why beans and game winnings appeared to arrive "after
-- closing the live", and why the code carries a note about winnings showing up
-- 5-7 minutes late.
--
-- Every table below already has RLS enabled, and Realtime evaluates those
-- policies per subscriber, so replicating them does not widen who can read what.
--
-- Watch after deploy: live_streams and user_task_progress are the write-heavy
-- ones. To back a table out: ALTER PUBLICATION supabase_realtime DROP TABLE x;

DO $$
DECLARE
  v_table TEXT;
  v_wanted TEXT[] := ARRAY[
    -- Balances, identity and the live room itself
    'profiles', 'live_streams', 'notifications', 'chat_messages', 'room_blocks',
    -- Catalogs the client hot-reloads when Super Admin edits them
    'gifts', 'system_settings', 'game_settings', 'home_banners', 'mall_intro_items',
    'audio_templates', 'user_audio_templates', 'profile_frames', 'badges', 'user_badges',
    'level_thresholds', 'level_tiers', 'vip_tiers',
    -- Requests and applications that need a live status flip
    'topup_requests', 'reseller_stock_requests', 'reseller_applications',
    'agency_stock_requests', 'agency_applications', 'agency_leave_requests', 'agency_members',
    -- Memberships and progression
    'vip_subscriptions', 'svip_subscriptions', 'tasks', 'user_task_progress', 'daily_login_rewards'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_wanted LOOP
    -- Skip anything already published so this migration is safe to re-run.
    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = v_table
    ) THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = v_table AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'skipping %: table not found', v_table;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
    RAISE NOTICE 'added % to supabase_realtime', v_table;
  END LOOP;
END $$;
