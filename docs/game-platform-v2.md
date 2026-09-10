# Mini-game platform

## Architecture

The Phaser/WebView platform is the production implementation for Greedy Lion, Teen Patti Pro, and Lucky Dice Royale. The legacy React Native renderers and Game Lab comparison routes were removed after manual approval.

```text
React Native route
  -> GameScreen (shared production screen)
  -> GameWebView (one active instance)
  -> NativeGameBridge (typed JSON only)
  -> self-contained trusted HTML bundle
  -> GameSDK + GameStateMachine
  -> registered Phaser scene

GameWebView
  -> GameBackendService
  -> authenticated Supabase RPC + Realtime
  -> existing authoritative game backend
```

Layer ownership:

- React Native owns authenticated Supabase access, network state, Realtime subscriptions, fallback polling, bet RPC calls, wallet synchronization, app/screen lifecycle, WebView recovery, and navigation.
- `NativeGameBridge` owns message validation, protocol versioning, queueing before `GAME_READY`, and delivery to the WebView.
- Phaser owns rendering, hit testing, local presentation state, tweens, card/wheel animation, localized audio effects, and performance sampling.
- `GameStateMachine` is the only Phaser component that advances a round phase. Realtime, polling, timers, and animation callbacks only submit events to it.
- Supabase remains authoritative for round creation/timing, bet validation, wallet deduction, winner, cards, payout, settlement, limits, and history.

No auth token, Supabase key, service-role credential, native API, filesystem access, or direct database client is exposed to the HTML game. The generated HTML has a restrictive Content Security Policy and cannot make network requests.

## Production routing

Both normal launch surfaces use the same platform:

- `/main/game/greedy_lion`
- `/main/game/greedy_pro`
- `/main/game/tin_patti_pro`
- `/main/game/lucky_dice`
- the mini-game sheet inside a live broadcast

Only one `GameWebView` mounts at a time. The former `/game-lab`, `/greedy-lion-v2`, and `/teen-patti-v2` routes no longer exist.

## Build commands

```bash
npm run games:assets
npm run games:build
npm run games:typecheck
npm run games:test
```

`games:assets` produces right-sized WebP files from source art. `games:build` bundles Phaser, TypeScript, and those assets into one self-contained generated HTML string. Run it after changing any file under `games/`.

## Bridge envelope

Every message uses this envelope:

```json
{
  "protocolVersion": 1,
  "messageId": "unique-request-id",
  "timestamp": 1786250000000,
  "type": "PLACE_BET",
  "gameId": "greedy_lion",
  "payload": {}
}
```

Unknown protocol versions, unknown message types, invalid JSON, and messages for another game ID are ignored. Both sides retain a bounded set of seen IDs to avoid duplicate bridge delivery.

### React Native to Phaser

| Message | Payload | Purpose |
| --- | --- | --- |
| `INIT` | `targetFps`, `locale`, `currencySymbol`, `debug` | Creates the registered game with platform settings. |
| `AUTH` | `userId`, `displayName`, `avatarUrl` | Supplies sanitized display identity. No token is included. |
| `ROUND_STATE` | `snapshot`, `reason` | Supplies authoritative normalized round, pots, bets, result, history, and wallet. |
| `WALLET_UPDATE` | `balance`, `authoritative` | Updates the displayed wallet. |
| `APP_ACTIVE` | `{}` | Reports foreground state. |
| `APP_BACKGROUND` | `{}` | Pauses rendering/audio and marks state stale. |
| `SCREEN_FOCUS` | `{}` | Starts resynchronization before render resumes. |
| `SCREEN_BLUR` | `{}` | Pauses rendering/audio. |
| `SOUND_SETTINGS` | `enabled`, `volume` | Applies user audio settings. |
| `EXIT_GAME` | `reason` | Destroys the Phaser instance and listeners. |
| `NETWORK_STATE` | `connected`, `synchronizing` | Shows reconnect/synchronization state. |
| `PLACE_BET_RESULT` | `requestId`, `accepted`, optional `queued`, `balance`, `betId`, `message` | Resolves a tap immediately. For Greedy Lion, `queued: true` means locally staged, not yet accepted by the backend. |
| `BET_BATCH_RESULT` | `roundId`, `requestIds`, `accepted`, optional `balance`, `bets`, `message` | Reconciles every staged game tap after the atomic backend batch succeeds or fails. |
| `ERROR` | `code`, `message`, `recoverable` | Reports a native/backend error without crashing the app. |

Round-state example:

