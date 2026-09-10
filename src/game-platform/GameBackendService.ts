import { supabase } from '../api/supabase';
import { evaluateQueuedBet } from './BetBatchPolicy';
import { BetSubmissionLedger } from './BetSubmissionLedger';
import { resolveSnapshotBetTotals } from './GameSnapshotTotals';
import type {
  GameBetBatchItem,
  GameId,
  GameOptionState,
  GamePhase,
  GameRankingEntry,
  GameSnapshot,
} from './GameMessageTypes';

export type BackendGameId = Exclude<GameId, 'crash'>;

export const realtimeBetChannelTopic = (gameId: BackendGameId, roundId: string) =>
  `v2-${gameId}-bets-${roundId}`;

const GLOBAL_ROOM_IDS: Record<BackendGameId, string> = {
  greedy_lion: '00000000-0000-0000-0000-000000000001',
  greedy_pro: '00000000-0000-0000-0000-000000000004',
  tin_patti_pro: '00000000-0000-0000-0000-000000000002',
  lucky_dice: '00000000-0000-0000-0000-000000000003',
};

const BACKEND_GAME_TYPES: Record<BackendGameId, BackendGameId> = {
  greedy_lion: 'greedy_lion',
  greedy_pro: 'greedy_pro',
  tin_patti_pro: 'tin_patti_pro',
  lucky_dice: 'lucky_dice',
};

const ROUND_TABLES: Record<BackendGameId, string> = {
  greedy_lion: 'game_rounds',
  greedy_pro: 'greedy_pro_rounds',
  tin_patti_pro: 'game_rounds',
  lucky_dice: 'game_rounds',
};

const BET_TABLES: Record<BackendGameId, string> = {
  greedy_lion: 'game_round_bets',
  greedy_pro: 'greedy_pro_bets',
  tin_patti_pro: 'game_round_bets',
  lucky_dice: 'game_round_bets',
};

const ROBOT_BET_TABLES: Partial<Record<BackendGameId, string>> = {
  greedy_lion: 'game_robot_bets',
  greedy_pro: 'greedy_pro_robot_bets',
  tin_patti_pro: 'game_robot_bets',
};

const GAME_CONFIG = {
  greedy_lion: {
    stateRpc: 'get_greedy_lion_state',
    betRpc: 'place_greedy_lion_bet',
    batchRpc: 'place_greedy_lion_bet_batch',
    maxOptions: 6,
    defaults: [
      { id: 'corn', label: 'Corn', category: 'salad', multiplier: 5 },
      { id: 'chicken', label: 'Chicken', category: 'pizza', multiplier: 45 },
      { id: 'shrimp', label: 'Shrimp', category: 'pizza', multiplier: 25 },
      { id: 'tomato', label: 'Tomato', category: 'salad', multiplier: 5 },
      { id: 'ham', label: 'Ham', category: 'pizza', multiplier: 15 },
      { id: 'pepper', label: 'Pepper', category: 'salad', multiplier: 5 },
      { id: 'fish', label: 'Fish', category: 'pizza', multiplier: 10 },
      { id: 'carrot', label: 'Carrot', category: 'salad', multiplier: 5 },
    ],
  },
  greedy_pro: {
    stateRpc: 'get_greedy_pro_state',
    betRpc: 'place_greedy_pro_bet',
    batchRpc: 'place_greedy_pro_bet_batch',
    maxOptions: 6,
    defaults: [
      { id: 'corn', label: 'Corn', category: 'salad', multiplier: 5 },
      { id: 'chicken', label: 'Chicken', category: 'pizza', multiplier: 45 },
      { id: 'shrimp', label: 'Shrimp', category: 'pizza', multiplier: 25 },
      { id: 'tomato', label: 'Tomato', category: 'salad', multiplier: 5 },
      { id: 'ham', label: 'Ham', category: 'pizza', multiplier: 15 },
      { id: 'pepper', label: 'Pepper', category: 'salad', multiplier: 5 },
      { id: 'fish', label: 'Fish', category: 'pizza', multiplier: 10 },
      { id: 'carrot', label: 'Carrot', category: 'salad', multiplier: 5 },
    ],
  },
  tin_patti_pro: {
    stateRpc: 'get_tin_patti_pro_state',
    betRpc: 'place_tin_patti_pro_bet',
    batchRpc: 'place_tin_patti_pro_bet_batch',
    maxOptions: 3,
    defaults: [
      { id: 'crown', label: 'Player A', multiplier: 2.9 },
      { id: 'coffee', label: 'Player B', multiplier: 2.9 },
      { id: 'cake', label: 'Player C', multiplier: 2.9 },
    ],
  },
  lucky_dice: {
    stateRpc: 'get_lucky_dice_state',
    betRpc: 'place_lucky_dice_bet',
    batchRpc: 'place_lucky_dice_bet_batch',
    maxOptions: 9,
    defaults: [
      { id: 'small', label: 'SMALL 4-10', multiplier: 2 },
      { id: 'big', label: 'BIG 11-17', multiplier: 2 },
      { id: 'odd', label: 'ODD', multiplier: 2 },
      { id: 'even', label: 'EVEN', multiplier: 2 },
      { id: 'any_triple', label: 'ANY TRIPLE', multiplier: 31 },
      { id: 'total_6', label: 'TOTAL 6', multiplier: 15 },
      { id: 'total_9', label: 'TOTAL 9', multiplier: 7 },
      { id: 'total_12', label: 'TOTAL 12', multiplier: 7 },
      { id: 'total_15', label: 'TOTAL 15', multiplier: 15 },
    ],
  },
} as const;

type BackendPayload = Record<string, any>;
type StateListener = (snapshot: GameSnapshot, reason: string) => void;
type ErrorListener = (message: string, recoverable: boolean) => void;

interface ServiceCallbacks {
  onState: StateListener;
  onError: ErrorListener;
  onNetworkChange: (connected: boolean, synchronizing: boolean) => void;
  onWalletChange?: (balance: number) => void;
  onBetBatchResult?: (result: {
    roundId: string;
    requestIds: string[];
    accepted: boolean;
    balance?: number;
    bets?: GameBetBatchItem[];
    message?: string;
  }) => void;
}

export interface BetRequest {
  requestId: string;
  roundId: string;
  optionId: string;
  amount: number;
}

export interface BetResponse {
  requestId: string;
  accepted: boolean;
  queued?: boolean;
  balance?: number;
  betId?: string;
  message?: string;
}

interface PendingBetBatch {
  roundId: string;
  batchId: string;
  createdAt: number;
  lastQueuedAt: number;
  items: Map<string, number>;
  requestIds: Set<string>;
  total: number;
  flushing: boolean;
  baseOptionTotals: Map<string, number>;
  baseMineTotals: Map<string, number>;
}

interface ViewerIdentity {
  userId: string | null;
  name: string;
  avatarUrl: string | null;
}

interface PendingPeerBets extends ViewerIdentity {
  roundId: string;
  items: Array<{ position: string; amount: number }>;
  updatedAt: number;
}

const asNumber = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
// Greedy King follows Popular Greedy's round-boundary batching: taps reserve
// locally during betting, then submit one aggregated financial request.
const REALTIME_BET_GAMES = new Set<BackendGameId>(['tin_patti_pro']);
const ROBOT_BET_GAMES = new Set<BackendGameId>(['greedy_lion', 'greedy_pro', 'tin_patti_pro']);
const DURABLE_BATCH_GAMES = new Set<BackendGameId>(['tin_patti_pro']);
const REALTIME_CHIPS = [500, 1000, 5000, 50000, 100000] as const;
// Teen Patti commits chip taps on a debounce rather than one RPC per tap. A tap
// used to schedule its own flush 40ms later, so tapping a stack of chips fired a
// write (plus its triggers and realtime fan-out) for nearly every chip, and each
// client's total landed at a slightly different moment — which is how two phones
// ended up showing different pot amounts mid-round. Waiting a beat coalesces a
// burst of taps into a single aggregated commit, so every client sees the same
// jump at the same time and the database does a fraction of the writes.
const REALTIME_BET_DEBOUNCE_MS = 1000;
// ...but never sit on a batch indefinitely: a player tapping continuously (or a
// steady stream of snapshots re-arming the timer) must still commit promptly.
const REALTIME_BET_MAX_HOLD_MS = 2000;
// Commit this far ahead of the betting boundary. The server still accepts bets
// for `bet_acceptance_grace_s` after ends_at, so a batch flushed *at* the
// boundary lands after the on-screen timer has already hit zero - the chips
// appear to be taken after betting closed. The margin has to cover the RPC round
// trip, not just the scheduling, so it is a full second: inside the last second
// of betting the debounce effectively switches off and every tap commits
// immediately, which is what a player expects that close to the deadline.
const BETTING_BOUNDARY_SAFETY_MS = 1000;
const BET_OUTBOX_KEY = 'game-bet-outbox-v2';

