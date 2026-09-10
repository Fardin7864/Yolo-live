import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { GameStateMachine } from '../../games/shared/GameStateMachine';
import { evaluateQueuedBet } from './BetBatchPolicy';
import {
  GameBackendService,
  getNextRoundRecoveryDelay,
  normalizeGameSnapshot,
  realtimeBetChannelTopic,
} from './GameBackendService';
import type { GameId, GameSnapshot } from './GameMessageTypes';
import { setTestRpcHandler } from './TestSupabaseStub.test';

const startedAt = '2026-08-24T10:00:00.000Z';
const endsAt = '2099-08-24T10:00:30.000Z';

function payload(gameId: 'greedy_pro' | 'tin_patti_pro', overrides: Record<string, unknown> = {}) {
  const positions = gameId === 'greedy_pro' ? ['corn', 'chicken'] : ['crown', 'coffee'];
  return {
    success: true,
    server_now: '2026-08-24T10:00:05.000Z',
    round: { id: `${gameId}-round-1`, status: 'betting', started_at: startedAt, ends_at: endsAt },
    bet_totals: Object.fromEntries(positions.map((position) => [position, 0])),
    my_bets: [],
    public_bets: [],
    my_balance: 20_000,
    ...overrides,
  };
}

function snapshot(gameId: 'greedy_pro' | 'tin_patti_pro', overrides: Record<string, unknown> = {}) {
  return normalizeGameSnapshot(gameId, payload(gameId, overrides), 1, Date.now());
}

function serviceFor(gameId: 'greedy_pro' | 'tin_patti_pro', initial: GameSnapshot) {
  const states: GameSnapshot[] = [];
  const wallets: number[] = [];
  const batchResults: Array<{ accepted: boolean; balance?: number; message?: string }> = [];
  const service = new GameBackendService(gameId, {
    onState: (state) => states.push(state),
    onError: () => undefined,
    onNetworkChange: () => undefined,
    onWalletChange: (balance) => wallets.push(balance),
    onBetBatchResult: (result) => batchResults.push(result),
  });
  const internal = service as unknown as {
    latestSnapshot: GameSnapshot;
    sequence: number;
    pendingBatch: {
      roundId: string;
      batchId: string;
      createdAt: number;
      items: Map<string, number>;
      requestIds: Set<string>;
      total: number;
      flushing: boolean;
    } | null;
    inFlightBatches: Map<string, unknown>;
    seenRealtimeBetIds: Set<string>;
    submissionLedger: {
      settle: (requestIds: Iterable<string>, accepted: boolean, details?: Record<string, unknown>) => void;
    };
    scheduleBatchFlush: (snapshot: GameSnapshot) => void;
    betChannel: { send: (message: Record<string, unknown>) => Promise<unknown> } | null;
    applyCommittedBatch: (
      batch: NonNullable<typeof internal.pendingBatch>,
      bets: Array<{ betId: string; position: string; amount: number }>,
      balance: number,
      stateVersion?: number,
      authoritativeTotals?: Record<string, number>,
      authoritativeMyTotals?: Record<string, number>,
    ) => void;
    applyRealtimeBet: (bet: Record<string, unknown>) => void;
    applyPendingBroadcast: (payload: Record<string, unknown>) => void;
    flushPendingBets: (reason: string, retryBatch?: NonNullable<typeof internal.pendingBatch>) => Promise<void>;
    acceptSnapshot: (state: GameSnapshot, reason: string) => boolean;
  };
  internal.latestSnapshot = initial;
  internal.sequence = initial.sequence;
  internal.seenRealtimeBetIds = new Set();
  internal.scheduleBatchFlush = () => undefined;
  return { service, internal, states, wallets, batchResults };
}

function optionAmount(state: GameSnapshot, optionId: string, field: 'totalAmount' | 'myAmount') {
  return state.options.find((option) => option.id === optionId)?.[field] ?? -1;
}

