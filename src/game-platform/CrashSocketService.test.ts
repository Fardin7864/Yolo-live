import assert from 'node:assert/strict';
import test from 'node:test';
import { deserializeCrashOutbox, mergeCrashEvent, normalizeCrashSnapshot, shouldRefreshCrashSession } from './CrashSocketService';

test('normalizes contract envelopes and preserves multiplier basis points', () => {
  const state = normalizeCrashSnapshot({
    sequence: 12,
    serverTime: '2026-08-24T12:00:00Z',
    payload: {
      state_version: 4,
      wallet: 9000,
      round: { id: 'r1', round_number: 7, phase: 'RUNNING', multiplier_bp: 245, seed_commitment: 'abc', algorithm_version: 'v2' },
      my_bet: { id: 'b1', amount: 500, status: 'placed', auto_cashout_bp: 300 },
      public_activity: [{ id: 'p1', name: 'Bot', amount: 20, simulated: true }],
      history: [{ round_id: 'old', crash_multiplier_bp: 175, seed_commitment: 'old-hash' }],
    },
  });
  assert.equal(state.sequence, 12);
  assert.equal(state.round?.multiplierBp, 245);
  assert.equal(state.myBet?.autoCashoutBp, 300);
  assert.equal(state.publicActivity[0]?.simulated, true);
  assert.equal(state.history[0]?.crashMultiplierBp, 175);
});

test('flat new-round events replace round identity while retaining wallet and feed', () => {
  const prior = normalizeCrashSnapshot({ payload: { sequence: 5, wallet: 7000, round: { id: 'old', phase: 'SETTLED' }, publicActivity: [{ id: 'p1', name: 'A', amount: 10 }] } });
  const { snapshot, gap } = mergeCrashEvent(prior, {
    sequence: 8, roundId: 'new', serverTime: '2026-08-24T12:00:01Z',
    payload: { roundId: 'new', roundNumber: 9, flightStartedAt: '2026-08-24T12:00:00Z', growthRate: 0.09, stateVersion: 2 },
  }, 'round:flight_started');
  assert.equal(snapshot.round?.id, 'new');
  assert.equal(snapshot.round?.phase, 'RUNNING');
  assert.equal(snapshot.round?.growthRate, 0.09);
  assert.equal(snapshot.wallet, 7000);
  assert.equal(snapshot.publicActivity.length, 1);
  assert.equal(gap, true);
});

test('session refresh threshold and durable command outbox are restart safe', () => {
  assert.equal(shouldRefreshCrashSession(Math.floor(Date.now() / 1000) + 30), true);
  assert.equal(shouldRefreshCrashSession(Math.floor(Date.now() / 1000) + 600), false);
  const request = { event: 'bet:cashout', payload: { requestId: 'stable-1', roundId: 'r1', betId: 'b1' } };
  assert.deepEqual(deserializeCrashOutbox(JSON.stringify([request])), [request]);
  assert.deepEqual(deserializeCrashOutbox('{broken'), []);
});
