-- Crash King: authoritative crash-game persistence, wallet RPCs, engine
-- fencing, durable outbox, provably-fair commitments and cosmetic bots.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.crash_game_configs (
  game_id TEXT NOT NULL DEFAULT 'crash', table_id TEXT NOT NULL DEFAULT 'global',
  is_active BOOLEAN NOT NULL DEFAULT FALSE, maintenance BOOLEAN NOT NULL DEFAULT TRUE,
  betting_duration_ms INT NOT NULL DEFAULT 8000 CHECK (betting_duration_ms BETWEEN 3000 AND 60000),
  result_duration_ms INT NOT NULL DEFAULT 5000 CHECK (result_duration_ms BETWEEN 1000 AND 30000),
  growth_rate NUMERIC(12,8) NOT NULL DEFAULT 0.08000000 CHECK (growth_rate BETWEEN 0.005 AND 1),
  house_edge_bps INT NOT NULL DEFAULT 100 CHECK (house_edge_bps BETWEEN 0 AND 5000),
  max_crash_multiplier_bp BIGINT NOT NULL DEFAULT 100000 CHECK (max_crash_multiplier_bp BETWEEN 100 AND 100000000),
  min_bet BIGINT NOT NULL DEFAULT 100 CHECK (min_bet > 0), max_bet BIGINT NOT NULL DEFAULT 100000 CHECK (max_bet >= min_bet),
  max_players INT NOT NULL DEFAULT 10000 CHECK(max_players BETWEEN 1 AND 100000),
  auto_cashout_min_bp BIGINT NOT NULL DEFAULT 101 CHECK(auto_cashout_min_bp>=101),
  auto_cashout_max_bp BIGINT NOT NULL DEFAULT 100000 CHECK(auto_cashout_max_bp>=auto_cashout_min_bp),
  max_round_liability BIGINT NOT NULL DEFAULT 100000000 CHECK (max_round_liability > 0),
  daily_loss_cap BIGINT CHECK(daily_loss_cap IS NULL OR daily_loss_cap>0),
  house_profile_id UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
  bot_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  bot_count_min INT NOT NULL DEFAULT 8 CHECK (bot_count_min BETWEEN 0 AND 500),
  bot_count_max INT NOT NULL DEFAULT 25 CHECK (bot_count_max BETWEEN bot_count_min AND 500),
  bot_bet_min BIGINT NOT NULL DEFAULT 500 CHECK(bot_bet_min>0),
  bot_bet_max BIGINT NOT NULL DEFAULT 50000 CHECK(bot_bet_max>=bot_bet_min),
  bot_cashout_min_bp BIGINT NOT NULL DEFAULT 105 CHECK(bot_cashout_min_bp>=100),
  bot_cashout_max_bp BIGINT NOT NULL DEFAULT 805 CHECK(bot_cashout_max_bp>=bot_cashout_min_bp),
  bot_activity_min_ms INT NOT NULL DEFAULT 250 CHECK(bot_activity_min_ms>=0),
  bot_activity_max_ms INT NOT NULL DEFAULT 7500 CHECK(bot_activity_max_ms>=bot_activity_min_ms),
  config_version BIGINT NOT NULL DEFAULT 1, updated_by UUID REFERENCES public.profiles(id), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(bot_activity_max_ms<betting_duration_ms),
  CHECK(auto_cashout_max_bp<=max_crash_multiplier_bp),
  PRIMARY KEY(game_id,table_id)
);
INSERT INTO public.crash_game_configs(game_id,table_id) VALUES('crash','global') ON CONFLICT DO NOTHING;
INSERT INTO public.game_settings(id,is_active,win_chance_percent,updated_at)
VALUES('crash',FALSE,100,NOW())
ON CONFLICT(id) DO UPDATE SET
  is_active=(SELECT c.is_active AND NOT c.maintenance FROM public.crash_game_configs c WHERE c.game_id='crash' AND c.table_id='global'),
  updated_at=NOW();

CREATE TABLE IF NOT EXISTS public.crash_internal_secrets (
  secret_name TEXT PRIMARY KEY,
  secret_value TEXT NOT NULL CHECK(length(secret_value)>=32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO public.crash_internal_secrets(secret_name,secret_value)
VALUES('seed_encryption_key',encode(extensions.gen_random_bytes(48),'base64'))
ON CONFLICT(secret_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.crash_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), game_id TEXT NOT NULL, table_id TEXT NOT NULL,
  round_number BIGINT GENERATED ALWAYS AS IDENTITY,
  status TEXT NOT NULL CHECK(status IN ('SCHEDULED','BETTING_OPEN','BETTING_LOCKED','RUNNING','CRASHED','SETTLING','SETTLED','VOIDING','VOIDED')),
  betting_opened_at TIMESTAMPTZ NOT NULL, betting_closes_at TIMESTAMPTZ NOT NULL,
  flight_started_at TIMESTAMPTZ, crash_at TIMESTAMPTZ, crashed_at TIMESTAMPTZ, settled_at TIMESTAMPTZ,
  crash_multiplier_bp BIGINT NOT NULL CHECK(crash_multiplier_bp>=100),
  seed_commitment TEXT NOT NULL, server_seed_ciphertext BYTEA NOT NULL, seed_reveal TEXT,
  algorithm_version INT NOT NULL DEFAULT 1, engine_epoch BIGINT NOT NULL, state_version BIGINT NOT NULL DEFAULT 1,
  real_bet_total BIGINT NOT NULL DEFAULT 0, real_payout_total BIGINT NOT NULL DEFAULT 0,
  bot_bet_total BIGINT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(game_id,table_id,round_number), FOREIGN KEY(game_id,table_id) REFERENCES public.crash_game_configs(game_id,table_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS crash_one_active_round_idx ON public.crash_rounds(game_id,table_id)
  WHERE status IN ('SCHEDULED','BETTING_OPEN','BETTING_LOCKED','RUNNING','CRASHED','SETTLING','VOIDING');
CREATE INDEX IF NOT EXISTS crash_round_lookup_idx ON public.crash_rounds(game_id,table_id,status,round_number DESC);

CREATE TABLE IF NOT EXISTS public.crash_bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), round_id UUID NOT NULL REFERENCES public.crash_rounds(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount BIGINT NOT NULL CHECK(amount>0), auto_cashout_bp BIGINT CHECK(auto_cashout_bp IS NULL OR auto_cashout_bp>=101),
  status TEXT NOT NULL DEFAULT 'placed' CHECK(status IN ('placed','cashed_out','lost','refunded','cancelled')),
  cashout_multiplier_bp BIGINT, payout BIGINT NOT NULL DEFAULT 0,
  placed_request_id TEXT NOT NULL, cashout_request_id TEXT,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), cashed_out_at TIMESTAMPTZ, settled_at TIMESTAMPTZ,
  UNIQUE(round_id,user_id), UNIQUE(user_id,placed_request_id), UNIQUE(user_id,cashout_request_id)
);
CREATE INDEX IF NOT EXISTS crash_bets_round_status_idx ON public.crash_bets(round_id,status);
CREATE INDEX IF NOT EXISTS crash_bets_user_history_idx ON public.crash_bets(user_id,placed_at DESC);
CREATE INDEX IF NOT EXISTS crash_bets_auto_idx ON public.crash_bets(round_id,auto_cashout_bp) WHERE status='placed' AND auto_cashout_bp IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.crash_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  command_type TEXT NOT NULL CHECK(command_type IN ('place_bet','cashout')),
  request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','completed','rejected')),
  response JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ,
  UNIQUE(user_id,command_type,request_id)
);
CREATE INDEX IF NOT EXISTS crash_commands_recovery_idx ON public.crash_commands(user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS public.crash_round_events (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, event_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  game_id TEXT NOT NULL, table_id TEXT NOT NULL, round_id UUID REFERENCES public.crash_rounds(id) ON DELETE CASCADE,
  state_version BIGINT NOT NULL, event_type TEXT NOT NULL, audience_user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  socket_sequence BIGINT, claimed_by TEXT, claimed_at TIMESTAMPTZ, published_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crash_outbox_pending_idx ON public.crash_round_events(sequence) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS public.crash_engine_leases (
  game_id TEXT NOT NULL, table_id TEXT NOT NULL, instance_id TEXT NOT NULL,
  epoch BIGINT NOT NULL DEFAULT 1, lease_expires_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_error TEXT,
  PRIMARY KEY(game_id,table_id), FOREIGN KEY(game_id,table_id) REFERENCES public.crash_game_configs(game_id,table_id)
);

CREATE TABLE IF NOT EXISTS public.crash_bot_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), round_id UUID NOT NULL REFERENCES public.crash_rounds(id) ON DELETE CASCADE,
  slot INT NOT NULL, robot_name TEXT NOT NULL, amount BIGINT NOT NULL CHECK(amount>0),
  cashout_target_bp BIGINT NOT NULL CHECK(cashout_target_bp>=100), scheduled_at TIMESTAMPTZ NOT NULL,
  emitted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(round_id,slot)
);
CREATE INDEX IF NOT EXISTS crash_bot_due_idx ON public.crash_bot_actions(scheduled_at) WHERE emitted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.crash_admin_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), admin_id UUID NOT NULL REFERENCES public.profiles(id),
  action TEXT NOT NULL, round_id UUID REFERENCES public.crash_rounds(id), reason TEXT,
  success BOOLEAN NOT NULL, details JSONB NOT NULL DEFAULT '{}'::JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS crash_admin_audit_created_idx ON public.crash_admin_audit(created_at DESC);

