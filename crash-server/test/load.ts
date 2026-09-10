import { io, type Socket } from 'socket.io-client';

const url = process.env.CRASH_LOAD_URL;
const durationMs = Number(process.env.CRASH_LOAD_DURATION_MS || 30_000);
const requestedConnections = Number(process.env.CRASH_LOAD_CONNECTIONS || 25);
const tokens = JSON.parse(process.env.CRASH_LOAD_TOKENS || '[]') as string[];

if (!url || !Array.isArray(tokens) || tokens.length === 0) {
  throw new Error('Set CRASH_LOAD_URL and CRASH_LOAD_TOKENS (a JSON array of staging JWTs).');
}
if (!Number.isInteger(requestedConnections) || requestedConnections < 1 || requestedConnections > 5_000) {
  throw new Error('CRASH_LOAD_CONNECTIONS must be between 1 and 5000.');
}

const sockets: Socket[] = [];
const latencies: number[] = [];
let connected = 0;
let snapshots = 0;
let failures = 0;

await Promise.all(Array.from({ length: requestedConnections }, (_, index) => new Promise<void>((resolve) => {
  const socket = io(`${url.replace(/\/$/, '')}/crash`, {
    transports: ['websocket'],
    auth: { token: tokens[index % tokens.length] },
    reconnection: true,
    forceNew: true,
  });
  sockets.push(socket);
  const timeout = setTimeout(() => { failures += 1; resolve(); }, 10_000);
  socket.once('connect', () => {
    clearTimeout(timeout);
    connected += 1;
    const started = performance.now();
    socket.emit('state:sync', {}, (ack: { accepted?: boolean }) => {
      latencies.push(performance.now() - started);
      if (!ack?.accepted) failures += 1;
      resolve();
    });
  });
  socket.on('crash:snapshot', () => { snapshots += 1; });
  socket.on('connect_error', () => { failures += 1; });
})));

await new Promise((resolve) => setTimeout(resolve, durationMs));
for (const socket of sockets) socket.disconnect();

latencies.sort((a, b) => a - b);
const percentile = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] || 0;
const report = {
  requestedConnections,
  connected,
  snapshots,
  failures,
  syncLatencyMs: { p50: percentile(0.5), p95: percentile(0.95), max: latencies.at(-1) || 0 },
};
console.log(JSON.stringify(report, null, 2));
if (connected !== requestedConnections || failures > 0) process.exitCode = 1;
