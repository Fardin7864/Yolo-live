-- =====================================================================
-- MIGRATION: Bring existing tables up to the new schema shape
-- Run this FIRST in Supabase SQL Editor, THEN re-run yolo_schema.sql
-- Safe to run multiple times (uses IF NOT EXISTS / ALTER IF EXISTS)
-- =====================================================================
-- Strategy: For every table that might already exist, ALTER ... ADD COLUMN
-- IF NOT EXISTS for every column. ALTER TABLE IF EXISTS handles the case
-- where the table doesn't exist yet (it just skips).
-- =====================================================================


-- ============================ PROFILES ============================
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS display_id      BIGINT;
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS full_name       TEXT;
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS avatar_url      TEXT;
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS phone_number    TEXT;
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS country_code    TEXT DEFAULT '+880';
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS bio             TEXT DEFAULT '';
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS gender          TEXT DEFAULT 'female';
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS dob             DATE;
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS role            TEXT DEFAULT 'user';
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS level           INT  DEFAULT 1;
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS diamonds        BIGINT DEFAULT 0;
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS beans           BIGINT DEFAULT 0;
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS vip_type        TEXT;
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS vip_expires_at  TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS is_verified     BOOLEAN DEFAULT FALSE;
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS is_banned       BOOLEAN DEFAULT FALSE;
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS banned_reason   TEXT;
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS banned_until    TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS status          TEXT DEFAULT 'Active';
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS agency_id       UUID;
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS last_seen_at    TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE IF EXISTS public.profiles ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ DEFAULT NOW();


-- ============================ AGENCIES ============================
ALTER TABLE IF EXISTS public.agencies ADD COLUMN IF NOT EXISTS name                  TEXT;
ALTER TABLE IF EXISTS public.agencies ADD COLUMN IF NOT EXISTS code                  TEXT;
ALTER TABLE IF EXISTS public.agencies ADD COLUMN IF NOT EXISTS owner_id              UUID;
ALTER TABLE IF EXISTS public.agencies ADD COLUMN IF NOT EXISTS payout_rate           INT DEFAULT 1150;
ALTER TABLE IF EXISTS public.agencies ADD COLUMN IF NOT EXISTS host_conversion_rate  NUMERIC(5,2) DEFAULT 0.50;
ALTER TABLE IF EXISTS public.agencies ADD COLUMN IF NOT EXISTS accumulated_beans     BIGINT DEFAULT 0;
ALTER TABLE IF EXISTS public.agencies ADD COLUMN IF NOT EXISTS diamond_balance       BIGINT DEFAULT 0;
ALTER TABLE IF EXISTS public.agencies ADD COLUMN IF NOT EXISTS member_count          INT DEFAULT 0;
ALTER TABLE IF EXISTS public.agencies ADD COLUMN IF NOT EXISTS status                TEXT DEFAULT 'pending';
ALTER TABLE IF EXISTS public.agencies ADD COLUMN IF NOT EXISTS created_at            TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE IF EXISTS public.agencies ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ DEFAULT NOW();


-- ============================ AGENCY MEMBERS ============================
ALTER TABLE IF EXISTS public.agency_members ADD COLUMN IF NOT EXISTS agency_id    UUID;
ALTER TABLE IF EXISTS public.agency_members ADD COLUMN IF NOT EXISTS host_id      UUID;
ALTER TABLE IF EXISTS public.agency_members ADD COLUMN IF NOT EXISTS status       TEXT DEFAULT 'pending';
ALTER TABLE IF EXISTS public.agency_members ADD COLUMN IF NOT EXISTS joined_at    TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE IF EXISTS public.agency_members ADD COLUMN IF NOT EXISTS released_at  TIMESTAMPTZ;


-- ============================ AGENCY PAYOUTS ============================
ALTER TABLE IF EXISTS public.agency_payouts ADD COLUMN IF NOT EXISTS agency_id    UUID;
ALTER TABLE IF EXISTS public.agency_payouts ADD COLUMN IF NOT EXISTS host_id      UUID;
ALTER TABLE IF EXISTS public.agency_payouts ADD COLUMN IF NOT EXISTS beans_amount BIGINT;
ALTER TABLE IF EXISTS public.agency_payouts ADD COLUMN IF NOT EXISTS bdt_value    NUMERIC(12,2);
ALTER TABLE IF EXISTS public.agency_payouts ADD COLUMN IF NOT EXISTS status       TEXT DEFAULT 'pending';
ALTER TABLE IF EXISTS public.agency_payouts ADD COLUMN IF NOT EXISTS notes        TEXT;
ALTER TABLE IF EXISTS public.agency_payouts ADD COLUMN IF NOT EXISTS paid_at      TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.agency_payouts ADD COLUMN IF NOT EXISTS paid_by      UUID;
ALTER TABLE IF EXISTS public.agency_payouts ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ DEFAULT NOW();


