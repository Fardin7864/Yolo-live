/**
 * Agora pre-warm — get the engine joined to the channel BEFORE the
 * broadcast room mounts.
 *
 * Why
 *   The "Going live" spinner the host sees in broadcast/[id] is almost
 *   entirely Agora doing its three slow things: token fetch, engine
 *   init, channel join. In total ~1-2 seconds on a budget Android.
 *   Since live.js already holds the user for a 3-second countdown,
 *   that's a free window to do all three in parallel. By the time the
 *   modal slides up, the engine is already joined and publishing.
 *
 * How
 *   1. live.js calls prewarmAgora(...) the moment the countdown starts.
 *   2. This module creates + initialises an engine, fetches a token,
 *      and joins the channel. Result is cached in module-level state.
 *   3. When useAgoraEngine mounts inside broadcast/[id], it calls
 *      consumeWarmAgora(channelName, isVideo). If there's a matching
 *      warm engine, the hook adopts it — no second init, no second
 *      join. If not (cold path), it falls through to the normal flow.
 *
 * Lifecycle safety
 *   - Only ONE warm engine at a time. If a second prewarm is requested
 *     before the first is consumed, we drop the old one and warm again.
 *   - disposeWarmAgora() leaves the channel and releases the engine.
 *     Call it if the user backs out of the countdown without ever
 *     landing in broadcast/[id], so we don't leak a joined channel.
 */
import {
  createAgoraRtcEngine,
  ChannelProfileType,
  ClientRoleType,
  OrientationMode,
  DegradationPreference,
} from 'react-native-agora';
import { fetchAgoraToken } from './agora';

// Module-level cache. Holds at most one warm engine. Cleared by
// consumeWarmAgora (adopted) or disposeWarmAgora (abandoned).
let warmCache = null;

/**
 * Starts the warm.
 * Safe to call multiple times — if already warming for the same channel
 * we return the existing promise; otherwise we drop the old warm and
 * start fresh.
 */
export async function prewarmAgora({ channelName, isVideo, role = 'publisher' }) {
  if (!channelName) return null;

  // Same channel already warming or warmed — reuse.
  if (warmCache && warmCache.channelName === channelName && warmCache.role === role && warmCache.isVideo === isVideo) {
    return warmCache;
  }

  // Different channel/role/video config — drop the stale warm.
  disposeWarmAgora();

  // We populate warmCache early with a placeholder so a second
  // prewarmAgora call for the same channel finds it and short-circuits
  // instead of racing us.
  const cache = {
    channelName,
    isVideo,
    role,
    engine:   null,
    appId:    null,
    uid:      null,
    token:    null,
    joined:   false,
    error:    null,
  };
  warmCache = cache;

  try {
    const isPublisher = role === 'publisher';

    // 1. Token + appId
    const creds = await fetchAgoraToken(channelName, role);
    if (warmCache !== cache) return null; // disposed mid-warm
    if (!creds) { cache.error = 'no_token'; return cache; }
    cache.appId = creds.appId;
    cache.uid   = creds.uid;
    cache.token = creds.token;

    // 2. Create + init engine
    const engine = createAgoraRtcEngine();
    engine.initialize({
      appId: creds.appId,
      channelProfile: ChannelProfileType.ChannelProfileLiveBroadcasting,
    });
    cache.engine = engine;

    // 3. Minimal handler — we only need to mark `joined` here so the
    //    hook can adopt the up-to-date state. The hook re-registers the
    //    full handler set the moment it adopts.
    engine.registerEventHandler({
      onJoinChannelSuccess: () => { cache.joined = true; },
      onError: () => { /* suppressed during warm */ },
    });

    // 4. Video / audio plumbing
    if (isVideo) {
      engine.enableVideo();
      if (isPublisher) {
        try {
          engine.setVideoEncoderConfiguration({
            dimensions: { width: 540, height: 960 },
            frameRate: 24,
            bitrate: 900,
            orientationMode: OrientationMode.OrientationModeAdaptive,
            degradationPreference: DegradationPreference.MaintainBalanced,
            mirrorMode: 0,
          });
        } catch (_) {}
        try { engine.startPreview(); } catch (_) {}
      }
    } else {
      engine.disableVideo();
      engine.enableAudio();
    }

    // 5. Role + join
    engine.setClientRole(
      isPublisher ? ClientRoleType.ClientRoleBroadcaster : ClientRoleType.ClientRoleAudience
    );
    engine.joinChannel(creds.token, channelName, creds.uid, {
      channelProfile: ChannelProfileType.ChannelProfileLiveBroadcasting,
      clientRoleType: isPublisher
        ? ClientRoleType.ClientRoleBroadcaster
        : ClientRoleType.ClientRoleAudience,
      publishMicrophoneTrack: isPublisher,
      publishCameraTrack: isPublisher && isVideo,
      autoSubscribeAudio: true,
      autoSubscribeVideo: isVideo,
    });

    return cache;
  } catch (err) {
    if (__DEV__) console.warn('[prewarmAgora] failed:', err?.message);
    cache.error = err?.message || 'prewarm_failed';
    return cache;
  }
}

/**
 * Adopt the warm engine — pulls it out of the cache so nobody else
 * can take it. Returns null if there's no compatible warm engine.
 */
export function consumeWarmAgora(channelName, isVideo) {
  if (!warmCache) return null;
  if (warmCache.channelName !== channelName || warmCache.isVideo !== isVideo) {
    return null;
  }
  if (!warmCache.engine) return null; // warm failed before engine was created
  const adopted = warmCache;
  warmCache = null;
  return adopted;
}

/**
 * Release the warm engine without adopting it. Called when the user
 * cancels the countdown / backs out before reaching the broadcast
 * room — otherwise the channel stays joined and uses bandwidth.
 */
export function disposeWarmAgora() {
  if (!warmCache) return;
  const { engine } = warmCache;
  if (engine) {
    try { engine.leaveChannel(); } catch (_) {}
    try { engine.unregisterEventHandler?.(); } catch (_) {}
    try { engine.release(); } catch (_) {}
  }
  warmCache = null;
}
