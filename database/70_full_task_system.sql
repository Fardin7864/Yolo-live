-- =====================================================================
-- 70_full_task_system.sql
-- =====================================================================
-- Ends the "task center" placeholder — both the 30-day login calendar
-- and the daily mission list now actually award diamonds, track
-- progress in the DB, and auto-complete via triggers.
--
-- THE FULL FLOW
--
--   Daily login
--     • Per-day reward table (admin-tunable)
--     • Per-user claim history with streak tracking
--     • claim_daily_login() RPC — verifies streak, awards diamonds,
--       resets to day 1 if a day was skipped
--
--   Daily missions
--     • Tasks table now carries `target` (the count required)
--     • Per-user-per-day progress table keyed (user, task, date)
--     • Triggers auto-bump progress:
--         gifts_log INSERT  → bumps gift-action tasks
--         live_streams 'live'→'ended' → bumps live-action tasks
--     • Client-driven bumps for the two actions the DB can't see
--       directly:
--         bump_watch_progress(minutes) — broadcast room calls this
--         claim_share_task()           — share button calls this
--     • claim_task_reward(task_id) — verifies completed, grants reward,
--       marks claimed
--
--   Shared award helper
--     • grant_reward_diamonds() — single source of truth for adding
--       diamonds + writing a transactions row. Used by both flows.
--
-- Idempotent: re-runnable.
-- =====================================================================


-- ╔═══════════════════════════════════════════════════════════════════╗
-- ║  PHASE C  —  Shared reward helper                                  ║
-- ╚═══════════════════════════════════════════════════════════════════╝
-- ---------------------------------------------------------------------
-- One canonical place to "give a user X diamonds for Y reason".
-- - Updates profiles.diamonds atomically
-- - Logs a transactions row so the admin earnings dashboard sees it
-- - Returns the new balance for the caller to display
--
-- Internal helper — callers should be other RPCs, not the mobile
-- client directly. EXECUTE is granted only to SECURITY DEFINER siblings.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.grant_reward_diamonds(
  p_user_id  UUID,
  p_amount   BIGINT,
  p_source   TEXT,             -- 'daily_login' | 'task_reward' | ...
  p_meta     JSONB DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_new_balance BIGINT;
BEGIN
  IF p_user_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN NULL;
  END IF;

  UPDATE public.profiles
     SET diamonds = COALESCE(diamonds, 0) + p_amount
   WHERE id = p_user_id
   RETURNING diamonds INTO v_new_balance;

  IF v_new_balance IS NULL THEN
    -- Profile didn't exist; refuse silently.
    RETURN NULL;
  END IF;

  INSERT INTO public.transactions
    (user_id, type, currency, amount, related_entity_type, status, notes)
  VALUES
    (p_user_id, p_source, 'diamond', p_amount, 'reward', 'completed',
     COALESCE(p_meta::text, ''));

  RETURN v_new_balance;
END $$;

REVOKE EXECUTE ON FUNCTION public.grant_reward_diamonds(uuid, bigint, text, jsonb) FROM PUBLIC;


-- ╔═══════════════════════════════════════════════════════════════════╗
-- ║  PHASE A  —  Daily login                                           ║
-- ╚═══════════════════════════════════════════════════════════════════╝

-- ---------------------------------------------------------------------
-- A.1  Reward table — admin-tunable per-day amounts.
--      30 days seeded by default with 5 / 50 (every 7th) / 200 (day 30).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_login_rewards (
  day_index INT     PRIMARY KEY CHECK (day_index BETWEEN 1 AND 30),
  diamonds  BIGINT  NOT NULL CHECK (diamonds >= 0)
);

INSERT INTO public.daily_login_rewards (day_index, diamonds)
SELECT d,
       CASE
         WHEN d = 30          THEN 200   -- finale jackpot
         WHEN d % 7 = 0       THEN 50    -- weekly bonus
         ELSE                      5     -- daily base
       END
  FROM generate_series(1, 30) AS d
ON CONFLICT (day_index) DO NOTHING;

ALTER TABLE public.daily_login_rewards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dlr_read ON public.daily_login_rewards;
CREATE POLICY dlr_read ON public.daily_login_rewards
  FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS dlr_admin_write ON public.daily_login_rewards;
CREATE POLICY dlr_admin_write ON public.daily_login_rewards
  FOR ALL
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname='supabase_realtime'
       AND schemaname='public'
       AND tablename='daily_login_rewards'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.daily_login_rewards;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- A.2  Claim history — one row per (user, claim_date). The PK enforces
--      "at most one claim per UTC date" without any explicit lock.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_login_claims (
  user_id          UUID    NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  claim_date       DATE    NOT NULL,
  day_index        INT     NOT NULL CHECK (day_index BETWEEN 1 AND 30),
  diamonds_awarded BIGINT  NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, claim_date)
);

