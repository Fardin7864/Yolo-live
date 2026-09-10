-- Additive real-time consistency layer for Greedy King and Teen Patti Pro.
-- Existing game rules, payout functions and RPC signatures remain unchanged.

DO $$
BEGIN
  IF to_regclass('public.game_rounds') IS NULL
     OR to_regclass('public.game_round_bets') IS NULL
     OR to_regclass('public.game_bet_batches') IS NULL
     OR to_regclass('public.game_robot_bets') IS NULL
     OR to_regprocedure('public.place_greedy_pro_bet_batch(uuid,text,jsonb)') IS NULL
     OR to_regprocedure('public.place_tin_patti_pro_bet_batch(uuid,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Realtime betting prerequisites are missing; apply game migrations through 168 first';
  END IF;
END;
$$;

ALTER TABLE public.game_rounds
  ADD COLUMN IF NOT EXISTS state_version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS state_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE public.game_bet_batches
  ADD COLUMN IF NOT EXISTS request_hash TEXT,
  ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'processing',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.game_bet_batches'::regclass
       AND conname = 'game_bet_batches_processing_status_check'
  ) THEN
    ALTER TABLE public.game_bet_batches
      ADD CONSTRAINT game_bet_batches_processing_status_check
      CHECK (processing_status IN ('processing', 'completed', 'rejected')) NOT VALID;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.canonical_game_bet_request(p_bets JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('position', normalized.position, 'amount', normalized.amount)
      ORDER BY normalized.position
    ),
    '[]'::jsonb
  )
  FROM (
    SELECT trim(item.position) AS position, SUM(item.amount)::numeric AS amount
      FROM jsonb_to_recordset(
        CASE WHEN jsonb_typeof(p_bets) = 'array' THEN p_bets ELSE '[]'::jsonb END
      ) AS item(position TEXT, amount NUMERIC)
     GROUP BY trim(item.position)
  ) normalized;
$$;