const parseMultipliers = (value: unknown) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const parseRules = (value: unknown): BackendPayload => {
  if (value && typeof value === 'object') return value as BackendPayload;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const phaseFor = (payload: BackendPayload, serverNowMs: number): GamePhase => {
  const round = payload.round;
  if (!round) return 'WAITING';
  if ((round.status === 'resolving' || round.status === 'settled')
    && (round.result?.winner_pos || round.winner_pos || round.result?.category
    || (Array.isArray(round.result?.winning_option_ids) && round.result.winning_option_ids.length))) {
    return 'RESULT_RECEIVED';
  }
  if (round.status !== 'betting') return 'RESULT_PENDING';
  const endsAt = Date.parse(round.ends_at || '');
  return Number.isFinite(endsAt) && endsAt <= serverNowMs ? 'BETTING_CLOSED' : 'BETTING';
};

export function normalizeGameSnapshot(
  gameId: BackendGameId,
  payload: BackendPayload,
  sequence: number,
  clockReceivedAt = Date.now(),
): GameSnapshot {
  const config = GAME_CONFIG[gameId];
  const serverNow = payload.server_now || new Date().toISOString();
  const serverNowMs = Date.parse(serverNow) || Date.now();
  const myBets = Array.isArray(payload.my_bets) ? payload.my_bets : [];
  const publicBets = Array.isArray(payload.public_bets)
    ? payload.public_bets
    : Array.isArray(payload.bets) ? payload.bets : [];
  const totals = resolveSnapshotBetTotals(payload, publicBets);
  const mine: Record<string, number> = {};
  myBets.forEach((bet: BackendPayload) => {
    if (bet?.position) mine[bet.position] = asNumber(mine[bet.position]) + asNumber(bet.amount);
  });
  const liveMultipliers = parseMultipliers(payload.settings?.multipliers);
  const rules = parseRules(payload.settings?.special_result_rules);
  const options: GameOptionState[] = config.defaults.map((base) => {
    const live = liveMultipliers.find((item: BackendPayload) => item?.id === base.id);
    return {
      ...base,
      label: live?.label || base.label,
      category: 'category' in base ? base.category : undefined,
      multiplier: asNumber(live?.m || base.multiplier),
      totalAmount: asNumber(totals[base.id]),
      myAmount: asNumber(mine[base.id]),
    };
  });
  const round = payload.round;
  const result = {
    ...(round?.result || {}),
    ...(payload.first_cards ? { first_cards: payload.first_cards } : {}),
  };
  const winnerIds = Array.isArray(result.winning_option_ids)
    ? result.winning_option_ids.map(String)
    : [];
  const winnerId = result.winner_pos || round?.winner_pos || result.category || winnerIds[0];
  const normalizedPublicBets: GameSnapshot['publicBets'] = publicBets.map((bet: BackendPayload) => ({
    id: bet.id,
    userId: String(bet.user_id || bet.userId || ''),
    position: bet.position,
    amount: asNumber(bet.amount),
    name: bet.name || 'Player',
    avatarUrl: bet.avatar_url || null,
    createdAt: bet.created_at,
  }));

  // Robot accounts use the same winner list as regular accounts. Their bets
  // are shared server rows, so every client derives the same payout and rank.
  // This replaces the old client-only/random robot-winner banner.
  if (round && winnerId && ROBOT_BET_GAMES.has(gameId)) {
    const robotWinners = new Map<string, BackendPayload>();
    normalizedPublicBets.forEach((bet) => {
      if (!bet.userId.startsWith('robot:')) return;
      const option = options.find((entry) => entry.id === bet.position);
      const won = bet.position === String(winnerId)
        || ((gameId === 'greedy_lion' || gameId === 'greedy_pro')
          && option?.category === String(winnerId));
      if (!won) return;
      const current = robotWinners.get(bet.userId) || {
        user_id: bet.userId,
        name: bet.name,
        avatar_url: null,
        is_robot: true,
        win_amount: 0,
      };
      current.win_amount = asNumber(current.win_amount) + bet.amount * Math.max(1, asNumber(option?.multiplier));
      robotWinners.set(bet.userId, current);
    });
    const existing = Array.isArray(result.top_winners) ? result.top_winners as BackendPayload[] : [];
    const merged = new Map<string, BackendPayload>();
    [...existing, ...robotWinners.values()].forEach((winner) => {
      const key = String(winner.user_id || winner.userId || `name:${winner.name || 'Player'}`);
      const previous = merged.get(key);
      if (!previous || asNumber(winner.win_amount || winner.amount) > asNumber(previous.win_amount || previous.amount)) {
        merged.set(key, winner);
      }
    });
    result.top_winners = [...merged.values()]
      .sort((left, right) => asNumber(right.win_amount || right.amount) - asNumber(left.win_amount || left.amount))
      .slice(0, 10);
  }
  return {
    sequence,
    stateVersion: Math.max(0, asNumber(payload.state_version)),
    stateUpdatedAt: payload.state_updated_at || undefined,
    receivedAt: clockReceivedAt,
    serverNow,
    phase: phaseFor(payload, serverNowMs),
    round: round ? {
      id: String(round.id),
      status: String(round.status || ''),
      startedAt: round.started_at,
      endsAt: round.ends_at,
      winnerId: winnerId ? String(winnerId) : undefined,
      winnerIds: winnerIds.length ? winnerIds : winnerId ? [String(winnerId)] : undefined,
      result,
    } : null,
    options,
    totalPot: options.reduce((sum, option) => sum + option.totalAmount, 0) || asNumber(round?.total_bet),
    myTotalBet: myBets.reduce((sum: number, bet: BackendPayload) => sum + asNumber(bet.amount), 0),
    myPayout: myBets.reduce((sum: number, bet: BackendPayload) => sum + asNumber(bet.win_amount), 0),
    wallet: asNumber(payload.my_balance),
    history: Array.isArray(payload.history) ? payload.history : [],
    myHistory: Array.isArray(payload.my_history) ? payload.my_history : [],
    publicBets: normalizedPublicBets,
    dailyRanking: Array.isArray(payload.daily_ranking) ? payload.daily_ranking.map((entry: BackendPayload) => ({
      userId: String(entry.user_id || entry.userId || ''),
      name: entry.name || entry.full_name || 'Player',
      avatarUrl: entry.avatar_url || entry.avatarUrl || null,
      totalBet: asNumber(entry.total_bet || entry.totalBet),
      totalWin: asNumber(entry.total_win || entry.totalWin),
      score: asNumber(entry.score),
    })) : [],
    settlementSeconds: Math.max(0, asNumber(rules.bet_acceptance_grace_s) || 5),
    resultDisplaySeconds: Math.max(3, asNumber(payload.settings?.result_display_s) || 15),
  };
}

export function getNextRoundRecoveryDelay(snapshot: GameSnapshot, now = Date.now()) {
  if (!snapshot.round || snapshot.phase !== 'RESULT_RECEIVED') return null;
  const serverNow = Date.parse(snapshot.serverNow) || snapshot.receivedAt;
  const serverOffset = snapshot.receivedAt - serverNow;
  const result = snapshot.round.result || {};
  const settledAt = Date.parse(String(result.settled_at || result.result_ready_at || snapshot.serverNow));
  const nextRoundExpectedAt = (Number.isFinite(settledAt) ? settledAt : serverNow)
    + serverOffset
    + snapshot.resultDisplaySeconds * 1000;
  return Math.max(150, nextRoundExpectedAt - now + 75);
}

export class GameBackendService {
  private active = false;
  private stopped = false;
  private fetchInFlight: Promise<void> | null = null;
  private fetchQueued = false;
  private sequence = 0;
  private latestSnapshot: GameSnapshot | null = null;
  private newestRoundStartedAt = 0;
  private roundChannel: ReturnType<typeof supabase.channel> | null = null;
  private betChannel: ReturnType<typeof supabase.channel> | null = null;
  private robotBetChannel: ReturnType<typeof supabase.channel> | null = null;
  private positionTotalsChannel: ReturnType<typeof supabase.channel> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private realtimeDebounce: ReturnType<typeof setTimeout> | null = null;
  private completedRequests = new Map<string, BetResponse>();
  private readonly submissionLedger = new BetSubmissionLedger();
  private seenRealtimeBetIds = new Set<string>();
  private rankingCache: GameRankingEntry[] = [];
  private rankingFetchedAt = 0;
  private myHistoryCache: BackendPayload[] = [];
  private myHistoryFetchedAt = 0;
  private pendingBatch: PendingBetBatch | null = null;
  private inFlightBatches = new Map<string, PendingBetBatch>();
  private batchFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private batchRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPeerBets = new Map<string, PendingPeerBets>();
  private viewer: ViewerIdentity = { userId: null, name: 'Player', avatarUrl: null };
  private roundOptionTotalFloor = new Map<string, number>();
  private roundMineFloor = new Map<string, number>();
  private roundMyTotalFloor = 0;
  private overdueRecoveryAttempts = 0;
  private authoritativeWallet: number | null = null;

  constructor(
    readonly gameId: BackendGameId,
    private readonly callbacks: ServiceCallbacks,
  ) {}

  start() {
    this.stopped = false;
    this.resume('service-start');
    if (DURABLE_BATCH_GAMES.has(this.gameId)) void this.replayPersistedBatches();
  }

  setViewerIdentity(viewer: ViewerIdentity) {
    if (viewer.userId !== this.viewer.userId) {
      this.myHistoryCache = [];
      this.myHistoryFetchedAt = 0;
    }
    this.viewer = viewer;
    if (viewer.userId && DURABLE_BATCH_GAMES.has(this.gameId)) void this.replayPersistedBatches();
  }

  pause() {
    if (this.pendingBatch && !this.pendingBatch.flushing) void this.flushPendingBets('lifecycle-pause');
    this.active = false;
    this.clearTimers();
    this.removeChannels();
  }

  resume(reason: string) {
    if (this.stopped) return;
    this.active = true;
    this.installRoundChannel();
    void this.refresh(reason);
  }

  ensureActive(reason: string) {
    if (!this.active) this.resume(reason);
  }

  requestRefresh(reason: string) {
    if (reason === 'countdown-ended' && this.pendingBatch) {
      this.ensureActive(reason);
      if (!this.pendingBatch.flushing) void this.flushPendingBets('countdown-ended');
      this.schedulePoll(500);
      return;
    }
    this.resume(reason);
  }

  stop() {
    this.stopped = true;
    this.pause();
    this.completedRequests.clear();
    this.submissionLedger.clear();
    this.inFlightBatches.clear();
    this.authoritativeWallet = null;
    this.seenRealtimeBetIds.clear();
  }

  queueBet(request: BetRequest): BetResponse {
    const duplicate = this.submissionLedger.lookup(request);
    if (duplicate) return duplicate;
    const current = this.latestSnapshot;
    if (!current?.round || current.round.id !== request.roundId || current.phase !== 'BETTING'
      || this.secondsUntilBettingEnds(current) <= 0) {
      return { requestId: request.requestId, accepted: false, message: 'Betting is closed for this round.' };
    }
    if (!current.options.some((option) => option.id === request.optionId)
      || !Number.isSafeInteger(request.amount) || request.amount <= 0) {
      return { requestId: request.requestId, accepted: false, message: 'Invalid bet.' };
    }
    if (this.pendingBatch && this.pendingBatch.roundId !== request.roundId) {
      return { requestId: request.requestId, accepted: false, message: 'Previous bet batch is still processing.' };
    }
    if (this.pendingBatch?.flushing && !REALTIME_BET_GAMES.has(this.gameId)) {
      return { requestId: request.requestId, accepted: false, message: 'Betting is closed for this round.' };
    }
    const batch = this.pendingBatch || {
      roundId: request.roundId,
      batchId: `${request.roundId}-${this.viewer.userId || 'player'}-${Date.now()}`,
      createdAt: Date.now(),
      lastQueuedAt: Date.now(),
      items: new Map<string, number>(),
      requestIds: new Set<string>(),
      total: 0,
      flushing: false,
      baseOptionTotals: new Map(current.options.map((option) => [
        option.id,
        option.totalAmount,
      ])),
      baseMineTotals: new Map(current.options.map((option) => [
        option.id,
        option.myAmount,
      ])),
    };
    if (REALTIME_BET_GAMES.has(this.gameId) && this.authoritativeWallet === null) {
      this.authoritativeWallet = current.wallet;
    }
    const policy = evaluateQueuedBet({
      wallet: REALTIME_BET_GAMES.has(this.gameId)
        ? (this.authoritativeWallet ?? current.wallet)
        : current.wallet,
      pendingTotal: this.submissionLedger.reservedTotal(request.roundId),
      existingOptionIds: current.options.filter((option) => option.myAmount > 0).map((option) => option.id),
      pendingOptionIds: this.submissionLedger.reservedOptionIds(request.roundId),
      optionId: request.optionId,
      amount: request.amount,
      maxOptions: GAME_CONFIG[this.gameId].maxOptions,
      allowedAmounts: REALTIME_BET_GAMES.has(this.gameId) ? REALTIME_CHIPS : undefined,
    });
    if (!policy.accepted) return { requestId: request.requestId, accepted: false, message: policy.message };
    const queuedResponse: BetResponse = {
      requestId: request.requestId,
      accepted: true,
      queued: true,
      balance: policy.projectedBalance,
    };
    const registration = this.submissionLedger.register(request, queuedResponse);
    if (registration.kind !== 'registered') return registration.response;
    batch.items.set(request.optionId, (batch.items.get(request.optionId) || 0) + request.amount);
    batch.requestIds.add(request.requestId);
    batch.total += request.amount;
    batch.lastQueuedAt = Date.now();
    this.pendingBatch = batch;
    if (DURABLE_BATCH_GAMES.has(this.gameId)) void this.persistBatch(batch);
    this.scheduleBatchFlush(current);
    if (REALTIME_BET_GAMES.has(this.gameId)) this.schedulePendingBroadcast();
    if (REALTIME_BET_GAMES.has(this.gameId)) {
      this.callbacks.onWalletChange?.(policy.projectedBalance);
      this.emitProjectedSnapshot('bet-reserved');
    }
    return queuedResponse;
  }

  async refresh(reason = 'manual') {
    if (!this.active || this.stopped) return;
    if (this.fetchInFlight) {
      this.fetchQueued = true;
      return this.fetchInFlight;
    }
    this.callbacks.onNetworkChange(true, true);
    this.fetchInFlight = this.performRefresh(reason).finally(() => {
      this.fetchInFlight = null;
      if (this.fetchQueued && this.active) {
        this.fetchQueued = false;
        void this.refresh('queued-refresh');
      }
    });
    return this.fetchInFlight;
  }

  async placeBet(request: BetRequest): Promise<BetResponse> {
    const cached = this.completedRequests.get(request.requestId);
    if (cached) return cached;
    const current = this.latestSnapshot;
    if (!current?.round || current.round.id !== request.roundId || current.phase !== 'BETTING') {
      return this.remember({ requestId: request.requestId, accepted: false, message: 'Betting is closed for this round.' });
    }
    if (!current.options.some((option) => option.id === request.optionId)) {
      return this.remember({ requestId: request.requestId, accepted: false, message: 'Invalid bet option.' });
    }
    if (!Number.isSafeInteger(request.amount) || request.amount <= 0) {
      return this.remember({ requestId: request.requestId, accepted: false, message: 'Invalid bet amount.' });
    }
    try {
      const config = GAME_CONFIG[this.gameId];
      const { data, error } = await supabase.rpc(config.betRpc, {
        p_round_id: request.roundId,
        p_position: request.optionId,
        p_amount: request.amount,
      });
      const accepted = !error && data?.success === true;
      const response = this.remember({
        requestId: request.requestId,
        accepted,
        balance: accepted && typeof data.balance === 'number' ? Number(data.balance) : undefined,
        betId: accepted ? data.bet_id : undefined,
        message: accepted ? undefined : data?.message || error?.message || 'Bet failed.',
      });
      if (response.balance !== undefined) this.callbacks.onWalletChange?.(response.balance);
      void this.refresh(accepted ? 'bet-accepted' : 'bet-rejected');
      return response;
    } catch (error) {
      this.callbacks.onNetworkChange(false, false);
      return this.remember({
        requestId: request.requestId,
        accepted: false,
        message: error instanceof Error ? error.message : 'Bet request failed.',
      });
    }
  }

  private scheduleBatchFlush(snapshot: GameSnapshot) {
    if (!this.pendingBatch || this.pendingBatch.flushing || !snapshot.round?.endsAt) return;
    if (this.batchFlushTimer) clearTimeout(this.batchFlushTimer);
    const serverNow = Date.parse(snapshot.serverNow) || snapshot.receivedAt;
    const serverOffset = snapshot.receivedAt - serverNow;
    const bettingBoundary = Date.parse(snapshot.round.endsAt) + serverOffset;
    // Anchor the debounce to the last tap, not to "now": this runs again on every
    // accepted snapshot, and using Date.now() there would let a busy round keep
    // pushing the commit back. The max-hold and the betting boundary both cap it,
    // so a batch always lands inside the window it belongs to.
    const flushAt = REALTIME_BET_GAMES.has(this.gameId)
        ? Math.min(
          this.pendingBatch.lastQueuedAt + REALTIME_BET_DEBOUNCE_MS,
          this.pendingBatch.createdAt + REALTIME_BET_MAX_HOLD_MS,
          bettingBoundary - BETTING_BOUNDARY_SAFETY_MS,
        )
        : bettingBoundary;
    this.batchFlushTimer = setTimeout(
      () => {
        this.batchFlushTimer = null;
        void this.flushPendingBets('betting-boundary');
      },
      Math.max(0, flushAt - Date.now()),
    );
  }

  private async flushPendingBets(reason: string, retryBatch?: PendingBetBatch) {
    const batch = retryBatch || this.pendingBatch;
    if (!batch || batch.flushing || !batch.items.size) return;
    batch.flushing = true;
    this.submissionLedger.markSubmitting(batch.requestIds);
    if (REALTIME_BET_GAMES.has(this.gameId) && this.pendingBatch === batch) {
      // Let taps made while this short RPC is in flight form the next batch.
      this.pendingBatch = null;
    }
    this.inFlightBatches.set(batch.batchId, batch);
    if (this.batchFlushTimer) clearTimeout(this.batchFlushTimer);
    this.batchFlushTimer = null;
    // Publish the complete optimistic batch before the RPC starts. Peers keep
    // showing it until the authoritative INSERT event reconciles the same user
    // and position, avoiding a gap while the database request is in flight.
    this.sendPendingBroadcast(false, batch);
    if (DURABLE_BATCH_GAMES.has(this.gameId)) await this.persistBatch(batch);

    let data: BackendPayload | null = null;
    let lastError = '';
    let definitiveFailure = false;
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await supabase.rpc(GAME_CONFIG[this.gameId].batchRpc, {
          p_round_id: batch.roundId,
          p_client_batch_id: batch.batchId,
          p_bets: [...batch.items.entries()].map(([position, amount]) => ({ position, amount })),
        });
        if (!response.error && response.data?.success === true) {
          data = response.data;
          break;
        }
        lastError = response.data?.message || response.error?.message || 'Bet batch failed.';
        if (response.data?.success === false || /not found|closed|invalid|limit|balance|configured/i.test(lastError)) {
          definitiveFailure = true;
          break;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Bet batch request failed.';
      }
      if (attempt + 1 < maxAttempts) {
        const retryDelay = Math.min(1500, 250 * (2 ** attempt));
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }

    const requestIds = [...batch.requestIds];
    const bets = Array.isArray(data?.bets) ? data.bets.map((item: BackendPayload) => ({
      betId: item.betId || item.bet_id,
      position: String(item.position || ''),
      amount: asNumber(item.amount),
    })) : [];
    if (data) {
      await this.removePersistedBatch(batch.batchId);
      this.myHistoryFetchedAt = 0;
      const balance = asNumber(data.balance);
      this.submissionLedger.settle(requestIds, true, { balance });
      this.inFlightBatches.delete(batch.batchId);
      this.applyCommittedBatch(
        batch,
        bets,
        balance,
        asNumber(data.state_version),
        parseRules(data.authoritative_totals),
        parseRules(data.authoritative_my_totals),
      );
      const projectedBalance = this.projectedWallet();
      this.callbacks.onBetBatchResult?.({
        roundId: batch.roundId,
        requestIds,
        accepted: true,
        balance: projectedBalance,
        bets,
      });
      this.callbacks.onWalletChange?.(projectedBalance);
    } else if (definitiveFailure) {
      this.sendPendingBroadcast(true, batch);
      await this.removePersistedBatch(batch.batchId);
      this.submissionLedger.settle(requestIds, false, {
        message: lastError || `Could not submit bets (${reason}).`,
      });
      this.inFlightBatches.delete(batch.batchId);
      this.callbacks.onBetBatchResult?.({
        roundId: batch.roundId,
        requestIds,
        accepted: false,
        message: lastError || `Could not submit bets (${reason}).`,
      });
    } else {
      // The outcome is unknown (for example the commit succeeded but its HTTP
      // response was lost). Keep the same idempotency key and reservation,
      // then retry; never manufacture a second financial request.
      batch.flushing = false;
      this.inFlightBatches.delete(batch.batchId);
      if (!this.pendingBatch) {
        this.pendingBatch = batch;
      }
      this.callbacks.onNetworkChange(false, false);
      this.callbacks.onError(lastError || 'Bet confirmation is pending. Reconnecting…', true);
      if (this.batchRetryTimer) clearTimeout(this.batchRetryTimer);
      this.batchRetryTimer = setTimeout(() => {
        this.batchRetryTimer = null;
        void this.flushPendingBets('ambiguous-retry', batch);
      }, 2000);
      return;
    }
    if (this.pendingBatch === batch) this.pendingBatch = null;
    this.emitProjectedSnapshot(data ? 'batch-accepted-reconciled' : 'batch-rejected-reconciled');
    if (this.active) void this.refresh(data ? 'batch-accepted' : 'batch-rejected');
  }

  private applyCommittedBatch(
    batch: PendingBetBatch,
    bets: GameBetBatchItem[],
    balance: number,
    stateVersion = 0,
    authoritativeTotals: BackendPayload = {},
    authoritativeMyTotals: BackendPayload = {},
  ) {
    const snapshot = this.latestSnapshot;
    if (!snapshot?.round || snapshot.round.id !== batch.roundId) return;
    if (!REALTIME_BET_GAMES.has(this.gameId)) {
      this.applyLegacyCommittedBatch(snapshot, batch, bets, balance);
      return;
    }
    this.submissionLedger.settle(batch.requestIds, true, { balance });
    this.authoritativeWallet = this.authoritativeWallet === null
      ? balance
      : Math.min(this.authoritativeWallet, balance);
    if (stateVersion > 0 && stateVersion < snapshot.stateVersion) {
      // The response is valid for its own request, but a newer canonical
      // revision is already displayed. Never let reverse HTTP response order
      // regress public or personal totals.
      return;
    }
    if (snapshot.round && Object.keys(authoritativeMyTotals).length) {
      const canonicalMyTotal = Object.values(authoritativeMyTotals)
        .reduce((sum, amount) => sum + asNumber(amount), 0);
      this.submissionLedger.acknowledgeCommitted(
        snapshot.round.id,
        Math.max(0, canonicalMyTotal - snapshot.myTotalBet),
      );
    }
    const publicRows = [...snapshot.publicBets];
    bets.forEach((bet) => {
      if (bet.betId) this.seenRealtimeBetIds.add(String(bet.betId));
      if (!publicRows.some((row) => bet.betId && String(row.id) === String(bet.betId))) {
        publicRows.unshift({
          id: bet.betId,
          userId: this.viewer.userId || '',
          position: bet.position,
          amount: bet.amount,
          name: this.viewer.name,
          avatarUrl: this.viewer.avatarUrl,
          createdAt: new Date().toISOString(),
        });
      }
    });
    const expectedTotal = (optionId: string) => (
      (batch.baseOptionTotals.get(optionId) || 0) + (batch.items.get(optionId) || 0)
    );
    const expectedMine = (optionId: string) => (
      (batch.baseMineTotals.get(optionId) || 0) + (batch.items.get(optionId) || 0)
    );
    const wallet = this.projectedWallet({ ...snapshot, wallet: balance });
    const next: GameSnapshot = {
      ...snapshot,
      sequence: ++this.sequence,
      stateVersion: Math.max(snapshot.stateVersion, stateVersion),
      options: snapshot.options.map((option) => {
        // The batch response may race either a database event or a state RPC.
        // Use the captured pre-submit floor instead of adding to the current
        // snapshot, otherwise a response that follows a refresh counts twice.
        const hasCanonicalTotal = Object.prototype.hasOwnProperty.call(authoritativeTotals, option.id);
        const hasCanonicalMine = Object.prototype.hasOwnProperty.call(authoritativeMyTotals, option.id);
        const totalAmount = hasCanonicalTotal
          ? asNumber(authoritativeTotals[option.id])
          : Math.max(option.totalAmount, expectedTotal(option.id));
        const myAmount = hasCanonicalMine
          ? asNumber(authoritativeMyTotals[option.id])
          : Math.max(option.myAmount, expectedMine(option.id));
        this.roundOptionTotalFloor.set(option.id, totalAmount);
        this.roundMineFloor.set(option.id, myAmount);
        return { ...option, totalAmount, myAmount };
      }),
      myTotalBet: Object.keys(authoritativeMyTotals).length
        ? Object.values(authoritativeMyTotals).reduce((sum, amount) => sum + asNumber(amount), 0)
        : Math.max(
          snapshot.myTotalBet,
          [...snapshot.options].reduce((sum, option) => sum + expectedMine(option.id), 0),
        ),
      wallet,
      publicBets: publicRows,
    };
    next.totalPot = next.options.reduce((sum, option) => sum + option.totalAmount, 0);
    this.roundMyTotalFloor = Math.max(this.roundMyTotalFloor, next.myTotalBet);
    this.acceptSnapshot(next, 'bet-batch-accepted');
  }

  private applyLegacyCommittedBatch(
    snapshot: GameSnapshot,
    batch: PendingBetBatch,
    bets: GameBetBatchItem[],
    balance: number,
  ) {
    const increments = new Map<string, number>();
    const publicRows = [...snapshot.publicBets];
    bets.forEach((bet) => {
      const alreadyApplied = !!bet.betId && this.seenRealtimeBetIds.has(String(bet.betId));
      if (!alreadyApplied) increments.set(bet.position, (increments.get(bet.position) || 0) + bet.amount);
      if (bet.betId) this.seenRealtimeBetIds.add(String(bet.betId));
      if (!publicRows.some((row) => bet.betId && String(row.id) === String(bet.betId))) {
        publicRows.unshift({
          id: bet.betId,
          userId: this.viewer.userId || '',
          position: bet.position,
          amount: bet.amount,
          name: this.viewer.name,
          avatarUrl: this.viewer.avatarUrl,
          createdAt: new Date().toISOString(),
        });
      }
    });
    const committedDelta = [...increments.values()].reduce((sum, amount) => sum + amount, 0);
    this.acceptSnapshot({
      ...snapshot,
      sequence: ++this.sequence,
      options: snapshot.options.map((option) => ({
        ...option,
        totalAmount: option.totalAmount + (increments.get(option.id) || 0),
        myAmount: option.myAmount + (batch.items.get(option.id) || 0),
      })),
      totalPot: snapshot.totalPot + committedDelta,
      myTotalBet: snapshot.myTotalBet + batch.total,
      wallet: balance,
      publicBets: publicRows,
    }, 'bet-batch-accepted');
  }

  private secondsUntilBettingEnds(snapshot: GameSnapshot) {
    const endsAt = Date.parse(snapshot.round?.endsAt || '');
    if (!Number.isFinite(endsAt)) return 0;
    const serverNow = Date.parse(snapshot.serverNow);
    const offset = snapshot.receivedAt - (Number.isFinite(serverNow) ? serverNow : snapshot.receivedAt);
    return Math.max(0, Math.ceil((endsAt + offset - Date.now()) / 1000));
  }

  private async performRefresh(reason: string) {
    try {
      const config = GAME_CONFIG[this.gameId];
      const requestStartedAt = Date.now();
      const realtimeSnapshot = REALTIME_BET_GAMES.has(this.gameId);
      const { data, error } = await supabase.rpc(
        realtimeSnapshot ? 'get_realtime_betting_snapshot' : config.stateRpc,
        realtimeSnapshot ? {
          p_game_type: this.gameId,
          p_known_round_id: this.latestSnapshot?.round?.id || null,
          p_known_state_version: this.latestSnapshot?.stateVersion || null,
        } : undefined,
      );
      const rpcReceivedAt = Date.now();
      if (error) throw error;
      if (!data?.success) {
        this.callbacks.onError(data?.message || 'Game is currently unavailable.', true);
        return;
      }
      const clockReceivedAt = Math.round((requestStartedAt + rpcReceivedAt) / 2);
      const previous = this.latestSnapshot;
      const sameRound = String(data.round?.id || '') === String(previous?.round?.id || '');
      data.public_bets = sameRound ? previous?.publicBets || [] : [];
      data.daily_ranking = this.rankingCache;

      // Deliver timing, phase and result before slower profile/ranking queries.
      // A delayed HUD must never delay the authoritative winner animation.
      const snapshot = normalizeGameSnapshot(this.gameId, data, ++this.sequence, clockReceivedAt);
      this.applyAuthoritativeWallet(snapshot);
      if (!this.acceptSnapshot(snapshot, reason)) return;

      if (!data.round?.id || !this.shouldEnrich(reason)) return;
      void this.enrichSnapshot(data, reason, clockReceivedAt, snapshot.sequence).catch(() => {});
    } catch (error) {
      this.callbacks.onNetworkChange(false, false);
      this.callbacks.onError(error instanceof Error ? error.message : 'Could not synchronize game.', true);
      this.schedulePoll(3000);
    }
  }

  private acceptSnapshot(snapshot: GameSnapshot, reason: string) {
      const startedAt = Date.parse(snapshot.round?.startedAt || '') || 0;
      if (startedAt && startedAt < this.newestRoundStartedAt && snapshot.round?.id !== this.latestSnapshot?.round?.id) return false;
      if (snapshot.round?.id && snapshot.round.id === this.latestSnapshot?.round?.id
        && snapshot.stateVersion > 0
        && this.latestSnapshot.stateVersion > snapshot.stateVersion) return false;
      this.newestRoundStartedAt = Math.max(this.newestRoundStartedAt, startedAt);
      const roundChanged = snapshot.round?.id !== this.latestSnapshot?.round?.id;
      if (roundChanged) {
        this.seenRealtimeBetIds.clear();
        this.pendingPeerBets.clear();
        this.roundOptionTotalFloor.clear();
        this.roundMineFloor.clear();
        this.roundMyTotalFloor = 0;
        this.installBetChannel(snapshot.round?.id);
      }
      snapshot = this.reconcileSameRoundSnapshot(snapshot, roundChanged);
      this.latestSnapshot = snapshot;
      snapshot.publicBets.forEach((bet) => {
        if (bet.id) this.seenRealtimeBetIds.add(String(bet.id));
      });
      if (this.pendingBatch && !this.pendingBatch.flushing
        && (this.pendingBatch.roundId !== snapshot.round?.id || snapshot.phase !== 'BETTING')) {
        void this.flushPendingBets('authoritative-phase-change');
      }
      this.callbacks.onNetworkChange(true, false);
      this.callbacks.onWalletChange?.(this.projectedWallet(snapshot));
      if (snapshot.phase !== 'BETTING') this.pendingPeerBets.clear();
      this.emitProjectedSnapshot(reason);
      this.scheduleRecovery(snapshot);
      this.schedulePoll();
      if (this.pendingBatch?.roundId === snapshot.round?.id) this.scheduleBatchFlush(snapshot);
      return true;
  }

  private reconcileSameRoundSnapshot(
    snapshot: GameSnapshot,
    roundChanged: boolean,
  ): GameSnapshot {
    if (!snapshot.round || !REALTIME_BET_GAMES.has(this.gameId)) return snapshot;
    const sameRound = !roundChanged && snapshot.round.id === this.latestSnapshot?.round?.id;
    const shouldTotalsRemainMonotonic = sameRound;
    const options = snapshot.options.map((option) => {
      const totalFloor = this.roundOptionTotalFloor.get(option.id) || 0;
      const mineFloor = this.roundMineFloor.get(option.id) || 0;
      const totalAmount = shouldTotalsRemainMonotonic
        ? Math.max(option.totalAmount, totalFloor)
        : option.totalAmount;
      const myAmount = shouldTotalsRemainMonotonic
        ? Math.max(option.myAmount, mineFloor)
        : option.myAmount;
      this.roundOptionTotalFloor.set(option.id, totalAmount);
      this.roundMineFloor.set(option.id, myAmount);
      return { ...option, totalAmount, myAmount };
    });

    const myTotalBet = shouldTotalsRemainMonotonic
      ? Math.max(snapshot.myTotalBet, this.roundMyTotalFloor)
      : snapshot.myTotalBet;
    this.roundMyTotalFloor = myTotalBet;

    return {
      ...snapshot,
      options,
      totalPot: options.reduce((sum, option) => sum + option.totalAmount, 0),
      myTotalBet,
    };
  }

  private shouldEnrich(reason: string) {
    return reason === 'service-start'
      || reason === 'game-ready'
      || reason === 'screen-focus'
      || reason === 'app-foreground'
      || reason === 'network-reconnected'
      || reason === 'bet-accepted'
      || reason === 'bet-rejected'
      || reason === 'batch-accepted'
      || reason === 'batch-rejected'
      || reason === 'realtime'
      || reason === 'fallback-poll'
      || reason === 'manual';
  }

  private async enrichSnapshot(data: BackendPayload, reason: string, clockReceivedAt: number, baseSequence: number) {
    const roundId = String(data.round?.id || '');
    const [publicBets, dailyRanking, myHistory] = await Promise.all([
      this.loadPublicBets(roundId),
      this.loadDailyRanking(),
      this.loadMyHistory(),
    ]);
    if (!this.active
      || this.latestSnapshot?.round?.id !== roundId
      || this.latestSnapshot.sequence !== baseSequence) return;
    if (publicBets) {
      data.public_bets = publicBets;
      if (this.gameId === 'greedy_lion' || this.gameId === 'greedy_pro') {
        const totals = { ...parseRules(data.bet_totals) };
        publicBets.forEach((bet) => {
          if (!String(bet.user_id || '').startsWith('robot:') || !bet.position) return;
          const position = String(bet.position);
          totals[position] = asNumber(totals[position]) + asNumber(bet.amount);
        });
        data.bet_totals = totals;
      }
    }
    data.daily_ranking = dailyRanking;
    data.my_history = myHistory;
    const enriched = normalizeGameSnapshot(this.gameId, data, ++this.sequence, clockReceivedAt);
    this.applyAuthoritativeWallet(enriched);
    this.acceptSnapshot(enriched, `${reason}-enriched`);
  }

  private installRoundChannel() {
    if (this.roundChannel || !this.active) return;
    this.roundChannel = supabase
      .channel(`v2-${this.gameId}-rounds-${Date.now()}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: ROUND_TABLES[this.gameId],
        filter: `room_id=eq.${GLOBAL_ROOM_IDS[this.gameId]}`,
      }, (payload) => this.handleRealtimeRound(payload.new as BackendPayload))
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void this.refresh('realtime-subscribed');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') this.schedulePoll(500);
      });
  }

  private handleRealtimeRound(round: BackendPayload) {
    const current = this.latestSnapshot?.round;
    if (!round?.id || !current || String(round.id) !== current.id) {
      this.scheduleRealtimeRefresh();
      return;
    }
    const incomingWinnerIds = Array.isArray(round.result?.winning_option_ids)
      ? round.result.winning_option_ids.map(String)
      : [];
    const incomingWinner = round.result?.winner_pos || round.winner_pos || round.result?.category || incomingWinnerIds[0];
    const incomingVersion = asNumber(round.state_version);
    const newerVersion = incomingVersion > (this.latestSnapshot?.stateVersion || 0);
    const sameAuthoritativeState = String(round.status || '') === current.status
      && String(incomingWinner || '') === String(current.winnerId || '');
    if (sameAuthoritativeState) {
      // Placing a bet writes `total_bet` and `bets` back to the round row, and
      // both columns are watched by bump_game_round_state_version - so every
      // wager bumps state_version and fans a round event out to *every* client.
      // Forcing an immediate refresh on that bump (as this did) meant each bet
      // cost every connected player a full state read: rounds with wagers carry
      // ~7 versions against ~3 for an idle round, so a table of bettors turned
      // one round into a burst of forced reads. Worse than the load, a read
      // issued in that burst can return the *next* round before the settled
      // round's result snapshot arrives, and the scene drops the late result as
      // stale - which is exactly why the result popup went missing only for
      // players who had bet. Per-position totals already arrive on the dedicated
      // bet channel, so a bump with no status/winner change only needs the
      // ordinary debounced reconcile.
      if (newerVersion) this.scheduleRealtimeRefresh();
      return;
    }
    const resultReady = (round.status === 'resolving' || round.status === 'settled') && !!incomingWinner;
    if (resultReady) this.applyRealtimeResult(round, String(incomingWinner), incomingWinnerIds);
    // A realtime round row contains the global winner but not this player's
    // post-settlement wallet/payout. Reconcile those authoritative values
    // immediately; normal betting updates can retain the short debounce.
    this.scheduleRealtimeRefresh(resultReady ? 0 : 300);
  }

  private applyRealtimeResult(round: BackendPayload, winnerId: string, winnerIds: string[] = []) {
    const snapshot = this.latestSnapshot;
    if (!snapshot?.round || String(round.id) !== snapshot.round.id) return;
    const now = Date.now();
    const result = parseRules(round.result);
    const historyRow = {
      id: String(round.id),
      winner_pos: winnerId,
      result,
      total_bet: asNumber(round.total_bet),
      win_amount: asNumber(round.win_amount),
      settled_at: result.settled_at,
    };
    const history = round.status !== 'settled' || snapshot.history.some((row) => String(row.id || '') === String(round.id))
      ? snapshot.history
      : [historyRow, ...snapshot.history];
    const next: GameSnapshot = {
      ...snapshot,
      sequence: ++this.sequence,
      stateVersion: Math.max(snapshot.stateVersion, asNumber(round.state_version)),
      receivedAt: now,
      serverNow: new Date(now).toISOString(),
      phase: 'RESULT_RECEIVED',
      round: {
        ...snapshot.round,
        status: String(round.status || 'resolving'),
        startedAt: round.started_at || snapshot.round.startedAt,
        endsAt: round.ends_at || snapshot.round.endsAt,
        winnerId,
        winnerIds: winnerIds.length ? winnerIds : [winnerId],
        result,
      },
      totalPot: asNumber(round.total_bet) || snapshot.totalPot,
      history,
    };
    this.acceptSnapshot(next, 'realtime-result-fast-path');
  }

  private installBetChannel(roundId?: string) {
    if (this.betChannel) supabase.removeChannel(this.betChannel).catch(() => {});
    if (this.robotBetChannel) supabase.removeChannel(this.robotBetChannel).catch(() => {});
    if (this.positionTotalsChannel) supabase.removeChannel(this.positionTotalsChannel).catch(() => {});
    this.betChannel = null;
    this.robotBetChannel = null;
    this.positionTotalsChannel = null;
    if (!roundId || !this.active) return;
    this.betChannel = supabase
      .channel(realtimeBetChannelTopic(this.gameId, roundId), {
        config: { broadcast: { self: false } },
      })
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: BET_TABLES[this.gameId], filter: `round_id=eq.${roundId}`,
      }, (payload) => {
        this.applyRealtimeBet(payload.new as BackendPayload);
        this.scheduleRealtimeRefresh(0);
      })
      .on('broadcast', { event: 'pending_bets' }, (message) => {
        this.applyPendingBroadcast(message.payload as BackendPayload);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void this.refresh('realtime-subscribed');
      });
    if (REALTIME_BET_GAMES.has(this.gameId)) {
      this.positionTotalsChannel = supabase
        .channel(`v2-${this.gameId}-position-totals-${roundId}-${Date.now()}`)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'game_round_position_totals', filter: `round_id=eq.${roundId}`,
        }, () => this.scheduleRealtimeRefresh(0))
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') void this.refresh('realtime-subscribed');
        });
    }
    if (ROBOT_BET_GAMES.has(this.gameId)) {
      const robotBetTable = ROBOT_BET_TABLES[this.gameId];
      if (!robotBetTable) return;
      this.robotBetChannel = supabase
        .channel(`v2-${this.gameId}-robots-${roundId}-${Date.now()}`)
        .on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: robotBetTable, filter: `round_id=eq.${roundId}`,
        }, (payload) => {
          const row = payload.new as BackendPayload;
          this.applyRealtimeBet({
            ...row,
            id: `robot:${row.id}`,
            user_id: `robot:${row.robot_name || row.id}`,
            name: row.robot_name || 'Robot player',
            avatar_url: null,
            is_robot: true,
          });
          this.scheduleRealtimeRefresh(0);
        })
        .subscribe();
    }
  }

  private applyRealtimeBet(bet: BackendPayload) {
    const snapshot = this.latestSnapshot;
    if (!snapshot?.round || !bet?.id || String(bet.round_id) !== snapshot.round.id) return;
    const betId = String(bet.id);
    if (this.seenRealtimeBetIds.has(betId)
      || snapshot.publicBets.some((row) => String(row.id) === betId)) return;
    this.seenRealtimeBetIds.add(betId);

    const amount = asNumber(bet.amount);
    const userId = String(bet.user_id || '');
    const position = String(bet.position || '');
    const betCreatedAt = Date.parse(String(bet.created_at || ''));
    // Compare against the moment the aggregate was computed on the server, not
    // `state_updated_at`. The round row only bumps `state_updated_at` on phase
    // transitions, so during a betting window it stays frozen at round start —
    // every bet then looked "newer" than the aggregate and got projected on top
    // of totals that already counted it. The monotonic floors below latch that
    // inflated value for the rest of the round, which is why two devices could
    // disagree on the pot permanently.
    const snapshotQueriedAt = Date.parse(String(snapshot.serverNow || ''));
    const aggregateAlreadyIncludesBet = Number.isFinite(betCreatedAt)
      && Number.isFinite(snapshotQueriedAt)
      && snapshotQueriedAt >= betCreatedAt;
    this.reconcilePendingPeerBet(userId, position, amount);
    const publicBets = bet.is_robot ? [{
      id: betId,
      userId,
      position,
      amount,
      name: String(bet.name || 'Robot player'),
      avatarUrl: null,
      createdAt: bet.created_at,
    }, ...snapshot.publicBets] : snapshot.publicBets;
    // The placing client already projects its own taps inside Phaser. Other
    // clients need this committed row reflected immediately instead of
    // waiting for the aggregate snapshot RPC. The event ID guard above and
    // the monotonic round floors prevent duplicate delivery or a racing stale
    // snapshot from counting the wager twice.
    const projectCommittedTotal = amount > 0
      && !!position
      && userId !== this.viewer.userId
      && !aggregateAlreadyIncludesBet;
    const options = projectCommittedTotal
      ? snapshot.options.map((option) => option.id === position
        ? { ...option, totalAmount: option.totalAmount + amount }
        : option)
      : snapshot.options;
    if (projectCommittedTotal) {
      const projected = options.find((option) => option.id === position)?.totalAmount || 0;
      this.roundOptionTotalFloor.set(position, Math.max(
        this.roundOptionTotalFloor.get(position) || 0,
        projected,
      ));
    }
    const next: GameSnapshot = {
      ...snapshot,
      sequence: ++this.sequence,
      options,
      totalPot: options.reduce((sum, option) => sum + option.totalAmount, 0),
      // Profile rows are loaded by the debounced refresh below. Publishing
      // an anonymous placeholder here caused a visible duplicate identity.
      publicBets,
    };
    if (this.secondsUntilBettingEnds(next) > 0) {
      this.acceptSnapshot(next, 'realtime-bet-fast-path');
    }
  }

  private reconcilePendingPeerBet(userId: string, position: string, committedAmount: number) {
    const peer = this.pendingPeerBets.get(userId);
    if (!peer || !position || committedAmount <= 0) return;
    let remaining = committedAmount;
    peer.items = peer.items.flatMap((item) => {
      if (item.position !== position || remaining <= 0) return [item];
      const consumed = Math.min(item.amount, remaining);
      remaining -= consumed;
      const amount = item.amount - consumed;
      return amount > 0 ? [{ ...item, amount }] : [];
    });
    if (peer.items.length) this.pendingPeerBets.set(userId, peer);
    else this.pendingPeerBets.delete(userId);
  }

  private schedulePendingBroadcast() {
    if (this.pendingBroadcastTimer) return;
    this.pendingBroadcastTimer = setTimeout(() => {
      this.pendingBroadcastTimer = null;
      this.sendPendingBroadcast(false);
    }, 12);
  }

  private sendPendingBroadcast(clear: boolean, sourceBatch = this.pendingBatch) {
    if (this.pendingBroadcastTimer) clearTimeout(this.pendingBroadcastTimer);
    this.pendingBroadcastTimer = null;
    const batch = sourceBatch;
    if (!batch || !this.betChannel || !this.viewer.userId) return;
    void this.betChannel.send({
      type: 'broadcast',
      event: 'pending_bets',
      payload: {
        roundId: batch.roundId,
        userId: this.viewer.userId,
        name: this.viewer.name,
        avatarUrl: this.viewer.avatarUrl,
        items: clear ? [] : [...batch.items.entries()].map(([position, amount]) => ({ position, amount })),
        updatedAt: Date.now(),
      },
    });
  }

  private applyPendingBroadcast(payload: BackendPayload) {
    const snapshot = this.latestSnapshot;
    const userId = String(payload.userId || '');
    if (!snapshot?.round || snapshot.phase !== 'BETTING'
      || String(payload.roundId || '') !== snapshot.round.id
      || !userId || userId === this.viewer.userId) return;
    const items = Array.isArray(payload.items) ? payload.items
      .map((item: BackendPayload) => ({ position: String(item.position || ''), amount: asNumber(item.amount) }))
      .filter((item) => snapshot.options.some((option) => option.id === item.position) && item.amount > 0)
      .slice(0, GAME_CONFIG[this.gameId].maxOptions) : [];
    if (!items.length) this.pendingPeerBets.delete(userId);
    else this.pendingPeerBets.set(userId, {
      roundId: snapshot.round.id,
      userId,
      name: String(payload.name || 'Player'),
      avatarUrl: typeof payload.avatarUrl === 'string' ? payload.avatarUrl : null,
      items,
      updatedAt: asNumber(payload.updatedAt) || Date.now(),
    });
    this.emitProjectedSnapshot('pending-bet-broadcast');
  }

  private emitProjectedSnapshot(reason: string) {
    const snapshot = this.latestSnapshot;
    if (!snapshot) return;
    const now = Date.now();
    const peers = [...this.pendingPeerBets.entries()].flatMap(([userId, peer]) => {
      if (peer.roundId !== snapshot.round?.id || now - peer.updatedAt > 10000) {
        this.pendingPeerBets.delete(userId);
        return [];
      }
      return peer.items.map((item) => ({ peer, item }));
    });
    const wallet = this.projectedWallet(snapshot);
    if (!peers.length) {
      this.callbacks.onState(wallet === snapshot.wallet ? snapshot : { ...snapshot, wallet }, reason);
      return;
    }
    const projectedBets: GameSnapshot['publicBets'] = [];
    const pendingTotals = new Map<string, number>();
    peers.forEach(({ peer, item }) => {
      pendingTotals.set(item.position, (pendingTotals.get(item.position) || 0) + item.amount);
      projectedBets.push({
        id: `pending:${peer.userId}:${item.position}`,
        userId: peer.userId || '',
        position: item.position,
        amount: item.amount,
        name: peer.name,
        avatarUrl: peer.avatarUrl,
        createdAt: new Date(peer.updatedAt).toISOString(),
      });
    });
    const options = snapshot.options.map((option) => ({
      ...option,
      totalAmount: option.totalAmount + (pendingTotals.get(option.id) || 0),
    }));
    this.callbacks.onState({
      ...snapshot,
      sequence: ++this.sequence,
      wallet,
      options,
      totalPot: options.reduce((sum, option) => sum + option.totalAmount, 0),
      publicBets: [...projectedBets, ...snapshot.publicBets],
    }, reason);
  }

  private projectedWallet(snapshot = this.latestSnapshot) {
    if (!snapshot?.round) return snapshot?.wallet || 0;
    if (!REALTIME_BET_GAMES.has(this.gameId)) return snapshot.wallet;
    const authoritative = this.authoritativeWallet ?? snapshot.wallet;
    return Math.max(0, authoritative - this.submissionLedger.reservedTotal(snapshot.round.id));
  }

  private applyAuthoritativeWallet(snapshot: GameSnapshot) {
    if (!snapshot.round || !REALTIME_BET_GAMES.has(this.gameId)) return;
    const roundChanged = snapshot.round.id !== this.latestSnapshot?.round?.id;
    const canExposeIncrease = roundChanged || snapshot.phase === 'RESULT_RECEIVED';
    this.authoritativeWallet = this.authoritativeWallet === null || canExposeIncrease
      ? snapshot.wallet
      : Math.min(this.authoritativeWallet, snapshot.wallet);
    snapshot.wallet = this.projectedWallet(snapshot);
  }

  private scheduleRealtimeRefresh(delay = 300) {
    if (this.realtimeDebounce) clearTimeout(this.realtimeDebounce);
    this.realtimeDebounce = setTimeout(() => {
      this.realtimeDebounce = null;
      void this.refresh('realtime');
    }, delay);
  }

  private scheduleRecovery(snapshot: GameSnapshot) {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    if (!this.active || !snapshot.round) return;
    const serverNow = Date.parse(snapshot.serverNow) || snapshot.receivedAt;
    const serverOffset = snapshot.receivedAt - serverNow;
    if (snapshot.phase === 'RESULT_RECEIVED') {
      this.overdueRecoveryAttempts = 0;
      const delay = getNextRoundRecoveryDelay(snapshot);
      this.recoveryTimer = setTimeout(
        () => void this.refresh('next-round-boundary-recovery'),
        delay ?? 150,
      );
      return;
    }
    if (!snapshot.round.endsAt) return;
    const resultExpectedAt = Date.parse(snapshot.round.endsAt)
      + serverOffset
      + snapshot.settlementSeconds * 1000;
    const resultIsOverdue = resultExpectedAt <= Date.now();
    if (!resultIsOverdue) this.overdueRecoveryAttempts = 0;
    // A flat 350ms retry turned every client into a polling storm whenever the
    // server clock ran behind: each device issued ~3 RPCs/second for as long as
    // the result stayed overdue, which slowed the database and delayed the next
    // tick further. Back off so a slow tick degrades gracefully instead of
    // feeding back on itself.
    const delay = resultIsOverdue
      ? Math.min(4000, 350 * 2 ** Math.min(this.overdueRecoveryAttempts++, 4))
      : Math.max(200, resultExpectedAt - Date.now() + 75);
    this.recoveryTimer = setTimeout(
      () => void this.refresh(resultIsOverdue ? 'result-overdue-recovery' : 'result-boundary-recovery'),
      delay,
    );
  }

  private schedulePoll(delay?: number) {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (!this.active) return;
    const phase = this.latestSnapshot?.phase;
    const nextDelay = delay ?? (
      phase === 'BETTING_CLOSED' || phase === 'RESULT_PENDING' ? 1500
        : phase === 'RESULT_RECEIVED' ? 2000
          : phase === 'BETTING' ? 30000
            : 3000
    );
    this.pollTimer = setTimeout(() => void this.refresh('fallback-poll'), nextDelay);
  }

  private async loadPublicBets(roundId: string) {
    const robotBetTable = ROBOT_BET_TABLES[this.gameId];
    const [playerResponse, robotResponse] = await Promise.all([
      supabase
        .from(BET_TABLES[this.gameId])
        .select('id,round_id,user_id,position,amount,win_amount,created_at')
        .eq('round_id', roundId)
        .order('created_at', { ascending: false })
        .limit(100),
      ROBOT_BET_GAMES.has(this.gameId) && robotBetTable
        ? supabase
          .from(robotBetTable)
          .select('id,round_id,position,amount,robot_name,created_at')
          .eq('round_id', roundId)
          .order('created_at', { ascending: false })
          .limit(100)
        : Promise.resolve({ data: [], error: null }),
    ]);
    const { data: bets, error } = playerResponse;
    if (error || !bets) return null;
    const profiles = await this.loadProfiles(bets.map((bet) => bet.user_id));
    const playerBets: BackendPayload[] = bets.map((bet) => ({
      ...bet,
      name: profiles.get(bet.user_id)?.name || 'Player',
      avatar_url: profiles.get(bet.user_id)?.avatarUrl || null,
    }));
    const robotBets: BackendPayload[] = robotResponse.error ? [] : (robotResponse.data || []).map((bet: BackendPayload) => ({
      ...bet,
      id: `robot:${bet.id}`,
      user_id: `robot:${bet.robot_name || bet.id}`,
      name: bet.robot_name || 'Robot player',
      avatar_url: null,
      is_robot: true,
    }));
    return [...playerBets, ...robotBets]
      .sort((left, right) => Date.parse(right.created_at || '') - Date.parse(left.created_at || ''))
      .slice(0, 200);
  }

  private async loadMyHistory(): Promise<BackendPayload[]> {
    if (!this.viewer.userId) return [];
    if (Date.now() - this.myHistoryFetchedAt < 5000) return this.myHistoryCache;
    const roundTable = ROUND_TABLES[this.gameId];
    const { data: bets, error } = await supabase
      .from(BET_TABLES[this.gameId])
      .select(`id,round_id,position,amount,win_amount,created_at,round:${roundTable}!inner(room_id,status,winner_pos,result,ends_at)`)
      .eq('user_id', this.viewer.userId)
      .eq('round.room_id', GLOBAL_ROOM_IDS[this.gameId])
      .order('created_at', { ascending: false })
      .limit(120);
    if (error || !bets) return this.myHistoryCache;

    const rounds = new Map<string, BackendPayload>();
    bets.forEach((bet: BackendPayload) => {
      const roundId = String(bet.round_id || '');
      if (!roundId || (!rounds.has(roundId) && rounds.size >= 20)) return;
      const relation = Array.isArray(bet.round) ? bet.round[0] : bet.round;
      const current = rounds.get(roundId) || {
        round_id: roundId,
        total_bet: 0,
        total_win: 0,
        positions: [],
        created_at: bet.created_at,
        winner_pos: relation?.winner_pos || relation?.result?.winner_pos || relation?.result?.category,
        status: relation?.status,
      };
      current.total_bet += asNumber(bet.amount);
      current.total_win += asNumber(bet.win_amount);
      current.positions.push({ position: bet.position, amount: asNumber(bet.amount) });
      rounds.set(roundId, current);
    });
    this.myHistoryCache = [...rounds.values()].slice(0, 20);
    this.myHistoryFetchedAt = Date.now();
    return this.myHistoryCache;
  }

  private async loadDailyRanking(): Promise<GameRankingEntry[]> {
    if (Date.now() - this.rankingFetchedAt < 30000) return this.rankingCache;
    const backendGameType = BACKEND_GAME_TYPES[this.gameId];
    if (this.gameId !== 'greedy_pro') {
      const { data: rpcData, error: rpcError } = await supabase.rpc('get_daily_game_ranking', {
        p_game_type: backendGameType,
        p_limit: 20,
      });
      if (!rpcError && Array.isArray(rpcData) && rpcData.length > 0) {
        this.rankingCache = this.normalizeRanking(rpcData);
        this.rankingFetchedAt = Date.now();
        return this.rankingCache;
      }
    }

    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const start = `${date}T00:00:00+06:00`;
    const roundTable = ROUND_TABLES[this.gameId];
    const { data: bets, error } = await supabase
      .from(BET_TABLES[this.gameId])
      .select(`user_id,amount,win_amount,round:${roundTable}!inner(room_id,game_type)`)
      .eq('round.room_id', GLOBAL_ROOM_IDS[this.gameId])
      .eq('round.game_type', backendGameType)
      .gte('created_at', start)
      .limit(5000);
    if (error || !bets) return this.rankingCache;
    const rankingBets = bets as unknown as BackendPayload[];
    const profiles = await this.loadProfiles(rankingBets.map((bet) => bet.user_id));
    const totals = new Map<string, { totalBet: number; totalWin: number }>();
    rankingBets.forEach((bet) => {
      const current = totals.get(bet.user_id) || { totalBet: 0, totalWin: 0 };
      current.totalBet += asNumber(bet.amount);
      current.totalWin += asNumber(bet.win_amount);
      totals.set(bet.user_id, current);
    });
    this.rankingCache = [...totals.entries()]
      .map(([userId, totalsForUser]) => ({
        userId,
        name: profiles.get(userId)?.name || 'Player',
        avatarUrl: profiles.get(userId)?.avatarUrl || null,
        ...totalsForUser,
        score: totalsForUser.totalBet + totalsForUser.totalWin,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
    this.rankingFetchedAt = Date.now();
    return this.rankingCache;
  }

  private normalizeRanking(rows: BackendPayload[]): GameRankingEntry[] {
    return rows.map((entry) => ({
      userId: String(entry.user_id || ''),
      name: entry.name || entry.full_name || 'Player',
      avatarUrl: entry.avatar_url || null,
      totalBet: asNumber(entry.total_bet),
      totalWin: asNumber(entry.total_win),
      score: asNumber(entry.score),
    }));
  }

  private async loadProfiles(userIds: Array<string | null | undefined>) {
    const uniqueIds = [...new Set(userIds.filter((id): id is string => !!id))];
    const profiles = new Map<string, { name: string; avatarUrl: string | null }>();
    if (!uniqueIds.length) return profiles;
    const { data } = await supabase
      .from('profiles')
      .select('id,full_name,avatar_url')
      .in('id', uniqueIds);
    (data || []).forEach((profile) => profiles.set(profile.id, {
      name: profile.full_name || 'Player',
      avatarUrl: profile.avatar_url || null,
    }));
    return profiles;
  }

  private clearTimers() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    if (this.realtimeDebounce) clearTimeout(this.realtimeDebounce);
    if (this.batchFlushTimer) clearTimeout(this.batchFlushTimer);
    if (this.batchRetryTimer) clearTimeout(this.batchRetryTimer);
    if (this.pendingBroadcastTimer) clearTimeout(this.pendingBroadcastTimer);
    this.pollTimer = null;
    this.recoveryTimer = null;
    this.realtimeDebounce = null;
    this.batchFlushTimer = null;
    this.batchRetryTimer = null;
    this.pendingBroadcastTimer = null;
  }

  private removeChannels() {
    if (this.roundChannel) supabase.removeChannel(this.roundChannel).catch(() => {});
    if (this.betChannel) supabase.removeChannel(this.betChannel).catch(() => {});
    if (this.robotBetChannel) supabase.removeChannel(this.robotBetChannel).catch(() => {});
    if (this.positionTotalsChannel) supabase.removeChannel(this.positionTotalsChannel).catch(() => {});
    this.roundChannel = null;
    this.betChannel = null;
    this.robotBetChannel = null;
    this.positionTotalsChannel = null;
  }

  private async outboxStorage() {
    try {
      return (await import('@react-native-async-storage/async-storage')).default;
    } catch {
      return null;
    }
  }

  private serializeBatch(batch: PendingBetBatch) {
    return {
      gameId: this.gameId,
      userId: this.viewer.userId,
      roundId: batch.roundId,
      batchId: batch.batchId,
      items: [...batch.items.entries()],
      requestIds: [...batch.requestIds],
      total: batch.total,
      createdAt: batch.createdAt,
    };
  }

  private async persistBatch(batch: PendingBetBatch) {
    const storage = await this.outboxStorage();
    if (!storage) return;
    try {
      const parsed = JSON.parse(await storage.getItem(BET_OUTBOX_KEY) || '[]') as BackendPayload[];
      const remaining = parsed.filter((entry) => entry?.batchId !== batch.batchId);
      remaining.push(this.serializeBatch(batch));
      await storage.setItem(BET_OUTBOX_KEY, JSON.stringify(remaining.slice(-50)));
    } catch {
      // The in-memory retry path remains active if device storage is unavailable.
    }
  }

  private async removePersistedBatch(batchId: string) {
    const storage = await this.outboxStorage();
    if (!storage) return;
    try {
      const parsed = JSON.parse(await storage.getItem(BET_OUTBOX_KEY) || '[]') as BackendPayload[];
      await storage.setItem(
        BET_OUTBOX_KEY,
        JSON.stringify(parsed.filter((entry) => entry?.batchId !== batchId)),
      );
    } catch {
      // A later replay is safe because the server idempotency key is unchanged.
    }
  }

  private async replayPersistedBatches() {
    const storage = await this.outboxStorage();
    if (!storage || this.stopped || !this.viewer.userId) return;
    try {
      const parsed = JSON.parse(await storage.getItem(BET_OUTBOX_KEY) || '[]') as BackendPayload[];
      const mine = parsed.filter((entry) => (
        entry?.gameId === this.gameId && entry?.userId === this.viewer.userId
      ));
      for (const entry of mine) {
        if (this.stopped || !entry?.batchId || !entry?.roundId || !Array.isArray(entry.items)) break;
        const { data, error } = await supabase.rpc(GAME_CONFIG[this.gameId].batchRpc, {
          p_round_id: entry.roundId,
          p_client_batch_id: entry.batchId,
          p_bets: entry.items.map((item: unknown[]) => ({ position: item[0], amount: item[1] })),
        });
        if (!error && (data?.success === true || data?.success === false)) {
          await this.removePersistedBatch(String(entry.batchId));
        } else {
          break;
        }
      }
      if (mine.length && this.active) void this.refresh('network-reconnected');
    } catch {
      // Realtime subscription and snapshot recovery still run normally.
    }
  }

  private remember(response: BetResponse) {
    this.completedRequests.set(response.requestId, response);
    if (this.completedRequests.size > 100) {
      const oldest = this.completedRequests.keys().next().value;
      if (oldest) this.completedRequests.delete(oldest);
    }
    return response;
  }
}
