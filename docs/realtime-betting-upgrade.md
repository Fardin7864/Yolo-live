# Greedy King and Teen Patti real-time betting upgrade

## Outcome

Greedy King (`greedy_pro`, room `...0004`) and Teen Patti (`tin_patti_pro`, room `...0002`) use PostgreSQL as the single financial source of truth, authenticated atomic RPCs for commands, and Supabase Realtime WebSockets for committed-state notification. The Phaser UI, game rules, layouts, multipliers, cards, wheel, history, and result presentation are unchanged.

Socket.IO was evaluated but is not introduced in this phase. Supabase Realtime already provides the required WebSocket transport and authentication integration. A second gateway would duplicate auth, room membership, deployment, Redis, monitoring, and failover while leaving the original state-ordering defects unresolved. WebRTC is inappropriate for authoritative financial state.

## Root-cause report

The defects were caused by several independent races:

1. The native service stored an optimistically reduced wallet, then subtracted the whole pending batch again on later taps. The Phaser scene could also subtract active requests from an already projected wallet.
2. Teen Patti held bets only in memory until the betting boundary. A refresh, reconnect, or process death could replace or lose that optimistic state.
3. Greedy King's cloned state RPC merged robot totals but omitted global real-player totals. Each phone therefore depended on the subset of bet events it happened to observe.
4. Per-bet Realtime used `event: '*'` and treated payloads as positive inserts. A settlement update could be counted as a new bet by a late-joining client.
5. Same-round snapshots and events had no comparable server revision. An old RPC response could overwrite a newer event, while monotonic client floors could preserve an accidental overcount.
6. Both upgraded UIs expose a 500 chip, but Teen Patti's database decomposition and denomination trigger rejected it.
7. Pending request IDs existed only in memory, leaving an ambiguous RPC outcome unresolved after process death.

## Implemented architecture

```text
Phaser scenes (unchanged visuals/rules)
  -> typed WebView bridge
  -> GameBackendService
       -> authenticated atomic bet RPC (40 ms micro-batch)
       -> Supabase Realtime WebSocket subscriptions
       -> versioned reconnect snapshot
  -> PostgreSQL transaction
       -> lock player/round
       -> validate round, option, denomination, balance and limits
       -> deduct wallet
       -> insert bet rows and transaction
       -> update canonical position totals
       -> increment state_version
       -> store idempotent response
       -> commit
```

Shared Realtime channels are transport, not financial authority. Raw bet rows drive chip/feed animation only. Pot totals come from the canonical versioned snapshot. A subscription transition to `SUBSCRIBED`, a version advance/gap, a position-total update, foregrounding, or network recovery requests a complete snapshot.

## Bet protocol

1. User taps an existing chip and item/board.
2. Client validates the current round, allowed chip, option limit, and projected spendable wallet.
3. The tap is assigned a stable request ID and added to a maximum 40 ms micro-batch.
4. The batch is persisted locally before submission.
5. Server derives the user from `auth.uid()`; client user IDs and balances are never trusted.
6. Server serializes requests per user, validates all rules, locks rows, and commits all financial writes atomically.
7. `(game_type, round_id, user_id, client_batch_id)` is unique. Replays return the stored response. Reusing a key with different payload produces `IDEMPOTENCY_CONFLICT`.
8. RPC response returns wallet, inserted bets, `state_version`, canonical public totals, and canonical personal totals.
9. UI reconciles optimistic chips against canonical personal totals and never clears them merely because a stale snapshot arrived.
10. If the response is lost, the same batch key retries. After process restart, the persisted outbox replays the same key; it cannot deduct twice.

## Database changes

Migration `20260824230000_realtime_betting_consistency.sql` adds:

- `game_rounds.state_version` and `state_updated_at`;
- canonical `game_round_position_totals` with transactional synchronization;
- payload hashes and processing status on `game_bet_batches`;
- per-user advisory serialization and stable retry responses;
- a versioned reconnect snapshot RPC;
- indexes for round/user totals, in-flight requests, reconnect history, and active-room lookup;
- Realtime publication for canonical position totals;
- state-version increments for human and Greedy King robot bets;
- a future-active-round guard;
- Teen Patti 500-chip parity while retaining Popular Greedy's legacy denominations.