```json
{
  "type": "ROUND_STATE",
  "gameId": "greedy_lion",
  "payload": {
    "reason": "realtime",
    "snapshot": {
      "sequence": 21,
      "phase": "BETTING",
      "round": { "id": "12345", "status": "betting", "endsAt": "2026-08-09T08:00:30Z" },
      "totalPot": 28500,
      "myTotalBet": 1000,
      "myPayout": 0,
      "wallet": 99000,
      "options": [{ "id": "lion", "label": "Lion", "totalAmount": 8500, "myAmount": 500 }]
    }
  }
}
```

### Phaser to React Native

| Message | Payload | Purpose |
| --- | --- | --- |
| `GAME_READY` | `initializedAt` | Opens the native bridge queue and requests bootstrap. |
| `PLACE_BET` | `requestId`, `roundId`, `optionId`, `amount` | Requests a validated backend bet. |
| `REQUEST_STATE_REFRESH` | `reason` | Requests an authoritative refresh after timeout/recovery. |
| `RESULT_ANIMATION_COMPLETE` | `roundId` | Confirms presentation completed for that exact round. |
| `OPEN_HISTORY` | `{}` | Notifies native navigation/analytics while history remains visible in-game. |
| `OPEN_RULES` | `{}` | Notifies native; each game also opens its local rules overlay. |
| `EXIT_GAME` | `reason` | Requests native navigation away. |
| `ERROR` | `code`, `message`, `fatal`, optional `stack` | Triggers recoverable handling or the native reload/exit UI. |
| `PERFORMANCE_METRICS` | `fps`, `frameTimeMs`, optional `heapBytes`, `initializedInMs` | Reports basic bounded diagnostics every 15 seconds in dev and 60 seconds in production. |
| `BRIDGE_ERROR` | `message`, optional `offendingType` | Reports malformed native traffic. |

Bet example:

```json
{
  "type": "PLACE_BET",
  "gameId": "greedy_lion",
  "payload": {
    "requestId": "12345-lion-1786250000000-abcd",
    "roundId": "12345",
    "optionId": "lion",
    "amount": 1000
  }
}
```

## Round state machine

Normal flow:

```text
WAITING -> BETTING -> BETTING_CLOSED -> RESULT_PENDING
        -> RESULT_RECEIVED -> ANIMATING_RESULT -> SHOWING_RESULT
        -> ROUND_COMPLETE -> BETTING
```

Recovery may enter `BETTING`, `RESULT_PENDING`, or `RESULT_RECEIVED` directly from a newly observed round because an app can resume in the middle of a server phase. Illegal animation callbacks are ignored when their round ID is not current.

The controller tracks:

- `currentRoundId`: only this round may update presentation.
- `lastProcessedRoundId`: a result from Realtime, polling, or foreground recovery is processed once.
- `lastAnimatedRoundId`: a processed result animates once.
- newest `startedAt`: data for an older round is rejected after a newer round has become current.

When a new round arrives, each scene kills remaining result tweens and Phaser time events before resetting. This prevents an old animation callback from changing the new board.

## Backend and recovery

`GameBackendService` calls these RPCs:

- `get_greedy_lion_state`
- `place_greedy_lion_bet_batch`
- `get_tin_patti_pro_state`
- `place_tin_patti_pro_bet_batch`
- `get_lucky_dice_state`
- `place_lucky_dice_bet_batch`

Greedy King and Teen Patti additionally use `get_realtime_betting_snapshot`
for versioned reconnect recovery. Their public state RPC names remain available
behind the compatibility wrapper installed by migration `20260824230000`.

It subscribes to `game_rounds` by the existing global room ID and `game_round_bets` by the current round ID. Realtime events are debounced and trigger a complete authoritative RPC refresh rather than directly mutating game phase.

Fallback behavior:

- Active betting polls every 30 seconds; result-pending phases poll every 3 seconds.
- A dedicated recovery refresh runs immediately after the authoritative settlement boundary.
- Failed refreshes retry after 3 seconds.
- Network reconnection, screen focus, app foreground, WebGL context restoration, countdown expiry, rejected bet, and result-animation completion all request a refresh.
- Concurrent refreshes collapse into one in-flight request plus one queued refresh.

Greedy Lion's state RPC does not return public per-option totals. The native service therefore reads the current round's publicly readable `game_round_bets` rows and derives totals from authoritative stored bets. Teen Patti already receives `bet_totals` from its state RPC.

Popular Greedy and Lucky Dice retain aggregated boundary commits. Greedy King
and Teen Patti use an immediate 40 ms micro-batch so wallet deduction and shared
state become authoritative while the chip animation is running:

