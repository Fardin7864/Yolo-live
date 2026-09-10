import { io, type Socket } from 'socket.io-client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../api/supabase';
import type { CrashPhase, CrashSnapshot } from './GameMessageTypes';

const PHASES = new Set<CrashPhase>([
  'SCHEDULED', 'BETTING_OPEN', 'BETTING_LOCKED', 'RUNNING', 'CRASHED',
  'SETTLING', 'SETTLED', 'VOIDING', 'VOIDED',
]);

type CommandResult = {
  requestId: string;
  accepted: boolean;
  code?: string;
  message?: string;
  wallet?: number;
  result?: Record<string, unknown>;
};
type PendingCommand = { event: 'bet:place' | 'bet:cashout'; payload: Record<string, unknown> };

export interface CrashSocketCallbacks {
  onState: (snapshot: CrashSnapshot, reason: string) => void;
  onNetworkChange: (connected: boolean, synchronizing: boolean) => void;
  onWalletChange: (balance: number) => void;
  onBetResult: (result: CommandResult & { betId?: string }) => void;
  onCashoutResult: (result: CommandResult & { payout?: number; multiplierBp?: number }) => void;
  onError: (message: string, recoverable: boolean) => void;
}

const number = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

export function normalizeCrashSnapshot(input: unknown, connected = true): CrashSnapshot {
  const envelope = object(input);
  const raw = object(envelope.payload ?? envelope.snapshot ?? input);
  const rawRound = object(raw.round);
  const rawBet = object(raw.myBet ?? raw.my_bet);
  const phaseCandidate = text(rawRound.phase ?? raw.phase, 'SCHEDULED').toUpperCase() as CrashPhase;
  const phase = PHASES.has(phaseCandidate) ? phaseCandidate : 'SCHEDULED';
  const roundId = text(rawRound.id ?? rawRound.roundId ?? rawRound.round_id ?? raw.roundId ?? raw.round_id ?? envelope.roundId ?? envelope.round_id);
  const betId = text(rawBet.id ?? rawBet.betId ?? rawBet.bet_id);
  const activity = Array.isArray(raw.publicActivity ?? raw.public_activity) ? raw.publicActivity ?? raw.public_activity : [];
  const history = Array.isArray(raw.history) ? raw.history : [];
  return {
    sequence: number(envelope.sequence ?? raw.sequence),
    stateVersion: number(raw.stateVersion ?? raw.state_version ?? rawRound.stateVersion ?? rawRound.state_version),
    serverTime: text(envelope.serverTime ?? envelope.server_time ?? raw.serverTime ?? raw.server_time, new Date().toISOString()),
    connected,
    round: roundId ? {
      id: roundId,
      roundNumber: number(rawRound.roundNumber ?? rawRound.round_number ?? raw.roundNumber ?? raw.round_number),
      phase,
      bettingClosesAt: text(rawRound.bettingClosesAt ?? rawRound.betting_closes_at ?? raw.bettingClosesAt ?? raw.betting_closes_at) || undefined,
      flightStartedAt: text(rawRound.flightStartedAt ?? rawRound.flight_started_at ?? raw.flightStartedAt ?? raw.flight_started_at) || undefined,
      growthRate: number(rawRound.growthRate ?? rawRound.growth_rate ?? raw.growthRate ?? raw.growth_rate, 0) || undefined,
      multiplierBp: number(rawRound.multiplierBp ?? rawRound.multiplier_bp ?? raw.multiplierBp ?? raw.multiplier_bp, 100),
      crashMultiplierBp: rawRound.crashMultiplierBp !== undefined || rawRound.crash_multiplier_bp !== undefined
        ? number(rawRound.crashMultiplierBp ?? rawRound.crash_multiplier_bp) : raw.crashMultiplierBp !== undefined || raw.crash_multiplier_bp !== undefined ? number(raw.crashMultiplierBp ?? raw.crash_multiplier_bp) : undefined,
      seedCommitment: text(rawRound.seedCommitment ?? rawRound.seed_commitment ?? raw.seedCommitment ?? raw.seed_commitment),
      revealedSeed: text(rawRound.revealedSeed ?? rawRound.revealed_seed ?? raw.revealedSeed ?? raw.revealed_seed) || undefined,
      algorithmVersion: text(rawRound.algorithmVersion ?? rawRound.algorithm_version ?? raw.algorithmVersion ?? raw.algorithm_version, 'v1'),
    } : null,
    myBet: betId ? {
      id: betId,
      amount: number(rawBet.amount),
      autoCashoutBp: rawBet.autoCashoutBp !== undefined || rawBet.auto_cashout_bp !== undefined
        ? number(rawBet.autoCashoutBp ?? rawBet.auto_cashout_bp) : undefined,
      status: text(rawBet.status, 'placed') as NonNullable<CrashSnapshot['myBet']>['status'],
      cashoutMultiplierBp: rawBet.cashoutMultiplierBp !== undefined || rawBet.cashout_multiplier_bp !== undefined
        ? number(rawBet.cashoutMultiplierBp ?? rawBet.cashout_multiplier_bp) : undefined,
      payout: rawBet.payout !== undefined ? number(rawBet.payout) : undefined,
    } : null,
    wallet: number(raw.wallet ?? raw.balance),
    config: raw.config ? (() => {
      const config = object(raw.config);
      return {
        minBet: number(config.minBet ?? config.min_bet, 100),
        maxBet: number(config.maxBet ?? config.max_bet, 1000000),
        minAutoCashoutBp: number(config.minAutoCashoutBp ?? config.min_auto_cashout_bp, 110),
        maxAutoCashoutBp: number(config.maxAutoCashoutBp ?? config.max_auto_cashout_bp, 100000),
      };
    })() : undefined,
    publicActivity: (activity as unknown[]).map((entry, index) => {
      const item = object(entry);
      return {
        id: text(item.id, `activity-${index}`),
        name: text(item.name, 'Player'),
        avatarUrl: text(item.avatarUrl ?? item.avatar_url) || undefined,
        amount: number(item.amount),
        cashoutMultiplierBp: item.cashoutMultiplierBp !== undefined || item.cashout_multiplier_bp !== undefined
          ? number(item.cashoutMultiplierBp ?? item.cashout_multiplier_bp) : undefined,
        simulated: item.simulated === true || item.is_simulated === true,
      };
    }),
    history: (history as unknown[]).map((entry) => {
      const item = object(entry);
      return {
        roundId: text(item.roundId ?? item.round_id),
        crashMultiplierBp: number(item.crashMultiplierBp ?? item.crash_multiplier_bp, 100),
        seedCommitment: text(item.seedCommitment ?? item.seed_commitment),
        revealedSeed: text(item.revealedSeed ?? item.revealed_seed) || undefined,
      };
    }),
  };
}