-- ============================ RESELLERS ============================
ALTER TABLE IF EXISTS public.resellers ADD COLUMN IF NOT EXISTS name         TEXT;
ALTER TABLE IF EXISTS public.resellers ADD COLUMN IF NOT EXISTS avatar_url   TEXT;
ALTER TABLE IF EXISTS public.resellers ADD COLUMN IF NOT EXISTS contact_link TEXT;
ALTER TABLE IF EXISTS public.resellers ADD COLUMN IF NOT EXISTS type         TEXT DEFAULT 'agency';
ALTER TABLE IF EXISTS public.resellers ADD COLUMN IF NOT EXISTS status       TEXT DEFAULT 'active';
ALTER TABLE IF EXISTS public.resellers ADD COLUMN IF NOT EXISTS priority     INT DEFAULT 0;
ALTER TABLE IF EXISTS public.resellers ADD COLUMN IF NOT EXISTS notes        TEXT;
ALTER TABLE IF EXISTS public.resellers ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ DEFAULT NOW();


-- ============================ TOPUP REQUESTS ============================
ALTER TABLE IF EXISTS public.topup_requests ADD COLUMN IF NOT EXISTS user_id         UUID;
ALTER TABLE IF EXISTS public.topup_requests ADD COLUMN IF NOT EXISTS reseller_id     UUID;
ALTER TABLE IF EXISTS public.topup_requests ADD COLUMN IF NOT EXISTS package_amount  BIGINT;
ALTER TABLE IF EXISTS public.topup_requests ADD COLUMN IF NOT EXISTS bdt_value       NUMERIC(12,2);
ALTER TABLE IF EXISTS public.topup_requests ADD COLUMN IF NOT EXISTS status          TEXT DEFAULT 'pending';
ALTER TABLE IF EXISTS public.topup_requests ADD COLUMN IF NOT EXISTS notes           TEXT;
ALTER TABLE IF EXISTS public.topup_requests ADD COLUMN IF NOT EXISTS confirmed_by    UUID;
ALTER TABLE IF EXISTS public.topup_requests ADD COLUMN IF NOT EXISTS confirmed_at    TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.topup_requests ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ DEFAULT NOW();


-- ============================ TRANSACTIONS ============================
ALTER TABLE IF EXISTS public.transactions ADD COLUMN IF NOT EXISTS user_id             UUID;
ALTER TABLE IF EXISTS public.transactions ADD COLUMN IF NOT EXISTS related_user_id     UUID;
ALTER TABLE IF EXISTS public.transactions ADD COLUMN IF NOT EXISTS type                TEXT;
ALTER TABLE IF EXISTS public.transactions ADD COLUMN IF NOT EXISTS currency            TEXT;
ALTER TABLE IF EXISTS public.transactions ADD COLUMN IF NOT EXISTS amount              BIGINT;
ALTER TABLE IF EXISTS public.transactions ADD COLUMN IF NOT EXISTS balance_after       BIGINT;
ALTER TABLE IF EXISTS public.transactions ADD COLUMN IF NOT EXISTS related_entity_type TEXT;
ALTER TABLE IF EXISTS public.transactions ADD COLUMN IF NOT EXISTS related_entity_id   UUID;
ALTER TABLE IF EXISTS public.transactions ADD COLUMN IF NOT EXISTS status              TEXT DEFAULT 'completed';
ALTER TABLE IF EXISTS public.transactions ADD COLUMN IF NOT EXISTS notes               TEXT;
ALTER TABLE IF EXISTS public.transactions ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ DEFAULT NOW();


-- ============================ GIFTS LOG ============================
ALTER TABLE IF EXISTS public.gifts_log ADD COLUMN IF NOT EXISTS sender_id    UUID;
ALTER TABLE IF EXISTS public.gifts_log ADD COLUMN IF NOT EXISTS receiver_id  UUID;
ALTER TABLE IF EXISTS public.gifts_log ADD COLUMN IF NOT EXISTS room_id      UUID;
ALTER TABLE IF EXISTS public.gifts_log ADD COLUMN IF NOT EXISTS gift_id      TEXT;
ALTER TABLE IF EXISTS public.gifts_log ADD COLUMN IF NOT EXISTS gift_name    TEXT;
ALTER TABLE IF EXISTS public.gifts_log ADD COLUMN IF NOT EXISTS count        INT DEFAULT 1;
ALTER TABLE IF EXISTS public.gifts_log ADD COLUMN IF NOT EXISTS diamond_cost BIGINT;
ALTER TABLE IF EXISTS public.gifts_log ADD COLUMN IF NOT EXISTS bean_value   BIGINT;
ALTER TABLE IF EXISTS public.gifts_log ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ DEFAULT NOW();


