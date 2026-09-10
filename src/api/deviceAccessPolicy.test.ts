import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEVICE_ACCESS_NETWORK_MESSAGE,
  DeviceAccessTransportError,
  isDeviceAccessTransportError,
  normalizeDeviceAccessResult,
} from './deviceAccessPolicy';

test('device access keeps genuine server block decisions intact', () => {
  const blocked = { allowed: false, code: 'DEVICE_BLOCKED', message: 'Blocked' };
  assert.equal(normalizeDeviceAccessResult(blocked), blocked);
});

test('missing transport responses use only the network-failure presentation', () => {
  assert.throws(
    () => normalizeDeviceAccessResult(null),
    (error) => isDeviceAccessTransportError(error)
      && error instanceof Error
      && error.message === DEVICE_ACCESS_NETWORK_MESSAGE,
  );
  assert.equal(new DeviceAccessTransportError(new Error('offline')).message, 'Internet connection failed');
});
