import { supabase } from './supabase';

export const LIVE_ANNOUNCEMENT_THRESHOLDS = Object.freeze({
  gift: 1000,
  luckyBag: 10000,
  gameWin: 10000,
});

// One global cadence is shared by the root app and every live room. New
// announcements are appended while the current entry owns this full slot.
export const LIVE_ANNOUNCEMENT_DISPLAY_MS = 3000;

const LIVE_ANNOUNCEMENT_EVENTS = Object.freeze([
  'gift_in_live',
  'lucky_bag_in_live',
  'lucky_bag_drop_global',
  'game_win_in_live',
]);

const listeners = new Set();
const deliveredEventIds = new Set();
let sharedChannel = null;
let sharedChannelState = 'idle';
let sharedSubscribePromise = null;

const amountFor = (event, payload = {}) => {
  if (event === 'gift_in_live') return Number(payload.totalCost || payload.amount || 0);
  if (event === 'game_win_in_live') return Number(payload.amount || 0);
  return Number(payload.prizeDiamonds || (Number(payload.perWinner || 0) * Number(payload.winnerCount || 0)) || 0);
};

export const meetsLiveAnnouncementThreshold = (event, payload = {}) => {
  const amount = amountFor(event, payload);
  if (event === 'gift_in_live') return amount >= LIVE_ANNOUNCEMENT_THRESHOLDS.gift;
  if (event === 'game_win_in_live') return amount >= LIVE_ANNOUNCEMENT_THRESHOLDS.gameWin;
  // Every valid Lucky Bag is globally discoverable. Bag visibility must not
  // depend on the old high-value banner threshold because 5K is an approved
  // denomination and users on any app page still need the join notification.
  if (event === 'lucky_bag_in_live' || event === 'lucky_bag_drop_global') {
    return !!(payload.bagId || payload.bag_id);
  }
  return false;
};

export const appendLiveAnnouncementFifo = (queue, announcement) => [...queue, announcement];

export const globalAnnouncementEventId = (event, payload = {}) => {
  const bagId = payload.bagId || payload.bag_id;
  if (bagId && event.startsWith('lucky_bag')) return `lucky-bag-${bagId}`;
  return payload.eventId || `${event}-${payload.id || payload.roundId || payload.ts || Date.now()}`;
};

export const buildLiveAnnouncementDestination = (payload = {}) => {
  const roomId = payload.roomId || payload.roomHostId || payload.room_host_id;
  const streamId = payload.streamId || payload.stream_id;
  // A host can have many historical rows. Never navigate from a Lucky Bag
  // announcement without the exact live_streams row that owns the bag.
  if (!roomId || !streamId) return null;
  const query = ['mode=viewer'];
  if (payload.type) query.push(`type=${encodeURIComponent(String(payload.type))}`);
  if (streamId) query.push(`streamId=${encodeURIComponent(String(streamId))}`);
  return `/broadcast/${encodeURIComponent(String(roomId))}?${query.join('&')}`;
};

export const luckyBagBelongsToLive = (payload = {}, roomId, streamId) => {
  const sourceRoomId = payload.roomId || payload.roomHostId || payload.room_host_id;
  const sourceStreamId = payload.streamId || payload.stream_id;
  if (!sourceStreamId || !streamId || String(sourceStreamId) !== String(streamId)) return false;
  return !sourceRoomId || !roomId || String(sourceRoomId) === String(roomId);
};

export const canOpenLuckyBagForUser = async (userId) => {
  if (!userId) return false;
  const { data, error } = await supabase
    .from('live_streams')
    .select('id')
    .eq('broadcaster_id', userId)
    .eq('status', 'live')
    .limit(1)
    .maybeSingle();
  // Protect a potentially active host if the status check itself fails.
  if (error) return false;
  return !data?.id;
};