async function waitFor(assertion: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('simultaneous queued bets reserve balance atomically within one client batch', async () => {
  const state = snapshot('greedy_pro');
  const { service, internal, states } = serviceFor('greedy_pro', state);
  const requests = [
    { requestId: 'parallel-1', roundId: state.round!.id, optionId: 'corn', amount: 5_000 },
    { requestId: 'parallel-2', roundId: state.round!.id, optionId: 'chicken', amount: 5_000 },
    { requestId: 'parallel-3', roundId: state.round!.id, optionId: 'corn', amount: 5_000 },
  ];

  const results = await Promise.all(requests.map(async (request) => service.queueBet(request)));

  assert.deepEqual(results.map((result) => result.accepted), [true, true, true]);
  assert.deepEqual(results.map((result) => result.balance), [15_000, 10_000, 5_000]);
  assert.equal(internal.pendingBatch?.total, 15_000);
  assert.equal(internal.pendingBatch?.items.get('corn'), 10_000);
  assert.equal(states.length, 0, 'Popular Greedy keeps optimistic drawing inside Phaser');
  assert.equal(internal.latestSnapshot.wallet, 20_000, 'authoritative snapshot must not be mutated by reservations');
});

test('rapid Greedy King taps commit as one Popular Greedy round batch', async () => {
  const state = snapshot('greedy_pro', { my_balance: 100_000 });
  const { service, internal, batchResults } = serviceFor('greedy_pro', state);
  const rpcCalls: Array<Record<string, unknown> | undefined> = [];
  setTestRpcHandler(async (_name, args) => {
    rpcCalls.push(args);
    return {
      data: {
        success: true,
        balance: 70_000,
        state_version: 2,
        authoritative_totals: { corn: 15_000, chicken: 15_000 },
        authoritative_my_totals: { corn: 15_000, chicken: 15_000 },
        bets: [],
      },
      error: null,
    };
  });
  for (let index = 0; index < 6; index += 1) {
    const result = service.queueBet({
      requestId: `round-batch-${index}`,
      roundId: state.round!.id,
      optionId: index % 2 === 0 ? 'corn' : 'chicken',
      amount: 5_000,
    });
    assert.equal(result.accepted, true);
  }

  assert.equal(rpcCalls.length, 0, 'the API must not run once per tap');
  await internal.flushPendingBets('test-betting-boundary');
  assert.equal(rpcCalls.length, 1);
  assert.equal(batchResults.length, 1);
  const submitted = rpcCalls[0]?.p_bets as Array<{ position: string; amount: number }>;
  assert.deepEqual(submitted, [
    { position: 'corn', amount: 15_000 },
    { position: 'chicken', amount: 15_000 },
  ]);
  assert.equal(batchResults[0]?.accepted, true);
});

test('Greedy King closes local betting while its Popular Greedy boundary batch is in flight', async () => {
  const state = snapshot('greedy_pro', { my_balance: 100_000 });
  const { service, internal, batchResults } = serviceFor('greedy_pro', state);
  let releaseFirst!: () => void;
  const firstResponseGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const rpcCalls: Array<Record<string, unknown> | undefined> = [];
  setTestRpcHandler(async (_name, args) => {
    rpcCalls.push(args);
    const callNumber = rpcCalls.length;
    if (callNumber === 1) await firstResponseGate;
    const committed = callNumber * 15_000;
    return {
      data: {
        success: true,
        balance: 100_000 - committed,
        state_version: callNumber + 1,
        authoritative_totals: { corn: committed },
        authoritative_my_totals: { corn: committed },
        bets: [],
      },
      error: null,
    };
  });

  for (let index = 0; index < 3; index += 1) {
    service.queueBet({ requestId: `first-${index}`, roundId: state.round!.id, optionId: 'corn', amount: 5_000 });
  }
  const firstFlush = internal.flushPendingBets('first-test-batch');
  await waitFor(() => rpcCalls.length === 1);

  const lateTap = service.queueBet({
    requestId: 'late-after-boundary', roundId: state.round!.id, optionId: 'corn', amount: 5_000,
  });
  assert.equal(lateTap.accepted, false);
  assert.equal(rpcCalls.length, 1, 'financial batches must not overlap');

  releaseFirst();
  await firstFlush;
  await waitFor(() => batchResults.length === 1);
  assert.equal(internal.inFlightBatches.size, 0);
  assert.equal(internal.pendingBatch, null);
  assert.equal(optionAmount(internal.latestSnapshot, 'corn', 'myAmount'), 15_000);
  assert.equal(internal.latestSnapshot.wallet, 85_000);
});

test('a rejected Greedy King round batch restores the complete Popular Greedy reservation', async () => {
  const state = snapshot('greedy_pro', { my_balance: 20_000 });
  const { service, internal, states, batchResults } = serviceFor('greedy_pro', state);
  let releaseFirst!: () => void;
  const firstResponseGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let rpcCall = 0;
  setTestRpcHandler(async () => {
    rpcCall += 1;
    if (rpcCall === 1) {
      await firstResponseGate;
      return { data: { success: false, message: 'Betting is closed.' }, error: null };
    }
    return { data: { success: false, message: 'Betting is closed.' }, error: null };
  });

  service.queueBet({ requestId: 'rejected-first', roundId: state.round!.id, optionId: 'corn', amount: 5_000 });
  const firstFlush = internal.flushPendingBets('rejection-test');
  await waitFor(() => rpcCall === 1);
  const blocked = service.queueBet({
    requestId: 'accepted-second', roundId: state.round!.id, optionId: 'chicken', amount: 5_000,
  });
  assert.equal(blocked.accepted, false);

  releaseFirst();
  await firstFlush;
  await waitFor(() => batchResults.length === 1);

  assert.deepEqual(batchResults.map((result) => result.accepted), [false]);
  assert.equal(states.at(-1)?.wallet, 20_000);
  assert.equal(optionAmount(internal.latestSnapshot, 'corn', 'myAmount'), 0);
  assert.equal(optionAmount(internal.latestSnapshot, 'chicken', 'myAmount'), 0);
});

test('simultaneous Teen Patti bets share the same reservation and balance guarantees', async () => {
  const state = snapshot('tin_patti_pro');
  const { service, internal, states } = serviceFor('tin_patti_pro', state);
  const results = await Promise.all([
    service.queueBet({ requestId: 'teen-parallel-1', roundId: state.round!.id, optionId: 'crown', amount: 5_000 }),
    service.queueBet({ requestId: 'teen-parallel-2', roundId: state.round!.id, optionId: 'coffee', amount: 5_000 }),
    service.queueBet({ requestId: 'teen-parallel-3', roundId: state.round!.id, optionId: 'cake', amount: 5_000 }),
  ]);

  assert.deepEqual(results.map((result) => result.balance), [15_000, 10_000, 5_000]);
  assert.equal(internal.pendingBatch?.total, 15_000);
  assert.equal(states.at(-1)?.wallet, 5_000);
});

test('duplicate request IDs are idempotent while a batch is pending', () => {
  const state = snapshot('greedy_pro');
  const { service, internal, states } = serviceFor('greedy_pro', state);
  const request = { requestId: 'retry-same-id', roundId: state.round!.id, optionId: 'corn', amount: 1_000 };

  const first = service.queueBet(request);
  const retry = service.queueBet(request);

  assert.equal(first.accepted, true);
  assert.deepEqual(retry, first);
  assert.equal(internal.pendingBatch?.requestIds.size, 1);
  assert.equal(internal.pendingBatch?.items.get('corn'), 1_000);
  assert.equal(internal.pendingBatch?.total, 1_000);
  assert.equal(states.length, 0, 'the native service must not duplicate Phaser optimistic drawing');
  assert.equal(internal.latestSnapshot.wallet, 20_000, 'authoritative wallet remains the reconciliation base');
});

test('optimistic Greedy King balance reconciles to authoritative commit without a zero reset', () => {
  const state = snapshot('greedy_pro');
  const { service, internal, states } = serviceFor('greedy_pro', state);
  const request = { requestId: 'optimistic-1', roundId: state.round!.id, optionId: 'corn', amount: 5_000 };

  const queued = service.queueBet(request);
  const batch = internal.pendingBatch!;
  assert.equal(queued.balance, 15_000);
  assert.equal(states.length, 0);
  assert.equal(internal.latestSnapshot.wallet, 20_000);

  internal.submissionLedger.settle([request.requestId], true, { balance: 15_000 });
  internal.applyCommittedBatch(batch, [{ betId: 'bet-1', position: 'corn', amount: 5_000 }], 15_000);
  const committed = states.at(-1)!;
  assert.equal(committed.wallet, 15_000);
  assert.equal(committed.myTotalBet, 5_000);
  assert.equal(optionAmount(committed, 'corn', 'myAmount'), 5_000);
  assert.equal(optionAmount(committed, 'corn', 'totalAmount'), 5_000);
});

test('different client activity feeds resolve to identical authoritative totals', () => {
  const authoritative = { corn: 11_000, chicken: 52_000, shrimp: 7_000 };
  const clientA = snapshot('greedy_pro', {
    bet_totals: authoritative,
    public_bets: [{ id: 'a', position: 'corn', amount: 1_000 }],
  });
  const clientB = snapshot('greedy_pro', {
    bet_totals: authoritative,
    public_bets: [{ id: 'b', position: 'chicken', amount: 100_000 }],
  });

  assert.deepEqual(
    clientA.options.map(({ id, totalAmount }) => [id, totalAmount]),
    clientB.options.map(({ id, totalAmount }) => [id, totalAmount]),
  );
  assert.equal(clientA.totalPot, clientB.totalPot);
  assert.equal(clientA.totalPot, 70_000);
});

test('reconnect hydrates the full authoritative state rather than a partial activity feed', () => {
  const beforeDisconnect = snapshot('tin_patti_pro', {
    bet_totals: { crown: 2_000, coffee: 5_000, cake: 0 },
    my_bets: [{ position: 'crown', amount: 1_000 }],
    my_balance: 19_000,
  });
  const afterReconnect = normalizeGameSnapshot('tin_patti_pro', payload('tin_patti_pro', {
    bet_totals: { crown: 8_000, coffee: 12_000, cake: 5_000 },
    public_bets: [],
    my_bets: [{ position: 'crown', amount: 1_000 }, { position: 'cake', amount: 5_000 }],
    my_balance: 14_000,
  }), beforeDisconnect.sequence + 1, Date.now());

  assert.equal(afterReconnect.totalPot, 25_000);
  assert.equal(afterReconnect.myTotalBet, 6_000);
  assert.equal(afterReconnect.wallet, 14_000);
  assert.equal(optionAmount(afterReconnect, 'cake', 'myAmount'), 5_000);
});

test('raw realtime bet events project chair totals immediately without counting twice', () => {
  const state = snapshot('greedy_pro', { bet_totals: { corn: 1_000 } });
  const { internal } = serviceFor('greedy_pro', state);

  internal.applyRealtimeBet({ id: 'event-1', round_id: state.round!.id, position: 'corn', amount: 5_000, user_id: 'u2' });
  internal.applyRealtimeBet({ id: 'event-1', round_id: state.round!.id, position: 'corn', amount: 5_000, user_id: 'u2' });
  internal.applyRealtimeBet({ id: 'old-round-event', round_id: 'old-round', position: 'corn', amount: 100_000, user_id: 'u3' });

  assert.equal(optionAmount(internal.latestSnapshot, 'corn', 'totalAmount'), 6_000);
  assert.equal(internal.latestSnapshot.totalPot, 6_000);
});

test('a realtime row arriving after its aggregate snapshot is not projected twice', () => {
  const state = snapshot('tin_patti_pro', {
    state_version: 4,
    // Freshness is judged against `server_now` — the moment the aggregate was
    // computed — not `state_updated_at`, which only moves on round-level phase
    // changes and stays frozen for the whole betting window. The aggregate below
    // was queried at 10:00:08 and so already counts the 10:00:07 bet.
    server_now: '2026-08-24T10:00:08.000Z',
    state_updated_at: '2026-08-24T10:00:08.000Z',
    bet_totals: { crown: 5_000, coffee: 0, cake: 0 },
  });
  const { internal } = serviceFor('tin_patti_pro', state);

  internal.applyRealtimeBet({
    id: 'aggregate-first-event', round_id: state.round!.id, position: 'crown', amount: 5_000,
    user_id: 'peer-2', created_at: '2026-08-24T10:00:07.000Z',
  });

  assert.equal(optionAmount(internal.latestSnapshot, 'crown', 'totalAmount'), 5_000);
  assert.equal(internal.latestSnapshot.totalPot, 5_000);
});

test('Teen Patti pending peer bets update chair totals before the database commit', () => {
  const state = snapshot('tin_patti_pro', { bet_totals: { crown: 0, coffee: 0, cake: 0 } });
  const { service, internal, states } = serviceFor('tin_patti_pro', state);
  service.setViewerIdentity({ userId: 'viewer-1', name: 'Viewer', avatarUrl: null });

  internal.applyPendingBroadcast({
    roundId: state.round!.id,
    userId: 'peer-1',
    name: 'Peer',
    items: [{ position: 'crown', amount: 5_000 }, { position: 'coffee', amount: 1_000 }],
    updatedAt: Date.now(),
  });

  assert.equal(optionAmount(states.at(-1)!, 'crown', 'totalAmount'), 5_000);
  assert.equal(optionAmount(states.at(-1)!, 'coffee', 'totalAmount'), 1_000);
  assert.equal(states.at(-1)?.totalPot, 6_000);
  assert.equal(optionAmount(internal.latestSnapshot, 'crown', 'totalAmount'), 0, 'projection must not mutate the canonical base');
});

test('Teen Patti robot bet events update chair totals immediately', () => {
  const state = snapshot('tin_patti_pro', { bet_totals: { crown: 0, coffee: 0, cake: 0 } });
  const { internal, states } = serviceFor('tin_patti_pro', state);

  internal.applyRealtimeBet({
    id: 'robot:teen-live-1',
    round_id: state.round!.id,
    position: 'coffee',
    amount: 5_000,
    user_id: 'robot:Live Bot',
    name: 'Live Bot',
    is_robot: true,
    created_at: new Date().toISOString(),
  });

  assert.equal(optionAmount(states.at(-1)!, 'coffee', 'totalAmount'), 5_000);
  assert.equal(states.at(-1)?.totalPot, 5_000);
});

test('Greedy King matches Popular Greedy by not broadcasting uncommitted financial totals', async () => {
  const state = snapshot('greedy_pro', { bet_totals: { corn: 0, chicken: 0 } });
  const { service, internal } = serviceFor('greedy_pro', state);
  const messages: Record<string, unknown>[] = [];
  internal.betChannel = {
    send: async (message) => {
      messages.push(message);
      return 'ok';
    },
  };
  service.setViewerIdentity({ userId: 'greedy-viewer', name: 'Greedy Viewer', avatarUrl: null });

  service.queueBet({
    requestId: 'greedy-live-total-1',
    roundId: state.round!.id,
    optionId: 'corn',
    amount: 5_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(messages.length, 0);
});

test('clients in the same game round share one realtime bet broadcast topic', () => {
  const firstClientTopic = realtimeBetChannelTopic('greedy_pro', 'greedy-round-42');
  const secondClientTopic = realtimeBetChannelTopic('greedy_pro', 'greedy-round-42');

  assert.equal(firstClientTopic, 'v2-greedy_pro-bets-greedy-round-42');
  assert.equal(secondClientTopic, firstClientTopic);
  assert.notEqual(realtimeBetChannelTopic('greedy_pro', 'greedy-round-43'), firstClientTopic);
  assert.notEqual(realtimeBetChannelTopic('tin_patti_pro', 'greedy-round-42'), firstClientTopic);
});

test('result recovery targets the configured next-round boundary instead of an eight-second poll', () => {
  const receivedAt = Date.parse('2026-08-24T10:00:06.000Z');
  const result = snapshot('tin_patti_pro', {
    server_now: '2026-08-24T10:00:06.000Z',
    settings: { result_display_s: 6 },
    round: {
      id: 'teen-result-boundary', status: 'settled', started_at: startedAt, ends_at: '2026-08-24T10:00:05.000Z',
      result: { winner_pos: 'crown', settled_at: '2026-08-24T10:00:06.000Z' },
    },
  });
  result.receivedAt = receivedAt;

  assert.equal(getNextRoundRecoveryDelay(result, receivedAt), 6_075);
  assert.equal(getNextRoundRecoveryDelay(result, receivedAt + 7_000), 150);
});

test('lower server state versions are rejected for the same round', () => {
  const current = snapshot('greedy_pro', { state_version: 12, bet_totals: { corn: 8_000 } });
  const stale = normalizeGameSnapshot(
    'greedy_pro',
    payload('greedy_pro', { state_version: 11, bet_totals: { corn: 2_000 } }),
    99,
    Date.now(),
  );
  const { internal } = serviceFor('greedy_pro', current);

  assert.equal(internal.acceptSnapshot(stale, 'delayed-version'), false);
  assert.equal(internal.latestSnapshot.stateVersion, 12);
  assert.equal(optionAmount(internal.latestSnapshot, 'corn', 'totalAmount'), 8_000);
});

test('out-of-order snapshots cannot regress a settled or newer round', () => {
  const machine = new GameStateMachine();
  const betting = snapshot('greedy_pro');
  const settled = { ...betting, phase: 'RESULT_RECEIVED' as const, round: { ...betting.round!, status: 'settled', winnerId: 'corn' } };
  assert.equal(machine.applySnapshot(betting).accepted, true);
  assert.equal(machine.applySnapshot(settled).accepted, true);
  assert.equal(machine.applySnapshot(betting).accepted, false);

  const newer = snapshot('greedy_pro', {
    round: { id: 'greedy_pro-round-2', status: 'betting', started_at: '2026-08-24T10:01:00.000Z', ends_at: endsAt },
  });
  assert.equal(machine.applySnapshot(newer).accepted, true);
  assert.equal(machine.applySnapshot(settled).accepted, false);
});

test('a delayed Teen Patti snapshot cannot reduce authoritative pot totals', () => {
  for (const gameId of ['tin_patti_pro'] as const) {
    const highTotals = { crown: 15_000, coffee: 5_000 };
    const lowTotals = { crown: 1_000, coffee: 0 };
    const high = snapshot(gameId, { bet_totals: highTotals });
    const low = normalizeGameSnapshot(gameId, payload(gameId, { bet_totals: lowTotals }), 2, Date.now());
    const firstPosition = 'crown';
    const { internal, states } = serviceFor(gameId, high);

    assert.equal(internal.acceptSnapshot(high, 'realtime-high'), true);
    assert.equal(internal.acceptSnapshot(low, 'delayed-low'), true);
    assert.equal(optionAmount(states.at(-1)!, firstPosition, 'totalAmount'), 15_000);
    assert.equal(states.at(-1)?.totalPot, 20_000);
  }
});

test('invalid chips and insufficient balances are rejected without changing balance', () => {
  const invalid = evaluateQueuedBet({
    wallet: 20_000, pendingTotal: 0, existingOptionIds: [], pendingOptionIds: [], optionId: 'corn', amount: 2_000,
  });
  const insufficient = evaluateQueuedBet({
    wallet: 5_000, pendingTotal: 1_000, existingOptionIds: [], pendingOptionIds: [], optionId: 'corn', amount: 5_000,
  });
  assert.equal(invalid.accepted, false);
  assert.equal(insufficient.accepted, false);

  const state = snapshot('tin_patti_pro', { my_balance: 1_000 });
  const { service, internal } = serviceFor('tin_patti_pro', state);
  const rejected = service.queueBet({ requestId: 'overdraw', roundId: state.round!.id, optionId: 'crown', amount: 5_000 });
  assert.equal(rejected.accepted, false);
  assert.equal(internal.latestSnapshot.wallet, 1_000);
  assert.equal(internal.pendingBatch, null);
});

test('an authoritative insufficient-balance error releases the optimistic reservation', async () => {
  const state = snapshot('tin_patti_pro');
  const { service, internal, states, batchResults } = serviceFor('tin_patti_pro', state);
  setTestRpcHandler(async () => ({
    data: { success: false, message: 'Insufficient balance.' },
    error: null,
  }));

  const queued = service.queueBet({
    requestId: 'server-reject-1', roundId: state.round!.id, optionId: 'crown', amount: 5_000,
  });
  assert.equal(queued.accepted, true);
  assert.equal(states.at(-1)?.wallet, 15_000);

  await internal.flushPendingBets('test-server-rejection');

  assert.equal(batchResults.at(-1)?.accepted, false);
  assert.match(batchResults.at(-1)?.message || '', /insufficient balance/i);
  assert.equal(states.at(-1)?.wallet, 20_000);
});

test('Greedy King and Teen Patti normalize isolated option sets and round state', () => {
  const greedy = snapshot('greedy_pro', { bet_totals: { corn: 5_000, crown: 999_000 } });
  const teen = snapshot('tin_patti_pro', { bet_totals: { crown: 7_000, corn: 999_000 } });

  assert.equal(greedy.round?.id, 'greedy_pro-round-1');
  assert.equal(teen.round?.id, 'tin_patti_pro-round-1');
  assert.deepEqual(greedy.options.map((option) => option.id), ['corn', 'chicken', 'shrimp', 'tomato', 'ham', 'pepper', 'fish', 'carrot']);
  assert.deepEqual(teen.options.map((option) => option.id), ['crown', 'coffee', 'cake']);
  assert.equal(greedy.options.some((option) => option.id === 'crown'), false);
  assert.equal(teen.options.some((option) => option.id === 'corn'), false);
  assert.equal(greedy.totalPot, 5_000);
  assert.equal(teen.totalPot, 7_000);
});

test('bot-enabled games inject authoritative robot winners', () => {
  const greedy = snapshot('greedy_pro', {
    round: {
      id: 'greedy-pro-result', status: 'settled', started_at: startedAt, ends_at: endsAt,
      result: { category: 'salad', top_winners: [] },
    },
    public_bets: [
      { id: 'robot-bet-1', user_id: 'robot:PAGLA', name: 'PAGLA', position: 'corn', amount: 5_000 },
    ],
  });
  const teen = snapshot('tin_patti_pro', {
    round: {
      id: 'teen-result', status: 'settled', started_at: startedAt, ends_at: endsAt,
      result: { winner_pos: 'crown', top_winners: [] },
    },
    public_bets: [
      { id: 'robot-bet-2', user_id: 'robot:Jack sparrow', name: 'Jack sparrow', position: 'crown', amount: 1_000 },
    ],
  });

  assert.deepEqual(greedy.round?.result?.top_winners, [{
    user_id: 'robot:PAGLA', name: 'PAGLA', avatar_url: null, is_robot: true, win_amount: 25_000,
  }]);
  assert.deepEqual(teen.round?.result?.top_winners, [{
    user_id: 'robot:Jack sparrow', name: 'Jack sparrow', avatar_url: null, is_robot: true, win_amount: 2_900,
  }]);
});

test('production wiring keeps Greedy King and Teen Patti on separate rooms and RPCs', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'src/game-platform/GameBackendService.ts'), 'utf8');
  assert.match(source, /greedy_pro:\s*'00000000-0000-0000-0000-000000000004'/);
  assert.match(source, /tin_patti_pro:\s*'00000000-0000-0000-0000-000000000002'/);
  assert.match(source, /greedy_pro:\s*\{[\s\S]*?stateRpc:\s*'get_greedy_pro_state'[\s\S]*?batchRpc:\s*'place_greedy_pro_bet_batch'/);
  assert.match(source, /tin_patti_pro:\s*\{[\s\S]*?stateRpc:\s*'get_tin_patti_pro_state'[\s\S]*?batchRpc:\s*'place_tin_patti_pro_bet_batch'/);
});

test('database batch contracts declare idempotency and game isolation guards', async () => {
  const teenSql = await fs.readFile(path.join(process.cwd(), 'database/153_tin_patti_pro_atomic_bet_batches.sql'), 'utf8');
  const greedySql = await fs.readFile(path.join(process.cwd(), 'supabase/migrations/20260824190000_greedy_king_isolation_realtime_bots.sql'), 'utf8');
  const teenBotsSql = await fs.readFile(path.join(process.cwd(), 'supabase/migrations/20260825010000_teen_patti_authoritative_bots.sql'), 'utf8');
  assert.match(teenSql, /ON CONFLICT \(game_type, round_id, user_id, client_batch_id\) DO NOTHING/i);
  assert.match(teenSql, /v_round\.game_type <> 'tin_patti_pro'/i);
  assert.match(greedySql, /replace\(cloned_definition, 'greedy_lion', 'greedy_pro'\)/i);
  assert.match(greedySql, /replace\(cloned_definition, 'pg_advisory_xact_lock\(1729, 1\)', 'pg_advisory_xact_lock\(1729, 4\)'\)/i);
  assert.match(teenBotsSql, /tin_patti_pro_sync_robot_bets/i);
  assert.match(teenBotsSql, /get_tin_patti_pro_state_core_169\(\)::jsonb, TRUE/i);
});

test('Greedy bot activation keeps King rows isolated from Popular Greedy', async () => {
  const sql = await fs.readFile(path.join(
    process.cwd(),
    'supabase/migrations/20260910110000_activate_greedy_game_bot_bets.sql',
  ), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.greedy_pro_robot_bets/i);
  assert.match(sql, /REFERENCES public\.greedy_pro_rounds\(id\)/i);
  assert.match(sql, /FROM public\.game_rounds[\s\S]*game_type = 'greedy_lion'/i);
  assert.match(sql, /FROM public\.greedy_pro_rounds[\s\S]*game_type = 'greedy_pro'/i);
  assert.doesNotMatch(sql, /UPDATE public\.profiles/i);
  assert.doesNotMatch(sql, /INSERT INTO public\.(game_round_bets|greedy_pro_bets)/i);
});

test('Greedy King active engine clones Popular Greedy into dedicated tables', async () => {
  const sql = await fs.readFile(path.join(
    process.cwd(),
    'supabase/migrations/20260826144500_greedy_king_dedicated_tables.sql',
  ), 'utf8');
  assert.match(sql, /procedure\.proname LIKE '%greedy\\_lion%'/i);
  assert.match(sql, /replace\(cloned_definition, 'greedy_lion', 'greedy_pro'\)/i);
  assert.doesNotMatch(sql, /execute_realtime_game_bet_batch/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.greedy_pro_rounds/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.greedy_pro_bets/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.greedy_pro_bet_batches/i);
  assert.match(sql, /replace\(cloned_definition, 'public\.game_round_bets', 'public\.greedy_pro_bets'\)/i);
  assert.match(sql, /replace\(cloned_definition, 'public\.game_rounds', 'public\.greedy_pro_rounds'\)/i);
});

test('Greedy King starts its result window after payout settlement completes', async () => {
  const sql = await fs.readFile(path.join(
    process.cwd(),
    'supabase/migrations/20260825047000_greedy_king_result_window_after_settlement.sql',
  ), 'utf8');
  const resolverCall = sql.indexOf('resolve_greedy_pro_round_without_grace_115(p_round_id)');
  const completedTimestamp = sql.indexOf('completed_at := clock_timestamp()');
  assert.ok(resolverCall >= 0);
  assert.ok(completedTimestamp > resolverCall);
  assert.match(sql, /'\{settled_at\}'[\s\S]*to_jsonb\(completed_at\)/i);
});

test('Greedy King accepts a revealed winner before payout settlement completes', () => {
  const revealed = snapshot('greedy_pro', {
    round: {
      id: 'greedy-fast-reveal',
      status: 'resolving',
      started_at: startedAt,
      ends_at: endsAt,
      winner_pos: 'salad',
      result: {
        winner_pos: 'salad',
        category: 'salad',
        payout_status: 'pending',
        result_ready_at: '2026-08-24T10:00:05.000Z',
      },
    },
  });

  assert.equal(revealed.phase, 'RESULT_RECEIVED');
  assert.equal(revealed.round?.status, 'resolving');
  assert.equal(revealed.round?.winnerId, 'salad');
});

test('Greedy King fast reveal migration keeps state reads separate from settlement', async () => {
  const sql = await fs.readFile(path.join(
    process.cwd(),
    'database/177_greedy_king_fast_reveal_async_settlement.sql',
  ), 'utf8');
  const stateFunction = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.get_greedy_pro_state()'));

  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.reveal_greedy_pro_round/i);
  assert.match(sql, /SET status = 'resolving'[\s\S]*'result_ready_at'/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.settle_revealed_greedy_pro_round/i);
  assert.match(sql, /GROUP BY user_id/i);
  assert.match(
    sql,
    /status = 'betting'[\s\S]*ends_at \+ \(v_grace \|\| ' seconds'\)::INTERVAL <= clock_timestamp\(\)/i,
    'the result clock must leave the configured grace window open for the boundary bet batch',
  );
  assert.doesNotMatch(stateFunction, /PERFORM public\.greedy_pro_tick\(\)/i);

  const settleBeforeReveal = sql.indexOf("status = 'resolving'");
  const revealBettingRounds = sql.indexOf("status = 'betting'", settleBeforeReveal);
  assert.ok(settleBeforeReveal >= 0);
  assert.ok(revealBettingRounds > settleBeforeReveal);
});
