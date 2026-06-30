/**
 * GiftSoundManager
 * ----------------
 * Plays gift SFX through a small expo-audio player pool keyed by
 * sound source. Mirrors the in-broadcast SFX_ASSETS pool pattern so
 * we don't create-and-leak a fresh native player on every gift send.
 *
 * Why a separate module instead of folding into broadcast/[id].js's
 * existing pool:
 *   - Gift SFX can fire from outside the broadcast screen (preview,
 *     gift catalog, future combo widget).
 *   - The room-SFX pool is room-scoped (released on unmount); gift
 *     SFX outlive a single room.
 *
 * Senior-level concerns baked in:
 *
 *   1. Audio session config lives in src/audio/audioSession.js so
 *      iOS silent-mode + Android audio-focus behaves like users
 *      expect (gift sound plays through silent; ducks other apps).
 *
 *   2. Per-tier volume so a 10💎 Rose doesn't blast at the same level
 *      as a 5000💎 Wedding. Classic gifts are deliberately quieter so
 *      a busy room doesn't become an SFX assault.
 *
 *   3. Combo-aware playback. handleSendGift already throttles to
 *      ~400ms but if two viewers in the same room send simultaneously
 *      we still want clean restart, not crackle. seekTo(0) before
 *      play() handles that.
 *
 *   4. LRU pool cap (MAX_POOL=20) so a noisy gifting session doesn't
 *      grow native player count past what a budget Android tolerates.
 *
 *   5. Crash-safe — wrapped in try/catch with __DEV__-gated warnings.
 *      A failed SFX must NEVER block a paid gift send.
 */
import * as Audio from 'expo-audio';
import { resolveGiftSound } from './giftSounds';

const MAX_POOL = 20;

// Map of cacheKey → { player, lastUsed }. Cache key is the require()
// numeric ID for bundled assets or the URL string for remote assets,
// so the same key always maps to the same player.
const pool = new Map();

function keyFor(source) {
  if (!source) return null;
  if (typeof source === 'number') return `bundle:${source}`;
  if (typeof source === 'object' && source.uri) return `uri:${source.uri}`;
  return null;
}

function touch(key) {
  const entry = pool.get(key);
  if (entry) entry.lastUsed = Date.now();
}

// Evict the least-recently-used entry if we're over the cap. Cheap
// linear scan — MAX_POOL is small enough that this is faster than
// maintaining a heap.
function evictIfNeeded() {
  if (pool.size <= MAX_POOL) return;
  let oldestKey = null;
  let oldestTs = Infinity;
  for (const [k, v] of pool.entries()) {
    if (v.lastUsed < oldestTs) {
      oldestTs = v.lastUsed;
      oldestKey = k;
    }
  }
  if (oldestKey) {
    const entry = pool.get(oldestKey);
    try { entry.player.pause?.(); } catch (_) {}
    try { entry.player.remove?.(); } catch (_) {}
    pool.delete(oldestKey);
  }
}

/**
 * Pick a sensible playback volume for the gift.
 *
 *   Classic:    0.55 — sent every few seconds in busy rooms; loud SFX
 *               becomes obnoxious fast.
 *   Premium:    0.75 — themed and intentional; user noticed the price.
 *   Exclusive:  0.95 — rare, dramatic, full-screen; volume completes
 *                       the moment.
 *
 * We read `category` first (fast path from GIFT_ITEMS) and fall back to
 * diamond_cost when category is missing (some seed paths only carry the
 * price field). NULL/unknown values default to the safe middle tier.
 */
function volumeFor(gift) {
  const cat = (gift?.category || '').toLowerCase();
  if (cat === 'classic')   return 0.55;
  if (cat === 'premium')   return 0.75;
  if (cat === 'exclusive') return 0.95;

  const cost = Number(gift?.price || gift?.diamond_cost || 0);
  if (cost <= 100)  return 0.55;
  if (cost <= 1000) return 0.75;
  return 0.95;
}

/**
 * Play the SFX for a gift, if one is configured.
 * Safe to call with a gift that has no sound — returns silently.
 *
 * @param {object} gift  Row from gifts table or merged GIFT_ITEMS shape.
 */
// Keys we've already failed to create a player for. Without this,
// a single broken sound_url would re-throw on every gift send and
// flood the breadcrumb stream. Each broken key is logged ONCE per
// session and then short-circuits silently on subsequent calls.
const failedKeys = new Set();

export function playGiftSound(gift) {
  try {
    const source = resolveGiftSound(gift);
    if (!source) return;
    const key = keyFor(source);
    if (!key) return;
    if (failedKeys.has(key)) return; // known-bad, skip silently

    let entry = pool.get(key);
    if (!entry) {
      let player;
      try {
        player = Audio.createAudioPlayer(source);
      } catch (createErr) {
        // Surface the first failure for this source so devs can spot
        // a malformed sound_url / 404 / unsupported codec. Future calls
        // for the same source are silenced via failedKeys.
        failedKeys.add(key);
        if (__DEV__) {
          console.warn(
            '[GiftSoundManager] createAudioPlayer failed for gift',
            gift?.id, gift?.name, '→', key,
            createErr?.message || createErr
          );
        }
        return;
      }
      entry = { player, lastUsed: Date.now() };
      pool.set(key, entry);
      evictIfNeeded();
    } else {
      touch(key);
    }

    // Per-tier volume. Setting it every play (not just on creation) so
    // an admin-side category change is reflected without a restart.
    try {
      const v = volumeFor(gift);
      if (typeof entry.player.volume === 'number' || 'volume' in entry.player) {
        entry.player.volume = v;
      } else if (typeof entry.player.setVolume === 'function') {
        entry.player.setVolume(v);
      }
    } catch (_) { /* volume is best-effort */ }

    // seekTo(0) lets us replay the same gift's SFX back-to-back
    // (combo sends) without waiting for the previous play to finish.
    try { entry.player.seekTo?.(0); } catch (_) {}
    entry.player.play();
  } catch (err) {
    // Silent in prod — SFX failures should NEVER block a paid gift
    // send. Dev gets the breadcrumb.
    if (__DEV__) console.warn('[GiftSoundManager] play failed:', err?.message);
  }
}

/**
 * Release every cached player. Call on app suspend / sign-out if you
 * want to free RAM aggressively; otherwise the pool self-bounds at
 * MAX_POOL.
 */
export function disposeAllGiftSounds() {
  for (const [, v] of pool.entries()) {
    try { v.player.pause?.(); } catch (_) {}
    try { v.player.remove?.(); } catch (_) {}
  }
  pool.clear();
}