-- ============================ LIVE STREAMS ============================
ALTER TABLE IF EXISTS public.live_streams ADD COLUMN IF NOT EXISTS broadcaster_id UUID;
ALTER TABLE IF EXISTS public.live_streams ADD COLUMN IF NOT EXISTS type           TEXT DEFAULT 'video';
ALTER TABLE IF EXISTS public.live_streams ADD COLUMN IF NOT EXISTS title          TEXT;
ALTER TABLE IF EXISTS public.live_streams ADD COLUMN IF NOT EXISTS tag            TEXT;
ALTER TABLE IF EXISTS public.live_streams ADD COLUMN IF NOT EXISTS cover_url      TEXT;
ALTER TABLE IF EXISTS public.live_streams ADD COLUMN IF NOT EXISTS status         TEXT DEFAULT 'live';
ALTER TABLE IF EXISTS public.live_streams ADD COLUMN IF NOT EXISTS peak_viewers   INT DEFAULT 0;
ALTER TABLE IF EXISTS public.live_streams ADD COLUMN IF NOT EXISTS total_gifts    INT DEFAULT 0;
ALTER TABLE IF EXISTS public.live_streams ADD COLUMN IF NOT EXISTS total_earnings BIGINT DEFAULT 0;
ALTER TABLE IF EXISTS public.live_streams ADD COLUMN IF NOT EXISTS started_at     TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE IF EXISTS public.live_streams ADD COLUMN IF NOT EXISTS ended_at       TIMESTAMPTZ;


-- ============================ GAME SETTINGS ============================
ALTER TABLE IF EXISTS public.game_settings ADD COLUMN IF NOT EXISTS win_chance_percent INT DEFAULT 30;
ALTER TABLE IF EXISTS public.game_settings ADD COLUMN IF NOT EXISTS is_active          BOOLEAN DEFAULT TRUE;
ALTER TABLE IF EXISTS public.game_settings ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ DEFAULT NOW();


-- ============================ GAME ROUNDS ============================
ALTER TABLE IF EXISTS public.game_rounds ADD COLUMN IF NOT EXISTS game_type  TEXT;
ALTER TABLE IF EXISTS public.game_rounds ADD COLUMN IF NOT EXISTS user_id    UUID;
ALTER TABLE IF EXISTS public.game_rounds ADD COLUMN IF NOT EXISTS bets       JSONB;
ALTER TABLE IF EXISTS public.game_rounds ADD COLUMN IF NOT EXISTS result     JSONB;
ALTER TABLE IF EXISTS public.game_rounds ADD COLUMN IF NOT EXISTS total_bet  BIGINT;
ALTER TABLE IF EXISTS public.game_rounds ADD COLUMN IF NOT EXISTS win_amount BIGINT DEFAULT 0;
ALTER TABLE IF EXISTS public.game_rounds ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();


-- ============================ MOMENTS POSTS ============================
ALTER TABLE IF EXISTS public.moments_posts ADD COLUMN IF NOT EXISTS user_id        UUID;
ALTER TABLE IF EXISTS public.moments_posts ADD COLUMN IF NOT EXISTS content        TEXT;
ALTER TABLE IF EXISTS public.moments_posts ADD COLUMN IF NOT EXISTS image_url      TEXT;
ALTER TABLE IF EXISTS public.moments_posts ADD COLUMN IF NOT EXISTS mood           TEXT;
ALTER TABLE IF EXISTS public.moments_posts ADD COLUMN IF NOT EXISTS likes_count    INT DEFAULT 0;
ALTER TABLE IF EXISTS public.moments_posts ADD COLUMN IF NOT EXISTS comments_count INT DEFAULT 0;
ALTER TABLE IF EXISTS public.moments_posts ADD COLUMN IF NOT EXISTS created_at     TIMESTAMPTZ DEFAULT NOW();


-- ============================ MOMENTS LIKES ============================
ALTER TABLE IF EXISTS public.moments_likes ADD COLUMN IF NOT EXISTS post_id    UUID;
ALTER TABLE IF EXISTS public.moments_likes ADD COLUMN IF NOT EXISTS user_id    UUID;
ALTER TABLE IF EXISTS public.moments_likes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();


-- ============================ MOMENTS COMMENTS ============================
ALTER TABLE IF EXISTS public.moments_comments ADD COLUMN IF NOT EXISTS post_id    UUID;
ALTER TABLE IF EXISTS public.moments_comments ADD COLUMN IF NOT EXISTS user_id    UUID;
ALTER TABLE IF EXISTS public.moments_comments ADD COLUMN IF NOT EXISTS content    TEXT;
ALTER TABLE IF EXISTS public.moments_comments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();


