import type { CrashPhase, CrashSnapshot } from '../../src/game-platform/GameMessageTypes';

export type CrashAction = 'BET' | 'WAIT' | 'CANCELLED' | 'CASH_OUT' | 'CASHED_OUT' | 'LOST';

export function resolveCrashAction(phase: CrashPhase, bet: CrashSnapshot['myBet']): CrashAction {
  if (bet?.status === 'cashed_out') return 'CASHED_OUT';
  if (bet?.status === 'lost') return 'LOST';
  if (bet?.status === 'refunded' || bet?.status === 'cancelled') return 'CANCELLED';
  if (phase === 'RUNNING' && bet?.status === 'placed') return 'CASH_OUT';
  if (phase === 'BETTING_OPEN' && !bet) return 'BET';
  return 'WAIT';
}
