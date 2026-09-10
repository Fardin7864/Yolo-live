import type { GamePhase, GameSnapshot, StateDecision } from './types';

const LEGAL_TRANSITIONS: Record<GamePhase, ReadonlySet<GamePhase>> = {
  WAITING: new Set(['BETTING']),
  BETTING: new Set(['BETTING_CLOSED', 'RESULT_PENDING', 'RESULT_RECEIVED', 'ROUND_COMPLETE']),
  BETTING_CLOSED: new Set(['RESULT_PENDING', 'RESULT_RECEIVED', 'ROUND_COMPLETE']),
  RESULT_PENDING: new Set(['RESULT_RECEIVED', 'ROUND_COMPLETE']),
  RESULT_RECEIVED: new Set(['ANIMATING_RESULT', 'SHOWING_RESULT', 'ROUND_COMPLETE']),
  ANIMATING_RESULT: new Set(['SHOWING_RESULT', 'ROUND_COMPLETE']),
  SHOWING_RESULT: new Set(['ROUND_COMPLETE', 'BETTING']),
  ROUND_COMPLETE: new Set(['WAITING', 'BETTING']),
};

export class GameStateMachine {
  phase: GamePhase = 'WAITING';
  currentRoundId: string | null = null;
  lastProcessedRoundId: string | null = null;
  lastAnimatedRoundId: string | null = null;
  private newestStartedAt = 0;

  applySnapshot(snapshot: GameSnapshot): StateDecision {
    const incomingId = snapshot.round?.id || null;
    const incomingStartedAt = Date.parse(snapshot.round?.startedAt || '') || 0;
    const staleRound = !!incomingId
      && !!this.currentRoundId
      && incomingId !== this.currentRoundId
      && incomingStartedAt > 0
      && incomingStartedAt < this.newestStartedAt;
    if (staleRound) {
      return { accepted: false, duplicateResult: false, staleRound: true, newRound: false, shouldAnimateResult: false, snapshot };
    }

    const newRound = !!incomingId && incomingId !== this.currentRoundId;
    const regressesCompletedRound = !newRound
      && !!incomingId
      && this.lastProcessedRoundId === incomingId
      && snapshot.phase !== 'RESULT_RECEIVED';
    if (regressesCompletedRound) {
      return { accepted: false, duplicateResult: false, staleRound: true, newRound: false, shouldAnimateResult: false, snapshot };
    }
    if (newRound) {
      if (this.currentRoundId) this.transition('ROUND_COMPLETE');
      this.currentRoundId = incomingId;
      this.newestStartedAt = Math.max(this.newestStartedAt, incomingStartedAt);
      this.transition(snapshot.phase === 'BETTING' ? 'BETTING' : snapshot.phase, true);
    } else if (!incomingId) {
      if (this.currentRoundId) this.transition('ROUND_COMPLETE');
      this.currentRoundId = null;
      this.transition('WAITING', true);
    } else if (snapshot.phase !== 'RESULT_RECEIVED') {
      this.transition(snapshot.phase);
    }

    const hasResult = snapshot.phase === 'RESULT_RECEIVED'
      && (!!snapshot.round?.winnerId || !!snapshot.round?.winnerIds?.length);
    const duplicateResult = hasResult && this.lastProcessedRoundId === incomingId;
    if (hasResult && !duplicateResult) {
      this.lastProcessedRoundId = incomingId;
      this.transition('RESULT_RECEIVED', true);
    }
    const shouldAnimateResult = hasResult && !duplicateResult && this.lastAnimatedRoundId !== incomingId;
    return { accepted: true, duplicateResult, staleRound: false, newRound, shouldAnimateResult, snapshot };
  }

  beginResultAnimation(roundId: string) {
    if (roundId !== this.currentRoundId || roundId === this.lastAnimatedRoundId) return false;
    this.lastAnimatedRoundId = roundId;
    this.transition('ANIMATING_RESULT');
    return true;
  }

  completeResultAnimation(roundId: string) {
    if (roundId !== this.currentRoundId || roundId !== this.lastAnimatedRoundId) return false;
    this.transition('SHOWING_RESULT');
    return true;
  }

  private transition(next: GamePhase, recovery = false) {
    if (next === this.phase) return;
    if (!recovery && !LEGAL_TRANSITIONS[this.phase].has(next)) return;
    this.phase = next;
  }
}