// Lucky Bag announcements are global, but the claimable bag is scoped to
// the exact source live carried by these fields.
export const normalizeGlobalLuckyBag = (payload = {}) => {
  const bagId = payload.bagId || payload.bag_id;
  if (!bagId) return null;
  const winnerCount = Number(payload.winnerCount || payload.winners || 0);
  const prizeDiamonds = Number(payload.prizeDiamonds || payload.prize_diamonds || 0);
  const perWinner = Number(payload.perWinner || payload.per_winner || (
    winnerCount > 0 ? Math.floor(prizeDiamonds / winnerCount) : 0
  ));
  return {
    id: String(bagId),
    perWinner,
    winners: winnerCount,
    droppedBy: payload.dropperId || payload.dropper_id || payload.droppedBy || null,
    dropperName: payload.dropperName || payload.dropper_name || 'Someone',
    dropAt: payload.dropAt || payload.created_at || new Date().toISOString(),
    expiresAt: payload.expiresAt || payload.expires_at || null,
    roomId: payload.roomId || payload.roomHostId || payload.room_host_id || null,
    streamId: payload.streamId || payload.stream_id || null,
    posX: Number.isFinite(Number(payload.posX)) ? Number(payload.posX) : 0.55,
    posY: Number.isFinite(Number(payload.posY)) ? Number(payload.posY) : 0.64,
  };
};

const dispatchAnnouncement = (event, payload = {}) => {
  if (!meetsLiveAnnouncementThreshold(event, payload)) return;
  // The persisted row and low-latency broadcast describe the same drop but
  // can arrive in either order. Canonicalising by bag id prevents two banners.
  const eventId = globalAnnouncementEventId(event, payload);
  if (deliveredEventIds.has(eventId)) return;
  deliveredEventIds.add(eventId);
  if (deliveredEventIds.size > 2000) deliveredEventIds.delete(deliveredEventIds.values().next().value);
  listeners.forEach((listener) => {
    try { listener(event, { ...payload, eventId }); } catch (_) {}
  });
};

const resetSharedChannel = () => {
  const previous = sharedChannel;
  sharedChannel = null;
  sharedChannelState = 'idle';
  sharedSubscribePromise = null;
  if (previous) supabase.removeChannel(previous).catch(() => {});
};

export const ensureGlobalLiveAnnouncementChannel = () => {
  if (sharedChannel && sharedChannelState === 'subscribed') return Promise.resolve(sharedChannel);
  if (sharedSubscribePromise) return sharedSubscribePromise;

  sharedChannelState = 'connecting';
  sharedChannel = supabase.channel('global-live-events', {
    config: { broadcast: { self: true } },
  });
  LIVE_ANNOUNCEMENT_EVENTS.forEach((event) => {
    sharedChannel.on('broadcast', { event }, ({ payload }) => dispatchAnnouncement(event, payload));
  });

  sharedSubscribePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resetSharedChannel();
      if (listeners.size > 0) setTimeout(() => ensureGlobalLiveAnnouncementChannel().catch(() => {}), 1200);
      reject(new Error('Live announcement channel timed out'));
    }, 7000);
    sharedChannel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timeout);
        sharedChannelState = 'subscribed';
        resolve(sharedChannel);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        clearTimeout(timeout);
        resetSharedChannel();
        if (listeners.size > 0) setTimeout(() => ensureGlobalLiveAnnouncementChannel().catch(() => {}), 1200);
        reject(new Error(`Live announcement channel ${status.toLowerCase()}`));
      }
    });
  });
  return sharedSubscribePromise;
};

export const subscribeGlobalLiveAnnouncements = (listener) => {
  listeners.add(listener);
  ensureGlobalLiveAnnouncementChannel().catch(() => {});
  return () => {
    listeners.delete(listener);
    // A login/logout or account switch must establish a fresh Realtime socket
    // with the new JWT. Leaving an anonymous channel alive here can silently
    // miss RLS-protected Lucky Bag rows for the rest of the app session.
    if (listeners.size === 0) resetSharedChannel();
  };
};

// One channel per app process prevents duplicate-topic subscriptions from
// replacing one another when a live room is opened over the root app.
export const publishGlobalLiveAnnouncement = async (event, payload = {}) => {
  if (!meetsLiveAnnouncementThreshold(event, payload)) return { skipped: true };
  const eventId = payload.eventId || `${event}-${payload.id || payload.roundId || Date.now()}`;
  const normalizedPayload = { ...payload, eventId };
  const channel = await ensureGlobalLiveAnnouncementChannel();
  const result = await channel.send({ type: 'broadcast', event, payload: normalizedPayload });
  if (result !== 'ok') throw new Error(`Live announcement send ${result || 'failed'}`);
  // Self-delivery should arrive over realtime. Dispatch locally as a fallback;
  // event-id deduplication guarantees that it still renders only once.
  dispatchAnnouncement(event, normalizedPayload);
  return { skipped: false, eventId };
};