CREATE OR REPLACE FUNCTION public.game_bet_request_hash(p_bets JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT md5(public.canonical_game_bet_request(p_bets)::text);
$$;

UPDATE public.game_bet_batches
   SET request_hash = public.game_bet_request_hash(bets),
       processing_status = CASE WHEN response IS NULL THEN 'processing' ELSE 'completed' END,
       completed_at = CASE WHEN response IS NULL THEN completed_at ELSE COALESCE(completed_at, created_at) END,
       updated_at = COALESCE(updated_at, created_at)
 WHERE request_hash IS NULL
    OR (response IS NOT NULL AND processing_status <> 'completed');

CREATE OR REPLACE FUNCTION public.guard_game_bet_batch_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  computed_hash TEXT := public.game_bet_request_hash(NEW.bets);
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.request_hash := COALESCE(NEW.request_hash, computed_hash);
    NEW.updated_at := NOW();
  ELSE
    IF NEW.game_type IS DISTINCT FROM OLD.game_type
       OR NEW.round_id IS DISTINCT FROM OLD.round_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.client_batch_id IS DISTINCT FROM OLD.client_batch_id
       OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
       OR computed_hash IS DISTINCT FROM OLD.request_hash THEN
      RAISE EXCEPTION 'Bet batch idempotency identity is immutable'
        USING ERRCODE = '23000';
    END IF;
    NEW.updated_at := NOW();
    IF NEW.response IS NOT NULL AND OLD.response IS NULL THEN
      NEW.processing_status := CASE
        WHEN COALESCE((NEW.response->>'success')::BOOLEAN, FALSE) THEN 'completed'
        ELSE 'rejected'
      END;
      NEW.completed_at := NOW();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_game_bet_batch_identity_trigger ON public.game_bet_batches;
CREATE TRIGGER guard_game_bet_batch_identity_trigger
BEFORE INSERT OR UPDATE ON public.game_bet_batches
FOR EACH ROW EXECUTE FUNCTION public.guard_game_bet_batch_identity();

CREATE TABLE IF NOT EXISTS public.game_round_position_totals (
  round_id UUID NOT NULL REFERENCES public.game_rounds(id) ON DELETE CASCADE,
  position TEXT NOT NULL,
  total_amount BIGINT NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (round_id, position)
);

INSERT INTO public.game_round_position_totals(round_id, position, total_amount, updated_at)
SELECT b.round_id, b.position, SUM(b.amount)::BIGINT, MAX(b.created_at)
  FROM public.game_round_bets b
  JOIN public.game_rounds r ON r.id = b.round_id
 WHERE r.game_type IN ('greedy_pro', 'tin_patti_pro')
 GROUP BY b.round_id, b.position
ON CONFLICT (round_id, position) DO UPDATE
  SET total_amount = EXCLUDED.total_amount,
      updated_at = EXCLUDED.updated_at;

CREATE OR REPLACE FUNCTION public.apply_game_round_position_total_delta(
  p_round_id UUID,
  p_position TEXT,
  p_delta BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_delta = 0 OR NOT EXISTS (
    SELECT 1 FROM public.game_rounds
     WHERE id = p_round_id AND game_type IN ('greedy_pro', 'tin_patti_pro')
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.game_round_position_totals(round_id, position, total_amount, updated_at)
  VALUES (p_round_id, p_position, p_delta, NOW())
  ON CONFLICT (round_id, position) DO UPDATE
    SET total_amount = public.game_round_position_totals.total_amount + EXCLUDED.total_amount,
        updated_at = NOW();

  IF EXISTS (
    SELECT 1 FROM public.game_round_position_totals
     WHERE round_id = p_round_id AND position = p_position AND total_amount < 0
  ) THEN
    RAISE EXCEPTION 'Authoritative game total cannot become negative'
      USING ERRCODE = '23514';
  END IF;

  DELETE FROM public.game_round_position_totals
   WHERE round_id = p_round_id AND position = p_position AND total_amount = 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_game_round_position_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.apply_game_round_position_total_delta(NEW.round_id, NEW.position, NEW.amount);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.apply_game_round_position_total_delta(OLD.round_id, OLD.position, -OLD.amount);
    RETURN OLD;
  END IF;

  IF (OLD.round_id, OLD.position, OLD.amount)
     IS DISTINCT FROM (NEW.round_id, NEW.position, NEW.amount) THEN
    PERFORM public.apply_game_round_position_total_delta(OLD.round_id, OLD.position, -OLD.amount);
    PERFORM public.apply_game_round_position_total_delta(NEW.round_id, NEW.position, NEW.amount);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_game_round_position_totals_trigger ON public.game_round_bets;
CREATE TRIGGER sync_game_round_position_totals_trigger
AFTER INSERT OR DELETE OR UPDATE OF round_id, position, amount ON public.game_round_bets
FOR EACH ROW EXECUTE FUNCTION public.sync_game_round_position_totals();

-- Close the small deployment window between the initial backfill and trigger
-- installation. This second exact reconciliation includes every row committed
-- before the trigger became active; later writes are covered by the trigger.
LOCK TABLE public.game_round_bets IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO public.game_round_position_totals(round_id, position, total_amount, updated_at)
SELECT b.round_id, b.position, SUM(b.amount)::BIGINT, MAX(b.created_at)
  FROM public.game_round_bets b
  JOIN public.game_rounds r ON r.id = b.round_id
 WHERE r.game_type IN ('greedy_pro', 'tin_patti_pro')
 GROUP BY b.round_id, b.position
ON CONFLICT (round_id, position) DO UPDATE
  SET total_amount = EXCLUDED.total_amount,
      updated_at = EXCLUDED.updated_at;

CREATE OR REPLACE FUNCTION public.bump_game_round_state_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.game_type IN ('greedy_pro', 'tin_patti_pro') AND (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
    OR NEW.winner_pos IS DISTINCT FROM OLD.winner_pos
    OR NEW.bets IS DISTINCT FROM OLD.bets
    OR NEW.result IS DISTINCT FROM OLD.result
    OR NEW.total_bet IS DISTINCT FROM OLD.total_bet
    OR NEW.win_amount IS DISTINCT FROM OLD.win_amount
  ) THEN
    NEW.state_version := OLD.state_version + 1;
    NEW.state_updated_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bump_game_round_state_version_trigger ON public.game_rounds;
CREATE TRIGGER bump_game_round_state_version_trigger
BEFORE UPDATE ON public.game_rounds
FOR EACH ROW EXECUTE FUNCTION public.bump_game_round_state_version();

CREATE OR REPLACE FUNCTION public.bump_greedy_pro_robot_state_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  affected_round UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.round_id ELSE NEW.round_id END;
BEGIN
  UPDATE public.game_rounds
     SET state_version = state_version + 1,
         state_updated_at = NOW()
   WHERE id = affected_round AND game_type = 'greedy_pro';
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS bump_greedy_pro_robot_state_version_trigger ON public.game_robot_bets;
CREATE TRIGGER bump_greedy_pro_robot_state_version_trigger
AFTER INSERT OR DELETE ON public.game_robot_bets
FOR EACH ROW EXECUTE FUNCTION public.bump_greedy_pro_robot_state_version();

-- A trigger uses the same per-game advisory locks as the deployed tick
-- coordinators. Unlike a partial unique index, this is safe to install even if
-- historical bad data exists, while still preventing any new active duplicate.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.game_rounds
     WHERE game_type IN ('greedy_pro', 'tin_patti_pro')
       AND status IN ('betting', 'resolving')
     GROUP BY game_type, room_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate active Greedy King or Teen Patti rounds must be reconciled before this migration';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_single_active_realtime_game_round()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.game_type NOT IN ('greedy_pro', 'tin_patti_pro')
     OR NEW.status NOT IN ('betting', 'resolving') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.game_type, NEW.room_id, NEW.status)
       IS NOT DISTINCT FROM (OLD.game_type, OLD.room_id, OLD.status) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    1729,
    CASE NEW.game_type WHEN 'greedy_pro' THEN 4 ELSE 2 END
  );
  IF EXISTS (
    SELECT 1 FROM public.game_rounds active
     WHERE active.game_type = NEW.game_type
       AND active.room_id = NEW.room_id
       AND active.status IN ('betting', 'resolving')
       AND active.id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION 'An active % round already exists for this room', NEW.game_type
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_single_active_realtime_game_round_trigger ON public.game_rounds;
CREATE TRIGGER guard_single_active_realtime_game_round_trigger
BEFORE INSERT OR UPDATE OF game_type, room_id, status ON public.game_rounds
FOR EACH ROW EXECUTE FUNCTION public.guard_single_active_realtime_game_round();

CREATE INDEX IF NOT EXISTS idx_game_round_bets_round_user_position
  ON public.game_round_bets(round_id, user_id, position);
CREATE INDEX IF NOT EXISTS idx_game_bet_batches_user_reconnect
  ON public.game_bet_batches(user_id, game_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_bet_batches_inflight
  ON public.game_bet_batches(game_type, round_id, user_id, updated_at)
  WHERE processing_status = 'processing';
CREATE INDEX IF NOT EXISTS idx_game_rounds_realtime_lookup
  ON public.game_rounds(game_type, room_id, status, started_at DESC)
  INCLUDE (state_version, state_updated_at, ends_at, total_bet);

ALTER TABLE public.game_round_position_totals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS game_round_position_totals_read ON public.game_round_position_totals;
CREATE POLICY game_round_position_totals_read
  ON public.game_round_position_totals FOR SELECT USING (TRUE);
REVOKE INSERT, UPDATE, DELETE ON public.game_round_position_totals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.game_round_position_totals TO anon, authenticated, service_role;

ALTER TABLE public.game_rounds REPLICA IDENTITY FULL;
ALTER TABLE public.game_round_position_totals REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'game_round_position_totals'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.game_round_position_totals;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.authoritative_game_bet_totals(
  p_round_id UUID,
  p_include_robot_bets BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH totals AS (
    SELECT position, total_amount AS amount
      FROM public.game_round_position_totals
     WHERE round_id = p_round_id
    UNION ALL
    SELECT position, SUM(amount)::BIGINT
      FROM public.game_robot_bets
     WHERE p_include_robot_bets AND round_id = p_round_id
     GROUP BY position
  ), merged AS (
    SELECT position, SUM(amount)::BIGINT AS amount FROM totals GROUP BY position
  )
  SELECT COALESCE(jsonb_object_agg(position, amount), '{}'::jsonb) FROM merged;
$$;

CREATE OR REPLACE FUNCTION public.authoritative_game_user_bet_totals(
  p_round_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_object_agg(position, amount), '{}'::jsonb)
  FROM (
    SELECT position, SUM(amount)::BIGINT AS amount
      FROM public.game_round_bets
     WHERE round_id = p_round_id AND user_id = p_user_id
     GROUP BY position
  ) totals;
$$;

-- Preserve the deployed bet processors as rule engines, then wrap their
-- public RPC names with request-key serialization and payload conflict checks.
DO $$
DECLARE
  tin_patti_definition TEXT;
BEGIN
  IF to_regprocedure('public.place_greedy_pro_bet_batch_core_169(uuid,text,jsonb)') IS NULL THEN
    ALTER FUNCTION public.place_greedy_pro_bet_batch(UUID, TEXT, JSONB)
      RENAME TO place_greedy_pro_bet_batch_core_169;
  END IF;
  IF to_regprocedure('public.place_tin_patti_pro_bet_batch_core_169(uuid,text,jsonb)') IS NULL THEN
    -- Teen Patti already exposes the 500 chip in its production UI. Preserve
    -- the deployed rules while extending only the denomination decomposition
    -- so the database contract matches the existing client contract.
    SELECT pg_get_functiondef('public.place_tin_patti_pro_bet_batch(uuid,text,jsonb)'::regprocedure)
      INTO tin_patti_definition;
    tin_patti_definition := replace(
      tin_patti_definition,
      'FUNCTION public.place_tin_patti_pro_bet_batch(',
      'FUNCTION public.place_tin_patti_pro_bet_batch_core_169('
    );
    tin_patti_definition := replace(
      tin_patti_definition,
      'ARRAY[100000, 50000, 5000, 1000]::bigint[]',
      'ARRAY[100000, 50000, 5000, 1000, 500]::bigint[]'
    );
    IF position('ARRAY[100000, 50000, 5000, 1000, 500]::bigint[]' IN tin_patti_definition) = 0 THEN
      RAISE EXCEPTION 'Could not safely extend Teen Patti batch decomposition to the 500 chip';
    END IF;
    EXECUTE tin_patti_definition;
  END IF;
  IF to_regprocedure('public.get_greedy_pro_state_core_169()') IS NULL THEN
    ALTER FUNCTION public.get_greedy_pro_state()
      RENAME TO get_greedy_pro_state_core_169;
  END IF;
  IF to_regprocedure('public.get_tin_patti_pro_state_core_169()') IS NULL THEN
    ALTER FUNCTION public.get_tin_patti_pro_state()
      RENAME TO get_tin_patti_pro_state_core_169;
  END IF;
END;
$$;

-- Keep the shared row-level denomination guard aligned with both visible
-- chip selectors without changing Popular Greedy's legacy denominations.
CREATE OR REPLACE FUNCTION public.validate_game_chip_denomination()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  round_game_type TEXT;
BEGIN
  SELECT game_type INTO round_game_type
    FROM public.game_rounds
   WHERE id = NEW.round_id;

  IF round_game_type = 'greedy_lion'
     AND NEW.amount <> ALL (ARRAY[1000, 5000, 50000, 100000]::BIGINT[]) THEN
    RAISE EXCEPTION 'Invalid chip amount. Use 1K, 5K, 50K, or 100K.' USING ERRCODE = '22023';
  END IF;
  IF round_game_type IN ('greedy_pro', 'tin_patti_pro')
     AND NEW.amount <> ALL (ARRAY[500, 1000, 5000, 50000, 100000]::BIGINT[]) THEN
    RAISE EXCEPTION 'Invalid real-time game chip amount.' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.execute_realtime_game_bet_batch(
  p_game_type TEXT,
  p_round_id UUID,
  p_client_batch_id TEXT,
  p_bets JSONB
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me UUID := auth.uid();
  expected_hash TEXT;
  existing_batch public.game_bet_batches%ROWTYPE;
  result_payload JSONB;
  current_version BIGINT;
  current_updated_at TIMESTAMPTZ;
BEGIN
  IF me IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Not authenticated')::json;
  END IF;
  IF p_game_type NOT IN ('greedy_pro', 'tin_patti_pro') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Unsupported real-time game')::json;
  END IF;
  IF p_round_id IS NULL OR p_client_batch_id IS NULL
     OR length(trim(p_client_batch_id)) NOT BETWEEN 8 AND 160 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Invalid bet batch')::json;
  END IF;

  expected_hash := public.game_bet_request_hash(p_bets);
  -- Serialize all real-time game batches from one player, not only retries of
  -- the same key. This makes wallet, daily-cap, max-bet and existing-total
  -- validation safe across concurrent rounds and both supported games.
  PERFORM pg_advisory_xact_lock(
    hashtext('realtime-game-bet-user'),
    hashtext(me::text)
  );

  SELECT * INTO existing_batch
    FROM public.game_bet_batches
   WHERE game_type = p_game_type
     AND round_id = p_round_id
     AND user_id = me
     AND client_batch_id = trim(p_client_batch_id)
   FOR UPDATE;

  IF FOUND THEN
    IF existing_batch.request_hash IS DISTINCT FROM expected_hash THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'IDEMPOTENCY_CONFLICT',
        'message', 'This bet request ID was already used with different bets'
      )::json;
    END IF;
    IF existing_batch.response IS NOT NULL THEN
      RETURN existing_batch.response::json;
    END IF;
  END IF;

  IF p_game_type = 'greedy_pro' THEN
    result_payload := public.place_greedy_pro_bet_batch_core_169(
      p_round_id, trim(p_client_batch_id), p_bets
    )::jsonb;
  ELSE
    result_payload := public.place_tin_patti_pro_bet_batch_core_169(
      p_round_id, trim(p_client_batch_id), p_bets
    )::jsonb;
  END IF;

  SELECT state_version, state_updated_at
    INTO current_version, current_updated_at
    FROM public.game_rounds WHERE id = p_round_id;

  result_payload := result_payload || jsonb_build_object(
    'state_version', COALESCE(current_version, 0),
    'state_updated_at', current_updated_at,
    'authoritative_totals', public.authoritative_game_bet_totals(
      p_round_id, p_game_type = 'greedy_pro'
    ),
    'authoritative_my_totals', public.authoritative_game_user_bet_totals(p_round_id, me)
  );

  UPDATE public.game_bet_batches
     SET response = result_payload,
         request_hash = expected_hash,
         processing_status = CASE
           WHEN COALESCE((result_payload->>'success')::BOOLEAN, FALSE) THEN 'completed'
           ELSE 'rejected'
         END,
         completed_at = NOW()
   WHERE game_type = p_game_type
     AND round_id = p_round_id
     AND user_id = me
     AND client_batch_id = trim(p_client_batch_id);

  RETURN result_payload::json;
END;
$$;

CREATE OR REPLACE FUNCTION public.place_greedy_pro_bet_batch(
  p_round_id UUID, p_client_batch_id TEXT, p_bets JSONB
)
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.execute_realtime_game_bet_batch(
    'greedy_pro', p_round_id, p_client_batch_id, p_bets
  );
$$;

CREATE OR REPLACE FUNCTION public.place_tin_patti_pro_bet_batch(
  p_round_id UUID, p_client_batch_id TEXT, p_bets JSONB
)
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.execute_realtime_game_bet_batch(
    'tin_patti_pro', p_round_id, p_client_batch_id, p_bets
  );
$$;

CREATE OR REPLACE FUNCTION public.decorate_realtime_game_state(
  p_state JSONB,
  p_include_robot_bets BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  round_id UUID;
  round_version BIGINT;
  round_updated_at TIMESTAMPTZ;
BEGIN
  BEGIN
    round_id := NULLIF(p_state #>> '{round,id}', '')::UUID;
  EXCEPTION WHEN OTHERS THEN
    round_id := NULL;
  END;
  IF round_id IS NULL THEN
    RETURN p_state || jsonb_build_object('snapshot_at', clock_timestamp());
  END IF;

  SELECT state_version, state_updated_at
    INTO round_version, round_updated_at
    FROM public.game_rounds WHERE id = round_id;

  RETURN jsonb_set(
    p_state,
    '{bet_totals}',
    public.authoritative_game_bet_totals(round_id, p_include_robot_bets),
    true
  ) || jsonb_build_object(
    'state_version', COALESCE(round_version, 0),
    'state_updated_at', round_updated_at,
    'snapshot_at', clock_timestamp()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_greedy_pro_state()
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.decorate_realtime_game_state(
    public.get_greedy_pro_state_core_169()::jsonb, TRUE
  )::json;
$$;

CREATE OR REPLACE FUNCTION public.get_tin_patti_pro_state()
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.decorate_realtime_game_state(
    public.get_tin_patti_pro_state_core_169()::jsonb, FALSE
  )::json;
$$;

CREATE OR REPLACE FUNCTION public.get_realtime_betting_snapshot(
  p_game_type TEXT,
  p_known_round_id UUID DEFAULT NULL,
  p_known_state_version BIGINT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  state_payload JSONB;
  current_round_id UUID;
  current_version BIGINT;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Not authenticated')::json;
  END IF;
  IF p_game_type = 'greedy_pro' THEN
    state_payload := public.get_greedy_pro_state()::jsonb;
  ELSIF p_game_type = 'tin_patti_pro' THEN
    state_payload := public.get_tin_patti_pro_state()::jsonb;
  ELSE
    RETURN jsonb_build_object('success', false, 'message', 'Unsupported real-time game')::json;
  END IF;

  BEGIN
    current_round_id := NULLIF(state_payload #>> '{round,id}', '')::UUID;
    current_version := COALESCE((state_payload->>'state_version')::BIGINT, 0);
  EXCEPTION WHEN OTHERS THEN
    current_round_id := NULL;
    current_version := 0;
  END;

  RETURN (state_payload || jsonb_build_object(
    'unchanged', p_known_round_id = current_round_id
      AND p_known_state_version IS NOT NULL
      AND p_known_state_version = current_version
  ))::json;
END;
$$;

REVOKE ALL ON FUNCTION public.canonical_game_bet_request(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.game_bet_request_hash(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apply_game_round_position_total_delta(UUID, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_game_round_position_totals() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_game_round_state_version() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_greedy_pro_robot_state_version() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_single_active_realtime_game_round() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.execute_realtime_game_bet_batch(TEXT, UUID, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decorate_realtime_game_state(JSONB, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.authoritative_game_bet_totals(UUID, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.authoritative_game_user_bet_totals(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.place_greedy_pro_bet_batch_core_169(UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.place_tin_patti_pro_bet_batch_core_169(UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_greedy_pro_state_core_169() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_tin_patti_pro_state_core_169() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.place_greedy_pro_bet_batch(UUID, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.place_tin_patti_pro_bet_batch(UUID, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_greedy_pro_state() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_tin_patti_pro_state() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_realtime_betting_snapshot(TEXT, UUID, BIGINT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.place_greedy_pro_bet_batch(UUID, TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.place_tin_patti_pro_bet_batch(UUID, TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_greedy_pro_state() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_tin_patti_pro_state() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_realtime_betting_snapshot(TEXT, UUID, BIGINT) TO authenticated, service_role;

COMMENT ON TABLE public.game_round_position_totals IS
  'Authoritative per-position human bet totals for reconnect reads and realtime fan-out.';
COMMENT ON FUNCTION public.execute_realtime_game_bet_batch(TEXT, UUID, TEXT, JSONB) IS
  'Serializes duplicate requests, rejects idempotency-key payload conflicts, and delegates unchanged game rules.';
COMMENT ON FUNCTION public.get_realtime_betting_snapshot(TEXT, UUID, BIGINT) IS
  'Versioned authoritative reconnect snapshot for Greedy King and Teen Patti Pro.';
