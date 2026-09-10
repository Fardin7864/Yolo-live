# Crash game implementation contract

This document is the cross-layer contract for the first production Crash implementation.
It intentionally keeps financial authority outside the Phaser WebView.

## Identity and units

- Game ID: `crash`
- Default table ID: `global`
- Socket.IO namespace: `/crash`
- Socket.IO transport: WebSocket only
- Money: integer diamonds (`BIGINT` in PostgreSQL)
- Multiplier: integer basis points (`100 = 1.00x`, `250 = 2.50x`)
- Client environment variable: `EXPO_PUBLIC_CRASH_SOCKET_URL`

## Authoritative phases

`SCHEDULED -> BETTING_OPEN -> BETTING_LOCKED -> RUNNING -> CRASHED -> SETTLING -> SETTLED`

Pre-flight failures use `VOIDING -> VOIDED`. Every transition increments a monotonic
`stateVersion`. PostgreSQL/server timestamps adjudicate bet and cashout validity; a
rendered client multiplier is never an input to a financial command.

## Socket envelope

```json
{
  "protocolVersion": 2,
  "eventId": "uuid",
  "gameId": "crash",
  "tableId": "global",
  "roundId": "uuid-or-null",
  "sequence": 1,
  "serverTime": "ISO-8601",
  "payload": {}
}
```

Client commands:

- `state:sync` — `{ knownRoundId?, knownSequence? }`
- `bet:place` — `{ requestId, roundId, amount, autoCashoutBp? }`
- `bet:cashout` — `{ requestId, roundId, betId }`
- `ping` — `{ clientTime }`

Server events:

- `session:ready`
- `crash:snapshot`
- `round:scheduled`
- `round:betting_open`
- `round:betting_locked`
- `round:flight_started`
- `round:tick`
- `round:crashed`
- `round:settled`
- `bet:accepted`
- `bet:rejected`
- `bet:public_activity`
- `cashout:confirmed`
- `cashout:rejected`
- `wallet:updated`
- `engine:maintenance`
- `server:error`

Every command acknowledgement is stable and idempotent:

```json
{
  "requestId": "uuid",
  "accepted": true,
  "code": "OK",
  "roundRevision": 1,
  "wallet": 0,
  "result": {}
}
```

## Snapshot minimum

```ts
interface CrashSnapshot {
  sequence: number;
  stateVersion: number;
  serverTime: string;
  connected: boolean;
  round: null | {
    id: string;
    roundNumber: number;
    phase: 'SCHEDULED' | 'BETTING_OPEN' | 'BETTING_LOCKED' | 'RUNNING' |
      'CRASHED' | 'SETTLING' | 'SETTLED' | 'VOIDING' | 'VOIDED';
    bettingClosesAt?: string;
    flightStartedAt?: string;
    growthRate?: number;
    crashMultiplierBp?: number; // absent until CRASHED
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
  publicActivity: Array<{
    id: string;
    name: string;
    avatarUrl?: string;
    amount: number;
    cashoutMultiplierBp?: number;
    simulated: boolean;
  }>;
  history: Array<{
    roundId: string;
    crashMultiplierBp: number;
    seedCommitment: string;
    revealedSeed?: string;
  }>;
}
```

## Non-negotiable invariants

1. The WebView never receives JWTs, Supabase keys, service-role credentials, or seed secrets.
2. Bet/cashout commands derive the player from verified auth, never a payload user ID.
3. Duplicate request IDs return the original response; a changed payload hash is rejected.
4. Wallet mutation, bet mutation, transaction ledger, and outbox write occur atomically.
5. Manual cashout multiplier is calculated from authoritative time inside the backend transaction.
6. Auto cashout is executed server-side and survives client disconnection.
7. No admin API can force or edit a committed crash point.
8. Simulated players are stored separately, visibly marked, and excluded from real totals,
   liability, rankings, wallet settlement, and fairness evidence.
9. Sequence gaps recover through `state:sync` over the socket; the Crash client does not poll HTTP.
10. Emergency stop blocks new bets and deterministically settles or refunds the active round.
