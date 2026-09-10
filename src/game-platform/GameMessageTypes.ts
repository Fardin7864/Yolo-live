export const GAME_PROTOCOL_VERSION = 1 as const;

export type GameId = 'greedy_lion' | 'greedy_pro' | 'tin_patti_pro' | 'lucky_dice' | 'crash';

export type CrashPhase =
  | 'SCHEDULED' | 'BETTING_OPEN' | 'BETTING_LOCKED' | 'RUNNING'
  | 'CRASHED' | 'SETTLING' | 'SETTLED' | 'VOIDING' | 'VOIDED';

export interface CrashSnapshot {
  sequence: number;
  stateVersion: number;
  serverTime: string;
  connected: boolean;
  round: null | {
    id: string;
    roundNumber: number;
    phase: CrashPhase;
    bettingClosesAt?: string;
    flightStartedAt?: string;
    growthRate?: number;
    multiplierBp?: number;
    crashMultiplierBp?: number;
    seedCommitment: string;
    revealedSeed?: string;
    algorithmVersion: string;
  };
  myBet: null | {
    id: string;
    amount: number;
    autoCashoutBp?: number;
    status: 'placed' | 'cashed_out' | 'lost' | 'refunded' | 'cancelled';
    cashoutMultiplierBp?: number;
    payout?: number;
  };
  wallet: number;
  config?: { minBet: number; maxBet: number; minAutoCashoutBp: number; maxAutoCashoutBp: number };
  publicActivity: Array<{ id: string; name: string; avatarUrl?: string; amount: number; cashoutMultiplierBp?: number; simulated: boolean }>;
  history: Array<{ roundId: string; crashMultiplierBp: number; seedCommitment: string; revealedSeed?: string }>;
}

export type GamePhase =
  | 'WAITING'
  | 'BETTING'
  | 'BETTING_CLOSED'
  | 'RESULT_PENDING'
  | 'RESULT_RECEIVED'
  | 'ANIMATING_RESULT'
  | 'SHOWING_RESULT'
  | 'ROUND_COMPLETE';

export interface GameOptionState {
  id: string;
  label: string;
  category?: string;
  multiplier?: number;
  totalAmount: number;
  myAmount: number;
}

export interface GameRoundState {
  id: string;
  status: string;
  startedAt?: string;
  endsAt?: string;
  winnerId?: string;
  winnerIds?: string[];
  result?: Record<string, unknown>;
}

export interface GamePublicBet {
  id?: string;
  userId: string;
  position: string;
  amount: number;
  name: string;
  avatarUrl: string | null;
  createdAt?: string;
}

export interface GameRankingEntry {
  userId: string;
  name: string;
  avatarUrl: string | null;
  totalBet: number;
  totalWin: number;
  score: number;
}

export interface GameBetBatchItem {
  betId?: string;
  position: string;
  amount: number;
}

export type GameBetRequestStatus = 'pending' | 'accepted' | 'failed';

export interface GameSnapshot {
  sequence: number;
  /** Monotonic database revision for ordering same-round snapshots. */
  stateVersion: number;
  stateUpdatedAt?: string;
  receivedAt: number;
  serverNow: string;
  phase: GamePhase;
  round: GameRoundState | null;
  options: GameOptionState[];
  totalPot: number;
  myTotalBet: number;
  myPayout: number;
  wallet: number;
  history: Array<Record<string, unknown>>;
  myHistory: Array<Record<string, unknown>>;
  publicBets: GamePublicBet[];
  dailyRanking: GameRankingEntry[];
  settlementSeconds: number;
  resultDisplaySeconds: number;
}

export interface BridgeEnvelope<TType extends string, TPayload> {
  protocolVersion: typeof GAME_PROTOCOL_VERSION;
  messageId: string;
  timestamp: number;
  type: TType;
  gameId: GameId;
  payload: TPayload;
}

