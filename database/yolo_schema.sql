-- =====================================================================
-- YOLO-LIVE COMPLETE SUPABASE SCHEMA
-- Run this file in Supabase → SQL Editor → New Query → Paste → Run
-- Idempotent: safe to run multiple times (uses IF NOT EXISTS / OR REPLACE)
-- =====================================================================

-- =====================================================================
-- SECTION 1: EXTENSIONS
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- =====================================================================
-- SECTION 2: TABLES
-- =====================================================================

-- 2.1 PROFILES (extends auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_id      BIGINT UNIQUE,                    -- auto-generated short ID for app display
  full_name       TEXT,
  avatar_url      TEXT,
  phone_number    TEXT UNIQUE,
  country_code    TEXT DEFAULT '+880',
  bio             TEXT DEFAULT '',
  gender          TEXT DEFAULT 'female' CHECK (gender IN ('male', 'female', 'other')),
  dob             DATE,
  role            TEXT DEFAULT 'user' CHECK (role IN ('user', 'host', 'agency_owner', 'admin', 'super_admin')),
  level           INT DEFAULT 1,
  diamonds        BIGINT DEFAULT 0 CHECK (diamonds >= 0),
  beans           BIGINT DEFAULT 0 CHECK (beans >= 0),
  vip_type        TEXT CHECK (vip_type IN ('VIP', 'VVIP', 'SVIP')),
  vip_expires_at  TIMESTAMPTZ,
  is_verified     BOOLEAN DEFAULT FALSE,            -- blue tick
  is_banned       BOOLEAN DEFAULT FALSE,
  banned_reason   TEXT,
  banned_until    TIMESTAMPTZ,
  status          TEXT DEFAULT 'Active' CHECK (status IN ('Active', 'Banned', 'Suspended')),
  agency_id       UUID,                              -- FK added below after agencies table
  last_seen_at    TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_profiles_display_id ON public.profiles(display_id);
CREATE INDEX IF NOT EXISTS idx_profiles_role       ON public.profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_is_banned  ON public.profiles(is_banned);

-- 2.2 AGENCIES
CREATE TABLE IF NOT EXISTS public.agencies (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT NOT NULL,
  code                   TEXT UNIQUE NOT NULL,
  owner_id               UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  payout_rate            INT DEFAULT 1150,         -- BDT per 100k beans
  host_conversion_rate   NUMERIC(5,2) DEFAULT 0.50,
  accumulated_beans      BIGINT DEFAULT 0,
  diamond_balance        BIGINT DEFAULT 0,
  member_count           INT DEFAULT 0,
  status                 TEXT DEFAULT 'pending' CHECK (status IN ('verified', 'pending', 'suspended')),
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- Add FK from profiles -> agencies now that agencies exists
DO $$ BEGIN
  ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_agency_id_fkey
    FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2.3 AGENCY MEMBERS (binding history)
CREATE TABLE IF NOT EXISTS public.agency_members (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id    UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  host_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status       TEXT DEFAULT 'pending' CHECK (status IN ('active', 'pending', 'released')),
  joined_at    TIMESTAMPTZ DEFAULT NOW(),
  released_at  TIMESTAMPTZ,
  UNIQUE(agency_id, host_id)
);
CREATE INDEX IF NOT EXISTS idx_agency_members_host ON public.agency_members(host_id, status);

-- 2.4 AGENCY PAYOUTS (host requesting payout from agency owner)
CREATE TABLE IF NOT EXISTS public.agency_payouts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  host_id       UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  beans_amount  BIGINT NOT NULL CHECK (beans_amount > 0),
  bdt_value     NUMERIC(12,2) NOT NULL,
  status        TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'rejected')),
  notes         TEXT,
  paid_at       TIMESTAMPTZ,
  paid_by       UUID REFERENCES public.profiles(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agency_payouts_status ON public.agency_payouts(status, created_at DESC);

-- 2.5 RESELLERS (certified top-up agents)
CREATE TABLE IF NOT EXISTS public.resellers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  avatar_url    TEXT,
  contact_link  TEXT NOT NULL,             -- e.g. https://wa.me/8801XXXXXXXXX
  type          TEXT DEFAULT 'agency' CHECK (type IN ('official', 'agency')),
  status        TEXT DEFAULT 'active' CHECK (status IN ('active', 'busy', 'inactive')),
  priority      INT DEFAULT 0,             -- higher first
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 2.6 TOPUP REQUESTS (user -> reseller; admin/reseller confirms manually)
CREATE TABLE IF NOT EXISTS public.topup_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reseller_id     UUID NOT NULL REFERENCES public.resellers(id) ON DELETE RESTRICT,
  package_amount  BIGINT NOT NULL CHECK (package_amount > 0),  -- diamonds requested
  bdt_value       NUMERIC(12,2) NOT NULL,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'contacted', 'confirmed', 'cancelled')),
  notes           TEXT,
  confirmed_by    UUID REFERENCES public.profiles(id),
  confirmed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_topup_user_status ON public.topup_requests(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_topup_status      ON public.topup_requests(status, created_at DESC);

-- 2.7 TRANSACTIONS (universal money ledger)
CREATE TABLE IF NOT EXISTS public.transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  related_user_id     UUID REFERENCES public.profiles(id),
  type                TEXT NOT NULL,           -- topup, gift_sent, gift_received, game_bet, game_win, bean_convert, agency_payout, agency_transfer
  currency            TEXT NOT NULL CHECK (currency IN ('diamond', 'bean', 'bdt')),
  amount              BIGINT NOT NULL,         -- positive for credit, negative for debit
  balance_after       BIGINT,
  related_entity_type TEXT,                    -- gift, game_round, topup_request, agency_payout, etc.
  related_entity_id   UUID,
  status              TEXT DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_transactions_user      ON public.transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type      ON public.transactions(type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_status    ON public.transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_related   ON public.transactions(related_entity_type, related_entity_id);

-- 2.8 GIFTS LOG
CREATE TABLE IF NOT EXISTS public.gifts_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id       UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  receiver_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  room_id         UUID,
  gift_id         TEXT NOT NULL,                -- e.g. '1', '1b', '2' (matches client GIFT_ITEMS)
  gift_name       TEXT,
  count           INT DEFAULT 1,
  diamond_cost    BIGINT NOT NULL,
  bean_value      BIGINT NOT NULL,              -- typically 50% of diamond_cost
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gifts_sender   ON public.gifts_log(sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gifts_receiver ON public.gifts_log(receiver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gifts_room     ON public.gifts_log(room_id, created_at DESC);

-- 2.9 LIVE STREAMS
CREATE TABLE IF NOT EXISTS public.live_streams (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcaster_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type              TEXT DEFAULT 'video' CHECK (type IN ('video', 'audio')),
  title             TEXT,
  tag               TEXT,
  cover_url         TEXT,
  status            TEXT DEFAULT 'live' CHECK (status IN ('live', 'ended', 'banned')),
  peak_viewers      INT DEFAULT 0,
  total_gifts       INT DEFAULT 0,
  total_earnings    BIGINT DEFAULT 0,       -- in diamonds
  started_at        TIMESTAMPTZ DEFAULT NOW(),
  ended_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_live_streams_status      ON public.live_streams(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_streams_broadcaster ON public.live_streams(broadcaster_id, started_at DESC);

-- 2.10 GAME SETTINGS (already exists; ensure shape)
CREATE TABLE IF NOT EXISTS public.game_settings (
  id                   TEXT PRIMARY KEY,        -- 'teen_patti', 'fruit_roulette'
  win_chance_percent   INT DEFAULT 30 CHECK (win_chance_percent BETWEEN 0 AND 100),
  is_active            BOOLEAN DEFAULT TRUE,
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- 2.11 GAME ROUNDS (every play recorded)
CREATE TABLE IF NOT EXISTS public.game_rounds (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_type    TEXT NOT NULL,                  -- teen_patti, fruit_roulette
  user_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  bets         JSONB NOT NULL,                 -- {A:100,B:200,...} or {apple:100,...}
  result       JSONB,                          -- {winner_pos:'A'} or {winning_slot_id:3}
  total_bet    BIGINT NOT NULL,
  win_amount   BIGINT DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_game_rounds_user ON public.game_rounds(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_rounds_game ON public.game_rounds(game_type, created_at DESC);

-- 2.12 MOMENTS POSTS
CREATE TABLE IF NOT EXISTS public.moments_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content         TEXT,
  image_url       TEXT,
  mood            TEXT,
  likes_count     INT DEFAULT 0,
  comments_count  INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_moments_user    ON public.moments_posts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_moments_created ON public.moments_posts(created_at DESC);

-- 2.13 MOMENTS LIKES
CREATE TABLE IF NOT EXISTS public.moments_likes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     UUID NOT NULL REFERENCES public.moments_posts(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id, user_id)
);

-- 2.14 MOMENTS COMMENTS
CREATE TABLE IF NOT EXISTS public.moments_comments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     UUID NOT NULL REFERENCES public.moments_posts(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 2.15 NOTIFICATIONS
CREATE TABLE IF NOT EXISTS public.notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT,
  body        TEXT,
  payload     JSONB,
  is_read     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON public.notifications(user_id, is_read, created_at DESC);

-- 2.16 FOLLOWS
CREATE TABLE IF NOT EXISTS public.follows (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  following_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(follower_id, following_id),
  CHECK (follower_id <> following_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_follower  ON public.follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON public.follows(following_id);

-- 2.17 CHAT MESSAGES (DM)
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL,         -- sorted "minId__maxId" string
  sender_id       UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  receiver_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content         TEXT,
  type            TEXT DEFAULT 'text' CHECK (type IN ('text', 'image', 'gift')),
  is_read         BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_conv  ON public.chat_messages(conversation_id, created_at DESC);

-- 2.18 USER REPORTS
CREATE TABLE IF NOT EXISTS public.user_reports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id       UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reported_user_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  room_id           UUID,
  reason            TEXT NOT NULL,
  evidence_url      TEXT,
  status            TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'action_taken', 'dismissed')),
  reviewed_by       UUID REFERENCES public.profiles(id),
  reviewed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON public.user_reports(status, created_at DESC);

-- 2.19 ADMIN AUDIT LOG
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id     UUID NOT NULL REFERENCES public.profiles(id),
  action       TEXT NOT NULL,         -- ban_user, edit_profile, confirm_topup, etc.
  target_type  TEXT,                  -- profile, topup_request, etc.
  target_id    UUID,
  payload      JSONB,
  ip_address   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_admin   ON public.admin_audit_log(admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target  ON public.admin_audit_log(target_type, target_id);

-- 2.20 LIVE STREAM TOKENS (for ZegoCloud / Agora — server issues short-lived tokens)
CREATE TABLE IF NOT EXISTS public.live_stream_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  room_id       TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('host', 'audience', 'co_host')),
  token         TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);


-- =====================================================================
-- SECTION 3: TRIGGERS & AUTO-CREATE
-- =====================================================================

-- 3.1 Auto-create profile row when auth.users row is created
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_display_id BIGINT;
BEGIN
  -- Generate a 9-digit display_id (like Bigo / Streamkar)
  LOOP
    new_display_id := 100000000 + floor(random() * 899999999)::BIGINT;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.profiles WHERE display_id = new_display_id);
  END LOOP;

  INSERT INTO public.profiles (id, display_id, full_name, phone_number, avatar_url)
  VALUES (
    NEW.id,
    new_display_id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', 'New User'),
    NEW.raw_user_meta_data->>'phone',
    'https://api.dicebear.com/7.x/avataaars/svg?seed=' || NEW.id::TEXT
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 3.2 updated_at maintenance
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_profiles_updated ON public.profiles;
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_agencies_updated ON public.agencies;
CREATE TRIGGER trg_agencies_updated BEFORE UPDATE ON public.agencies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3.3 Moments counters
CREATE OR REPLACE FUNCTION public.bump_moments_likes()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.moments_posts SET likes_count = likes_count + 1 WHERE id = NEW.post_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.moments_posts SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = OLD.post_id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_moments_likes ON public.moments_likes;
CREATE TRIGGER trg_moments_likes AFTER INSERT OR DELETE ON public.moments_likes
  FOR EACH ROW EXECUTE FUNCTION public.bump_moments_likes();

CREATE OR REPLACE FUNCTION public.bump_moments_comments()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.moments_posts SET comments_count = comments_count + 1 WHERE id = NEW.post_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.moments_posts SET comments_count = GREATEST(comments_count - 1, 0) WHERE id = OLD.post_id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_moments_comments ON public.moments_comments;
CREATE TRIGGER trg_moments_comments AFTER INSERT OR DELETE ON public.moments_comments
  FOR EACH ROW EXECUTE FUNCTION public.bump_moments_comments();


-- =====================================================================
-- SECTION 4: RPC FUNCTIONS (called from app)
-- =====================================================================

-- 4.1 SEND GIFT (secure server-side transfer)
CREATE OR REPLACE FUNCTION public.send_gift(
  p_sender_id     UUID,
  p_recipient_id  UUID,
  p_gift_id       TEXT,
  p_diamond_cost  BIGINT,
  p_room_id       UUID DEFAULT NULL,
  p_gift_name     TEXT DEFAULT NULL,
  p_count         INT  DEFAULT 1
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sender_balance BIGINT;
  v_bean_value     BIGINT;
BEGIN
  IF p_sender_id = p_recipient_id THEN
    RETURN json_build_object('success', false, 'message', 'Cannot gift yourself');
  END IF;
  IF p_diamond_cost <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'Invalid cost');
  END IF;

  -- Lock & verify
  SELECT diamonds INTO v_sender_balance FROM public.profiles WHERE id = p_sender_id FOR UPDATE;
  IF v_sender_balance IS NULL OR v_sender_balance < p_diamond_cost THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient diamonds');
  END IF;

  v_bean_value := FLOOR(p_diamond_cost * 0.50);  -- host gets 50% as beans

  -- Debit sender
  UPDATE public.profiles SET diamonds = diamonds - p_diamond_cost WHERE id = p_sender_id;
  -- Credit receiver
  UPDATE public.profiles SET beans = beans + v_bean_value WHERE id = p_recipient_id;

  -- Logs
  INSERT INTO public.gifts_log (sender_id, receiver_id, room_id, gift_id, gift_name, count, diamond_cost, bean_value)
  VALUES (p_sender_id, p_recipient_id, p_room_id, p_gift_id, p_gift_name, p_count, p_diamond_cost, v_bean_value);

  INSERT INTO public.transactions (user_id, related_user_id, type, currency, amount, related_entity_type, status)
  VALUES (p_sender_id, p_recipient_id, 'gift_sent', 'diamond', -p_diamond_cost, 'gift', 'completed');

  INSERT INTO public.transactions (user_id, related_user_id, type, currency, amount, related_entity_type, status)
  VALUES (p_recipient_id, p_sender_id, 'gift_received', 'bean', v_bean_value, 'gift', 'completed');

  -- Update live_stream tally if in a room
  IF p_room_id IS NOT NULL THEN
    UPDATE public.live_streams
       SET total_gifts = total_gifts + p_count,
           total_earnings = total_earnings + p_diamond_cost
     WHERE id = p_room_id;
  END IF;

  RETURN json_build_object('success', true, 'bean_value', v_bean_value);
END;
$$;

-- 4.2 CONVERT BEANS TO DIAMONDS
CREATE OR REPLACE FUNCTION public.convert_beans_to_diamonds(
  p_user_id     UUID,
  p_bean_amount BIGINT,
  p_rate        NUMERIC DEFAULT 0.50
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bean_balance BIGINT;
  v_diamond_gain BIGINT;
BEGIN
  IF p_bean_amount <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'Invalid amount');
  END IF;

  SELECT beans INTO v_bean_balance FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF v_bean_balance IS NULL OR v_bean_balance < p_bean_amount THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient beans');
  END IF;

  v_diamond_gain := FLOOR(p_bean_amount * p_rate);

  UPDATE public.profiles
     SET beans = beans - p_bean_amount,
         diamonds = diamonds + v_diamond_gain
   WHERE id = p_user_id;

  INSERT INTO public.transactions (user_id, type, currency, amount, status) VALUES
    (p_user_id, 'bean_convert',  'bean',    -p_bean_amount, 'completed'),
    (p_user_id, 'bean_convert',  'diamond',  v_diamond_gain, 'completed');

  RETURN json_build_object('success', true, 'diamond_gain', v_diamond_gain);
END;
$$;

-- 4.3 PLAY TEEN PATTI (server decides outcome)
CREATE OR REPLACE FUNCTION public.play_teen_patti(
  p_user_id UUID,
  p_bet_a   BIGINT,
  p_bet_b   BIGINT,
  p_bet_c   BIGINT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance     BIGINT;
  v_total_bet   BIGINT;
  v_win_chance  INT;
  v_is_active   BOOLEAN;
  v_user_wins   BOOLEAN;
  v_winner_pos  TEXT;
  v_win_amount  BIGINT := 0;
  v_round_id    UUID;
BEGIN
  v_total_bet := COALESCE(p_bet_a,0) + COALESCE(p_bet_b,0) + COALESCE(p_bet_c,0);
  IF v_total_bet <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'No bet placed');
  END IF;

  SELECT win_chance_percent, is_active INTO v_win_chance, v_is_active
    FROM public.game_settings WHERE id = 'teen_patti';
  IF v_is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Game disabled');
  END IF;

  SELECT diamonds INTO v_balance FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF v_balance IS NULL OR v_balance < v_total_bet THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient diamonds');
  END IF;

  -- Deduct total bet first
  UPDATE public.profiles SET diamonds = diamonds - v_total_bet WHERE id = p_user_id;

  -- Decide if user wins (admin-tunable RTP)
  v_user_wins := (random() * 100) < v_win_chance;

  IF v_user_wins THEN
    -- Pick a position user actually bet on
    IF p_bet_a >= p_bet_b AND p_bet_a >= p_bet_c AND p_bet_a > 0 THEN
      v_winner_pos := 'A'; v_win_amount := p_bet_a * 2;
    ELSIF p_bet_b >= p_bet_c AND p_bet_b > 0 THEN
      v_winner_pos := 'B'; v_win_amount := p_bet_b * 2;
    ELSE
      v_winner_pos := 'C'; v_win_amount := p_bet_c * 2;
    END IF;
    UPDATE public.profiles SET diamonds = diamonds + v_win_amount WHERE id = p_user_id;
  ELSE
    -- Pick a losing position: a position user did NOT bet on (or smallest bet)
    IF p_bet_a = 0 THEN v_winner_pos := 'A';
    ELSIF p_bet_b = 0 THEN v_winner_pos := 'B';
    ELSIF p_bet_c = 0 THEN v_winner_pos := 'C';
    ELSE
      v_winner_pos := (ARRAY['A','B','C'])[1 + floor(random()*3)::INT];
    END IF;
  END IF;

  INSERT INTO public.game_rounds (game_type, user_id, bets, result, total_bet, win_amount)
  VALUES ('teen_patti', p_user_id,
          jsonb_build_object('A',p_bet_a,'B',p_bet_b,'C',p_bet_c),
          jsonb_build_object('winner_pos', v_winner_pos, 'user_won', v_user_wins),
          v_total_bet, v_win_amount)
  RETURNING id INTO v_round_id;

  INSERT INTO public.transactions (user_id, type, currency, amount, related_entity_type, related_entity_id, status)
  VALUES (p_user_id, 'game_bet', 'diamond', -v_total_bet, 'game_round', v_round_id, 'completed');
  IF v_win_amount > 0 THEN
    INSERT INTO public.transactions (user_id, type, currency, amount, related_entity_type, related_entity_id, status)
    VALUES (p_user_id, 'game_win', 'diamond', v_win_amount, 'game_round', v_round_id, 'completed');
  END IF;

  RETURN json_build_object('success', true, 'winner_pos', v_winner_pos, 'win_amount', v_win_amount);
END;
$$;

-- 4.4 PLAY FRUIT ROULETTE
CREATE OR REPLACE FUNCTION public.play_fruit_roulette(
  p_user_id        UUID,
  p_apple_bet      BIGINT,
  p_watermelon_bet BIGINT,
  p_star_bet       BIGINT,
  p_crown_bet      BIGINT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance       BIGINT;
  v_total_bet     BIGINT;
  v_win_chance    INT;
  v_is_active     BOOLEAN;
  v_user_wins     BOOLEAN;
  v_winning_slot  INT;
  v_winning_type  TEXT;
  v_multiplier    INT;
  v_user_bet      BIGINT;
  v_win_amount    BIGINT := 0;
  v_round_id      UUID;
  v_slots         JSONB := '[
    {"id":0,"type":"apple","m":5},
    {"id":1,"type":"watermelon","m":10},
    {"id":2,"type":"apple","m":5},
    {"id":3,"type":"star","m":15},
    {"id":4,"type":"apple","m":5},
    {"id":5,"type":"crown","m":25},
    {"id":6,"type":"watermelon","m":10},
    {"id":7,"type":"apple","m":5}
  ]'::JSONB;
  v_slot          JSONB;
BEGIN
  v_total_bet := COALESCE(p_apple_bet,0) + COALESCE(p_watermelon_bet,0) + COALESCE(p_star_bet,0) + COALESCE(p_crown_bet,0);
  IF v_total_bet <= 0 THEN
    RETURN json_build_object('success', false, 'message', 'No bet placed');
  END IF;

  SELECT win_chance_percent, is_active INTO v_win_chance, v_is_active
    FROM public.game_settings WHERE id = 'fruit_roulette';
  IF v_is_active IS DISTINCT FROM TRUE THEN
    RETURN json_build_object('success', false, 'message', 'Game disabled');
  END IF;

  SELECT diamonds INTO v_balance FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF v_balance IS NULL OR v_balance < v_total_bet THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient diamonds');
  END IF;

  UPDATE public.profiles SET diamonds = diamonds - v_total_bet WHERE id = p_user_id;

  v_user_wins := (random() * 100) < v_win_chance;

  IF v_user_wins THEN
    DECLARE
      v_candidates JSONB := '[]'::JSONB;
      v_i INT;
    BEGIN
      FOR v_i IN 0..7 LOOP
        v_slot := v_slots->v_i;
        v_user_bet := CASE v_slot->>'type'
          WHEN 'apple' THEN p_apple_bet
          WHEN 'watermelon' THEN p_watermelon_bet
          WHEN 'star' THEN p_star_bet
          WHEN 'crown' THEN p_crown_bet
        END;
        IF v_user_bet > 0 THEN
          v_candidates := v_candidates || v_slot;
        END IF;
      END LOOP;
      IF jsonb_array_length(v_candidates) > 0 THEN
        v_slot := v_candidates->(floor(random()*jsonb_array_length(v_candidates))::INT);
      ELSE
        v_slot := v_slots->0;
      END IF;
    END;
  ELSE
    DECLARE
      v_losers JSONB := '[]'::JSONB;
      v_i INT;
    BEGIN
      FOR v_i IN 0..7 LOOP
        v_slot := v_slots->v_i;
        v_user_bet := CASE v_slot->>'type'
          WHEN 'apple' THEN p_apple_bet
          WHEN 'watermelon' THEN p_watermelon_bet
          WHEN 'star' THEN p_star_bet
          WHEN 'crown' THEN p_crown_bet
        END;
        IF v_user_bet = 0 THEN
          v_losers := v_losers || v_slot;
        END IF;
      END LOOP;
      IF jsonb_array_length(v_losers) > 0 THEN
        v_slot := v_losers->(floor(random()*jsonb_array_length(v_losers))::INT);
      ELSE
        v_slot := v_slots->(floor(random()*8)::INT);
      END IF;
    END;
  END IF;

  v_winning_slot := (v_slot->>'id')::INT;
  v_winning_type := v_slot->>'type';
  v_multiplier   := (v_slot->>'m')::INT;

  v_user_bet := CASE v_winning_type
    WHEN 'apple' THEN p_apple_bet
    WHEN 'watermelon' THEN p_watermelon_bet
    WHEN 'star' THEN p_star_bet
    WHEN 'crown' THEN p_crown_bet
  END;

  IF v_user_wins AND v_user_bet > 0 THEN
    v_win_amount := v_user_bet * v_multiplier;
    UPDATE public.profiles SET diamonds = diamonds + v_win_amount WHERE id = p_user_id;
  END IF;

  INSERT INTO public.game_rounds (game_type, user_id, bets, result, total_bet, win_amount)
  VALUES ('fruit_roulette', p_user_id,
          jsonb_build_object('apple',p_apple_bet,'watermelon',p_watermelon_bet,'star',p_star_bet,'crown',p_crown_bet),
          jsonb_build_object('winning_slot_id', v_winning_slot, 'winning_type', v_winning_type, 'user_won', v_user_wins),
          v_total_bet, v_win_amount)
  RETURNING id INTO v_round_id;

  INSERT INTO public.transactions (user_id, type, currency, amount, related_entity_type, related_entity_id, status)
  VALUES (p_user_id, 'game_bet', 'diamond', -v_total_bet, 'game_round', v_round_id, 'completed');
  IF v_win_amount > 0 THEN
    INSERT INTO public.transactions (user_id, type, currency, amount, related_entity_type, related_entity_id, status)
    VALUES (p_user_id, 'game_win', 'diamond', v_win_amount, 'game_round', v_round_id, 'completed');
  END IF;

  RETURN json_build_object('success', true, 'winning_slot_id', v_winning_slot, 'winning_type', v_winning_type, 'win_amount', v_win_amount);
END;
$$;

-- 4.5 CREATE TOPUP REQUEST
CREATE OR REPLACE FUNCTION public.create_topup_request(
  p_user_id        UUID,
  p_reseller_id    UUID,
  p_package_amount BIGINT,
  p_bdt_value      NUMERIC
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO public.topup_requests (user_id, reseller_id, package_amount, bdt_value)
  VALUES (p_user_id, p_reseller_id, p_package_amount, p_bdt_value)
  RETURNING id INTO v_id;
  RETURN json_build_object('success', true, 'request_id', v_id);
END $$;

-- 4.6 CONFIRM TOPUP (admin/reseller confirms manual payment, credits diamonds)
CREATE OR REPLACE FUNCTION public.confirm_topup_request(
  p_request_id UUID,
  p_admin_id   UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request public.topup_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_request FROM public.topup_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'Request not found');
  END IF;
  IF v_request.status = 'confirmed' THEN
    RETURN json_build_object('success', false, 'message', 'Already confirmed');
  END IF;

  UPDATE public.profiles SET diamonds = diamonds + v_request.package_amount WHERE id = v_request.user_id;

  UPDATE public.topup_requests
     SET status = 'confirmed', confirmed_by = p_admin_id, confirmed_at = NOW()
   WHERE id = p_request_id;

  INSERT INTO public.transactions (user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
  VALUES (v_request.user_id, 'topup', 'diamond', v_request.package_amount, 'topup_request', p_request_id, 'completed',
          'Confirmed by admin');

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (p_admin_id, 'confirm_topup', 'topup_request', p_request_id,
          jsonb_build_object('user_id', v_request.user_id, 'amount', v_request.package_amount));

  RETURN json_build_object('success', true);
END $$;

-- 4.7 BIND HOST TO AGENCY
CREATE OR REPLACE FUNCTION public.bind_to_agency(
  p_host_id    UUID,
  p_agency_code TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_agency public.agencies%ROWTYPE;
BEGIN
  SELECT * INTO v_agency FROM public.agencies WHERE code = p_agency_code AND status = 'verified';
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'Invalid or unverified agency code');
  END IF;

  UPDATE public.agency_members SET status = 'released', released_at = NOW()
    WHERE host_id = p_host_id AND status = 'active';

  INSERT INTO public.agency_members (agency_id, host_id, status) VALUES (v_agency.id, p_host_id, 'pending')
  ON CONFLICT (agency_id, host_id) DO UPDATE SET status = 'pending', released_at = NULL;

  RETURN json_build_object('success', true, 'agency_id', v_agency.id, 'agency_name', v_agency.name);
END $$;

-- 4.8 AGENCY APPROVE MEMBER
CREATE OR REPLACE FUNCTION public.approve_agency_member(
  p_agency_id UUID,
  p_host_id   UUID,
  p_owner_id  UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.agencies WHERE id = p_agency_id AND owner_id = p_owner_id) THEN
    RETURN json_build_object('success', false, 'message', 'Not the agency owner');
  END IF;

  UPDATE public.agency_members SET status = 'active' WHERE agency_id = p_agency_id AND host_id = p_host_id;
  UPDATE public.profiles SET agency_id = p_agency_id WHERE id = p_host_id;
  UPDATE public.agencies SET member_count = (
    SELECT COUNT(*) FROM public.agency_members WHERE agency_id = p_agency_id AND status = 'active'
  ) WHERE id = p_agency_id;

  RETURN json_build_object('success', true);
END $$;

-- 4.9 REQUEST PAYOUT (host -> agency)
CREATE OR REPLACE FUNCTION public.request_payout(
  p_host_id      UUID,
  p_beans_amount BIGINT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agency_id UUID;
  v_rate INT;
  v_balance BIGINT;
  v_bdt NUMERIC;
  v_id UUID;
BEGIN
  SELECT agency_id INTO v_agency_id FROM public.profiles WHERE id = p_host_id;
  IF v_agency_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not in any agency');
  END IF;

  SELECT payout_rate INTO v_rate FROM public.agencies WHERE id = v_agency_id;
  SELECT beans INTO v_balance FROM public.profiles WHERE id = p_host_id FOR UPDATE;
  IF v_balance < p_beans_amount THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient beans');
  END IF;

  v_bdt := (p_beans_amount::NUMERIC / 100000) * v_rate;

  UPDATE public.profiles SET beans = beans - p_beans_amount WHERE id = p_host_id;
  UPDATE public.agencies SET accumulated_beans = accumulated_beans + p_beans_amount WHERE id = v_agency_id;

  INSERT INTO public.agency_payouts (agency_id, host_id, beans_amount, bdt_value)
  VALUES (v_agency_id, p_host_id, p_beans_amount, v_bdt)
  RETURNING id INTO v_id;

  INSERT INTO public.transactions (user_id, type, currency, amount, related_entity_type, related_entity_id, status, notes)
  VALUES (p_host_id, 'agency_payout', 'bean', -p_beans_amount, 'agency_payout', v_id, 'pending',
          'Payout requested from agency');

  RETURN json_build_object('success', true, 'payout_id', v_id, 'bdt_value', v_bdt);
END $$;

-- 4.10 MARK PAYOUT AS PAID
CREATE OR REPLACE FUNCTION public.mark_payout_paid(
  p_payout_id UUID,
  p_actor_id  UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_payout public.agency_payouts%ROWTYPE;
BEGIN
  SELECT * INTO v_payout FROM public.agency_payouts WHERE id = p_payout_id FOR UPDATE;
  IF NOT FOUND OR v_payout.status = 'paid' THEN
    RETURN json_build_object('success', false, 'message', 'Invalid payout');
  END IF;

  UPDATE public.agency_payouts SET status = 'paid', paid_at = NOW(), paid_by = p_actor_id WHERE id = p_payout_id;
  UPDATE public.transactions SET status = 'completed'
    WHERE related_entity_type = 'agency_payout' AND related_entity_id = p_payout_id;

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (p_actor_id, 'mark_payout_paid', 'agency_payout', p_payout_id,
          jsonb_build_object('bdt', v_payout.bdt_value));
  RETURN json_build_object('success', true);
END $$;

-- 4.11 AGENCY -> HOST DIAMOND TRANSFER
CREATE OR REPLACE FUNCTION public.agency_transfer_to_host(
  p_agency_id      UUID,
  p_owner_id       UUID,
  p_host_id        UUID,
  p_diamond_amount BIGINT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_agency public.agencies%ROWTYPE;
BEGIN
  SELECT * INTO v_agency FROM public.agencies WHERE id = p_agency_id AND owner_id = p_owner_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'Not your agency');
  END IF;
  IF v_agency.diamond_balance < p_diamond_amount THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient agency diamonds');
  END IF;

  UPDATE public.agencies SET diamond_balance = diamond_balance - p_diamond_amount WHERE id = p_agency_id;
  UPDATE public.profiles SET diamonds = diamonds + p_diamond_amount WHERE id = p_host_id;

  INSERT INTO public.transactions (user_id, related_user_id, type, currency, amount, related_entity_type, related_entity_id, status)
  VALUES (p_host_id, p_owner_id, 'agency_transfer', 'diamond', p_diamond_amount, 'agency', p_agency_id, 'completed');

  RETURN json_build_object('success', true);
END $$;

-- 4.12 AGENCY CONVERT BEANS -> DIAMONDS
CREATE OR REPLACE FUNCTION public.agency_convert_beans(
  p_agency_id   UUID,
  p_owner_id    UUID,
  p_bean_amount BIGINT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agency public.agencies%ROWTYPE;
  v_diamond_gain BIGINT;
BEGIN
  SELECT * INTO v_agency FROM public.agencies WHERE id = p_agency_id AND owner_id = p_owner_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'Not your agency');
  END IF;
  IF v_agency.accumulated_beans < p_bean_amount THEN
    RETURN json_build_object('success', false, 'message', 'Insufficient beans');
  END IF;

  v_diamond_gain := FLOOR(p_bean_amount * v_agency.host_conversion_rate);

  UPDATE public.agencies
    SET accumulated_beans = accumulated_beans - p_bean_amount,
        diamond_balance   = diamond_balance + v_diamond_gain
    WHERE id = p_agency_id;

  RETURN json_build_object('success', true, 'diamond_gain', v_diamond_gain);
END $$;

-- 4.13 START LIVE STREAM
CREATE OR REPLACE FUNCTION public.start_live_stream(
  p_broadcaster_id UUID,
  p_type           TEXT,
  p_title          TEXT,
  p_tag            TEXT,
  p_cover_url      TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id UUID;
BEGIN
  UPDATE public.live_streams SET status = 'ended', ended_at = NOW()
    WHERE broadcaster_id = p_broadcaster_id AND status = 'live';

  INSERT INTO public.live_streams (broadcaster_id, type, title, tag, cover_url)
  VALUES (p_broadcaster_id, COALESCE(p_type,'video'), p_title, p_tag, p_cover_url)
  RETURNING id INTO v_id;

  RETURN json_build_object('success', true, 'stream_id', v_id);
END $$;

-- 4.14 END LIVE STREAM
CREATE OR REPLACE FUNCTION public.end_live_stream(
  p_stream_id    UUID,
  p_peak_viewers INT DEFAULT 0
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.live_streams
     SET status = 'ended', ended_at = NOW(), peak_viewers = GREATEST(peak_viewers, COALESCE(p_peak_viewers,0))
   WHERE id = p_stream_id;
  RETURN json_build_object('success', true);
END $$;

-- 4.15 BAN / UNBAN
CREATE OR REPLACE FUNCTION public.ban_user(
  p_admin_id UUID,
  p_user_id  UUID,
  p_reason   TEXT,
  p_hours    INT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND role IN ('admin','super_admin')) THEN
    RETURN json_build_object('success', false, 'message', 'Not an admin');
  END IF;

  UPDATE public.profiles
     SET is_banned = TRUE,
         status = 'Banned',
         banned_reason = p_reason,
         banned_until = CASE WHEN p_hours IS NULL THEN NULL ELSE NOW() + (p_hours || ' hours')::INTERVAL END
   WHERE id = p_user_id;

  UPDATE public.live_streams SET status = 'banned', ended_at = NOW()
    WHERE broadcaster_id = p_user_id AND status = 'live';

  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id, payload)
  VALUES (p_admin_id, 'ban_user', 'profile', p_user_id, jsonb_build_object('reason', p_reason, 'hours', p_hours));

  RETURN json_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.unban_user(p_admin_id UUID, p_user_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND role IN ('admin','super_admin')) THEN
    RETURN json_build_object('success', false, 'message', 'Not an admin');
  END IF;
  UPDATE public.profiles
     SET is_banned = FALSE, status = 'Active', banned_reason = NULL, banned_until = NULL
   WHERE id = p_user_id;
  INSERT INTO public.admin_audit_log (admin_id, action, target_type, target_id)
    VALUES (p_admin_id, 'unban_user', 'profile', p_user_id);
  RETURN json_build_object('success', true);
END $$;


-- =====================================================================
-- SECTION 5: ROW LEVEL SECURITY (RLS)
-- =====================================================================

ALTER TABLE public.profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gifts_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_streams       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agencies           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agency_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agency_payouts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resellers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topup_requests     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_settings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_rounds        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moments_posts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moments_likes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moments_comments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_reports       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_stream_tokens ENABLE ROW LEVEL SECURITY;

-- Helper: is_admin()
CREATE OR REPLACE FUNCTION public.is_admin(uid UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = uid AND role IN ('admin','super_admin'));
$$;

-- PROFILES
DROP POLICY IF EXISTS profiles_read ON public.profiles;
CREATE POLICY profiles_read ON public.profiles FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
CREATE POLICY profiles_update_self ON public.profiles FOR UPDATE
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS profiles_admin_all ON public.profiles;
CREATE POLICY profiles_admin_all ON public.profiles FOR ALL
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- TRANSACTIONS
DROP POLICY IF EXISTS tx_read_self  ON public.transactions;
CREATE POLICY tx_read_self ON public.transactions FOR SELECT
  USING (user_id = auth.uid() OR public.is_admin(auth.uid()));

-- GIFTS_LOG
DROP POLICY IF EXISTS gifts_read ON public.gifts_log;
CREATE POLICY gifts_read ON public.gifts_log FOR SELECT
  USING (sender_id = auth.uid() OR receiver_id = auth.uid() OR public.is_admin(auth.uid()));

-- LIVE STREAMS
DROP POLICY IF EXISTS streams_read ON public.live_streams;
CREATE POLICY streams_read ON public.live_streams FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS streams_write ON public.live_streams;
CREATE POLICY streams_write ON public.live_streams FOR ALL
  USING (broadcaster_id = auth.uid() OR public.is_admin(auth.uid()))
  WITH CHECK (broadcaster_id = auth.uid() OR public.is_admin(auth.uid()));

-- AGENCIES & MEMBERS
DROP POLICY IF EXISTS agencies_read ON public.agencies;
CREATE POLICY agencies_read ON public.agencies FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS agencies_write ON public.agencies;
CREATE POLICY agencies_write ON public.agencies FOR ALL
  USING (owner_id = auth.uid() OR public.is_admin(auth.uid()))
  WITH CHECK (owner_id = auth.uid() OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS agency_members_read ON public.agency_members;
CREATE POLICY agency_members_read ON public.agency_members FOR SELECT
  USING (host_id = auth.uid()
         OR EXISTS (SELECT 1 FROM public.agencies a WHERE a.id = agency_members.agency_id AND a.owner_id = auth.uid())
         OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS agency_payouts_read ON public.agency_payouts;
CREATE POLICY agency_payouts_read ON public.agency_payouts FOR SELECT
  USING (host_id = auth.uid()
         OR EXISTS (SELECT 1 FROM public.agencies a WHERE a.id = agency_payouts.agency_id AND a.owner_id = auth.uid())
         OR public.is_admin(auth.uid()));

-- RESELLERS
DROP POLICY IF EXISTS resellers_read ON public.resellers;
CREATE POLICY resellers_read ON public.resellers FOR SELECT USING (status <> 'inactive');

DROP POLICY IF EXISTS resellers_admin ON public.resellers;
CREATE POLICY resellers_admin ON public.resellers FOR ALL
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- TOPUP REQUESTS
DROP POLICY IF EXISTS topup_read ON public.topup_requests;
CREATE POLICY topup_read ON public.topup_requests FOR SELECT
  USING (user_id = auth.uid() OR public.is_admin(auth.uid()));

-- GAME SETTINGS
DROP POLICY IF EXISTS game_settings_read ON public.game_settings;
CREATE POLICY game_settings_read ON public.game_settings FOR SELECT USING (TRUE);
DROP POLICY IF EXISTS game_settings_admin ON public.game_settings;
CREATE POLICY game_settings_admin ON public.game_settings FOR ALL
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- GAME ROUNDS
DROP POLICY IF EXISTS game_rounds_read ON public.game_rounds;
CREATE POLICY game_rounds_read ON public.game_rounds FOR SELECT
  USING (user_id = auth.uid() OR public.is_admin(auth.uid()));

-- MOMENTS POSTS
DROP POLICY IF EXISTS moments_read ON public.moments_posts;
CREATE POLICY moments_read ON public.moments_posts FOR SELECT USING (TRUE);
DROP POLICY IF EXISTS moments_insert ON public.moments_posts;
CREATE POLICY moments_insert ON public.moments_posts FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS moments_update_own ON public.moments_posts;
CREATE POLICY moments_update_own ON public.moments_posts FOR UPDATE
  USING (user_id = auth.uid() OR public.is_admin(auth.uid()))
  WITH CHECK (user_id = auth.uid() OR public.is_admin(auth.uid()));
DROP POLICY IF EXISTS moments_delete_own ON public.moments_posts;
CREATE POLICY moments_delete_own ON public.moments_posts FOR DELETE
  USING (user_id = auth.uid() OR public.is_admin(auth.uid()));

-- MOMENTS LIKES / COMMENTS
DROP POLICY IF EXISTS ml_read ON public.moments_likes;
CREATE POLICY ml_read ON public.moments_likes FOR SELECT USING (TRUE);
DROP POLICY IF EXISTS ml_write ON public.moments_likes;
CREATE POLICY ml_write ON public.moments_likes FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS mc_read ON public.moments_comments;
CREATE POLICY mc_read ON public.moments_comments FOR SELECT USING (TRUE);
DROP POLICY IF EXISTS mc_write ON public.moments_comments;
CREATE POLICY mc_write ON public.moments_comments FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- NOTIFICATIONS
DROP POLICY IF EXISTS notif_read ON public.notifications;
CREATE POLICY notif_read ON public.notifications FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS notif_update ON public.notifications;
CREATE POLICY notif_update ON public.notifications FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- FOLLOWS
DROP POLICY IF EXISTS follows_read ON public.follows;
CREATE POLICY follows_read ON public.follows FOR SELECT USING (TRUE);
DROP POLICY IF EXISTS follows_write ON public.follows;
CREATE POLICY follows_write ON public.follows FOR ALL USING (follower_id = auth.uid()) WITH CHECK (follower_id = auth.uid());

-- CHAT MESSAGES
DROP POLICY IF EXISTS chat_read ON public.chat_messages;
CREATE POLICY chat_read ON public.chat_messages FOR SELECT
  USING (sender_id = auth.uid() OR receiver_id = auth.uid() OR public.is_admin(auth.uid()));
DROP POLICY IF EXISTS chat_write ON public.chat_messages;
CREATE POLICY chat_write ON public.chat_messages FOR INSERT WITH CHECK (sender_id = auth.uid());

-- USER REPORTS
DROP POLICY IF EXISTS reports_insert ON public.user_reports;
CREATE POLICY reports_insert ON public.user_reports FOR INSERT WITH CHECK (reporter_id = auth.uid());
DROP POLICY IF EXISTS reports_admin_read ON public.user_reports;
CREATE POLICY reports_admin_read ON public.user_reports FOR SELECT
  USING (reporter_id = auth.uid() OR public.is_admin(auth.uid()));

-- ADMIN AUDIT
DROP POLICY IF EXISTS audit_admin ON public.admin_audit_log;
CREATE POLICY audit_admin ON public.admin_audit_log FOR SELECT USING (public.is_admin(auth.uid()));

-- LIVE STREAM TOKENS
DROP POLICY IF EXISTS lst_self ON public.live_stream_tokens;
CREATE POLICY lst_self ON public.live_stream_tokens FOR SELECT USING (user_id = auth.uid());


-- =====================================================================
-- SECTION 6: SEED DATA
-- =====================================================================

-- 6.1 Game settings defaults
INSERT INTO public.game_settings (id, win_chance_percent, is_active) VALUES
  ('teen_patti',      30, TRUE),
  ('fruit_roulette',  20, TRUE)
ON CONFLICT (id) DO NOTHING;

-- 6.2 Sample resellers (replace contact_link with real WhatsApp numbers later)
INSERT INTO public.resellers (id, name, contact_link, type, status, priority, avatar_url) VALUES
  (gen_random_uuid(), 'Al-Madina Telecom', 'https://wa.me/8801XXXXXXXXX', 'official', 'active', 100, 'https://i.pravatar.cc/150?u=rs1'),
  (gen_random_uuid(), 'Yolo Top-Up BD',    'https://wa.me/8801XXXXXXXXX', 'agency',   'active', 90,  'https://i.pravatar.cc/150?u=rs2'),
  (gen_random_uuid(), 'Safi Agency',       'https://wa.me/8801XXXXXXXXX', 'official', 'busy',   80,  'https://i.pravatar.cc/150?u=rs3')
ON CONFLICT DO NOTHING;

-- 6.3 Promote yourself to super_admin (RUN THIS once you've signed up)
-- Replace YOUR_AUTH_UID with the value from auth.users:
-- UPDATE public.profiles SET role = 'super_admin' WHERE id = 'YOUR_AUTH_UID_HERE';


-- =====================================================================
-- SECTION 7: REALTIME PUBLICATION
-- =====================================================================
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.live_streams;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.gifts_log;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.topup_requests;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.agency_payouts;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;