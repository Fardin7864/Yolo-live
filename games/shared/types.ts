import type {
  GameId,
  GamePhase,
  GamePublicBet,
  GameRankingEntry,
  GameSnapshot,
  NativeToGameMessage,
} from '../../src/game-platform/GameMessageTypes';

export type { GameId, GamePhase, GamePublicBet, GameRankingEntry, GameSnapshot, NativeToGameMessage };

declare global {
  interface Window {
    __GAME_ID__: GameId;
    __GAME_EMBEDDED__?: boolean;
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }

  interface Performance {
    memory?: { usedJSHeapSize: number };
  }
}

export interface GameBootstrap {
  gameId: GameId;
  targetFps: 30;
  locale: string;
  currencySymbol: string;
  debug: boolean;
}

export interface StateDecision {
  accepted: boolean;
  duplicateResult: boolean;
  staleRound: boolean;
  newRound: boolean;
  shouldAnimateResult: boolean;
  snapshot: GameSnapshot;
}
