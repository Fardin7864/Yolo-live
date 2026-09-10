-- Anubis monthly settlement must sweep the full host/agency-owner bins
-- wallet balance into holder ID 990001 at the Bangladesh month boundary.

CREATE OR REPLACE FUNCTION public.run_anubis_monthly_settlement(p_period_month DATE DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_month DATE := COALESCE(
    DATE_TRUNC('month', p_period_month)::DATE,
    (DATE_TRUNC('month', NOW() AT TIME ZONE 'Asia/Dhaka') - INTERVAL '1 month')::DATE
  );
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  v_holder UUID;
  v_total BIGINT := 0;
  v_count INT := 0;
  settlement RECORD;
  v_deposit BIGINT;
  v_balance_before BIGINT;
BEGIN
  IF v_month >= (DATE_TRUNC('month', NOW() AT TIME ZONE 'Asia/Dhaka'))::DATE THEN
    RAISE EXCEPTION 'Only completed months can be settled';
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended('anubis_monthly_settlement', 0)) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Settlement is already running', 'period_month', v_month);
  END IF;

  v_start := (v_month::TIMESTAMP AT TIME ZONE 'Asia/Dhaka');
  v_end := ((v_month + INTERVAL '1 month')::TIMESTAMP AT TIME ZONE 'Asia/Dhaka');

  SELECT holder_row.id
    INTO v_holder
    FROM public.bins_holder_accounts AS holder_row
   WHERE holder_row.display_id = 990001
   FOR UPDATE;

  IF v_holder IS NULL THEN
    RAISE EXCEPTION 'Anubis holder account 990001 is missing';
  END IF;

  FOR settlement IN
    SELECT
      profile_row.id AS user_id,
      profile_row.role,
      COALESCE(SUM(tx_row.amount) FILTER (
        WHERE tx_row.status = 'completed'
          AND tx_row.currency = 'bean'
          AND tx_row.amount > 0
          AND tx_row.type IN ('gift_received', 'live_hour_reward')
          AND tx_row.created_at >= v_start
          AND tx_row.created_at < v_end
      ), 0)::BIGINT AS earned
    FROM public.profiles AS profile_row
    LEFT JOIN public.transactions AS tx_row ON tx_row.user_id = profile_row.id
    WHERE profile_row.role IN ('host', 'agency_owner')
      AND (
        COALESCE(profile_row.beans, 0) > 0
        OR EXISTS (
          SELECT 1
          FROM public.transactions AS earned_row
          WHERE earned_row.user_id = profile_row.id
            AND earned_row.status = 'completed'
            AND earned_row.currency = 'bean'
            AND earned_row.amount > 0
            AND earned_row.type IN ('gift_received', 'live_hour_reward')
            AND earned_row.created_at >= v_start
            AND earned_row.created_at < v_end
        )
      )
    GROUP BY profile_row.id, profile_row.role, profile_row.beans
    ORDER BY profile_row.id
  LOOP
    IF EXISTS (
      SELECT 1
      FROM public.anubis_monthly_ledger AS ledger_row
      WHERE ledger_row.period_month = v_month
        AND ledger_row.user_id = settlement.user_id
    ) THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(profile_row.beans, 0)::BIGINT
      INTO v_balance_before
      FROM public.profiles AS profile_row
     WHERE profile_row.id = settlement.user_id
     FOR UPDATE;

    v_deposit := GREATEST(v_balance_before, 0);

    IF v_deposit > 0 THEN
      UPDATE public.profiles
         SET beans = 0,
             updated_at = NOW()
       WHERE id = settlement.user_id;
    END IF;

    INSERT INTO public.anubis_monthly_ledger(
      period_month,
      user_id,
      holder_id,
      role_at_settlement,
      earned_beans,
      deposited_beans,
      balance_before,
      balance_after
    )
    VALUES (
      v_month,
      settlement.user_id,
      v_holder,
      settlement.role,
      settlement.earned,
      v_deposit,
      v_balance_before,
      0
    );

    IF v_deposit > 0 THEN
      INSERT INTO public.transactions(
        user_id,
        type,
        currency,
        amount,
        balance_after,
        status,
        notes
      )
      VALUES (
        settlement.user_id,
        'anubis_monthly_deposit',
        'bean',
        -v_deposit,
        0,
        'completed',
        'Monthly bins deposited to Anubis ID 990001 for ' || v_month
      );
    END IF;

    v_total := v_total + v_deposit;
    v_count := v_count + 1;
  END LOOP;

  UPDATE public.bins_holder_accounts
     SET total_bins_received = total_bins_received + v_total
   WHERE id = v_holder;

  RETURN jsonb_build_object(
    'success', TRUE,
    'period_month', v_month,
    'accounts_settled', v_count,
    'beans_deposited', v_total,
    'anubis_display_id', 990001
  );
END $$;

GRANT EXECUTE ON FUNCTION public.run_anubis_monthly_settlement(DATE) TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'anubis-monthly-beans-settlement';

  -- pg_cron runs in UTC on Supabase. 18:00 UTC is 00:00 Asia/Dhaka,
  -- so the guarded daily run lands exactly as the new Dhaka month begins.
  PERFORM cron.schedule(
    'anubis-monthly-beans-settlement',
    '0 18 * * *',
    $cron$
      SELECT CASE
        WHEN EXTRACT(DAY FROM (NOW() AT TIME ZONE 'Asia/Dhaka')::DATE) = 1
          THEN public.run_anubis_monthly_settlement()
        ELSE jsonb_build_object('success', FALSE, 'skipped', TRUE, 'reason', 'not_dhaka_month_start')
      END;
    $cron$
  );
END $$;

NOTIFY pgrst, 'reload schema';
