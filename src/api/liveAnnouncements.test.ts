import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  LIVE_ANNOUNCEMENT_DISPLAY_MS,
  LIVE_ANNOUNCEMENT_THRESHOLDS,
  appendLiveAnnouncementFifo,
  buildLiveAnnouncementDestination,
  globalAnnouncementEventId,
  luckyBagBelongsToLive,
  meetsLiveAnnouncementThreshold,
  normalizeGlobalLuckyBag,
} from './liveAnnouncements';

const liveGiftMigrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20260825040000_global_lucky_bags_and_authoritative_live_gifts.sql',
);
const roomScopedClaimMigrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20260825173000_room_scoped_lucky_bag_claims.sql',
);
const reliableClaimMigrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20260825223000_reliable_lucky_bag_claims.sql',
);

test('global game-win and gift thresholds include the exact boundary', () => {
  assert.equal(LIVE_ANNOUNCEMENT_THRESHOLDS.gameWin, 10_000);
  assert.equal(LIVE_ANNOUNCEMENT_THRESHOLDS.gift, 1_000);
  assert.equal(meetsLiveAnnouncementThreshold('game_win_in_live', { amount: 9_999 }), false);
  assert.equal(meetsLiveAnnouncementThreshold('game_win_in_live', { amount: 10_000 }), true);
  assert.equal(meetsLiveAnnouncementThreshold('gift_in_live', { totalCost: 999 }), false);
  assert.equal(meetsLiveAnnouncementThreshold('gift_in_live', { totalCost: 1_000 }), true);
});

test('announcement queues preserve first-in first-out order without dropping entries', () => {
  const first = { id: 'first' };
  const second = { id: 'second' };
  const third = { id: 'third' };
  const queue = appendLiveAnnouncementFifo(
    appendLiveAnnouncementFifo(appendLiveAnnouncementFifo([], first), second),
    third,
  );
  assert.deepEqual(queue.map((item) => item.id), ['first', 'second', 'third']);
  assert.deepEqual(queue.slice(1).map((item) => item.id), ['second', 'third']);
});

test('later rounds and other games append behind an unfinished winner queue', () => {
  let queue = [];
  const firstRound = Array.from({ length: 10 }, (_, index) => ({
    id: `greedy-round-1-winner-${index + 1}`,
  }));
  firstRound.forEach((winner) => { queue = appendLiveAnnouncementFifo(queue, winner); });

  const currentlyShowing = queue[0];
  queue = queue.slice(1);
  queue = appendLiveAnnouncementFifo(queue, { id: 'teen-patti-round-8-winner-1' });
  queue = appendLiveAnnouncementFifo(queue, { id: 'greedy-round-2-winner-1' });

  assert.equal(LIVE_ANNOUNCEMENT_DISPLAY_MS, 3_000);
  assert.equal(currentlyShowing.id, 'greedy-round-1-winner-1');
  assert.deepEqual(queue.map((item) => item.id), [
    ...firstRound.slice(1).map((item) => item.id),
    'teen-patti-round-8-winner-1',
    'greedy-round-2-winner-1',
  ]);
});

test('a Lucky Bag announcement retains its exact source live', () => {
  assert.equal(meetsLiveAnnouncementThreshold('lucky_bag_in_live', { bagId: 'bag-1', prizeDiamonds: 5_000 }), true);
  assert.equal(meetsLiveAnnouncementThreshold('lucky_bag_drop_global', { bagId: 'bag-1', prizeDiamonds: 5_000 }), true);
  assert.equal(meetsLiveAnnouncementThreshold('lucky_bag_in_live', { prizeDiamonds: 50_000 }), false);
  assert.deepEqual(normalizeGlobalLuckyBag({
    bag_id: 'bag-1',
    prize_diamonds: 50_000,
    winners: 10,
    dropper_id: 'dropper-1',
    created_at: '2026-08-25T00:00:00.000Z',
  }), {
    id: 'bag-1',
    perWinner: 5_000,
    winners: 10,
    droppedBy: 'dropper-1',
    dropperName: 'Someone',
    dropAt: '2026-08-25T00:00:00.000Z',
    expiresAt: null,
    roomId: null,
    streamId: null,
    posX: 0.55,
    posY: 0.64,
  });
  assert.equal(normalizeGlobalLuckyBag({ prize_diamonds: 10_000 }), null);
});

test('Lucky Bag realtime and persisted copies deduplicate and route to the exact live', () => {
  const payload = {
    bagId: 'bag-1', roomId: 'host-1', streamId: 'stream-1', type: 'audio',
  };
  assert.equal(globalAnnouncementEventId('lucky_bag_in_live', payload), 'lucky-bag-bag-1');
  assert.equal(globalAnnouncementEventId('lucky_bag_drop_global', {
    bag_id: 'bag-1', eventId: 'different-wire-event-id',
  }), 'lucky-bag-bag-1');
  assert.equal(
    buildLiveAnnouncementDestination(payload),
    '/broadcast/host-1?mode=viewer&type=audio&streamId=stream-1',
  );
  assert.equal(buildLiveAnnouncementDestination({ bagId: 'bag-1' }), null);
  assert.equal(buildLiveAnnouncementDestination({ bagId: 'bag-1', roomId: 'host-1' }), null);
  assert.equal(luckyBagBelongsToLive(payload, 'host-1', 'stream-1'), true);
  assert.equal(luckyBagBelongsToLive(payload, 'host-1', 'stream-2'), false);
  assert.equal(luckyBagBelongsToLive(payload, 'host-2', 'stream-1'), false);
  assert.equal(luckyBagBelongsToLive({ bagId: 'bag-1', roomId: 'host-1' }, 'host-1', 'stream-1'), false);
  assert.equal(luckyBagBelongsToLive({ bagId: 'bag-1', streamId: 'stream-1' }, 'host-1', 'stream-1'), true);
});