1. Every tap is validated against the current authoritative round, projected wallet, and six-item limit.
2. Phaser updates `Total`, `My`, and the player's single live-feed identity immediately without a database call. The displayed wallet remains authoritative until the batch is accepted.
3. Native aggregates repeated taps by item. A throttled Supabase Broadcast publishes the player's latest aggregate to other connected clients; this is transient presentation data and does not write a row or deduct a wallet.
4. Native calls the game's idempotent batch RPC at the configured commit point. Greedy Lion accepts at most six item totals, Teen Patti accepts all three boards, and Lucky Dice accepts all nine zones. Each RPC uses one idempotency key, one wallet deduction, one round-total update, and one transaction record.
5. `BET_BATCH_RESULT`, Postgres Realtime, and an authoritative state refresh reconcile the optimistic display. Duplicate Realtime rows are ignored by bet ID.

Migrations `151_greedy_lion_atomic_bet_batches.sql` and `153_tin_patti_pro_atomic_bet_batches.sql` provide the game-specific commits. Migration `20260824230000_realtime_betting_consistency.sql` adds canonical totals, server revisions, durable idempotency responses, and versioned reconnect snapshots for Greedy King and Teen Patti. Migration `149_serialize_global_game_ticks.sql` serializes client/coordinator tick calls so two global rounds cannot be created at the same boundary.

Queued amounts are never authoritative. If the app is force-killed, loses all connectivity, or the device powers off before the boundary RPC reaches Supabase, those unsent amounts cannot be recovered. A normal blur/background transition attempts an immediate batch flush before network subscriptions are stopped.

## Game implementations

### Greedy Lion V2

- Renders the existing visual identity with an optimized static background, wheel, item textures, Phaser containers, graphics, text, and hit areas.
- Pots and the player's amounts update in-place from `ROUND_STATE`; the scene is not recreated.
- Bet taps emit `PLACE_BET`; local staging comes back immediately through `PLACE_BET_RESULT`, while backend acceptance/rejection comes through `BET_BATCH_RESULT` and an authoritative refresh.
- The result winner always comes from `round.winnerId`.
- During the five-second settlement window, one Phaser time event advances the highlight around the fixed board. Only the previous and next item graphics repaint per step. The event stops on the authoritative backend winner; it does not use JavaScript timeout batches or React Native rerenders.
- Category results choose a deterministic member of that backend-winning category using a stable round-ID hash, while the result remains the backend category.
- The result overlay persists until a newer round is accepted and includes total pot, winning bet, payout, and top winner when supplied.

### Teen Patti Pro V2

- Uses an optimized 540×960 static WebP background. The legacy looping MP4 is not included.
- The table, three existing backend positions (A/B/C), cards, pots, chips, status, history, and overlays are Phaser objects.
- The internal A/B/C positions are presented as red, blue, and green chairs. Chair images replace player labels on each board and in the history rail below the chip row.
- Pot, own-bet labels, total bet, and the grouped live-player feed update optimistically in-place, then reconcile by authoritative bet IDs.
- Migration `156_tin_patti_pro_varied_valid_hands.sql` derives a stable shuffled 52-card deck from each round UUID. It exposes three different public first cards during betting, then deals six more unique cards from the same deck; devices therefore agree while consecutive rounds have large card variation.
- The backend evaluates Trail, Pure Sequence, Sequence, Color, Pair, and High Card, including A-K-Q and A-2-3 sequence ordering and category-specific tie scores. It retries the deterministic shuffle until the backend-selected winning chair is strictly stronger than both other hands.
- On an authoritative result, the first cards remain face-up while the other six cards deal and flip using Phaser tweens and time events.
- Every board receives its authoritative hand badge (`High Card`, `Pair`, `Pure Sequence`, `Trail`, etc.); the winning badge and frame are emphasized.
- Result presentation is keyed to one round ID and cannot open twice for a duplicate result. A compact bottom drawer renders the winning chair and actual card objects, the round's top winner and amount, and the current user's payout only when positive; total bet, own bet, and loss copy are omitted.
- Card values, suits, hand rank, winner, and payout all come from the backend result. Phaser does not evaluate hands or choose a winner.
- The help control opens a scrollable Phaser guide with all three chairs, visual card examples for every hand category, betting instructions, sequence order, and tie-breaking rules.
- Winner emphasis is a short localized board tween; there is no continuous full-screen animation.

### Lucky Dice Royale