CREATE TABLE IF NOT EXISTS public.crash_admin_refresh_signals (
  game_id TEXT NOT NULL DEFAULT 'crash', table_id TEXT NOT NULL DEFAULT 'global',
  revision BIGINT NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(game_id,table_id)
);
INSERT INTO public.crash_admin_refresh_signals(game_id,table_id) VALUES('crash','global') ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.touch_crash_admin_refresh_signal() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE row_data JSONB:=COALESCE(to_jsonb(NEW),to_jsonb(OLD)); target_round UUID; target_game TEXT:='crash'; target_table TEXT:='global';
BEGIN
  IF row_data?'game_id' THEN target_game:=COALESCE(row_data->>'game_id','crash'); END IF;
  IF row_data?'table_id' THEN target_table:=COALESCE(row_data->>'table_id','global'); END IF;
  IF NOT row_data?'table_id' AND row_data?'round_id' THEN
    target_round:=NULLIF(row_data->>'round_id','')::UUID;
    SELECT r.game_id,r.table_id INTO target_game,target_table FROM public.crash_rounds r WHERE r.id=target_round;
  END IF;
  INSERT INTO public.crash_admin_refresh_signals(game_id,table_id,revision,updated_at)
  VALUES(COALESCE(target_game,'crash'),COALESCE(target_table,'global'),1,NOW())
  ON CONFLICT(game_id,table_id) DO UPDATE SET revision=crash_admin_refresh_signals.revision+1,updated_at=NOW();
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS crash_config_admin_refresh ON public.crash_game_configs;
CREATE TRIGGER crash_config_admin_refresh AFTER INSERT OR UPDATE OR DELETE ON public.crash_game_configs FOR EACH ROW EXECUTE FUNCTION public.touch_crash_admin_refresh_signal();
DROP TRIGGER IF EXISTS crash_round_admin_refresh ON public.crash_rounds;
CREATE TRIGGER crash_round_admin_refresh AFTER INSERT OR UPDATE OR DELETE ON public.crash_rounds FOR EACH ROW EXECUTE FUNCTION public.touch_crash_admin_refresh_signal();
DROP TRIGGER IF EXISTS crash_bet_admin_refresh ON public.crash_bets;
CREATE TRIGGER crash_bet_admin_refresh AFTER INSERT OR UPDATE OR DELETE ON public.crash_bets FOR EACH ROW EXECUTE FUNCTION public.touch_crash_admin_refresh_signal();
DROP TRIGGER IF EXISTS crash_bot_admin_refresh ON public.crash_bot_actions;
CREATE TRIGGER crash_bot_admin_refresh AFTER INSERT OR UPDATE OR DELETE ON public.crash_bot_actions FOR EACH ROW EXECUTE FUNCTION public.touch_crash_admin_refresh_signal();
DROP TRIGGER IF EXISTS crash_lease_admin_refresh ON public.crash_engine_leases;
CREATE TRIGGER crash_lease_admin_refresh AFTER INSERT OR UPDATE OR DELETE ON public.crash_engine_leases FOR EACH ROW EXECUTE FUNCTION public.touch_crash_admin_refresh_signal();
DROP TRIGGER IF EXISTS crash_event_admin_refresh ON public.crash_round_events;
CREATE TRIGGER crash_event_admin_refresh AFTER INSERT OR UPDATE OR DELETE ON public.crash_round_events FOR EACH ROW EXECUTE FUNCTION public.touch_crash_admin_refresh_signal();
DROP TRIGGER IF EXISTS crash_audit_admin_refresh ON public.crash_admin_audit;
CREATE TRIGGER crash_audit_admin_refresh AFTER INSERT OR UPDATE OR DELETE ON public.crash_admin_audit FOR EACH ROW EXECUTE FUNCTION public.touch_crash_admin_refresh_signal();

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.crash_admin_refresh_signals;
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL;
END $$;

ALTER TABLE public.crash_game_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crash_internal_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crash_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crash_bets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crash_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crash_round_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crash_engine_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crash_bot_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crash_admin_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crash_admin_refresh_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crash_game_configs,public.crash_rounds,public.crash_bets,public.crash_commands,public.crash_round_events,public.crash_engine_leases,public.crash_bot_actions FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.crash_internal_secrets FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON public.crash_admin_audit FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.crash_admin_refresh_signals FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.crash_game_configs TO authenticated;
DROP POLICY IF EXISTS crash_config_staff_read ON public.crash_game_configs;
CREATE POLICY crash_config_staff_read ON public.crash_game_configs FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.role='super_admin'));

CREATE OR REPLACE FUNCTION public.is_crash_super_admin(p_user UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_user AND role='super_admin') $$;

GRANT SELECT ON public.crash_admin_refresh_signals TO authenticated;
DROP POLICY IF EXISTS crash_admin_refresh_super_admin_read ON public.crash_admin_refresh_signals;
CREATE POLICY crash_admin_refresh_super_admin_read ON public.crash_admin_refresh_signals FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.role='super_admin'));

CREATE OR REPLACE FUNCTION public.crash_seed_key() RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE key_value TEXT:=current_setting('app.settings.crash_seed_key',TRUE);
BEGIN
  IF length(COALESCE(key_value,''))<32 THEN SELECT secret_value INTO key_value FROM public.crash_internal_secrets WHERE secret_name='seed_encryption_key'; END IF;
  IF length(COALESCE(key_value,''))<32 THEN RAISE EXCEPTION 'Crash seed encryption key is not configured'; END IF;
  RETURN key_value;
END $$;

