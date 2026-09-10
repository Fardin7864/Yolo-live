import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rateLimit.js';

test('local presence enforces capacity and expires crashed connections', async () => {
  let now = 1_000;
  const limiter = new RateLimiter(undefined, () => now);
  assert.equal(await limiter.enterConnection('global', 'socket-a', 1), true);
  assert.equal(await limiter.enterConnection('global', 'socket-b', 1), false);
  now += 90_001;
  assert.equal(await limiter.enterConnection('global', 'socket-b', 1), true);
});

test('presence refresh keeps a connected socket and leave frees its slot', async () => {
  let now = 1_000;
  const limiter = new RateLimiter(undefined, () => now);
  assert.equal(await limiter.enterConnection('global', 'socket-a', 1), true);
  now += 60_000;
  await limiter.refreshConnection('global', 'socket-a');
  now += 60_000;
  assert.equal(await limiter.enterConnection('global', 'socket-b', 1), false);
  await limiter.leaveConnection('global', 'socket-a');
  assert.equal(await limiter.enterConnection('global', 'socket-b', 1), true);
});
