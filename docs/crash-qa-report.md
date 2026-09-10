# Crash implementation QA report

## Automated checks completed

- Mobile game suite: 33/33 passing.
- Crash server unit/contract suite: 6/6 passing.
- Expo application TypeScript: passing.
- Crash server strict TypeScript and production build: passing.
- Admin strict TypeScript, targeted ESLint, and Next.js production build: passing.
- Android Expo export: passing.
- Generated Phaser bundle: passing (2.16 MB, assets embedded).
- PostgreSQL migration parse: 115 statements parsed successfully with PostgreSQL's
  grammar via `pglast`.
- Changed-file whitespace validation: `git diff --check` passing.

## Responsive visual checks completed

The built Crash canvas was rendered with realistic history and player activity at:

- 320×568 — compact phone portrait.
- 640×360 — short phone landscape.
- 768×1024 — tablet portrait.
- 1200×800 — desktop/wide tablet.

At each viewport the canvas remained within the viewport with no document overflow.
The graph, multiplier, status, fairness link, player feed, amount controls,
auto-cashout controls, chips, potential payout and primary action remained visible.

## Security and consistency checks

- WebView has no network permission and receives no JWT, Supabase key, service-role
  key, encrypted seed, or raw wallet mutation API.
- Authenticated identity comes from the verified Socket.IO token, never a command
  payload user id.
- Bet and cashout request ids are idempotent and payload-bound.
- Round, wallet, ledger and durable event mutations occur in database functions.
- Crash points are committed before flight; the seed is revealed only after crash.
- Admin APIs cannot select or force a crash point.
- Simulated activity is separate from financial bets, marked `[SIM]`, and excluded
  from wallet, liability and real-player totals.
- Admin Realtime subscribes only to a row-secured revision signal; financial rows,
  player data and seed material are not published to the dashboard client.
- Admin activation atomically synchronizes authoritative runtime state with the
  mobile discovery tile. Enabling requires a configured encryption key and funded
  house profile; disabling hides the game and blocks new rounds.

## Environment checks required during deployment

The local Docker daemon was unavailable, so the migration was parsed but was not
executed against a local or production database. The deployment owner must complete
the database privilege/RPC smoke checks, Redis multi-replica test, authenticated
Socket.IO load test, wallet reconciliation and canary rounds in the target staging
environment using `crash-deployment-runbook.md`.