CREATE OR REPLACE FUNCTION public.crash_request_hash(p_payload JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$ SELECT encode(extensions.digest(COALESCE(p_payload,'{}'::jsonb)::text,'sha256'),'hex') $$;

CREATE OR REPLACE FUNCTION public.crash_finish_command(p_user UUID,p_type TEXT,p_request TEXT,p_response JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  UPDATE public.crash_commands SET status=CASE WHEN COALESCE((p_response->>'success')::BOOLEAN,FALSE) THEN 'completed' ELSE 'rejected' END,
    response=p_response,completed_at=NOW() WHERE user_id=p_user AND command_type=p_type AND request_id=p_request;
  RETURN p_response;
END $$;

CREATE OR REPLACE FUNCTION public.crash_compute_point(p_seed BYTEA,p_round_id UUID,p_edge_bps INT,p_max_bp BIGINT)
RETURNS BIGINT LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE h NUMERIC; e CONSTANT NUMERIC:=4503599627370496; raw NUMERIC;
BEGIN
  h:=(('x'||substr(encode(extensions.hmac(convert_to(p_round_id::text,'UTF8'),p_seed,'sha256'),'hex'),1,13))::bit(52)::bigint)::numeric;
  raw:=floor((100*(1-p_edge_bps/10000.0)*e)/(e-h));
  RETURN LEAST(GREATEST(raw,100),p_max_bp);
END $$;

CREATE OR REPLACE FUNCTION public.crash_emit(p_round public.crash_rounds,p_type TEXT,p_payload JSONB,p_user UUID DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN INSERT INTO public.crash_round_events(game_id,table_id,round_id,state_version,event_type,audience_user_id,payload)
VALUES(p_round.game_id,p_round.table_id,p_round.id,p_round.state_version,p_type,p_user,COALESCE(p_payload,'{}')); END $$;

CREATE OR REPLACE FUNCTION public.crash_acquire_lease(p_game_id TEXT,p_table_id TEXT,p_instance_id TEXT,p_ttl_ms INT DEFAULT 5000)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE lease public.crash_engine_leases%ROWTYPE;
BEGIN
  IF length(COALESCE(p_instance_id,''))<3 OR p_ttl_ms NOT BETWEEN 1000 AND 30000 THEN RETURN jsonb_build_object('success',false,'message','Invalid lease'); END IF;
  INSERT INTO public.crash_engine_leases(game_id,table_id,instance_id,epoch,lease_expires_at)
  VALUES(p_game_id,p_table_id,p_instance_id,1,NOW()+make_interval(secs=>p_ttl_ms/1000.0))
  ON CONFLICT(game_id,table_id) DO UPDATE SET
    instance_id=EXCLUDED.instance_id,
    epoch=CASE WHEN crash_engine_leases.instance_id=EXCLUDED.instance_id THEN crash_engine_leases.epoch ELSE crash_engine_leases.epoch+1 END,
    lease_expires_at=EXCLUDED.lease_expires_at,heartbeat_at=NOW()
  WHERE crash_engine_leases.instance_id=EXCLUDED.instance_id OR crash_engine_leases.lease_expires_at<=NOW()
  RETURNING * INTO lease;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'leader',false); END IF;
  RETURN jsonb_build_object('success',true,'leader',true,'epoch',lease.epoch,'expires_at',lease.lease_expires_at);
END $$;

CREATE OR REPLACE FUNCTION public.crash_seed_bots(p_round public.crash_rounds,p_cfg public.crash_game_configs)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n BIGINT; i INT; hv BIGINT; bot_count INT;
BEGIN
  IF NOT p_cfg.bot_enabled OR p_cfg.bot_count_max=0 THEN RETURN; END IF;
  bot_count:=p_cfg.bot_count_min+mod(abs(hashtext(p_round.id::text)),p_cfg.bot_count_max-p_cfg.bot_count_min+1);
  FOR i IN 1..bot_count LOOP
    hv:=abs(hashtextextended(p_round.id::text||':'||i,0));
    INSERT INTO public.crash_bot_actions(round_id,slot,robot_name,amount,cashout_target_bp,scheduled_at)
    VALUES(p_round.id,i,'Player '||lpad(mod(hv,9999)::text,4,'0'),
      p_cfg.bot_bet_min+mod(hv,GREATEST(1,p_cfg.bot_bet_max-p_cfg.bot_bet_min+1)),
      p_cfg.bot_cashout_min_bp+mod(hv/17,GREATEST(1,p_cfg.bot_cashout_max_bp-p_cfg.bot_cashout_min_bp+1)),
      p_round.betting_opened_at+make_interval(secs=>((p_cfg.bot_activity_min_ms+mod(hv/31,GREATEST(1,LEAST(p_cfg.bot_activity_max_ms,p_cfg.betting_duration_ms-100)-p_cfg.bot_activity_min_ms+1)))::numeric/1000)))
    ON CONFLICT DO NOTHING;
  END LOOP;
  SELECT COALESCE(SUM(amount),0) INTO n FROM public.crash_bot_actions WHERE round_id=p_round.id;
  UPDATE public.crash_rounds SET bot_bet_total=n WHERE id=p_round.id;
END $$;

CREATE OR REPLACE FUNCTION public.crash_engine_start_round(p_game_id TEXT,p_table_id TEXT,p_instance_id TEXT,p_epoch BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg public.crash_game_configs%ROWTYPE; r public.crash_rounds%ROWTYPE; seed BYTEA:=extensions.gen_random_bytes(32);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_game_id),hashtext(p_table_id));
  IF NOT EXISTS(SELECT 1 FROM public.crash_engine_leases l WHERE l.game_id=p_game_id AND l.table_id=p_table_id AND l.instance_id=p_instance_id AND l.epoch=p_epoch AND l.lease_expires_at>NOW()) THEN RETURN jsonb_build_object('success',false,'code','STALE_ENGINE'); END IF;
  SELECT * INTO cfg FROM public.crash_game_configs WHERE game_id=p_game_id AND table_id=p_table_id;
  IF NOT FOUND OR NOT cfg.is_active OR cfg.maintenance THEN RETURN jsonb_build_object('success',false,'code','GAME_OFFLINE'); END IF;
  SELECT * INTO r FROM public.crash_rounds WHERE game_id=p_game_id AND table_id=p_table_id AND status IN('SCHEDULED','BETTING_OPEN','BETTING_LOCKED','RUNNING','CRASHED','SETTLING','VOIDING') LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('success',true,'round_id',r.id,'status',r.status,'reused',true); END IF;
  IF EXISTS(SELECT 1 FROM public.crash_rounds previous_round WHERE previous_round.game_id=p_game_id AND previous_round.table_id=p_table_id AND previous_round.settled_at>NOW()-make_interval(secs=>cfg.result_duration_ms/1000.0)) THEN RETURN jsonb_build_object('success',true,'code','INTERMISSION'); END IF;
  INSERT INTO public.crash_rounds(game_id,table_id,status,betting_opened_at,betting_closes_at,crash_multiplier_bp,seed_commitment,server_seed_ciphertext,engine_epoch)
  VALUES(p_game_id,p_table_id,'BETTING_OPEN',NOW(),NOW()+make_interval(secs=>cfg.betting_duration_ms/1000.0),
    100,encode(extensions.digest(seed,'sha256'),'hex'),extensions.pgp_sym_encrypt_bytea(seed,public.crash_seed_key(),'cipher-algo=aes256'),p_epoch) RETURNING * INTO r;
  UPDATE public.crash_rounds SET crash_multiplier_bp=public.crash_compute_point(seed,r.id,cfg.house_edge_bps,cfg.max_crash_multiplier_bp) WHERE id=r.id RETURNING * INTO r;
  PERFORM public.crash_seed_bots(r,cfg);
  PERFORM public.crash_emit(r,'round:betting_open',jsonb_build_object('bettingClosesAt',r.betting_closes_at,'seedCommitment',r.seed_commitment));
  RETURN jsonb_build_object('success',true,'round_id',r.id,'status',r.status,'reused',false);
END $$;

CREATE OR REPLACE FUNCTION public.crash_engine_settle_round(p_round_id UUID,p_instance_id TEXT,p_epoch BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.crash_rounds%ROWTYPE; b public.crash_bets%ROWTYPE; cfg public.crash_game_configs%ROWTYPE; bal BIGINT; house_bal BIGINT; payout_value BIGINT; activity JSONB;
BEGIN
  SELECT * INTO r FROM public.crash_rounds WHERE id=p_round_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','ROUND_NOT_FOUND'); END IF;
  IF NOT EXISTS(SELECT 1 FROM public.crash_engine_leases l WHERE l.game_id=r.game_id AND l.table_id=r.table_id AND l.instance_id=p_instance_id AND l.epoch=p_epoch AND l.lease_expires_at>NOW()) THEN RETURN jsonb_build_object('success',false,'code','STALE_ENGINE'); END IF;
  IF r.status='SETTLED' THEN RETURN jsonb_build_object('success',true,'already_settled',true); END IF;
  IF r.status<>'RUNNING' OR r.crash_at>NOW() THEN RETURN jsonb_build_object('success',false,'code','NOT_READY'); END IF;
  UPDATE public.crash_rounds SET status='CRASHED',crashed_at=COALESCE(crash_at,NOW()),state_version=state_version+1,updated_at=NOW() WHERE id=r.id RETURNING * INTO r;
  PERFORM public.crash_emit(r,'round:crashed',jsonb_build_object('crashMultiplierBp',r.crash_multiplier_bp,'crashedAt',r.crashed_at,'seedReveal',encode(extensions.pgp_sym_decrypt_bytea(r.server_seed_ciphertext,public.crash_seed_key()),'hex'),'algorithmVersion',r.algorithm_version));
  UPDATE public.crash_rounds SET status='SETTLING',state_version=state_version+1 WHERE id=r.id RETURNING * INTO r;
  SELECT * INTO cfg FROM public.crash_game_configs WHERE game_id=r.game_id AND table_id=r.table_id;
  SELECT diamonds INTO house_bal FROM public.profiles WHERE id=cfg.house_profile_id FOR UPDATE;
  FOR b IN SELECT * FROM public.crash_bets WHERE round_id=r.id AND status='placed' AND auto_cashout_bp IS NOT NULL AND auto_cashout_bp<r.crash_multiplier_bp ORDER BY user_id FOR UPDATE LOOP
    payout_value:=floor(b.amount*b.auto_cashout_bp/100.0);
    IF COALESCE(house_bal,0)<payout_value THEN RAISE EXCEPTION 'Crash house wallet cannot fund settlement'; END IF;
    UPDATE public.profiles SET diamonds=diamonds-payout_value WHERE id=cfg.house_profile_id RETURNING diamonds INTO house_bal;
    UPDATE public.profiles SET diamonds=COALESCE(diamonds,0)+payout_value WHERE id=b.user_id RETURNING diamonds INTO bal;
    UPDATE public.crash_bets SET status='cashed_out',cashout_multiplier_bp=b.auto_cashout_bp,payout=payout_value,cashed_out_at=r.flight_started_at+make_interval(secs=>ln(b.auto_cashout_bp/100.0)/(SELECT growth_rate FROM public.crash_game_configs WHERE game_id=r.game_id AND table_id=r.table_id)),settled_at=NOW() WHERE id=b.id;
    INSERT INTO public.transactions(user_id,type,currency,amount,balance_after,related_entity_type,related_entity_id,status,notes) VALUES(b.user_id,'game_win','diamond',payout_value,bal,'crash_bet',b.id,'completed','Crash King auto cashout');
    INSERT INTO public.transactions(user_id,related_user_id,type,currency,amount,balance_after,related_entity_type,related_entity_id,status,notes) VALUES(cfg.house_profile_id,b.user_id,'game_payout_house','diamond',-payout_value,house_bal,'crash_bet',b.id,'completed','Crash house funded auto cashout');
    PERFORM public.crash_emit(r,'cashout:confirmed',jsonb_build_object('betId',b.id,'cashoutMultiplierBp',b.auto_cashout_bp,'payout',payout_value,'wallet',bal),b.user_id);
    SELECT jsonb_build_object('id',b.id,'name',COALESCE(p.full_name,'Player'),'avatarUrl',p.avatar_url,'amount',b.amount,'cashoutMultiplierBp',b.auto_cashout_bp,'simulated',FALSE) INTO activity FROM public.profiles p WHERE p.id=b.user_id;
    PERFORM public.crash_emit(r,'bet:public_activity',activity);
  END LOOP;
  UPDATE public.crash_bets SET status='lost',settled_at=NOW() WHERE round_id=r.id AND status='placed';
  SELECT COALESCE(SUM(payout),0) INTO payout_value FROM public.crash_bets WHERE round_id=r.id;
  UPDATE public.crash_rounds SET status='SETTLED',settled_at=NOW(),seed_reveal=encode(extensions.pgp_sym_decrypt_bytea(server_seed_ciphertext,public.crash_seed_key()),'hex'),real_payout_total=payout_value,state_version=state_version+1,updated_at=NOW() WHERE id=r.id RETURNING * INTO r;
  PERFORM public.crash_emit(r,'round:settled',jsonb_build_object('crashMultiplierBp',r.crash_multiplier_bp,'seedReveal',r.seed_reveal));
  RETURN jsonb_build_object('success',true,'round_id',r.id,'crashMultiplierBp',r.crash_multiplier_bp);
END $$;

CREATE OR REPLACE FUNCTION public.crash_engine_process_auto_cashouts(p_round_id UUID,p_instance_id TEXT,p_epoch BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.crash_rounds%ROWTYPE; cfg public.crash_game_configs%ROWTYPE; b public.crash_bets%ROWTYPE; current_bp BIGINT; payout_value BIGINT; house_bal BIGINT; player_bal BIGINT; processed INT:=0; activity JSONB;
BEGIN
  SELECT * INTO r FROM public.crash_rounds WHERE id=p_round_id FOR UPDATE;
  IF NOT FOUND OR r.status<>'RUNNING' THEN RETURN jsonb_build_object('success',true,'processed',0); END IF;
  IF NOT EXISTS(SELECT 1 FROM public.crash_engine_leases l WHERE l.game_id=r.game_id AND l.table_id=r.table_id AND l.instance_id=p_instance_id AND l.epoch=p_epoch AND l.lease_expires_at>NOW()) THEN RETURN jsonb_build_object('success',false,'code','STALE_ENGINE'); END IF;
  SELECT * INTO cfg FROM public.crash_game_configs WHERE game_id=r.game_id AND table_id=r.table_id;
  current_bp:=LEAST(r.crash_multiplier_bp,FLOOR(EXP(cfg.growth_rate*EXTRACT(EPOCH FROM (clock_timestamp()-r.flight_started_at)))*100));
  SELECT diamonds INTO house_bal FROM public.profiles WHERE id=cfg.house_profile_id FOR UPDATE;
  FOR b IN SELECT * FROM public.crash_bets WHERE round_id=r.id AND status='placed' AND auto_cashout_bp IS NOT NULL AND auto_cashout_bp<=current_bp AND auto_cashout_bp<r.crash_multiplier_bp ORDER BY user_id FOR UPDATE LOOP
    payout_value:=floor(b.amount*b.auto_cashout_bp/100.0);
    IF COALESCE(house_bal,0)<payout_value THEN RAISE EXCEPTION 'Crash house wallet cannot fund auto cashout'; END IF;
    UPDATE public.profiles SET diamonds=diamonds-payout_value WHERE id=cfg.house_profile_id RETURNING diamonds INTO house_bal;
    UPDATE public.profiles SET diamonds=COALESCE(diamonds,0)+payout_value WHERE id=b.user_id RETURNING diamonds INTO player_bal;
    UPDATE public.crash_bets SET status='cashed_out',cashout_multiplier_bp=b.auto_cashout_bp,payout=payout_value,cashed_out_at=r.flight_started_at+make_interval(secs=>ln(b.auto_cashout_bp/100.0)/cfg.growth_rate),settled_at=NOW() WHERE id=b.id;
    INSERT INTO public.transactions(user_id,type,currency,amount,balance_after,related_entity_type,related_entity_id,status,notes) VALUES(b.user_id,'game_win','diamond',payout_value,player_bal,'crash_bet',b.id,'completed','Crash auto cashout');
    INSERT INTO public.transactions(user_id,related_user_id,type,currency,amount,balance_after,related_entity_type,related_entity_id,status,notes) VALUES(cfg.house_profile_id,b.user_id,'game_payout_house','diamond',-payout_value,house_bal,'crash_bet',b.id,'completed','Crash house funded auto cashout');
    processed:=processed+1;
    UPDATE public.crash_rounds SET real_payout_total=real_payout_total+payout_value,state_version=state_version+1,updated_at=NOW() WHERE id=r.id RETURNING * INTO r;
    PERFORM public.crash_emit(r,'cashout:confirmed',jsonb_build_object('betId',b.id,'cashoutMultiplierBp',b.auto_cashout_bp,'payout',payout_value,'wallet',player_bal),b.user_id);
    SELECT jsonb_build_object('id',b.id,'name',COALESCE(p.full_name,'Player'),'avatarUrl',p.avatar_url,'amount',b.amount,'cashoutMultiplierBp',b.auto_cashout_bp,'simulated',FALSE) INTO activity FROM public.profiles p WHERE p.id=b.user_id;
    PERFORM public.crash_emit(r,'bet:public_activity',activity);
  END LOOP;
  RETURN jsonb_build_object('success',true,'processed',processed,'currentMultiplierBp',current_bp);
END $$;

CREATE OR REPLACE FUNCTION public.crash_engine_advance(p_game_id TEXT,p_table_id TEXT,p_instance_id TEXT,p_epoch BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.crash_rounds%ROWTYPE; cfg public.crash_game_configs%ROWTYPE;
BEGIN
  SELECT * INTO cfg FROM public.crash_game_configs WHERE game_id=p_game_id AND table_id=p_table_id;
  SELECT * INTO r FROM public.crash_rounds WHERE game_id=p_game_id AND table_id=p_table_id AND status IN('SCHEDULED','BETTING_OPEN','BETTING_LOCKED','RUNNING','CRASHED','SETTLING','VOIDING') ORDER BY round_number DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN public.crash_engine_start_round(p_game_id,p_table_id,p_instance_id,p_epoch); END IF;
  IF r.engine_epoch<>p_epoch OR NOT EXISTS(SELECT 1 FROM public.crash_engine_leases l WHERE l.game_id=p_game_id AND l.table_id=p_table_id AND l.instance_id=p_instance_id AND l.epoch=p_epoch AND l.lease_expires_at>NOW()) THEN RETURN jsonb_build_object('success',false,'code','STALE_ENGINE'); END IF;
  IF r.status='BETTING_OPEN' AND r.betting_closes_at<=NOW() THEN
    UPDATE public.crash_rounds SET status='BETTING_LOCKED',state_version=state_version+1,updated_at=NOW() WHERE id=r.id RETURNING * INTO r;
    PERFORM public.crash_emit(r,'round:betting_locked','{}');
    UPDATE public.crash_rounds SET status='RUNNING',flight_started_at=NOW(),crash_at=NOW()+make_interval(secs=>ln(crash_multiplier_bp/100.0)/cfg.growth_rate),state_version=state_version+1,updated_at=NOW() WHERE id=r.id RETURNING * INTO r;
    PERFORM public.crash_emit(r,'round:flight_started',jsonb_build_object('flightStartedAt',r.flight_started_at,'growthRate',cfg.growth_rate));
  END IF;
  IF r.status='RUNNING' THEN
    PERFORM public.crash_engine_process_auto_cashouts(r.id,p_instance_id,p_epoch);
    SELECT * INTO r FROM public.crash_rounds WHERE id=r.id;
    IF r.crash_at<=NOW() THEN RETURN public.crash_engine_settle_round(r.id,p_instance_id,p_epoch); END IF;
  END IF;
  RETURN jsonb_build_object('success',true,'round_id',r.id,'status',r.status,'state_version',r.state_version,
    'flight_started_at',r.flight_started_at,'crash_at',r.crash_at,'growth_rate',cfg.growth_rate);
END $$;

CREATE OR REPLACE FUNCTION public.place_crash_bet(p_round_id UUID,p_request_id TEXT,p_amount BIGINT,p_auto_cashout_bp BIGINT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE me UUID:=auth.uid(); req_hash TEXT; cmd public.crash_commands%ROWTYPE; r public.crash_rounds%ROWTYPE; cfg public.crash_game_configs%ROWTYPE; bal BIGINT; house_bal BIGINT; bet_id UUID; liability NUMERIC; response JSONB; activity JSONB; loss_24h BIGINT; player_count INT;
BEGIN
  IF me IS NULL THEN RETURN jsonb_build_object('success',false,'code','NOT_AUTHENTICATED'); END IF;
  IF length(COALESCE(p_request_id,'')) NOT BETWEEN 8 AND 160 THEN RETURN jsonb_build_object('success',false,'code','INVALID_REQUEST'); END IF;
  req_hash:=public.crash_request_hash(jsonb_build_object('roundId',p_round_id,'amount',p_amount,'autoCashoutBp',p_auto_cashout_bp));
  PERFORM pg_advisory_xact_lock(hashtext('crash-user'),hashtext(me::text));
  SELECT * INTO cmd FROM public.crash_commands WHERE user_id=me AND command_type='place_bet' AND request_id=p_request_id FOR UPDATE;
  IF FOUND THEN IF cmd.request_hash<>req_hash THEN RETURN jsonb_build_object('success',false,'code','IDEMPOTENCY_CONFLICT'); END IF; IF cmd.response IS NOT NULL THEN RETURN cmd.response; END IF; END IF;
  INSERT INTO public.crash_commands(user_id,command_type,request_id,request_hash) VALUES(me,'place_bet',p_request_id,req_hash) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.crash_rounds WHERE id=p_round_id FOR UPDATE;
  IF NOT FOUND OR r.status<>'BETTING_OPEN' OR r.betting_closes_at<=clock_timestamp() THEN RETURN public.crash_finish_command(me,'place_bet',p_request_id,jsonb_build_object('success',false,'code','BETTING_CLOSED')); END IF;
  SELECT * INTO cfg FROM public.crash_game_configs WHERE game_id=r.game_id AND table_id=r.table_id;
  IF NOT cfg.is_active OR cfg.maintenance THEN RETURN public.crash_finish_command(me,'place_bet',p_request_id,jsonb_build_object('success',false,'code','GAME_OFFLINE')); END IF;
  IF cfg.house_profile_id IS NULL OR cfg.house_profile_id=me THEN RETURN public.crash_finish_command(me,'place_bet',p_request_id,jsonb_build_object('success',false,'code','HOUSE_NOT_CONFIGURED')); END IF;
  IF p_amount NOT BETWEEN cfg.min_bet AND cfg.max_bet OR (p_auto_cashout_bp IS NOT NULL AND (p_auto_cashout_bp<cfg.auto_cashout_min_bp OR p_auto_cashout_bp>cfg.auto_cashout_max_bp)) THEN RETURN public.crash_finish_command(me,'place_bet',p_request_id,jsonb_build_object('success',false,'code','INVALID_BET')); END IF;
  SELECT COUNT(*) INTO player_count FROM public.crash_bets WHERE round_id=r.id;
  IF player_count>=cfg.max_players THEN RETURN public.crash_finish_command(me,'place_bet',p_request_id,jsonb_build_object('success',false,'code','ROUND_FULL')); END IF;
  IF cfg.daily_loss_cap IS NOT NULL THEN
    SELECT GREATEST(0,-COALESCE(SUM(t.amount),0))::BIGINT INTO loss_24h FROM public.transactions t WHERE t.user_id=me AND t.currency='diamond' AND t.related_entity_type='crash_bet' AND t.created_at>=NOW()-INTERVAL '24 hours';
    IF loss_24h+p_amount>cfg.daily_loss_cap THEN RETURN public.crash_finish_command(me,'place_bet',p_request_id,jsonb_build_object('success',false,'code','DAILY_LOSS_CAP')); END IF;
  END IF;
  SELECT COALESCE(SUM(amount*COALESCE(auto_cashout_bp,cfg.max_crash_multiplier_bp)/100.0),0)+p_amount*COALESCE(p_auto_cashout_bp,cfg.max_crash_multiplier_bp)/100.0 INTO liability FROM public.crash_bets WHERE round_id=r.id;
  IF liability>cfg.max_round_liability THEN RETURN public.crash_finish_command(me,'place_bet',p_request_id,jsonb_build_object('success',false,'code','LIABILITY_LIMIT')); END IF;
  SELECT diamonds INTO bal FROM public.profiles WHERE id=me AND NOT COALESCE(is_banned,false) FOR UPDATE;
  IF COALESCE(bal,0)<p_amount THEN RETURN public.crash_finish_command(me,'place_bet',p_request_id,jsonb_build_object('success',false,'code','INSUFFICIENT_BALANCE')); END IF;
  SELECT diamonds INTO house_bal FROM public.profiles WHERE id=cfg.house_profile_id FOR UPDATE;
  IF COALESCE(house_bal,0)+p_amount<liability THEN RETURN public.crash_finish_command(me,'place_bet',p_request_id,jsonb_build_object('success',false,'code','HOUSE_LIQUIDITY_LIMIT')); END IF;
  UPDATE public.profiles SET diamonds=diamonds-p_amount WHERE id=me RETURNING diamonds INTO bal;
  UPDATE public.profiles SET diamonds=COALESCE(diamonds,0)+p_amount WHERE id=cfg.house_profile_id RETURNING diamonds INTO house_bal;
  INSERT INTO public.crash_bets(round_id,user_id,amount,auto_cashout_bp,placed_request_id) VALUES(r.id,me,p_amount,p_auto_cashout_bp,p_request_id) RETURNING id INTO bet_id;
  INSERT INTO public.transactions(user_id,type,currency,amount,balance_after,related_entity_type,related_entity_id,status,notes) VALUES(me,'game_bet','diamond',-p_amount,bal,'crash_bet',bet_id,'completed','Crash King bet');
  INSERT INTO public.transactions(user_id,related_user_id,type,currency,amount,balance_after,related_entity_type,related_entity_id,status,notes) VALUES(cfg.house_profile_id,me,'game_bet_house','diamond',p_amount,house_bal,'crash_bet',bet_id,'completed','Crash house received bet stake');
  UPDATE public.crash_rounds SET real_bet_total=real_bet_total+p_amount,state_version=state_version+1,updated_at=NOW() WHERE id=r.id RETURNING * INTO r;
  response:=jsonb_build_object('success',true,'betId',bet_id,'roundId',r.id,'amount',p_amount,'autoCashoutBp',p_auto_cashout_bp,'wallet',bal,'stateVersion',r.state_version);
  PERFORM public.crash_emit(r,'bet:accepted',response,me);
  SELECT jsonb_build_object('id',bet_id,'name',COALESCE(p.full_name,'Player'),'avatarUrl',p.avatar_url,'amount',p_amount,'cashoutMultiplierBp',NULL,'simulated',FALSE) INTO activity FROM public.profiles p WHERE p.id=me;
  PERFORM public.crash_emit(r,'bet:public_activity',activity);
  RETURN public.crash_finish_command(me,'place_bet',p_request_id,response);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success',false,'code','BET_ALREADY_PLACED');
END $$;

CREATE OR REPLACE FUNCTION public.cash_out_crash_bet(p_round_id UUID,p_bet_id UUID,p_request_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE me UUID:=auth.uid(); req_hash TEXT; cmd public.crash_commands%ROWTYPE; b public.crash_bets%ROWTYPE; r public.crash_rounds%ROWTYPE; cfg public.crash_game_configs%ROWTYPE; mult BIGINT; payout_value BIGINT; bal BIGINT; house_bal BIGINT; response JSONB; activity JSONB;
BEGIN
  IF me IS NULL THEN RETURN jsonb_build_object('success',false,'code','NOT_AUTHENTICATED'); END IF;
  IF length(COALESCE(p_request_id,'')) NOT BETWEEN 8 AND 160 THEN RETURN jsonb_build_object('success',false,'code','INVALID_REQUEST'); END IF;
  req_hash:=public.crash_request_hash(jsonb_build_object('roundId',p_round_id,'betId',p_bet_id)); PERFORM pg_advisory_xact_lock(hashtext('crash-user'),hashtext(me::text));
  SELECT * INTO cmd FROM public.crash_commands WHERE user_id=me AND command_type='cashout' AND request_id=p_request_id FOR UPDATE;
  IF FOUND THEN IF cmd.request_hash<>req_hash THEN RETURN jsonb_build_object('success',false,'code','IDEMPOTENCY_CONFLICT'); END IF; IF cmd.response IS NOT NULL THEN RETURN cmd.response; END IF; END IF;
  INSERT INTO public.crash_commands(user_id,command_type,request_id,request_hash) VALUES(me,'cashout',p_request_id,req_hash) ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM public.crash_bets WHERE id=p_bet_id AND round_id=p_round_id AND user_id=me) THEN RETURN public.crash_finish_command(me,'cashout',p_request_id,jsonb_build_object('success',false,'code','BET_NOT_FOUND')); END IF;
  SELECT * INTO r FROM public.crash_rounds WHERE id=p_round_id FOR UPDATE;
  IF NOT FOUND THEN RETURN public.crash_finish_command(me,'cashout',p_request_id,jsonb_build_object('success',false,'code','ROUND_NOT_FOUND')); END IF;
  SELECT * INTO b FROM public.crash_bets WHERE id=p_bet_id AND round_id=r.id AND user_id=me FOR UPDATE;
  IF NOT FOUND THEN RETURN public.crash_finish_command(me,'cashout',p_request_id,jsonb_build_object('success',false,'code','BET_NOT_FOUND')); END IF;
  IF b.status='cashed_out' THEN RETURN public.crash_finish_command(me,'cashout',p_request_id,jsonb_build_object('success',true,'betId',b.id,'cashoutMultiplierBp',b.cashout_multiplier_bp,'payout',b.payout,'alreadyProcessed',true)); END IF;
  IF b.status<>'placed' THEN RETURN public.crash_finish_command(me,'cashout',p_request_id,jsonb_build_object('success',false,'code','BET_NOT_ACTIVE')); END IF;
  SELECT * INTO cfg FROM public.crash_game_configs WHERE game_id=r.game_id AND table_id=r.table_id;
  IF r.status<>'RUNNING' OR clock_timestamp()>=r.crash_at THEN RETURN public.crash_finish_command(me,'cashout',p_request_id,jsonb_build_object('success',false,'code','CRASHED')); END IF;
  mult:=LEAST(r.crash_multiplier_bp,FLOOR(EXP(cfg.growth_rate*EXTRACT(EPOCH FROM (clock_timestamp()-r.flight_started_at)))*100));
  IF mult<100 THEN RETURN public.crash_finish_command(me,'cashout',p_request_id,jsonb_build_object('success',false,'code','TOO_EARLY')); END IF;
  payout_value:=floor(b.amount*mult/100.0);
  SELECT diamonds INTO house_bal FROM public.profiles WHERE id=cfg.house_profile_id FOR UPDATE;
  IF COALESCE(house_bal,0)<payout_value THEN RETURN public.crash_finish_command(me,'cashout',p_request_id,jsonb_build_object('success',false,'code','HOUSE_LIQUIDITY_ERROR')); END IF;
  UPDATE public.profiles SET diamonds=diamonds-payout_value WHERE id=cfg.house_profile_id RETURNING diamonds INTO house_bal;
  UPDATE public.profiles SET diamonds=COALESCE(diamonds,0)+payout_value WHERE id=me RETURNING diamonds INTO bal;
  UPDATE public.crash_bets SET status='cashed_out',cashout_request_id=p_request_id,cashout_multiplier_bp=mult,payout=payout_value,cashed_out_at=clock_timestamp(),settled_at=NOW() WHERE id=b.id;
  INSERT INTO public.transactions(user_id,type,currency,amount,balance_after,related_entity_type,related_entity_id,status,notes) VALUES(me,'game_win','diamond',payout_value,bal,'crash_bet',b.id,'completed','Crash King manual cashout');
  INSERT INTO public.transactions(user_id,related_user_id,type,currency,amount,balance_after,related_entity_type,related_entity_id,status,notes) VALUES(cfg.house_profile_id,me,'game_payout_house','diamond',-payout_value,house_bal,'crash_bet',b.id,'completed','Crash house funded manual cashout');
  UPDATE public.crash_rounds SET real_payout_total=real_payout_total+payout_value,state_version=state_version+1,updated_at=NOW() WHERE id=r.id RETURNING * INTO r;
  response:=jsonb_build_object('success',true,'betId',b.id,'roundId',r.id,'cashoutMultiplierBp',mult,'payout',payout_value,'wallet',bal,'stateVersion',r.state_version); PERFORM public.crash_emit(r,'cashout:confirmed',response,me);
  SELECT jsonb_build_object('id',b.id,'name',COALESCE(p.full_name,'Player'),'avatarUrl',p.avatar_url,'amount',b.amount,'cashoutMultiplierBp',mult,'simulated',FALSE) INTO activity FROM public.profiles p WHERE p.id=me;
  PERFORM public.crash_emit(r,'bet:public_activity',activity);
  RETURN public.crash_finish_command(me,'cashout',p_request_id,response);
END $$;

CREATE OR REPLACE FUNCTION public.get_crash_snapshot(p_game_id TEXT DEFAULT 'crash',p_table_id TEXT DEFAULT 'global',p_known_version BIGINT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE me UUID:=auth.uid(); r public.crash_rounds%ROWTYPE; cfg public.crash_game_configs%ROWTYPE; my_bet JSONB; wallet BIGINT; history JSONB; activity JSONB;
BEGIN
  IF me IS NULL THEN RETURN jsonb_build_object('success',false,'code','NOT_AUTHENTICATED'); END IF;
  SELECT * INTO cfg FROM public.crash_game_configs WHERE game_id=p_game_id AND table_id=p_table_id;
  SELECT * INTO r FROM public.crash_rounds WHERE game_id=p_game_id AND table_id=p_table_id ORDER BY round_number DESC LIMIT 1;
  SELECT diamonds INTO wallet FROM public.profiles WHERE id=me;
  IF r.id IS NOT NULL THEN
    SELECT jsonb_build_object('id',b.id,'amount',b.amount,'autoCashoutBp',b.auto_cashout_bp,'status',b.status,'cashoutMultiplierBp',b.cashout_multiplier_bp,'payout',b.payout) INTO my_bet FROM public.crash_bets b WHERE b.round_id=r.id AND b.user_id=me;
    SELECT COALESCE(jsonb_agg(row_payload ORDER BY activity_at DESC),'[]') INTO activity FROM (
      SELECT * FROM (
        SELECT jsonb_build_object('id',b.id,'name',COALESCE(p.full_name,'Player'),'avatarUrl',p.avatar_url,'amount',b.amount,'cashoutMultiplierBp',b.cashout_multiplier_bp,'simulated',false) AS row_payload,b.placed_at AS activity_at
        FROM public.crash_bets b JOIN public.profiles p ON p.id=b.user_id WHERE b.round_id=r.id
        UNION ALL
        SELECT jsonb_build_object('id',a.id,'name',a.robot_name,'amount',a.amount,'cashoutMultiplierBp',a.cashout_target_bp,'simulated',true),a.scheduled_at FROM public.crash_bot_actions a WHERE a.round_id=r.id AND a.emitted_at IS NOT NULL
      ) all_activity ORDER BY activity_at DESC LIMIT 50
    ) activity_rows;
  END IF;
  SELECT COALESCE(jsonb_agg(x ORDER BY x.round_number DESC),'[]') INTO history FROM (SELECT id AS "roundId",round_number,crash_multiplier_bp AS "crashMultiplierBp",seed_commitment AS "seedCommitment",seed_reveal AS "revealedSeed" FROM public.crash_rounds WHERE game_id=p_game_id AND table_id=p_table_id AND status='SETTLED' ORDER BY round_number DESC LIMIT 20) x;
  RETURN jsonb_build_object('success',true,'unchanged',p_known_version IS NOT NULL AND p_known_version=COALESCE(r.state_version,0),'serverNow',NOW(),'wallet',wallet,
    'config',jsonb_build_object('isActive',cfg.is_active,'maintenance',cfg.maintenance,'growthRate',cfg.growth_rate,'minBet',cfg.min_bet,'maxBet',cfg.max_bet,'autoCashoutMinBp',cfg.auto_cashout_min_bp,'autoCashoutMaxBp',cfg.auto_cashout_max_bp,'maxPlayers',cfg.max_players),
    'round',CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('id',r.id,'roundNumber',r.round_number,'phase',r.status,'bettingClosesAt',r.betting_closes_at,'flightStartedAt',r.flight_started_at,'crashedAt',r.crashed_at,'growthRate',cfg.growth_rate,'crashMultiplierBp',CASE WHEN r.status IN('CRASHED','SETTLING','SETTLED','VOIDED') THEN r.crash_multiplier_bp ELSE NULL END,'seedCommitment',r.seed_commitment,'revealedSeed',r.seed_reveal,'algorithmVersion',r.algorithm_version::text,'stateVersion',r.state_version,'realBetTotal',r.real_bet_total,'botBetTotal',r.bot_bet_total) END,
    'myBet',my_bet,'publicActivity',COALESCE(activity,'[]'::jsonb),'history',history);
END $$;

CREATE OR REPLACE FUNCTION public.get_crash_connection_limit(p_game_id TEXT DEFAULT 'crash',p_table_id TEXT DEFAULT 'global')
RETURNS INT LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT COALESCE((SELECT max_players FROM public.crash_game_configs WHERE game_id=p_game_id AND table_id=p_table_id),10000)
$$;

CREATE OR REPLACE FUNCTION public.crash_service_readiness(p_game_id TEXT DEFAULT 'crash',p_table_id TEXT DEFAULT 'global')
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT jsonb_build_object(
    'ready', c.game_id IS NOT NULL
      AND length(public.crash_seed_key())>=32
      AND c.house_profile_id IS NOT NULL AND p.id IS NOT NULL,
    'database',TRUE,
    'configFound',c.game_id IS NOT NULL,
    'seedConfigured',length(public.crash_seed_key())>=32,
    'houseConfigured',c.house_profile_id IS NOT NULL AND p.id IS NOT NULL,
    'gameActive',COALESCE(c.is_active,FALSE),
    'maintenance',COALESCE(c.maintenance,TRUE)
  )
  FROM (SELECT 1) anchor
  LEFT JOIN public.crash_game_configs c ON c.game_id=p_game_id AND c.table_id=p_table_id
  LEFT JOIN public.profiles p ON p.id=c.house_profile_id
$$;

CREATE OR REPLACE FUNCTION public.crash_void_round(p_round_id UUID,p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.crash_rounds%ROWTYPE; b public.crash_bets%ROWTYPE; cfg public.crash_game_configs%ROWTYPE; bal BIGINT; house_bal BIGINT;
BEGIN
  SELECT * INTO r FROM public.crash_rounds WHERE id=p_round_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','ROUND_NOT_FOUND'); END IF;
  IF EXISTS(SELECT 1 FROM public.crash_bets WHERE round_id=r.id AND status='cashed_out') THEN RETURN jsonb_build_object('success',false,'code','PAYOUTS_ALREADY_MADE'); END IF;
  SELECT * INTO cfg FROM public.crash_game_configs WHERE game_id=r.game_id AND table_id=r.table_id;
  SELECT diamonds INTO house_bal FROM public.profiles WHERE id=cfg.house_profile_id FOR UPDATE;
  IF COALESCE(house_bal,0)<COALESCE((SELECT SUM(amount) FROM public.crash_bets WHERE round_id=r.id AND status IN('placed','lost')),0) THEN RETURN jsonb_build_object('success',false,'code','HOUSE_LIQUIDITY_ERROR'); END IF;
  UPDATE public.crash_rounds SET status='VOIDING',state_version=state_version+1,updated_at=NOW() WHERE id=r.id RETURNING * INTO r;
  FOR b IN SELECT * FROM public.crash_bets WHERE round_id=r.id AND status IN('placed','lost') ORDER BY user_id FOR UPDATE LOOP
    UPDATE public.profiles SET diamonds=diamonds-b.amount WHERE id=cfg.house_profile_id RETURNING diamonds INTO house_bal;
    UPDATE public.profiles SET diamonds=COALESCE(diamonds,0)+b.amount WHERE id=b.user_id RETURNING diamonds INTO bal;
    UPDATE public.crash_bets SET status='refunded',payout=b.amount,settled_at=NOW() WHERE id=b.id;
    INSERT INTO public.transactions(user_id,type,currency,amount,balance_after,related_entity_type,related_entity_id,status,notes) VALUES(b.user_id,'game_refund','diamond',b.amount,bal,'crash_bet',b.id,'completed','Crash King void refund: '||COALESCE(p_reason,'unspecified'));
    INSERT INTO public.transactions(user_id,related_user_id,type,currency,amount,balance_after,related_entity_type,related_entity_id,status,notes) VALUES(cfg.house_profile_id,b.user_id,'game_refund_house','diamond',-b.amount,house_bal,'crash_bet',b.id,'completed','Crash house funded void refund');
  END LOOP;
  UPDATE public.crash_rounds SET status='VOIDED',settled_at=NOW(),seed_reveal=encode(extensions.pgp_sym_decrypt_bytea(server_seed_ciphertext,public.crash_seed_key()),'hex'),state_version=state_version+1,updated_at=NOW() WHERE id=r.id RETURNING * INTO r;
  PERFORM public.crash_emit(r,'round:voided',jsonb_build_object('reason',p_reason,'seedReveal',r.seed_reveal)); RETURN jsonb_build_object('success',true,'round_id',r.id);
END $$;

CREATE OR REPLACE FUNCTION public.admin_void_crash_round(p_round_id UUID,p_reason TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN IF NOT public.is_crash_super_admin(auth.uid()) THEN RETURN jsonb_build_object('success',false,'code','SUPER_ADMIN_REQUIRED'); END IF; RETURN public.crash_void_round(p_round_id,p_reason); END $$;
CREATE OR REPLACE FUNCTION public.admin_set_crash_maintenance(p_game_id TEXT,p_table_id TEXT,p_maintenance BOOLEAN) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE active_value BOOLEAN; updated BOOLEAN:=FALSE;
BEGIN IF NOT public.is_crash_super_admin(auth.uid()) THEN RETURN jsonb_build_object('success',false,'code','SUPER_ADMIN_REQUIRED'); END IF; UPDATE public.crash_game_configs SET maintenance=p_maintenance,config_version=config_version+1,updated_by=auth.uid(),updated_at=NOW() WHERE game_id=p_game_id AND table_id=p_table_id RETURNING is_active INTO active_value; updated:=FOUND; IF p_game_id='crash' AND p_table_id='global' AND updated THEN UPDATE public.game_settings SET is_active=active_value AND NOT p_maintenance,updated_at=NOW() WHERE id='crash'; END IF; RETURN jsonb_build_object('success',updated,'maintenance',p_maintenance); END $$;

CREATE OR REPLACE FUNCTION public.admin_update_crash_config(p_patch JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg public.crash_game_configs%ROWTYPE; allowed CONSTANT TEXT[]:=ARRAY['is_active','betting_duration_ms','result_duration_ms','growth_rate','house_edge_bps','max_crash_multiplier_bp','min_bet','max_bet','max_players','auto_cashout_min_bp','auto_cashout_max_bp','max_round_liability','daily_loss_cap','house_profile_id','bot_enabled','bot_count_min','bot_count_max','bot_bet_min','bot_bet_max','bot_cashout_min_bp','bot_cashout_max_bp','bot_activity_min_ms','bot_activity_max_ms']; unknown_keys TEXT[]; target_active BOOLEAN; target_house UUID;
BEGIN
  IF NOT public.is_crash_super_admin(auth.uid()) THEN RETURN jsonb_build_object('success',false,'message','Super admin access required'); END IF;
  SELECT ARRAY_AGG(key) INTO unknown_keys FROM jsonb_object_keys(COALESCE(p_patch,'{}')) key WHERE NOT key=ANY(allowed);
  IF unknown_keys IS NOT NULL THEN RETURN jsonb_build_object('success',false,'message','Unsupported config keys','keys',unknown_keys); END IF;
  SELECT * INTO cfg FROM public.crash_game_configs WHERE game_id='crash' AND table_id='global' FOR UPDATE;
  target_active:=COALESCE((p_patch->>'is_active')::BOOLEAN,cfg.is_active);
  target_house:=CASE WHEN p_patch?'house_profile_id' THEN NULLIF(p_patch->>'house_profile_id','')::UUID ELSE cfg.house_profile_id END;
  IF p_patch?'is_active' AND target_active THEN
    IF length(public.crash_seed_key())<32 THEN RETURN jsonb_build_object('success',false,'message','Configure the crash seed encryption key before enabling the game'); END IF;
    IF target_house IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=target_house AND COALESCE(p.diamonds,0)>0) THEN RETURN jsonb_build_object('success',false,'message','Choose and fund the Crash house profile before enabling the game'); END IF;
  END IF;
  UPDATE public.crash_game_configs SET
    is_active=target_active,maintenance=CASE WHEN p_patch?'is_active' THEN NOT target_active ELSE cfg.maintenance END,
    betting_duration_ms=COALESCE((p_patch->>'betting_duration_ms')::INT,cfg.betting_duration_ms),result_duration_ms=COALESCE((p_patch->>'result_duration_ms')::INT,cfg.result_duration_ms),
    growth_rate=COALESCE((p_patch->>'growth_rate')::NUMERIC,cfg.growth_rate),house_edge_bps=COALESCE((p_patch->>'house_edge_bps')::INT,cfg.house_edge_bps),max_crash_multiplier_bp=COALESCE((p_patch->>'max_crash_multiplier_bp')::BIGINT,cfg.max_crash_multiplier_bp),
    min_bet=COALESCE((p_patch->>'min_bet')::BIGINT,cfg.min_bet),max_bet=COALESCE((p_patch->>'max_bet')::BIGINT,cfg.max_bet),max_players=COALESCE((p_patch->>'max_players')::INT,cfg.max_players),
    auto_cashout_min_bp=COALESCE((p_patch->>'auto_cashout_min_bp')::BIGINT,cfg.auto_cashout_min_bp),auto_cashout_max_bp=COALESCE((p_patch->>'auto_cashout_max_bp')::BIGINT,cfg.auto_cashout_max_bp),
    max_round_liability=COALESCE((p_patch->>'max_round_liability')::BIGINT,cfg.max_round_liability),daily_loss_cap=CASE WHEN p_patch?'daily_loss_cap' THEN NULLIF(p_patch->>'daily_loss_cap','')::BIGINT ELSE cfg.daily_loss_cap END,
    house_profile_id=CASE WHEN p_patch?'house_profile_id' THEN NULLIF(p_patch->>'house_profile_id','')::UUID ELSE cfg.house_profile_id END,
    bot_enabled=COALESCE((p_patch->>'bot_enabled')::BOOLEAN,cfg.bot_enabled),bot_count_min=COALESCE((p_patch->>'bot_count_min')::INT,cfg.bot_count_min),bot_count_max=COALESCE((p_patch->>'bot_count_max')::INT,cfg.bot_count_max),
    bot_bet_min=COALESCE((p_patch->>'bot_bet_min')::BIGINT,cfg.bot_bet_min),bot_bet_max=COALESCE((p_patch->>'bot_bet_max')::BIGINT,cfg.bot_bet_max),bot_cashout_min_bp=COALESCE((p_patch->>'bot_cashout_min_bp')::BIGINT,cfg.bot_cashout_min_bp),bot_cashout_max_bp=COALESCE((p_patch->>'bot_cashout_max_bp')::BIGINT,cfg.bot_cashout_max_bp),bot_activity_min_ms=COALESCE((p_patch->>'bot_activity_min_ms')::INT,cfg.bot_activity_min_ms),bot_activity_max_ms=COALESCE((p_patch->>'bot_activity_max_ms')::INT,cfg.bot_activity_max_ms),
    config_version=config_version+1,updated_by=auth.uid(),updated_at=NOW()
  WHERE game_id='crash' AND table_id='global' RETURNING * INTO cfg;
  IF p_patch?'is_active' THEN
    INSERT INTO public.game_settings(id,is_active,win_chance_percent,updated_at) VALUES('crash',cfg.is_active AND NOT cfg.maintenance,100,NOW())
    ON CONFLICT(id) DO UPDATE SET is_active=EXCLUDED.is_active,updated_at=NOW();
  END IF;
  RETURN jsonb_build_object('success',true,'config',to_jsonb(cfg));
EXCEPTION WHEN check_violation OR foreign_key_violation OR invalid_text_representation THEN RETURN jsonb_build_object('success',false,'message',SQLERRM); END $$;

CREATE OR REPLACE FUNCTION public.admin_get_crash_operations()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_row public.crash_rounds%ROWTYPE; engine_payload JSONB; human_payload JSONB; bot_payload JSONB; recent_payload JSONB; health_payload JSONB; audit_payload JSONB;
BEGIN
  IF NOT public.is_crash_super_admin(auth.uid()) THEN RETURN jsonb_build_object('success',false,'message','Super admin access required'); END IF;
  SELECT * INTO current_row FROM public.crash_rounds WHERE game_id='crash' AND table_id='global' ORDER BY round_number DESC LIMIT 1;
  SELECT COALESCE((SELECT to_jsonb(l) FROM public.crash_engine_leases l WHERE game_id='crash' AND table_id='global'),'{}'::JSONB)
    || jsonb_build_object('paused',c.maintenance OR NOT c.is_active,'status',CASE WHEN c.maintenance OR NOT c.is_active THEN 'paused' ELSE 'active' END,'updated_at',c.updated_at)
    INTO engine_payload FROM public.crash_game_configs c WHERE c.game_id='crash' AND c.table_id='global';
  SELECT jsonb_build_object('players',COUNT(DISTINCT user_id),'bets',COUNT(*),'stake',COALESCE(SUM(amount),0),'exposure',COALESCE(SUM(amount*COALESCE(auto_cashout_bp,(SELECT max_crash_multiplier_bp FROM public.crash_game_configs WHERE game_id='crash' AND table_id='global'))/100.0),0),'payout',COALESCE(SUM(payout),0),'wins',COUNT(*) FILTER(WHERE status='cashed_out'),'losses',COUNT(*) FILTER(WHERE status='lost')) INTO human_payload FROM public.crash_bets WHERE round_id=current_row.id;
  SELECT jsonb_build_object('players',COUNT(*),'bets',COUNT(*),'stake',COALESCE(SUM(amount),0),'emitted',COUNT(*) FILTER(WHERE emitted_at IS NOT NULL),'simulated',TRUE,'enabled',(SELECT bot_enabled FROM public.crash_game_configs WHERE game_id='crash' AND table_id='global')) INTO bot_payload FROM public.crash_bot_actions WHERE round_id=current_row.id;
  SELECT COALESCE(jsonb_agg(row_data ORDER BY round_number DESC),'[]') INTO recent_payload FROM (
    SELECT r.id AS round_id,r.round_number,r.status AS phase,CASE WHEN r.status IN('CRASHED','SETTLING','SETTLED','VOIDED') THEN r.crash_multiplier_bp ELSE NULL END AS crash_multiplier_bp,
      (SELECT COUNT(DISTINCT b.user_id) FROM public.crash_bets b WHERE b.round_id=r.id) AS real_players,
      (SELECT COUNT(*) FROM public.crash_bets b WHERE b.round_id=r.id) AS real_bets,
      r.real_bet_total AS real_stake,r.real_payout_total AS real_payout,
      (SELECT COUNT(*) FROM public.crash_bets b WHERE b.round_id=r.id AND b.status='cashed_out') AS wins,
      (SELECT COUNT(*) FROM public.crash_bets b WHERE b.round_id=r.id AND b.status='lost') AS losses,
      r.bot_bet_total,r.betting_opened_at,r.crashed_at,r.settled_at,r.seed_commitment,r.seed_reveal AS revealed_seed,r.algorithm_version
    FROM public.crash_rounds r WHERE r.game_id='crash' AND r.table_id='global' ORDER BY r.round_number DESC LIMIT 25
  ) row_data;
  SELECT jsonb_build_object('engine',jsonb_build_object('healthy',COALESCE((SELECT lease_expires_at>NOW() FROM public.crash_engine_leases WHERE game_id='crash' AND table_id='global'),false),'heartbeatAt',(SELECT heartbeat_at FROM public.crash_engine_leases WHERE game_id='crash' AND table_id='global')),'socket',jsonb_build_object('status','external-metrics'),'outbox',jsonb_build_object('pending',(SELECT COUNT(*) FROM public.crash_round_events WHERE published_at IS NULL),'oldestAgeSeconds',COALESCE((SELECT EXTRACT(EPOCH FROM(NOW()-MIN(created_at)))::INT FROM public.crash_round_events WHERE published_at IS NULL),0)),'database',jsonb_build_object('reachable',TRUE),'rpc',jsonb_build_object('stuckCommands',(SELECT COUNT(*) FROM public.crash_commands WHERE status='processing' AND created_at<NOW()-INTERVAL '30 seconds'))) INTO health_payload;
  SELECT COALESCE(jsonb_agg(a ORDER BY created_at DESC),'[]') INTO audit_payload FROM (SELECT id,admin_id,action,round_id,reason,success,details,created_at FROM public.crash_admin_audit ORDER BY created_at DESC LIMIT 50) a;
  RETURN jsonb_build_object('success',true,'engine',engine_payload,'current_round',CASE WHEN current_row.id IS NULL THEN NULL ELSE (to_jsonb(current_row)-'server_seed_ciphertext'-'crash_multiplier_bp'-'crash_at'-'seed_reveal')||jsonb_build_object('phase',current_row.status,'crash_multiplier_bp',CASE WHEN current_row.status IN('CRASHED','SETTLING','SETTLED','VOIDED') THEN current_row.crash_multiplier_bp ELSE NULL END,'revealed_seed',current_row.seed_reveal) END,'human_summary',human_payload,'bot_summary',bot_payload,'recent_rounds',recent_payload,'health',health_payload,'audit_events',audit_payload);
END $$;

CREATE OR REPLACE FUNCTION public.admin_crash_control(p_action TEXT,p_round_id UUID DEFAULT NULL,p_reason TEXT DEFAULT NULL,p_confirmation TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE me UUID:=auth.uid(); normalized TEXT:=LOWER(BTRIM(COALESCE(p_action,''))); expected TEXT; result_payload JSONB; audit_id UUID; active_round UUID; ok BOOLEAN:=FALSE; message_text TEXT;
BEGIN
  IF NOT public.is_crash_super_admin(me) THEN RETURN jsonb_build_object('success',false,'message','Super admin access required','audit_id',NULL); END IF;
  expected:=CASE normalized WHEN 'pause' THEN 'PAUSE CRASH' WHEN 'resume' THEN 'RESUME CRASH' WHEN 'refund' THEN 'REFUND '||COALESCE(p_round_id::TEXT,'') ELSE NULL END;
  IF expected IS NULL OR p_confirmation IS DISTINCT FROM expected THEN RETURN jsonb_build_object('success',false,'message','Confirmation text mismatch','audit_id',NULL); END IF;
  IF normalized='pause' THEN
    UPDATE public.crash_game_configs SET is_active=FALSE,maintenance=TRUE,config_version=config_version+1,updated_by=me,updated_at=NOW() WHERE game_id='crash' AND table_id='global';
    UPDATE public.game_settings SET is_active=FALSE,updated_at=NOW() WHERE id='crash';
    SELECT id INTO active_round FROM public.crash_rounds WHERE game_id='crash' AND table_id='global' AND status='BETTING_OPEN' ORDER BY round_number DESC LIMIT 1;
    IF active_round IS NOT NULL THEN result_payload:=public.crash_void_round(active_round,COALESCE(p_reason,'Emergency pause before flight')); ELSE result_payload:=jsonb_build_object('success',true); END IF;
    ok:=COALESCE((result_payload->>'success')::BOOLEAN,FALSE); message_text:=CASE WHEN ok THEN 'Crash game paused' ELSE COALESCE(result_payload->>'code','Pause failed') END;
  ELSIF normalized='resume' THEN
    IF length(public.crash_seed_key())<32 THEN ok:=FALSE; message_text:='Configure the crash seed encryption key before resuming';
    ELSIF NOT EXISTS(SELECT 1 FROM public.crash_game_configs c JOIN public.profiles p ON p.id=c.house_profile_id WHERE c.game_id='crash' AND c.table_id='global' AND COALESCE(p.diamonds,0)>0) THEN ok:=FALSE; message_text:='Configure and fund the crash house wallet before resuming';
    ELSE UPDATE public.crash_game_configs SET is_active=TRUE,maintenance=FALSE,config_version=config_version+1,updated_by=me,updated_at=NOW() WHERE game_id='crash' AND table_id='global'; ok:=FOUND; IF ok THEN UPDATE public.game_settings SET is_active=TRUE,updated_at=NOW() WHERE id='crash'; END IF; message_text:=CASE WHEN ok THEN 'Crash game resumed' ELSE 'Crash config not found' END; END IF;
  ELSE
    IF p_round_id IS NULL OR length(BTRIM(COALESCE(p_reason,'')))<5 THEN ok:=FALSE; message_text:='Round and refund reason are required';
    ELSE result_payload:=public.crash_void_round(p_round_id,p_reason); ok:=COALESCE((result_payload->>'success')::BOOLEAN,FALSE); message_text:=CASE WHEN ok THEN 'Crash round refunded' ELSE COALESCE(result_payload->>'code','Refund failed') END; END IF;
  END IF;
  INSERT INTO public.crash_admin_audit(admin_id,action,round_id,reason,success,details) VALUES(me,normalized,COALESCE(p_round_id,active_round),p_reason,ok,COALESCE(result_payload,'{}')) RETURNING id INTO audit_id;
  RETURN jsonb_build_object('success',ok,'message',message_text,'audit_id',audit_id);
END $$;

CREATE OR REPLACE FUNCTION public.crash_claim_events(p_instance_id TEXT,p_limit INT DEFAULT 100) RETURNS SETOF public.crash_round_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN RETURN QUERY WITH picked AS (SELECT sequence FROM public.crash_round_events WHERE published_at IS NULL AND (claimed_at IS NULL OR claimed_at<NOW()-INTERVAL '30 seconds') ORDER BY sequence LIMIT LEAST(GREATEST(p_limit,1),500) FOR UPDATE SKIP LOCKED) UPDATE public.crash_round_events e SET claimed_by=p_instance_id,claimed_at=NOW() FROM picked WHERE e.sequence=picked.sequence RETURNING e.*; END $$;
CREATE OR REPLACE FUNCTION public.crash_ack_events(p_instance_id TEXT,p_sequences BIGINT[]) RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE n INT; BEGIN UPDATE public.crash_round_events SET published_at=NOW() WHERE claimed_by=p_instance_id AND sequence=ANY(p_sequences) AND published_at IS NULL; GET DIAGNOSTICS n=ROW_COUNT; RETURN n; END $$;
CREATE OR REPLACE FUNCTION public.crash_assign_event_socket_sequence(p_event_id UUID,p_socket_sequence BIGINT) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE assigned BIGINT; BEGIN UPDATE public.crash_round_events SET socket_sequence=COALESCE(socket_sequence,p_socket_sequence) WHERE event_id=p_event_id RETURNING socket_sequence INTO assigned; RETURN assigned; END $$;
CREATE OR REPLACE FUNCTION public.crash_claim_due_bots(p_instance_id TEXT,p_limit INT DEFAULT 50) RETURNS SETOF public.crash_bot_actions LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN RETURN QUERY WITH picked AS (SELECT id FROM public.crash_bot_actions WHERE emitted_at IS NULL AND scheduled_at<=NOW() ORDER BY scheduled_at LIMIT LEAST(GREATEST(p_limit,1),200) FOR UPDATE SKIP LOCKED) UPDATE public.crash_bot_actions b SET emitted_at=NOW() FROM picked WHERE b.id=picked.id RETURNING b.*; END $$;

REVOKE ALL ON FUNCTION public.crash_seed_key() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.is_crash_super_admin(UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.touch_crash_admin_refresh_signal() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.crash_request_hash(JSONB) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.crash_finish_command(UUID,TEXT,TEXT,JSONB) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.crash_compute_point(BYTEA,UUID,INT,BIGINT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.crash_emit(public.crash_rounds,TEXT,JSONB,UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.crash_acquire_lease(TEXT,TEXT,TEXT,INT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.crash_seed_bots(public.crash_rounds,public.crash_game_configs) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.crash_engine_start_round(TEXT,TEXT,TEXT,BIGINT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.crash_engine_settle_round(UUID,TEXT,BIGINT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.crash_engine_process_auto_cashouts(UUID,TEXT,BIGINT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.crash_engine_advance(TEXT,TEXT,TEXT,BIGINT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.crash_void_round(UUID,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.crash_claim_events(TEXT,INT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.crash_ack_events(TEXT,BIGINT[]) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.crash_assign_event_socket_sequence(UUID,BIGINT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.crash_claim_due_bots(TEXT,INT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.place_crash_bet(UUID,TEXT,BIGINT,BIGINT) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.cash_out_crash_bet(UUID,UUID,TEXT) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.get_crash_snapshot(TEXT,TEXT,BIGINT) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.get_crash_connection_limit(TEXT,TEXT) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.crash_service_readiness(TEXT,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.admin_void_crash_round(UUID,TEXT) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.admin_set_crash_maintenance(TEXT,TEXT,BOOLEAN) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.admin_update_crash_config(JSONB) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.admin_get_crash_operations() FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.admin_crash_control(TEXT,UUID,TEXT,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.crash_acquire_lease(TEXT,TEXT,TEXT,INT),public.crash_engine_start_round(TEXT,TEXT,TEXT,BIGINT),public.crash_engine_settle_round(UUID,TEXT,BIGINT),public.crash_engine_process_auto_cashouts(UUID,TEXT,BIGINT),public.crash_engine_advance(TEXT,TEXT,TEXT,BIGINT),public.crash_service_readiness(TEXT,TEXT),public.crash_claim_events(TEXT,INT),public.crash_ack_events(TEXT,BIGINT[]),public.crash_assign_event_socket_sequence(UUID,BIGINT),public.crash_claim_due_bots(TEXT,INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.place_crash_bet(UUID,TEXT,BIGINT,BIGINT),public.cash_out_crash_bet(UUID,UUID,TEXT),public.get_crash_snapshot(TEXT,TEXT,BIGINT),public.get_crash_connection_limit(TEXT,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_void_crash_round(UUID,TEXT),public.admin_set_crash_maintenance(TEXT,TEXT,BOOLEAN),public.admin_update_crash_config(JSONB),public.admin_get_crash_operations(),public.admin_crash_control(TEXT,UUID,TEXT,TEXT) TO authenticated;
NOTIFY pgrst,'reload schema';