CREATE INDEX IF NOT EXISTS idx_dlc_user_recent
  ON public.daily_login_claims (user_id, claim_date DESC);

ALTER TABLE public.daily_login_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dlc_read_self ON public.daily_login_claims;
CREATE POLICY dlc_read_self ON public.daily_login_claims
  FOR SELECT
  USING (user_id = auth.uid() OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS dlc_block_writes ON public.daily_login_claims;
CREATE POLICY dlc_block_writes ON public.daily_login_claims
  FOR ALL USING (FALSE) WITH CHECK (FALSE);

-- ---------------------------------------------------------------------
-- A.3  claim_daily_login()
--      Streak logic:
--        Last claim was YESTERDAY  → day_index = last + 1 (wraps to 1 after 30)
--        Last claim is TODAY       → already claimed, no-op
--        Last claim < yesterday    → streak broken, day_index = 1
--        No previous claim         → first day, day_index = 1
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_daily_login()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me              uuid := auth.uid();
  v_today         date := (NOW() AT TIME ZONE 'UTC')::date;
  v_last_date     date;
  v_last_day      int;
  v_next_day      int;
  v_reward        bigint;
  v_balance       bigint;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  SELECT claim_date, day_index
    INTO v_last_date, v_last_day
    FROM public.daily_login_claims
    WHERE user_id = me
    ORDER BY claim_date DESC
    LIMIT 1;

  -- Already claimed today.
  IF v_last_date = v_today THEN
    RETURN json_build_object(
      'success', false,
      'already_claimed', true,
      'day_index', v_last_day,
      'message', 'Already claimed today.'
    );
  END IF;

  -- Decide next day.
  IF v_last_date IS NULL OR v_last_date < v_today - 1 THEN
    v_next_day := 1;                          -- fresh streak
  ELSIF v_last_day = 30 THEN
    v_next_day := 1;                          -- finished cycle; loop back
  ELSE
    v_next_day := v_last_day + 1;             -- streak continues
  END IF;

  SELECT diamonds INTO v_reward
    FROM public.daily_login_rewards WHERE day_index = v_next_day;
  v_reward := COALESCE(v_reward, 5);

  INSERT INTO public.daily_login_claims (user_id, claim_date, day_index, diamonds_awarded)
  VALUES (me, v_today, v_next_day, v_reward);

  v_balance := public.grant_reward_diamonds(
    me, v_reward, 'daily_login',
    jsonb_build_object('day_index', v_next_day, 'date', v_today)
  );

  RETURN json_build_object(
    'success',         true,
    'day_index',       v_next_day,
    'reward',          v_reward,
    'new_balance',     v_balance
  );
END $$;

GRANT EXECUTE ON FUNCTION public.claim_daily_login() TO authenticated;


-- ╔═══════════════════════════════════════════════════════════════════╗
-- ║  PHASE B  —  Mission tracking                                      ║
-- ╚═══════════════════════════════════════════════════════════════════╝

-- ---------------------------------------------------------------------
-- B.1  Add target to tasks. Default 1 for backwards-compat with seeded
--      rows that didn't specify one; the UPDATEs below fix them.
-- ---------------------------------------------------------------------
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS target BIGINT NOT NULL DEFAULT 1
  CHECK (target > 0);

UPDATE public.tasks SET target = 5    WHERE id = 'viewer_watch_5'  AND target = 1;
UPDATE public.tasks SET target = 50   WHERE id = 'viewer_gift_50'  AND target = 1;
UPDATE public.tasks SET target = 1    WHERE id = 'viewer_share_1';
UPDATE public.tasks SET target = 30   WHERE id = 'host_live_30'    AND target = 1;
UPDATE public.tasks SET target = 60   WHERE id = 'host_live_60'    AND target = 1;
UPDATE public.tasks SET target = 120  WHERE id = 'host_live_120'   AND target = 1;

-- ---------------------------------------------------------------------
-- B.2  Per-user-per-day progress.
--      Keyed (user, task, date) so each day is a fresh row — no need
--      for an explicit reset job. Yesterday's rows are just historical.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_task_progress (
  user_id        UUID    NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  task_id        TEXT    NOT NULL REFERENCES public.tasks(id)    ON DELETE CASCADE,
  progress_date  DATE    NOT NULL,
  count          BIGINT  NOT NULL DEFAULT 0,
  completed_at   TIMESTAMPTZ,
  claimed_at     TIMESTAMPTZ,
  reward_paid    BIGINT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, task_id, progress_date)
);

