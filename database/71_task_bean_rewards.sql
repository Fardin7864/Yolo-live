-- =====================================================================
-- 71_task_bean_rewards.sql
-- =====================================================================
-- Adds support for BEAN-denominated task rewards so hosts can be paid
-- for time spent broadcasting (the gift-earning currency they already
-- understand), while viewers continue earning diamonds for engagement.
--
-- Product decision: 1 hour of live = 5,000 beans (~58 BDT at the
-- default 1150 BDT / 100k bean payout rate). The 30-min and 2-hour
-- thresholds scale proportionally so a host streaming 2 hours
-- accumulates 18,500 beans across the three host tasks (stacked).
--
-- WHAT THIS MIGRATION CHANGES
--
--   1. tasks.reward_currency column. NOT NULL with CHECK so a typo
--      can't slip a wrong value into the catalogue.
--   2. grant_reward — polymorphic replacement for grant_reward_diamonds.
--      Routes the credit to the right column (diamonds vs beans) and
--      writes a transactions row tagged with the currency.
--      The old function name is kept as a thin wrapper for back-compat.
--   3. claim_task_reward reads the task's reward_currency and uses the
--      new grant helper.
--   4. Re-targets the three existing host_live_X tasks to bean rewards
--      using the schedule the product owner specified.
--
-- Viewer tasks (watch / gift / share) remain diamond-denominated —
-- viewers don't have a bean balance to spend, so beans on the viewer
-- side would be a confusing reward.
--
-- Idempotent: re-runnable. The currency UPDATEs are guarded so an
-- admin who manually tunes a value later doesn't get it stomped on
-- replay.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Schema — currency column on tasks
-- ---------------------------------------------------------------------
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS reward_currency TEXT NOT NULL DEFAULT 'diamond'
  CHECK (reward_currency IN ('diamond', 'bean'));

-- ---------------------------------------------------------------------
-- 2. Polymorphic grant helper.
--
-- p_currency = 'diamond' → bumps profiles.diamonds
-- p_currency = 'bean'    → bumps profiles.beans
--
-- Returns the new balance of THAT currency so the caller can show it
-- in the success toast. NULL on a failed lookup.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.grant_reward(
  p_user_id  UUID,
  p_amount   BIGINT,
  p_currency TEXT,             -- 'diamond' | 'bean'
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
  IF p_currency NOT IN ('diamond', 'bean') THEN
    RETURN NULL;
  END IF;

  IF p_currency = 'diamond' THEN
    UPDATE public.profiles
       SET diamonds = COALESCE(diamonds, 0) + p_amount
     WHERE id = p_user_id
     RETURNING diamonds INTO v_new_balance;
  ELSE
    UPDATE public.profiles
       SET beans = COALESCE(beans, 0) + p_amount
     WHERE id = p_user_id
     RETURNING beans INTO v_new_balance;
  END IF;

  IF v_new_balance IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.transactions
    (user_id, type, currency, amount, related_entity_type, status, notes)
  VALUES
    (p_user_id, p_source, p_currency, p_amount, 'reward', 'completed',
     COALESCE(p_meta::text, ''));

  RETURN v_new_balance;
END $$;

REVOKE EXECUTE ON FUNCTION public.grant_reward(uuid, bigint, text, text, jsonb) FROM PUBLIC;

-- Back-compat wrapper — claim_daily_login (migration 70) still calls
-- grant_reward_diamonds. We keep that signature alive but it now just
-- forwards to grant_reward, so the two paths share the same audit row
-- shape.
CREATE OR REPLACE FUNCTION public.grant_reward_diamonds(
  p_user_id  UUID,
  p_amount   BIGINT,
  p_source   TEXT,
  p_meta     JSONB DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.grant_reward(p_user_id, p_amount, 'diamond', p_source, p_meta);
END $$;

REVOKE EXECUTE ON FUNCTION public.grant_reward_diamonds(uuid, bigint, text, jsonb) FROM PUBLIC;

-- ---------------------------------------------------------------------
-- 3. claim_task_reward — pick currency from the task row instead of
--    hardcoding diamonds. Everything else (FOR UPDATE lock, completion
--    check, claim mark) is preserved verbatim from migration 70.
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

  v_balance := public.grant_reward(
    me, v_task.reward, v_task.reward_currency, 'task_reward',
    jsonb_build_object('task_id', p_task_id, 'date', v_today)
  );

  UPDATE public.user_task_progress
     SET claimed_at = NOW(), reward_paid = v_task.reward, updated_at = NOW()
   WHERE user_id = me AND task_id = p_task_id AND progress_date = v_today;

  RETURN json_build_object(
    'success',     true,
    'reward',      v_task.reward,
    'currency',    v_task.reward_currency,
    'new_balance', v_balance
  );
END $$;

GRANT EXECUTE ON FUNCTION public.claim_task_reward(text) TO authenticated;

-- ---------------------------------------------------------------------
-- 4. Retarget the host_live_X tasks to bean rewards.
--    Guarded WHERE so an admin who tuned a value later doesn't get it
--    clobbered on replay.
-- ---------------------------------------------------------------------
UPDATE public.tasks
   SET reward = 1500, reward_currency = 'bean'
 WHERE id = 'host_live_30'
   AND reward_currency = 'diamond';

UPDATE public.tasks
   SET reward = 5000, reward_currency = 'bean'
 WHERE id = 'host_live_60'
   AND reward_currency = 'diamond';

UPDATE public.tasks
   SET reward = 12000, reward_currency = 'bean'
 WHERE id = 'host_live_120'
   AND reward_currency = 'diamond';