- Uses a Royal Treasure background and cup as optimized WebP assets; dice, pips, betting zones, chips, history, and effects are lightweight Phaser objects.
- Offers Small, Big, Odd, Even, Any Triple, and exact totals 6/9/12/15. Multipliers live in `game_settings` and are not trusted from Phaser.
- Bets update immediately in the local UI and peer broadcast, then commit in one idempotent atomic batch at the server-aligned boundary.
- The backend alone generates the three dice and derives every winning option. A roll can settle multiple player bets, but each stored wager is paid exactly once.
- Rolling starts locally when betting closes while the three-second acceptance grace receives final batches. The animation lands only after authoritative dice arrive.
- Result history includes settled no-bet rounds because the shared server coordinator advances the global game independently of viewers.
- Migration `160_lucky_dice_royale.sql` owns round timing, validation, wallet deduction, payout transactions, settlement, history, and coordinator registration.

## Lifecycle and cleanup

| Event | Behavior |
| --- | --- |
| Focus | Request authoritative state; wake rendering/audio only after `ROUND_STATE`. |
| Blur | Flush the active game's queued batch, stop polling/subscriptions, sleep Phaser loop, and pause audio. |
| Background | Same as blur. |
| Foreground | Reconnect and refresh; do not blindly resume stale state. |
| Network reconnect | Show synchronization state and refresh. |
| WebGL context restored | Refresh authoritative state. |
| WebView content-process termination | Show native recovery behavior and reload. |
| Exit/unmount | Send `EXIT_GAME`, destroy Phaser, remove SDK/window listeners, kill tweens/time events, close audio context, stop metrics, remove Supabase channels and native listeners. |

Routes create one `GameWebView` only. Switching routes unmounts the prior instance, so two Phaser loops are not kept active.

## Performance strategy

- Target frame rate: 30 FPS, minimum smoothing threshold 20 FPS.
- Renderer: `Phaser.AUTO`, which selects WebGL and falls back to Canvas when WebGL is unavailable.
- Logical resolution: 540×960, aspect-preserving `FIT` scaling and centered letterboxing. The game does not render at the phone's 1440p/4K physical size.
- WebView bundle: one 1.66 MB self-contained HTML bundle shared by all registered games. Only the selected scene starts.
- Asset output: WebP; Greedy background 73 KB, Teen Patti background 40 KB, item textures roughly 4–6 KB, suit textures under 2 KB, chip textures roughly 2.5 KB. No GIF or video is included.
- Normal-state animation: no continuous custom spin/deal loop. The Greedy highlight timer exists only during settlement. Phaser renders at the configured 30 FPS while focused and sleeps offscreen.
- Metrics: FPS, average frame time, accessible JS heap, initialization time; native can additionally count WebView reloads, bridge errors, and network recoveries.

## Add another game

1. Create `games/new-game/config.ts`, `games/new-game/main.ts`, scene files, and right-sized assets.
2. Extend `GameId`, `REGISTERED_GAMES`, `GAME_CONFIG`, and the scene registry in `games/main.ts`.
3. Extend native snapshot normalization only for genuinely game-specific server fields.
4. Derive the scene from `BaseGameScene`; implement build, snapshot render, result animation, result overlay, optimistic feedback, wallet, network, and status hooks.
5. Send bets only through `GameSDK.requestBet`; never add Supabase or auth code under `games/`.
6. Put every phase change through `GameStateMachine` and key result animation to the authoritative round ID.
7. Add optimized assets to `prepare-game-v2-assets.mjs`, run `npm run games:build`, and add state-machine/recovery tests.
8. Register the production route only after the game has passed its own approval and device-test checklist.

## Test status and known work

Completed locally:

- Phaser production bundle build.
- React Native/Phaser TypeScript check.
- State-controller unit tests for duplicate result, stale round, and wrong-round callback protection.
- Bet-policy tests for immediate aggregation, projected-wallet enforcement, and the six-item limit.
- Teen Patti evaluator verification for all six hand categories, A-K-Q/A-2-3 ordering, nine-card uniqueness, varied first cards, and strict agreement between the stored winner and the strongest hand.
- Supabase migrations through `160_lucky_dice_royale.sql` deployed to the linked project.
- Lucky Dice multiplier mapping, multi-winner rolls, 25-second coordinator round, and rollback-only wallet deduction/payout settlement verified against the linked Supabase project.
- Greedy Lion and Teen Patti Pro manually approved and promoted to both standalone and live-room production entry points; legacy renderers and lab routes removed.

Not completed:

- A USB Android build has been installed for manual testing, but no 20–30 minute physical-device performance session has been completed or claimed.
- No 20–30 minute heat, battery, memory, background/foreground, network interruption, or repeated-switch test has been claimed.
- Production analytics/storage for performance metrics and WebView reload counts is intentionally not wired; the typed callback exists so a chosen telemetry provider can be added later without changing Phaser.
- Final audio design uses lightweight synthesized cues. Product-quality licensed sound assets can replace them through the shared audio manager after review.

The authoritative Supabase game backend remains in production and must not be removed with the retired React Native rendering code.
