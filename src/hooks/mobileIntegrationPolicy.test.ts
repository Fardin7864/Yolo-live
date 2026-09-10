import assert from 'node:assert/strict';
import test from 'node:test';
import { createClientRequestUuid, luckyBagExpiryDelayMs } from './mobileIntegrationPolicy';

test('gift client request IDs are valid stable-shape UUID v4 values', () => {
  const requestId = createClientRequestUuid(() => 0.5);
  assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('Lucky Bag expiry accepts absolute server timestamps and bounded delays', () => {
  assert.equal(luckyBagExpiryDelayMs('2026-08-25T00:01:00.000Z', Date.parse('2026-08-25T00:00:00.000Z')), 60250);
  assert.equal(luckyBagExpiryDelayMs(75000, 0), 75000);
  assert.equal(luckyBagExpiryDelayMs('invalid', 0), 75000);
});