export type NativeToGameMessage =
  | BridgeEnvelope<'INIT', { targetFps: 30; locale: string; currencySymbol: string; debug: boolean }>
  | BridgeEnvelope<'AUTH', { userId: string | null; displayName: string; avatarUrl: string | null }>
  | BridgeEnvelope<'ROUND_STATE', { snapshot: GameSnapshot; reason: string }>
  | BridgeEnvelope<'WALLET_UPDATE', { balance: number; authoritative: boolean }>
  | BridgeEnvelope<'APP_ACTIVE', Record<string, never>>
  | BridgeEnvelope<'APP_BACKGROUND', Record<string, never>>
  | BridgeEnvelope<'SCREEN_FOCUS', Record<string, never>>
  | BridgeEnvelope<'SCREEN_BLUR', Record<string, never>>
  | BridgeEnvelope<'SOUND_SETTINGS', { enabled: boolean; volume: number }>
  | BridgeEnvelope<'EXIT_GAME', { reason: string }>
  | BridgeEnvelope<'NETWORK_STATE', { connected: boolean; synchronizing: boolean }>
  | BridgeEnvelope<'PLACE_BET_RESULT', { requestId: string; accepted: boolean; queued?: boolean; status?: GameBetRequestStatus; balance?: number; betId?: string; message?: string }>
  | BridgeEnvelope<'BET_BATCH_RESULT', { roundId: string; requestIds: string[]; accepted: boolean; status?: Exclude<GameBetRequestStatus, 'pending'>; balance?: number; bets?: GameBetBatchItem[]; message?: string }>
  | BridgeEnvelope<'CRASH_STATE', { snapshot: CrashSnapshot; reason: string }>
  | BridgeEnvelope<'CRASH_BET_RESULT', { requestId: string; accepted: boolean; balance?: number; betId?: string; code?: string; message?: string }>
  | BridgeEnvelope<'CRASH_CASHOUT_RESULT', { requestId: string; accepted: boolean; balance?: number; payout?: number; multiplierBp?: number; code?: string; message?: string }>
  | BridgeEnvelope<'ERROR', { code: string; message: string; recoverable: boolean }>;

export type GameToNativeMessage =
  | BridgeEnvelope<'GAME_READY', { initializedAt: number }>
  | BridgeEnvelope<'PLACE_BET', { requestId: string; roundId: string; optionId: string; amount: number }>
  | BridgeEnvelope<'PLACE_CRASH_BET', { requestId: string; roundId: string; amount: number; autoCashoutBp?: number }>
  | BridgeEnvelope<'CASH_OUT', { requestId: string; roundId: string; betId: string }>
  | BridgeEnvelope<'REQUEST_STATE_REFRESH', { reason: string }>
  | BridgeEnvelope<'RESULT_ANIMATION_COMPLETE', { roundId: string }>
  | BridgeEnvelope<'OPEN_HISTORY', Record<string, never>>
  | BridgeEnvelope<'OPEN_RULES', Record<string, never>>
  | BridgeEnvelope<'EXIT_GAME', { reason: string }>
  | BridgeEnvelope<'ERROR', { code: string; message: string; fatal: boolean; stack?: string }>
  | BridgeEnvelope<'PERFORMANCE_METRICS', { fps: number; frameTimeMs: number; heapBytes?: number; initializedInMs: number }>
  | BridgeEnvelope<'BRIDGE_ERROR', { message: string; offendingType?: string }>;

export const NATIVE_MESSAGE_TYPES = new Set<NativeToGameMessage['type']>([
  'INIT', 'AUTH', 'ROUND_STATE', 'WALLET_UPDATE', 'APP_ACTIVE',
  'APP_BACKGROUND', 'SCREEN_FOCUS', 'SCREEN_BLUR', 'SOUND_SETTINGS',
  'EXIT_GAME', 'NETWORK_STATE', 'PLACE_BET_RESULT', 'ERROR',
  'BET_BATCH_RESULT',
  'CRASH_STATE', 'CRASH_BET_RESULT', 'CRASH_CASHOUT_RESULT',
]);

export const GAME_MESSAGE_TYPES = new Set<GameToNativeMessage['type']>([
  'GAME_READY', 'PLACE_BET', 'REQUEST_STATE_REFRESH',
  'RESULT_ANIMATION_COMPLETE', 'OPEN_HISTORY', 'OPEN_RULES', 'EXIT_GAME',
  'ERROR', 'PERFORMANCE_METRICS', 'BRIDGE_ERROR',
  'PLACE_CRASH_BET', 'CASH_OUT',
]);

export function createBridgeMessage(
  gameId: GameId,
  type: NativeToGameMessage['type'] | GameToNativeMessage['type'],
  payload: object,
): NativeToGameMessage | GameToNativeMessage {
  return {
    protocolVersion: GAME_PROTOCOL_VERSION,
    messageId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    type,
    gameId,
    payload,
  } as NativeToGameMessage | GameToNativeMessage;
}

export function isGameToNativeMessage(value: unknown): value is GameToNativeMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<GameToNativeMessage>;
  return message.protocolVersion === GAME_PROTOCOL_VERSION
    && typeof message.messageId === 'string'
    && typeof message.gameId === 'string'
    && typeof message.type === 'string'
    && GAME_MESSAGE_TYPES.has(message.type as GameToNativeMessage['type'])
    && !!message.payload
    && typeof message.payload === 'object';
}
