import assert from 'node:assert/strict';
import test from 'node:test';
import { resizeAudioGuestSeats, shouldApplyRealtimeRevision } from './audioRoomSync';

test('audio room revisions reject delayed and legacy snapshots after newer state', () => {
  assert.equal(shouldApplyRealtimeRevision(4, 3), false);
  assert.equal(shouldApplyRealtimeRevision(4, 0), false);
  assert.equal(shouldApplyRealtimeRevision(4, 4), true);
  assert.equal(shouldApplyRealtimeRevision(4, 5), true);
  assert.equal(shouldApplyRealtimeRevision(0, 0), true);
});

test('audio guest seats resize to the configured capacity without moving guests', () => {
  const guest = { id: 'guest-1' };
  assert.deepEqual(resizeAudioGuestSeats([guest], 4), [guest, null, null]);
  assert.deepEqual(resizeAudioGuestSeats([guest, null, { id: 'guest-2' }], 2), [guest]);
});