CREATE INDEX IF NOT EXISTS idx_utp_user_date
  ON public.user_task_progress (user_id, progress_date);

ALTER TABLE public.user_task_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS utp_read_self ON public.user_task_progress;
CREATE POLICY utp_read_self ON public.user_task_progress
  FOR SELECT
  USING (user_id = auth.uid() OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS utp_block_writes ON public.user_task_progress;
CREATE POLICY utp_block_writes ON public.user_task_progress
  FOR ALL USING (FALSE) WITH CHECK (FALSE);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname='supabase_realtime'
       AND schemaname='public'
       AND tablename='user_task_progress'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_task_progress;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- B.3  Internal helper used by every progress-bump path. Pure SQL
--      "add delta to (user, task_id, today)" with auto-completion.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bump_task_progress_for_action(
  p_user_id  UUID,
  p_action   TEXT,
  p_delta    BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (NOW() AT TIME ZONE 'UTC')::date;
  r       RECORD;
BEGIN
  IF p_user_id IS NULL OR p_delta IS NULL OR p_delta <= 0 OR p_action IS NULL THEN
    RETURN;
  END IF;

  -- One upsert per active task matching this action.
  FOR r IN
    SELECT id, target
      FROM public.tasks
      WHERE action = p_action AND is_active = TRUE
  LOOP
    INSERT INTO public.user_task_progress
      (user_id, task_id, progress_date, count, completed_at, updated_at)
    VALUES
      (p_user_id, r.id, v_today, p_delta,
       CASE WHEN p_delta >= r.target THEN NOW() ELSE NULL END,
       NOW())
    ON CONFLICT (user_id, task_id, progress_date) DO UPDATE
      SET count        = user_task_progress.count + EXCLUDED.count,
          completed_at = COALESCE(
                          user_task_progress.completed_at,
                          CASE
                            WHEN user_task_progress.count + EXCLUDED.count >= r.target
                            THEN NOW()
                            ELSE NULL
                          END),
          updated_at   = NOW();
  END LOOP;
END $$;

REVOKE EXECUTE ON FUNCTION public.bump_task_progress_for_action(uuid, text, bigint) FROM PUBLIC;

-- ---------------------------------------------------------------------
-- B.4  Trigger: gifts_log INSERT → bump sender's gift tasks by cost.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_gift_task_progress()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.bump_task_progress_for_action(NEW.sender_id, 'gift', COALESCE(NEW.diamond_cost, 0));
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_gift_task_progress ON public.gifts_log;
CREATE TRIGGER trg_gift_task_progress
  AFTER INSERT ON public.gifts_log
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_gift_task_progress();

-- ---------------------------------------------------------------------
-- B.5  Trigger: live_streams flip from 'live' to 'ended' → award the
--      session's total minutes to the broadcaster's live tasks.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_live_task_progress()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_minutes bigint;
BEGIN
  IF OLD.status = 'live' AND NEW.status = 'ended' THEN
    v_minutes := GREATEST(
      0,
      EXTRACT(EPOCH FROM (COALESCE(NEW.ended_at, NOW()) - NEW.started_at)) / 60
    )::bigint;
    IF v_minutes > 0 THEN
      PERFORM public.bump_task_progress_for_action(NEW.broadcaster_id, 'live', v_minutes);
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_live_task_progress ON public.live_streams;
CREATE TRIGGER trg_live_task_progress
  AFTER UPDATE OF status ON public.live_streams
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_live_task_progress();

-- ---------------------------------------------------------------------
-- B.6  Client-driven bumps for actions the DB can't see directly.
-- ---------------------------------------------------------------------

-- Viewer side: the broadcast room calls this ~once a minute while the
-- user is viewing. p_minutes is bounded to 5 so a malicious client
-- can't spam "I watched 10000 minutes".
CREATE OR REPLACE FUNCTION public.bump_watch_progress(p_minutes INT DEFAULT 1)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  PERFORM public.bump_task_progress_for_action(
    me, 'watch', GREATEST(1, LEAST(5, COALESCE(p_minutes, 1)))
  );
  RETURN json_build_object('success', true);
END $$;

GRANT EXECUTE ON FUNCTION public.bump_watch_progress(int) TO authenticated;

-- Share button: the mobile share handler calls this after Share.share
-- resolves successfully. Idempotent thanks to the upsert.
CREATE OR REPLACE FUNCTION public.claim_share_task()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;
  PERFORM public.bump_task_progress_for_action(me, 'share', 1);
  RETURN json_build_object('success', true);
END $$;

GRANT EXECUTE ON FUNCTION public.claim_share_task() TO authenticated;

-- ---------------------------------------------------------------------
-- B.7  claim_task_reward — single endpoint the UI calls when the user
--      taps "Claim" on a completed mission. Guards:
--        - task must exist + be active
--        - must be completed (count >= target) AND not yet claimed
--        - reward awarded via grant_reward_diamonds for unified audit
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_task_reward(p_task_id TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me           uuid := auth.uid();
  v_today      date := (NOW() AT TIME ZONE 'UTC')::date;
  v_task       public.tasks%ROWTYPE;
  v_progress   public.user_task_progress%ROWTYPE;
  v_balance    bigint;
BEGIN
  IF me IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  SELECT * INTO v_task FROM public.tasks WHERE id = p_task_id AND is_active = TRUE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'Task not found');
  END IF;

  -- FOR UPDATE blocks a second tap from double-claiming.
  SELECT * INTO v_progress
    FROM public.user_task_progress
    WHERE user_id = me AND task_id = p_task_id AND progress_date = v_today
    FOR UPDATE;

  IF NOT FOUND OR v_progress.count < v_task.target THEN
    RETURN json_build_object('success', false, 'message', 'Not yet completed');
  END IF;
  IF v_progress.claimed_at IS NOT NULL THEN
    RETURN json_build_object('success', false, 'message', 'Already claimed');
  END IF;

  v_balance := public.grant_reward_diamonds(
    me, v_task.reward, 'task_reward',
    jsonb_build_object('task_id', p_task_id, 'date', v_today)
  );

  UPDATE public.user_task_progress
     SET claimed_at = NOW(), reward_paid = v_task.reward, updated_at = NOW()
   WHERE user_id = me AND task_id = p_task_id AND progress_date = v_today;

  RETURN json_build_object(
    'success', true,
    'reward', v_task.reward,
    'new_balance', v_balance
  );
END $$;

GRANT EXECUTE ON FUNCTION public.claim_task_reward(text) TO authenticated;

-- ---------------------------------------------------------------------
-- B.8  Cleanup helper — wipes progress rows older than 14 days so the
--      table doesn't grow forever. Scheduled by pg_cron if available;
--      otherwise admins can call it manually.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_old_task_progress()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count int;
BEGIN
  DELETE FROM public.user_task_progress
   WHERE progress_date < CURRENT_DATE - INTERVAL '14 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN json_build_object('success', true, 'deleted', v_count);
END $$;

GRANT EXECUTE ON FUNCTION public.cleanup_old_task_progress() TO authenticated;

DO $$
BEGIN
  PERFORM cron.schedule(
    'cleanup_old_task_progress',
    '15 0 * * *',                                -- daily at 00:15 UTC
    $cron$ SELECT public.cleanup_old_task_progress(); $cron$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available — task progress will grow until manually cleaned.';
END $$;