function normalizeResult(input: unknown, fallbackRequestId = ''): CommandResult {
  const raw = object(input);
  const result = object(raw.result);
  return {
    requestId: text(raw.requestId ?? raw.request_id, fallbackRequestId),
    accepted: raw.accepted === true || raw.success === true,
    code: text(raw.code) || undefined,
    message: text(raw.message ?? raw.error) || undefined,
    wallet: raw.wallet !== undefined ? number(raw.wallet) : undefined,
    result,
  };
}

export function shouldRefreshCrashSession(expiresAtSeconds: number | undefined, nowMs = Date.now()) {
  return !expiresAtSeconds || expiresAtSeconds * 1000 <= nowMs + 60_000;
}

export function deserializeCrashOutbox(raw: string | null): PendingCommand[] {
  try {
    const saved = JSON.parse(raw || '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter((entry) => entry && (entry.event === 'bet:place' || entry.event === 'bet:cashout') && text(entry.payload?.requestId));
  } catch { return []; }
}

export function mergeCrashEvent(last: CrashSnapshot | null, data: unknown, reason: string) {
  const envelope = object(data);
  const raw = object(envelope.payload ?? data);
  const incoming = normalizeCrashSnapshot(data, true);
  const gap = !!last && incoming.sequence > last.sequence + 1;
  if (reason === 'crash:snapshot' || !last) return { snapshot: incoming, gap };
  const phaseByEvent: Partial<Record<string, CrashPhase>> = {
    'round:scheduled': 'SCHEDULED', 'round:betting_open': 'BETTING_OPEN',
    'round:betting_locked': 'BETTING_LOCKED', 'round:flight_started': 'RUNNING',
    'round:crashed': 'CRASHED', 'round:settled': 'SETTLED',
  };
  const newRound = !!incoming.round && incoming.round.id !== last.round?.id;
  const roundBase = newRound ? incoming.round : last.round;
  const snapshot: CrashSnapshot = {
    ...last,
    sequence: number(envelope.sequence ?? raw.sequence, last.sequence),
    stateVersion: number(raw.stateVersion ?? raw.state_version ?? object(raw.round).stateVersion ?? object(raw.round).state_version, last.stateVersion),
    serverTime: text(envelope.serverTime ?? envelope.server_time, last.serverTime),
    connected: true,
    round: roundBase ? {
      ...roundBase,
      ...(!newRound && incoming.round ? incoming.round : {}),
      phase: phaseByEvent[reason] || incoming.round?.phase || roundBase.phase,
      multiplierBp: number(raw.multiplierBp ?? raw.multiplier_bp, incoming.round?.multiplierBp ?? roundBase.multiplierBp ?? 100),
      crashMultiplierBp: raw.crashMultiplierBp !== undefined || raw.crash_multiplier_bp !== undefined
        ? number(raw.crashMultiplierBp ?? raw.crash_multiplier_bp) : incoming.round?.crashMultiplierBp ?? roundBase.crashMultiplierBp,
    } : null,
    publicActivity: reason === 'bet:public_activity' && (raw.id || raw.name)
      ? [normalizeCrashSnapshot({ payload: { publicActivity: [raw] } }).publicActivity[0], ...last.publicActivity].filter(Boolean).slice(0, 30)
      : last.publicActivity,
  };
  return { snapshot, gap };
}

export class CrashSocketService {
  private socket: Socket | null = null;
  private active = false;
  private lastSnapshot: CrashSnapshot | null = null;
  private pending = new Map<string, PendingCommand>();
  private completed = new Map<string, CommandResult>();
  private storageKey = 'crash.pending.anonymous';

  constructor(private readonly callbacks: CrashSocketCallbacks) {}

  start() { this.active = true; void this.restoreAndConnect(); }
  stop() { this.active = false; this.socket?.removeAllListeners(); this.socket?.disconnect(); this.socket = null; this.pending.clear(); }
  pause() { this.active = false; this.socket?.disconnect(); }
  resume(_reason = 'resume') { this.active = true; void this.connect(); }
  requestRefresh(_reason = 'manual') { this.emitSync(); }

  placeBet(payload: { requestId: string; roundId: string; amount: number; autoCashoutBp?: number }) {
    return this.command('bet:place', payload);
  }

  cashout(payload: { requestId: string; roundId: string; betId: string }) {
    return this.command('bet:cashout', payload);
  }

  private async restoreAndConnect() {
    const { data } = await supabase.auth.getSession();
    this.storageKey = `crash.pending.${data.session?.user?.id || 'anonymous'}`;
    try {
      const saved = deserializeCrashOutbox(await AsyncStorage.getItem(this.storageKey));
      saved.forEach((entry) => {
        const requestId = text(entry.payload?.requestId);
        if (requestId && (entry.event === 'bet:place' || entry.event === 'bet:cashout')) this.pending.set(requestId, entry);
      });
    } catch { /* Corrupt retry state is ignored; server state remains authoritative. */ }
    await this.connect();
    if (this.socket?.connected) this.pending.forEach((entry, requestId) => this.emitCommand(entry.event, { ...entry.payload, requestId }));
  }

  private async connect() {
    if (!this.active || this.socket?.connected) return;
    const socketUrl = process.env.EXPO_PUBLIC_CRASH_SOCKET_URL;
    if (!socketUrl) {
      this.callbacks.onError('Crash is not configured on this build.', false);
      return;
    }
    let { data } = await supabase.auth.getSession();
    if (shouldRefreshCrashSession(data.session?.expires_at)) {
      const refreshed = await supabase.auth.refreshSession();
      if (refreshed.data.session) data = refreshed.data;
    }
    const token = data.session?.access_token;
    if (!token || !this.active) {
      this.callbacks.onError('Sign in again to play Crash.', true);
      return;
    }
    if (!this.socket) {
      this.socket = io(`${socketUrl.replace(/\/$/, '')}/crash`, {
        transports: ['websocket'], upgrade: false, autoConnect: false,
        reconnection: true, reconnectionAttempts: Infinity,
        reconnectionDelay: 500, reconnectionDelayMax: 5000, randomizationFactor: 0.35,
        timeout: 8000, auth: { token, protocolVersion: 2, tableId: 'global' },
      });
      this.bindSocket(this.socket);
    } else {
      this.socket.auth = { token, protocolVersion: 2, tableId: 'global' };
    }
    if (!this.socket.connected) this.socket.connect();
  }

  private bindSocket(socket: Socket) {
    socket.on('connect', () => {
      this.callbacks.onNetworkChange(true, true);
      this.emitSync();
      this.pending.forEach((entry, requestId) => this.emitCommand(entry.event, { ...entry.payload, requestId }));
    });
    socket.on('disconnect', () => this.callbacks.onNetworkChange(false, false));
    socket.on('connect_error', (error) => this.callbacks.onError(error.message || 'Crash connection failed.', true));
    socket.io.on('reconnect_attempt', () => { void this.refreshSocketAuth(); });
    socket.on('session:ready', () => this.emitSync());
    const stateEvents = [
      'crash:snapshot', 'round:scheduled', 'round:betting_open', 'round:betting_locked',
      'round:flight_started', 'round:tick', 'round:crashed', 'round:settled', 'bet:public_activity',
    ];
    stateEvents.forEach((event) => socket.on(event, (data) => this.receiveState(data, event)));
    socket.on('wallet:updated', (data) => {
      const wallet = number(object(data).payload ? object(object(data).payload).wallet : object(data).wallet);
      this.callbacks.onWalletChange(wallet);
    });
    socket.on('bet:accepted', (data) => this.receiveResult(data, true, 'bet'));
    socket.on('bet:rejected', (data) => this.receiveResult(data, false, 'bet'));
    socket.on('cashout:confirmed', (data) => this.receiveResult(data, true, 'cashout'));
    socket.on('cashout:rejected', (data) => this.receiveResult(data, false, 'cashout'));
    socket.on('engine:maintenance', () => this.callbacks.onError('Crash is temporarily under maintenance.', true));
    socket.on('server:error', (data) => this.callbacks.onError(text(object(data).message, 'Crash server error.'), true));
  }

  private receiveState(data: unknown, reason: string) {
    const merged = mergeCrashEvent(this.lastSnapshot, data, reason);
    const snapshot = merged.snapshot;
    if (merged.gap) this.emitSync();
    if (this.lastSnapshot && snapshot.sequence && snapshot.sequence < this.lastSnapshot.sequence) return;
    this.lastSnapshot = snapshot;
    this.callbacks.onState(snapshot, reason);
    this.callbacks.onWalletChange(snapshot.wallet);
    this.callbacks.onNetworkChange(true, false);
  }

  private command(event: 'bet:place' | 'bet:cashout', payload: Record<string, unknown> & { requestId: string }) {
    const done = this.completed.get(payload.requestId);
    if (done) { this.dispatchResult(done, event === 'bet:place' ? 'bet' : 'cashout'); return; }
    if (!this.pending.has(payload.requestId)) this.pending.set(payload.requestId, { event, payload });
    void this.persistPending();
    if (!this.socket?.connected) { void this.connect(); return; }
    this.emitCommand(event, payload);
  }

  private emitCommand(event: 'bet:place' | 'bet:cashout', payload: Record<string, unknown>) {
    this.socket?.timeout(7000).emit(event, payload, (error: Error | null, ack: unknown) => {
      if (error || !ack) return;
      const result = normalizeResult(ack, text(payload.requestId));
      if (this.finish(result)) this.dispatchResult(result, event === 'bet:place' ? 'bet' : 'cashout');
    });
  }

  private receiveResult(data: unknown, accepted: boolean, kind: 'bet' | 'cashout') {
    const envelope = object(data);
    const result = { ...normalizeResult(envelope.payload ?? data), accepted };
    if (this.finish(result)) this.dispatchResult(result, kind);
  }

  private dispatchResult(result: CommandResult, kind: 'bet' | 'cashout') {
    if (kind === 'bet') this.callbacks.onBetResult({
      ...result, betId: text(result.result?.betId ?? result.result?.bet_id) || undefined,
    });
    else this.callbacks.onCashoutResult({
      ...result,
      payout: result.result?.payout !== undefined ? number(result.result.payout) : undefined,
      multiplierBp: result.result?.multiplierBp !== undefined || result.result?.multiplier_bp !== undefined
        ? number(result.result.multiplierBp ?? result.result.multiplier_bp) : undefined,
    });
  }

  private finish(result: CommandResult) {
    if (!result.requestId || this.completed.has(result.requestId)) return false;
    this.pending.delete(result.requestId);
    void this.persistPending();
    this.completed.set(result.requestId, result);
    while (this.completed.size > 200) this.completed.delete(this.completed.keys().next().value as string);
    if (result.wallet !== undefined) this.callbacks.onWalletChange(result.wallet);
    return true;
  }

  private emitSync() {
    if (!this.socket?.connected) return;
    this.socket.emit('state:sync', {
      knownRoundId: this.lastSnapshot?.round?.id,
      knownSequence: this.lastSnapshot?.sequence,
    });
  }

  private async refreshSocketAuth() {
    let { data } = await supabase.auth.getSession();
    if (shouldRefreshCrashSession(data.session?.expires_at)) {
      const refreshed = await supabase.auth.refreshSession();
      if (refreshed.data.session) data = refreshed.data;
    }
    if (data.session?.access_token && this.socket) {
      this.socket.auth = { token: data.session.access_token, protocolVersion: 2, tableId: 'global' };
    }
  }

  private async persistPending() {
    try { await AsyncStorage.setItem(this.storageKey, JSON.stringify([...this.pending.values()])); } catch { /* Best-effort crash recovery. */ }
  }
}
