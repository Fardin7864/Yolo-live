# Crash server

Production Socket.IO `/crash` gateway, fenced round engine and durable outbox publisher for game ID `crash`.

Database prerequisites: apply `20260825030000_crash_game_backend.sql`, configure `app.settings.crash_seed_key` to a high-entropy value of at least 32 characters, assign and fund `house_profile_id`, then explicitly enable the config. Bots and the game default off.

```bash
cp .env.example .env
npm install
npm run typecheck
npm test
npm run build
```

Production requires TLS termination, Redis HA, `SUPABASE_SERVICE_ROLE_KEY`, and at least two replicas (engine fencing ensures one active leader). Never expose the service-role key or database seed key to clients.

`/healthz` is process liveness; `/readyz` verifies Redis plus the protected
database configuration, encryption key, and house profile. Use `/readyz` for the
load-balancer readiness probe.

Run the opt-in staging socket load check with short-lived test-user JWTs (never
production user tokens):

```bash
CRASH_LOAD_URL=https://games-staging.example.com \
CRASH_LOAD_TOKENS='["jwt-1","jwt-2"]' \
CRASH_LOAD_CONNECTIONS=100 CRASH_LOAD_DURATION_MS=60000 npm run test:load
```
