import assert from 'node:assert/strict';
import test from 'node:test';
import { getResultSecondsLeft, getRoundSecondsLeft } from './GameClock';
import { GameStateMachine } from './GameStateMachine';
import { evaluateQueuedBet } from '../../src/game-platform/BetBatchPolicy';
import { resolveSnapshotBetTotals } from '../../src/game-platform/GameSnapshotTotals';
import { evaluateTeenPattiHand } from '../teen-patti/HandEvaluator';
import type { GameSnapshot } from './types';

const snapshot = (roundId: string, phase: GameSnapshot['phase'], startedAt: string, winnerId?: string): GameSnapshot => ({
  sequence: 1,
  stateVersion: 1,
  receivedAt: Date.now(),
  serverNow: new Date().toISOString(),
  phase,
  round: { id: roundId, status: phase === 'RESULT_RECEIVED' ? 'settled' : 'betting', startedAt, winnerId },
  options: [],
  totalPot: 0,
  myTotalBet: 0,
  myPayout: 0,
  wallet: 0,
  history: [],
  myHistory: [],
  publicBets: [],
  dailyRanking: [],
  settlementSeconds: 5,
  resultDisplaySeconds: 15,
});

test('animates one authoritative result exactly once', () => {
  const machine = new GameStateMachine();
  machine.applySnapshot(snapshot('round-1', 'BETTING', '2026-01-01T00:00:00Z'));
  const realtime = machine.applySnapshot(snapshot('round-1', 'RESULT_RECEIVED', '2026-01-01T00:00:00Z', 'lion'));
  assert.equal(realtime.shouldAnimateResult, true);
  assert.equal(machine.beginResultAnimation('round-1'), true);
  assert.equal(machine.completeResultAnimation('round-1'), true);
  const pollingDuplicate = machine.applySnapshot(snapshot('round-1', 'RESULT_RECEIVED', '2026-01-01T00:00:00Z', 'lion'));
  assert.equal(pollingDuplicate.duplicateResult, true);
  assert.equal(pollingDuplicate.shouldAnimateResult, false);
  assert.equal(machine.beginResultAnimation('round-1'), false);
});

test('accepts and deduplicates a multi-winning dice result', () => {
  const machine = new GameStateMachine();
  machine.applySnapshot(snapshot('dice-round', 'BETTING', '2026-01-01T00:00:00Z'));
  const result = snapshot('dice-round', 'RESULT_RECEIVED', '2026-01-01T00:00:00Z');
  result.round!.winnerIds = ['small', 'even', 'total_6'];
  const first = machine.applySnapshot(result);
  assert.equal(first.shouldAnimateResult, true);
  assert.equal(machine.beginResultAnimation('dice-round'), true);
  assert.equal(machine.completeResultAnimation('dice-round'), true);
  const duplicate = machine.applySnapshot(result);
  assert.equal(duplicate.duplicateResult, true);
  assert.equal(duplicate.shouldAnimateResult, false);
});

test('rejects an old round after a newer round is active', () => {
  const machine = new GameStateMachine();
  machine.applySnapshot(snapshot('round-1', 'BETTING', '2026-01-01T00:00:00Z'));
  const next = machine.applySnapshot(snapshot('round-2', 'BETTING', '2026-01-01T00:01:00Z'));
  assert.equal(next.newRound, true);
  const stale = machine.applySnapshot(snapshot('round-1', 'RESULT_RECEIVED', '2026-01-01T00:00:00Z', 'lion'));
  assert.equal(stale.accepted, false);
  assert.equal(stale.staleRound, true);
  assert.equal(machine.currentRoundId, 'round-2');
});

test('cannot complete animation for a different round', () => {
  const machine = new GameStateMachine();
  machine.applySnapshot(snapshot('round-2', 'RESULT_RECEIVED', '2026-01-01T00:01:00Z', 'coffee'));
  assert.equal(machine.beginResultAnimation('round-1'), false);
  assert.equal(machine.completeResultAnimation('round-1'), false);
});

test('rejects a delayed betting payload after the same round result', () => {
  const machine = new GameStateMachine();
  machine.applySnapshot(snapshot('round-race', 'BETTING', '2026-01-01T00:01:00Z'));
  machine.applySnapshot(snapshot('round-race', 'RESULT_RECEIVED', '2026-01-01T00:01:00Z', 'fish'));

  const delayedEnrichment = machine.applySnapshot(snapshot('round-race', 'BETTING', '2026-01-01T00:01:00Z'));

  assert.equal(delayedEnrichment.accepted, false);
  assert.equal(delayedEnrichment.staleRound, true);
  assert.equal(machine.phase, 'RESULT_RECEIVED');
});

test('countdown advances every second without a new backend snapshot', () => {
  const receivedAt = Date.parse('2026-01-01T00:00:02Z');
  const state = snapshot('round-clock', 'BETTING', '2026-01-01T00:00:00Z');
  state.receivedAt = receivedAt;
  state.serverNow = '2026-01-01T00:00:00Z';
  state.round!.endsAt = '2026-01-01T00:00:30Z';

  assert.equal(getRoundSecondsLeft(state, receivedAt), 30);
  assert.equal(getRoundSecondsLeft(state, receivedAt + 1001), 29);
  assert.equal(getRoundSecondsLeft(state, receivedAt + 29001), 1);
  assert.equal(getRoundSecondsLeft(state, receivedAt + 30001), 0);
});