The migration performs prerequisite and duplicate-active-round preflights. Its final aggregate reconciliation takes a short write lock so live bets cannot fall into the backfill/trigger installation gap.

## Frontend integration

- Existing bridge message shapes remain compatible.
- `GameSnapshot.stateVersion` carries the database revision.
- Lower same-round revisions are rejected.
- Raw bet events never increment canonical totals.
- Realtime reconnect/subscription always triggers snapshot hydration.
- Optimistic wallet reservations remain separate from authoritative wallet state.
- Failed authoritative requests release reservations; ambiguous requests stay pending and retry.
- Greedy King and Teen Patti commit immediately; Popular Greedy and other legacy games retain their prior batching behavior.

## Multi-agent workflow and review

1. System analysis traced Phaser, bridge, service, RPC, tables, triggers, and Realtime; it produced the RCA and invariants.
2. Architecture review selected Supabase Realtime WebSockets and defined authority, event ordering, reconnect, room isolation, and scaling gates.
3. Betting-logic implementation added reservations, idempotency, micro-batching, retry, canonical reconciliation, and zero-reset protection.
4. Frontend implementation preserved UI while fixing pending, failure, reconnect, and optimistic reconciliation behavior.
5. Database implementation added transactions, versions, aggregates, indexes, idempotency conflict detection, and Realtime publication.
6. QA added concurrency-model, duplicate, reconnect, stale-state, wallet, totals, and game-isolation tests.
7. Analysis, architecture, and QA agents cross-reviewed the combined changes. Their findings drove the final fixes for server-version consumption, INSERT-only bet events, canonical-total subscriptions, Teen Patti 500 parity, overlapping batches, wallet double reservation, robot versions, rejected statuses, and deployment backfill safety.

## Test strategy and release gates

Automated coverage includes:

- simultaneous bets in both games;
- overlapping 40 ms batches;
- duplicate request IDs and conflicting payloads;
- optimistic-to-authoritative reconciliation without zero reset;
- canonical totals independent of truncated activity feeds;
- duplicate/out-of-order raw events;
- stale server revisions;
- reconnect hydration;
- invalid chips, insufficient balances, and rollback;
- room/RPC isolation between Greedy King and Teen Patti;
- result/state-machine deduplication.

Production release gates:

- migration transaction rehearsal and explicit migration-history update;
- real 500-chip Teen Patti transaction rollback test;
- two devices/accounts must show the same round, version, option totals, and result;
- disconnect immediately before and after commit, then verify one deduction and outbox recovery;
- 100+ concurrent-user staging load test with RPC p95, commit-to-client p95, lock duration, duplicate rate, and aggregate-drift checks;
- Android background/foreground and WebView process-recreation test;
- settlement and payout verification with controlled test wallets.

## Deployment and rollback

1. Back up schema and capture current active rounds/settings.
2. Verify prerequisites and no duplicate active rounds.
3. Transaction-rehearse only migration `20260824230000` against the target schema.
4. Apply that migration explicitly; do not use `--include-all` because an unrelated agency migration is pending locally.
5. Record only `20260824230000` in migration history.
6. Verify functions, publication, indexes, canonical totals, versions, game isolation, and rollback-only wallet tests.
7. Release the client first to testers/canary users, then widen after metrics and multi-device acceptance.
8. Roll back the client independently if needed. The database changes are additive; keep them in place unless a separately reviewed down migration is required.

## Scalability recommendations

- Keep PostgreSQL authoritative for wallets, bets, results, payouts, and idempotency.
- Do not add Redis initially. Measure first.
- Monitor bet RPC p50/p95/p99, database lock waits, commit-to-WebSocket latency, reconnect frequency, version gaps, aggregate drift, and outbox age.
- Partition/archive old bet batches and event diagnostics as volume grows.
- Consider a durable database outbox and one room event stream when event volume justifies it.
- Introduce a horizontally scaled Socket.IO gateway with Redis adapter only if measured Supabase connection/fanout limits are exceeded. Redis Pub/Sub must never become the financial source of truth; use Redis Streams or a database outbox for durable delivery.
- Keep deterministic rooms (`game:v2:{gameType}:{roomId}`) and private per-user wallet responses if a dedicated gateway is introduced later.