test('Lucky Bag claims are authorized against the exact active source stream', () => {
  const sql = fs.readFileSync(roomScopedClaimMigrationPath, 'utf8');
  assert.match(sql, /claim_lucky_bag\(bag UUID, p_stream_id UUID\)/i);
  assert.match(sql, /announcement\.bag_id = bag[\s\S]*announcement\.stream_id = p_stream_id/i);
  assert.match(sql, /stream_row\.status = 'live'/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.claim_lucky_bag\(UUID\) FROM PUBLIC, anon, authenticated/i);

  const broadcastSource = fs.readFileSync(
    path.join(process.cwd(), 'app/broadcast/[id].js'),
    'utf8',
  );
  assert.match(broadcastSource, /claim_lucky_bag_v2'[\s\S]{0,180}p_stream_id:\s*streamRecordId/i);
  assert.match(broadcastSource, /\.eq\('stream_id', streamRecordId\)/i);
  assert.match(broadcastSource, /activeLuckyBag\?\.id[\s\S]{0,160}luckyBagBelongsToLive\(payload\.activeLuckyBag, id, streamRecordIdRef\.current\)/i);
  assert.match(broadcastSource, /payload\?\.bagId[\s\S]{0,180}luckyBagBelongsToLive\(payload, id, streamRecordIdRef\.current\)/i);

  const notificationSource = fs.readFileSync(
    path.join(process.cwd(), 'app/main/notifications.js'),
    'utf8',
  );
  assert.match(notificationSource, /const isLuckyBag =[\s\S]*destination = isLuckyBag/i);
  assert.doesNotMatch(notificationSource, /item\.payload\?\.route/);
});

test('Lucky Bag V2 claims return typed outcomes and authoritative wallet state', () => {
  const sql = fs.readFileSync(reliableClaimMigrationPath, 'utf8');
  assert.match(sql, /claim_lucky_bag_v2\([\s\S]*p_bag_id UUID[\s\S]*p_stream_id UUID/i);
  assert.match(sql, /FOR UPDATE/i);
  assert.match(sql, /announcement\.stream_id = p_stream_id[\s\S]*stream_row\.status = 'live'/i);
  assert.match(sql, /'status', 'WRONG_LIVE'/i);
  assert.match(sql, /'status', 'ALREADY_CLAIMED'/i);
  assert.match(sql, /'status', 'CLAIMED'[\s\S]*'balance', balance_after/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.claim_lucky_bag_v2\(UUID, UUID\) TO authenticated/i);

  const broadcastSource = fs.readFileSync(path.join(process.cwd(), 'app/broadcast/[id].js'), 'utf8');
  assert.match(broadcastSource, /rpc\('claim_lucky_bag_v2'[\s\S]{0,180}p_stream_id:\s*streamRecordId/i);
  assert.match(broadcastSource, /setMyDiamonds\(Number\(data\.balance\)\)/i);
});

test('Lucky Bag creation refunds division remainder and announces only distributable currency', () => {
  const sql = fs.readFileSync(liveGiftMigrationPath, 'utf8');
  assert.match(sql, /remainder\s*:=\s*prize_diamonds\s*-\s*\(per_winner\s*\*\s*winner_count\)/i);
  assert.match(sql, /distributable_prize\s*:=\s*per_winner\s*\*\s*winner_count/i);
  assert.match(sql, /IF remainder > 0 THEN[\s\S]*diamonds\s*=\s*diamonds\s*\+\s*remainder/i);
  assert.match(sql, /lucky_bag_global_announcements[\s\S]*distributable_prize/i);
});

test('gift batching is request-idempotent and retains a six-argument compatibility wrapper', () => {
  const sql = fs.readFileSync(liveGiftMigrationPath, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.gift_batch_requests/i);
  assert.match(sql, /PRIMARY KEY\s*\(sender_id,\s*request_id\)/i);
  assert.match(sql, /p_request_id UUID[\s\S]*pg_advisory_xact_lock/i);
  assert.match(sql, /WHERE request_row\.sender_id = me AND request_row\.request_id = p_request_id/i);
  assert.match(sql, /INSERT INTO public\.gift_batch_requests\(sender_id, request_id, response\)/i);
  assert.match(sql, /p_count, gen_random_uuid\(\)/i);

  const replayLookup = sql.indexOf('SELECT request_row.response INTO v_response');
  const senderDebit = sql.indexOf('SET diamonds = diamonds - v_total_cost');
  assert.ok(replayLookup >= 0 && senderDebit > replayLookup, 'idempotency replay must be checked before debit');
});

test('gift room state is live-validated and host totals use full gift diamond cost', () => {
  const sql = fs.readFileSync(liveGiftMigrationPath, 'utf8');
  assert.match(sql, /WHERE stream_row\.id = p_room_id AND stream_row\.status = 'live'[\s\S]*FOR SHARE/i);
  assert.match(sql, /recipient\.user_id = v_room_host_id/i);
  assert.match(sql, /THEN v_unit_cost \* p_count ELSE 0 END/i);
  assert.doesNotMatch(sql, /THEN v_total_beans ELSE 0 END/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.get_room_seat_earnings\(UUID\) FROM PUBLIC, anon/i);
});