test('late result snapshots only show the authoritative time remaining', () => {
  const state = snapshot('round-result-clock', 'RESULT_RECEIVED', '2026-01-01T00:00:00Z', 'fish');
  state.receivedAt = Date.parse('2026-01-01T00:00:14Z');
  state.serverNow = '2026-01-01T00:00:14Z';
  state.resultDisplaySeconds = 5;
  state.round!.endsAt = '2026-01-01T00:00:05Z';
  state.round!.result = { settled_at: '2026-01-01T00:00:10Z' };

  assert.equal(getResultSecondsLeft(state, state.receivedAt), 1);
  assert.equal(getResultSecondsLeft(state, state.receivedAt + 1001), 0);
});

test('queued bets aggregate without exceeding wallet or six unique items', () => {
  const accepted = evaluateQueuedBet({
    wallet: 10000,
    pendingTotal: 3000,
    existingOptionIds: ['corn'],
    pendingOptionIds: ['fish'],
    optionId: 'fish',
    amount: 1000,
  });
  assert.deepEqual(accepted, { accepted: true, projectedBalance: 6000 });

  const seventh = evaluateQueuedBet({
    wallet: 10000,
    pendingTotal: 0,
    existingOptionIds: ['corn', 'fish', 'ham', 'pepper', 'carrot', 'tomato'],
    pendingOptionIds: [],
    optionId: 'shrimp',
    amount: 1000,
  });
  assert.equal(seventh.accepted, false);

  const overWallet = evaluateQueuedBet({
    wallet: 5000,
    pendingTotal: 4000,
    existingOptionIds: [],
    pendingOptionIds: ['corn'],
    optionId: 'corn',
    amount: 5000,
  });
  assert.equal(overWallet.accepted, false);

  const invalidChip = evaluateQueuedBet({
    wallet: 10000,
    pendingTotal: 0,
    existingOptionIds: [],
    pendingOptionIds: [],
    optionId: 'corn',
    amount: 2000,
  });
  assert.equal(invalidChip.accepted, false);

  const teenFourthBoard = evaluateQueuedBet({
    wallet: 10000,
    pendingTotal: 0,
    existingOptionIds: ['crown', 'coffee', 'cake'],
    pendingOptionIds: [],
    optionId: 'another-board',
    amount: 1000,
    maxOptions: 3,
  });
  assert.equal(teenFourthBoard.accepted, false);
});

test('authoritative bet totals win over truncated or different public bet feeds', () => {
  const authoritative = { crown: 0, coffee: '1500', cake: 5000 };
  const firstFeed = [
    { position: 'crown', amount: 1000 },
    { position: 'coffee', amount: 500 },
  ];
  const secondFeed = [
    { position: 'crown', amount: 100000 },
    { position: 'cake', amount: 50000 },
  ];

  assert.deepEqual(
    resolveSnapshotBetTotals({ bet_totals: authoritative }, firstFeed),
    { crown: 0, coffee: 1500, cake: 5000 },
  );
  assert.deepEqual(
    resolveSnapshotBetTotals({ bet_totals: authoritative }, secondFeed),
    { crown: 0, coffee: 1500, cake: 5000 },
  );
});

test('public bet feed is aggregated only when authoritative totals are absent', () => {
  const publicFeed = [
    { position: 'crown', amount: 1000 },
    { position: 'crown', amount: '500' },
    { position: 'coffee', amount: 5000 },
  ];

  assert.deepEqual(resolveSnapshotBetTotals({}, publicFeed), { crown: 1500, coffee: 5000 });
  assert.deepEqual(resolveSnapshotBetTotals({ bet_totals: {} }, publicFeed), {});
});

test('Teen Patti derives Run and Color labels from the exact displayed cards', () => {
  assert.equal(evaluateTeenPattiHand([
    { value: '7', suit: 'H' }, { value: '6', suit: 'D' }, { value: '5', suit: 'C' },
  ]), 'Sequence');
  assert.equal(evaluateTeenPattiHand([
    { value: 'K', suit: 'H' }, { value: '9', suit: 'H' }, { value: '4', suit: 'H' },
  ]), 'Color');
  assert.equal(evaluateTeenPattiHand([
    { value: 'A', suit: 'S' }, { value: 'K', suit: 'S' }, { value: 'Q', suit: 'S' },
  ]), 'Pure Sequence');
  assert.equal(evaluateTeenPattiHand([
    { value: 'A', suit: 'S' }, { value: '3', suit: 'H' }, { value: '2', suit: 'D' },
  ]), 'Sequence');
  assert.equal(evaluateTeenPattiHand([
    { value: 'Q', suit: 'H' }, { value: 'Q', suit: 'C' }, { value: '9', suit: 'D' },
  ]), 'Pair');
  assert.equal(evaluateTeenPattiHand([
    { value: '8', suit: 'H' }, { value: '8', suit: 'C' }, { value: '8', suit: 'D' },
  ]), 'Trail');
});
