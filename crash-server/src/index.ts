import http from 'node:http';
import pino from 'pino';
import { Server } from 'socket.io';
import { createClient, type RedisClientType } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import { config, instanceId } from './config.js';
import { Sequencer } from './sequencer.js';
import { installSocket } from './socket.js';
import { CrashEngine } from './engine.js';
import { OutboxPublisher } from './outbox.js';
import { registry } from './metrics.js';
import { RateLimiter } from './rateLimit.js';
import { rpc, serviceDb } from './database.js';

const log = pino({ level: config.LOG_LEVEL, base: { service: 'crash-server', instanceId } });
let redisPub: RedisClientType | undefined;
let redisSub: RedisClientType | undefined;
let shuttingDown = false;

async function readiness() {
  if (shuttingDown) return { ready: false, reason: 'shutting_down' };
  if (config.REQUIRE_REDIS && (!redisPub?.isReady || !redisSub?.isReady)) {
    return { ready: false, reason: 'redis_unavailable' };
  }
  try {
    const database = await rpc<Record<string, unknown>>(serviceDb, 'crash_service_readiness', {
      p_game_id: config.CRASH_GAME_ID,
      p_table_id: config.CRASH_TABLE_ID,
    });
    return { ...database, redis: redisPub?.isReady ?? !config.REQUIRE_REDIS };
  } catch (error) {
    log.warn({ error }, 'readiness database probe failed');
    return { ready: false, reason: 'database_unavailable', redis: redisPub?.isReady ?? false };
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, instanceId }));
    return;
  }
  if (req.url === '/readyz') {
    const state = await readiness();
    res.writeHead(state.ready === true ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(state));
    return;
  }
  if (req.url === '/metrics') {
    res.writeHead(200, { 'content-type': registry.contentType }).end(await registry.metrics());
    return;
  }
  res.writeHead(404).end();
});

const io = new Server(server, {
  transports: ['websocket'],
  allowUpgrades: false,
  maxHttpBufferSize: 32 * 1024,
  pingInterval: 15_000,
  pingTimeout: 10_000,
  cors: { origin: false },
});

if (config.REDIS_URL) {
  redisPub = createClient({ url: config.REDIS_URL });
  redisSub = redisPub.duplicate();
  await Promise.all([redisPub.connect(), redisSub.connect()]);
  io.adapter(createAdapter(redisPub, redisSub));
} else if (config.REQUIRE_REDIS) {
  throw new Error('REDIS_URL is required');
}

const seq = new Sequencer(redisPub);
const limiter = new RateLimiter(redisPub);
const nsp = installSocket(io, seq, log, limiter);
const outbox = new OutboxPublisher(nsp, seq, log);
outbox.start();
const engine = new CrashEngine(nsp, seq, log);
if (config.ENGINE_ENABLED) engine.start();

server.listen(config.PORT, () => log.info({ port: config.PORT }, 'crash server listening'));

const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('crash server draining');
  engine.stop();
  server.close();
  nsp.disconnectSockets(true);
  await outbox.drain();
  await new Promise<void>((resolve) => io.close(() => resolve()));
  if (redisSub) await redisSub.quit();
  if (redisPub) await redisPub.quit();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
