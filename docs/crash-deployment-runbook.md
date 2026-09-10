# Crash game deployment and rollback runbook

This runbook deploys the authoritative Crash game introduced by
`20260825030000_crash_game_backend.sql`. The migration is intentionally safe by
default: the game, bots, and round engine remain disabled until the final canary
step.

## 1. Release gates

Do not enable Crash until all of these are true:

- Mobile game tests, Expo TypeScript, server typecheck/tests/build, and admin
  build pass from a clean CI checkout.
- The production database has a dedicated, non-player house profile with enough
  diamonds for `max_round_liability` and the configured maximum bet exposure.
- Redis is highly available, uses TLS and authentication, and is reachable from
  every Crash server replica.
- The Socket.IO endpoint is behind TLS and supports WebSocket upgrade traffic
  without HTTP polling.
- Dashboards and alerts exist for engine leadership, outbox age, command latency,
  rejection/error rate, connections, process restarts, database errors, and Redis
  errors.

## 2. Database preparation

Back up the database and apply the canonical Supabase migration through the
normal migration pipeline. `database/170_crash_game_backend.sql` is a psql
wrapper for manual environments; do not apply both copies.

The seed-encryption key must be at least 32 high-entropy characters and must be
available as the database setting `app.settings.crash_seed_key`. Set it through
the platform's protected database configuration mechanism. Never place the
value in source control, mobile configuration, logs, admin forms, or Socket.IO
payloads. Confirm a privileged database session can read the setting and that
`anon`/`authenticated` cannot execute `crash_seed_key()`.

After migration, verify:

```sql
select game_id, table_id, is_active, maintenance, bot_enabled
from public.crash_game_configs;

select has_function_privilege('anon',
  'public.place_crash_bet(uuid,text,bigint,bigint)', 'EXECUTE');
select has_function_privilege('authenticated',
  'public.place_crash_bet(uuid,text,bigint,bigint)', 'EXECUTE');
select has_function_privilege('authenticated',
  'public.crash_seed_key()', 'EXECUTE');
```

Expected values are `false`, `true`, `false` for the three config flags, then
`false`, `true`, `false` for the privilege checks.

Using the super-admin Games page, select the dedicated house profile and set
conservative initial limits. Keep bots disabled. Saving Crash settings must update
the authoritative `crash_game_configs` row and mirror only discovery activation
to `game_settings.crash` atomically.

## 3. Crash server deployment

Build the immutable image from `crash-server/Dockerfile`. Supply these values
from the deployment secret manager:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `REDIS_URL`
- `REQUIRE_REDIS=true`
- `CRASH_GAME_ID=crash`
- `CRASH_TABLE_ID=global`
- `ENGINE_ENABLED=true`

Run at least two replicas across failure domains. Use `/healthz` for process
liveness and `/readyz` for traffic readiness. Termination must remove the pod
from service, stop accepting commands, stop the engine loop, drain/leave the
durable outbox publisher, and then close Redis.

The load balancer must route `/crash` Socket.IO WebSockets and allow the server's
heartbeat interval. Redis adapter fan-out removes a sticky-session requirement
for established WebSockets, but enabling stickiness is acceptable.

## 4. Mobile and admin release

Build the mobile app with:

```text
EXPO_PUBLIC_CRASH_SOCKET_URL=https://games.example.com
```

The URL is the Socket.IO origin, not a polling endpoint and not a URL containing
credentials. Release the admin build containing Games settings and Crash
Operations before activating the game. Confirm only super admins can read or
invoke Crash admin RPCs.

## 5. Canary activation

1. Keep `maintenance=true`, start the server replicas, and verify one and only
   one engine leader.
2. Verify Redis fan-out, database readiness, an empty/stable outbox, and the
   Operations dashboard's live updates.
3. Use a staging table/environment to verify commitment/reveal, duplicate bet and
   cashout idempotency, wallet/ledger balance, auto cashout while disconnected,
   reconnect snapshot recovery, and server restart during every round phase.
4. Set conservative limits and activate with the typed `RESUME CRASH` operation.
5. Observe at least 100 low-limit real rounds before increasing exposure or
   enabling simulated activity.
6. Enable bots separately. Bot rows must remain marked `simulated=true`, excluded
   from wallets, liability, revenue and player rankings, and displayed as `[SIM]`
   in the client/admin surfaces.

## 6. Incident response

For elevated errors, inconsistent state, excessive command latency, outbox lag,
or suspected wallet mismatch:

1. Use `PAUSE CRASH`. This blocks new rounds/bets and refunds a pre-flight round.
2. Do not refund a round that has already made cashout payments; investigate and
   reconcile from `crash_bets`, `transactions`, round events, and admin audit rows.
3. Preserve logs, Redis state, round/event rows, commitments, revealed seeds, and
   the deployment version.
4. Repair forward. Do not edit crash points, seed commitments, settled bets, or
   wallet history manually.

If a running round loses the engine leader, fencing prevents a stale replica from
advancing it. A new leader resumes from database state. If deterministic recovery
is impossible, use the audited refund control only where no payouts have occurred.

## 7. Rollback

Application rollback is feature-gated:

1. Pause Crash and wait for/refund the eligible active round.
2. Confirm `maintenance=true` and `game_settings.crash.is_active=false`.
3. Stop Crash server traffic and roll back mobile/admin/server artifacts.
4. Leave the database tables, events, ledgers, commitments and audit records in
   place. Do not run a destructive down migration in production.

Database removal, if ever required after the retention period, is a separately
approved data-destruction change with a verified backup and explicit table list.