-- ============================ NOTIFICATIONS ============================
ALTER TABLE IF EXISTS public.notifications ADD COLUMN IF NOT EXISTS user_id    UUID;
ALTER TABLE IF EXISTS public.notifications ADD COLUMN IF NOT EXISTS type       TEXT;
ALTER TABLE IF EXISTS public.notifications ADD COLUMN IF NOT EXISTS title      TEXT;
ALTER TABLE IF EXISTS public.notifications ADD COLUMN IF NOT EXISTS body       TEXT;
ALTER TABLE IF EXISTS public.notifications ADD COLUMN IF NOT EXISTS payload    JSONB;
ALTER TABLE IF EXISTS public.notifications ADD COLUMN IF NOT EXISTS is_read    BOOLEAN DEFAULT FALSE;
ALTER TABLE IF EXISTS public.notifications ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();


-- ============================ FOLLOWS ============================
ALTER TABLE IF EXISTS public.follows ADD COLUMN IF NOT EXISTS follower_id  UUID;
ALTER TABLE IF EXISTS public.follows ADD COLUMN IF NOT EXISTS following_id UUID;
ALTER TABLE IF EXISTS public.follows ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ DEFAULT NOW();


-- ============================ CHAT MESSAGES ============================
ALTER TABLE IF EXISTS public.chat_messages ADD COLUMN IF NOT EXISTS conversation_id TEXT;
ALTER TABLE IF EXISTS public.chat_messages ADD COLUMN IF NOT EXISTS sender_id       UUID;
ALTER TABLE IF EXISTS public.chat_messages ADD COLUMN IF NOT EXISTS receiver_id     UUID;
ALTER TABLE IF EXISTS public.chat_messages ADD COLUMN IF NOT EXISTS content         TEXT;
ALTER TABLE IF EXISTS public.chat_messages ADD COLUMN IF NOT EXISTS type            TEXT DEFAULT 'text';
ALTER TABLE IF EXISTS public.chat_messages ADD COLUMN IF NOT EXISTS is_read         BOOLEAN DEFAULT FALSE;
ALTER TABLE IF EXISTS public.chat_messages ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ DEFAULT NOW();


-- ============================ USER REPORTS ============================
ALTER TABLE IF EXISTS public.user_reports ADD COLUMN IF NOT EXISTS reporter_id      UUID;
ALTER TABLE IF EXISTS public.user_reports ADD COLUMN IF NOT EXISTS reported_user_id UUID;
ALTER TABLE IF EXISTS public.user_reports ADD COLUMN IF NOT EXISTS room_id          UUID;
ALTER TABLE IF EXISTS public.user_reports ADD COLUMN IF NOT EXISTS reason           TEXT;
ALTER TABLE IF EXISTS public.user_reports ADD COLUMN IF NOT EXISTS evidence_url     TEXT;
ALTER TABLE IF EXISTS public.user_reports ADD COLUMN IF NOT EXISTS status           TEXT DEFAULT 'pending';
ALTER TABLE IF EXISTS public.user_reports ADD COLUMN IF NOT EXISTS reviewed_by      UUID;
ALTER TABLE IF EXISTS public.user_reports ADD COLUMN IF NOT EXISTS reviewed_at      TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.user_reports ADD COLUMN IF NOT EXISTS created_at       TIMESTAMPTZ DEFAULT NOW();


-- ============================ ADMIN AUDIT LOG ============================
ALTER TABLE IF EXISTS public.admin_audit_log ADD COLUMN IF NOT EXISTS admin_id    UUID;
ALTER TABLE IF EXISTS public.admin_audit_log ADD COLUMN IF NOT EXISTS action      TEXT;
ALTER TABLE IF EXISTS public.admin_audit_log ADD COLUMN IF NOT EXISTS target_type TEXT;
ALTER TABLE IF EXISTS public.admin_audit_log ADD COLUMN IF NOT EXISTS target_id   UUID;
ALTER TABLE IF EXISTS public.admin_audit_log ADD COLUMN IF NOT EXISTS payload     JSONB;
ALTER TABLE IF EXISTS public.admin_audit_log ADD COLUMN IF NOT EXISTS ip_address  TEXT;
ALTER TABLE IF EXISTS public.admin_audit_log ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ DEFAULT NOW();


-- ============================ LIVE STREAM TOKENS ============================
ALTER TABLE IF EXISTS public.live_stream_tokens ADD COLUMN IF NOT EXISTS user_id    UUID;
ALTER TABLE IF EXISTS public.live_stream_tokens ADD COLUMN IF NOT EXISTS room_id    TEXT;
ALTER TABLE IF EXISTS public.live_stream_tokens ADD COLUMN IF NOT EXISTS role       TEXT;
ALTER TABLE IF EXISTS public.live_stream_tokens ADD COLUMN IF NOT EXISTS token      TEXT;
ALTER TABLE IF EXISTS public.live_stream_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.live_stream_tokens ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();


-- =====================================================================
-- DONE. Now re-run yolo_schema.sql in the SQL Editor.
-- =====================================================================