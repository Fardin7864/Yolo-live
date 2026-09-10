import { useEffect, useRef, useState, useCallback } from 'react';
import { AppState } from 'react-native';
import {
  createAgoraRtcEngine,
  ChannelProfileType,
  ClientRoleType,
  OrientationMode,
  DegradationPreference,
} from 'react-native-agora';
import { fetchAgoraToken } from '../api/agora';
import { consumeWarmAgora } from '../api/agoraPrewarm';

// Codes the Agora SDK fires as part of normal lifecycle: audio device
// route changes, OS focus changes (phone call interrupts, notification
// sounds, another app grabbing audio), volume button presses, etc.
// They're warnings only — the engine self-recovers within a few hundred
// ms. We silence them in production so they don't flood the log bridge
// and stutter low-end Androids; dev still sees them at info level for
// diagnostics.
//
//   1033 / 1034 — ADM runtime recording / playout warning
//   1051        — Audio device run-time error (most are transient)
//   1052        — Audio device warning
//   1053        — ADM playout malfunction (auto recovers)
const TRANSIENT_AGORA_CODES = new Set([1033, 1034, 1051, 1052, 1053]);

function handleAgoraError(err, msg) {
  if (TRANSIENT_AGORA_CODES.has(err)) {
    if (__DEV__) console.log('[Agora] transient:', err, msg);
    return;
  }
  console.warn('Agora error:', err, msg);
}

/**
 * Wraps the Agora RTC engine for a live-stream room.
 *
 * Roles:
 *   - host / guest  -> 'publisher'  (sends camera+mic)
 *   - viewer        -> 'subscriber' (receive only)
 *
 * IMPORTANT: the engine is created exactly ONCE per channel and is NOT torn
 * down when the role changes (viewer -> guest). Recreating it would orphan
 * the <RtcSurfaceView> components that are already bound to it, which is why
 * a promoted guest couldn't see their own local preview. Instead, role
 * changes are applied live via setClientRole + renewToken.
 */
export function useAgoraEngine({ channelName, role, isVideo, enabled = true }) {
  const engineRef = useRef(null);
  const [joined, setJoined] = useState(false);
  const [localUid, setLocalUid] = useState(0);
  const [remoteUids, setRemoteUids] = useState([]); // numbers
  const [videoOffUids, setVideoOffUids] = useState([]); // remote uids with camera off
  const [speakingUids, setSpeakingUids] = useState([]); // remote uids currently talking
  const [localSpeaking, setLocalSpeaking] = useState(false); // am I talking
  const [appId, setAppId] = useState(null);
  const [error, setError] = useState(null);

  // Latest role kept in a ref so the live-switch effect can read it without
  // forcing the init effect to re-run (which would recreate the engine).
  const roleRef = useRef(role);
  roleRef.current = role;

  // Desired mute state, kept in a ref so we can re-apply it after the
  // Agora SDK silently resets `muteLocalAudioStream`. This happens after
  // transient ADM errors (codes 1051/1052/1053 — incoming phone call,
  // Bluetooth route swap, OS audio focus loss). The SDK auto-recovers
  // the audio device but forgets the publish-side mute, so a host who
  // had self-muted suddenly goes live. The handlers below watch for
  // those recovery events and re-apply the user's intent.
  const desiredMuteRef = useRef(false);
  const tokenRenewalRef = useRef(null);

  const renewAgoraToken = useCallback(async () => {
    if (tokenRenewalRef.current) return tokenRenewalRef.current;
    tokenRenewalRef.current = (async () => {
      try {
        const creds = await fetchAgoraToken(channelName, roleRef.current);
        if (!creds?.token) throw new Error('Token service returned no token');
        engineRef.current?.renewToken(creds.token);
        setError(null);
        return true;
      } catch (e) {
        if (__DEV__) console.warn('Agora token renewal failed:', e?.message);
        setError('Live connection needs to reconnect');
        return false;
      } finally {
        tokenRenewalRef.current = null;
      }
    })();
    return tokenRenewalRef.current;
  }, [channelName]);

  const restoreMediaAfterReconnect = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const publish = roleRef.current === 'publisher';
    try {
      engine.setClientRole(publish
        ? ClientRoleType.ClientRoleBroadcaster
        : ClientRoleType.ClientRoleAudience);
      engine.updateChannelMediaOptions({
        publishMicrophoneTrack: publish,
        publishCameraTrack: publish && isVideo,
        autoSubscribeAudio: true,
        autoSubscribeVideo: isVideo,
      });
      engine.muteLocalAudioStream(desiredMuteRef.current);
    } catch (_) {}
  }, [isVideo]);

  // Every restart of the local video pipeline drops engine-side video
  // post-processing (Agora's beauty effect among it). Callers cannot see those
  // restarts, so publish a counter they can depend on to re-apply their effects.
  // Bumped on: publisher role switch, camera re-enable, camera flip, initial
  // preview, and app foreground.
  const [videoEpoch, setVideoEpoch] = useState(0);
  const bumpVideoEpoch = useCallback(() => setVideoEpoch((n) => n + 1), []);

  // --- Apply a role to the live engine (no rejoin) ---
  const applyRole = useCallback(async (nextRole) => {
    const engine = engineRef.current;
    if (!engine) return;
    const publish = nextRole === 'publisher';
    try {
      // Becoming a publisher needs a token with publish privilege — fetch a
      // fresh one and renew, then switch role + start sending media.
      if (publish) {
        const creds = await fetchAgoraToken(channelName, 'publisher');
        if (creds?.token) {
          try { engine.renewToken(creds.token); } catch (_) {}
        }
        engine.setClientRole(ClientRoleType.ClientRoleBroadcaster);
        if (isVideo) {
          try { engine.muteAllRemoteVideoStreams(false); } catch (_) {}
          engine.enableLocalVideo(true);
          engine.muteLocalVideoStream(false);
          engine.startPreview();
          bumpVideoEpoch();
        }
        engine.updateChannelMediaOptions({
          publishMicrophoneTrack: true,
          publishCameraTrack: isVideo,
          autoSubscribeAudio: true,
          autoSubscribeVideo: isVideo,
        });
      } else {
        engine.setClientRole(ClientRoleType.ClientRoleAudience);
        if (isVideo) {
          try { engine.muteAllRemoteVideoStreams(false); } catch (_) {}
          try { engine.stopPreview(); } catch (_) {}
        }
        engine.updateChannelMediaOptions({
          publishMicrophoneTrack: false,
          publishCameraTrack: false,
          autoSubscribeAudio: true,
          autoSubscribeVideo: isVideo,
        });
      }
    } catch (e) {
      if (__DEV__) console.warn('Agora role switch failed:', e?.message);
    }
  }, [channelName, isVideo]);

  // --- Initialise + join ONCE (engine lives for the whole session) ---
  useEffect(() => {
    if (!enabled || !channelName) return;
    let cancelled = false;

    // Fast path: live.js pre-warmed an engine for this channel during
    // the countdown. Adopt it instead of going through token fetch +
    // create + init + join again — that whole chain is what the
    // "Going live" spinner used to wait on.
    const adopted = consumeWarmAgora(channelName, isVideo);
    if (adopted && adopted.engine) {
      const engine = adopted.engine;
      engineRef.current = engine;
      setAppId(adopted.appId);
      setLocalUid(adopted.uid);
      // Replace the minimal warm handler with the full hook handler
      // set below — easiest to do that by unregistering first, then
      // letting the regular registerEventHandler call below run.
      try { engine.unregisterEventHandler?.(); } catch (_) {}
      // Register the full handler set inline (same as the cold path
      // below). We do this synchronously so onUserJoined etc. are live
      // before any remote user join event can be missed.
      engine.registerEventHandler({
        onJoinChannelSuccess: () => {
          if (!cancelled) { setJoined(true); setLocalUid(adopted.uid); setError(null); }
        },
        onTokenPrivilegeWillExpire: renewAgoraToken,
        onRequestToken: renewAgoraToken,
        onRejoinChannelSuccess: () => {
          if (cancelled) return;
          setJoined(true);
          setError(null);
          restoreMediaAfterReconnect();
        },
        onConnectionStateChanged: (_conn, state) => {
          if (cancelled) return;
          if (state === 3) {
            setJoined(true);
            setError(null);
            restoreMediaAfterReconnect();
          } else if (state === 5) {
            setJoined(false);
            setError('Live connection lost');
          }
        },
        onUserJoined: (_conn, uid) => {
          if (!cancelled) setRemoteUids((prev) => prev.includes(uid) ? prev : [...prev, uid]);
        },
        onUserOffline: (_conn, uid) => {
          if (!cancelled) {
            setRemoteUids((prev) => prev.filter((u) => u !== uid));
            setVideoOffUids((prev) => prev.filter((u) => u !== uid));
          }
        },
        onUserMuteVideo: (_conn, uid, muted) => {
          if (cancelled) return;
          setVideoOffUids((prev) => muted
            ? (prev.includes(uid) ? prev : [...prev, uid])
            : prev.filter((u) => u !== uid));
        },
        onRemoteVideoStateChanged: (_conn, uid, state) => {
          if (cancelled) return;
          const off = state === 0 || state === 4;
          setVideoOffUids((prev) => off
            ? (prev.includes(uid) ? prev : [...prev, uid])
            : prev.filter((u) => u !== uid));
        },
        onAudioVolumeIndication: (_conn, speakers) => {
          if (cancelled || !Array.isArray(speakers)) return;
          const THRESH = 5;
          const hasLocal = speakers.some((s) => s.uid === 0);
          if (hasLocal) {
            const me = speakers.find((s) => s.uid === 0);
            setLocalSpeaking((me?.volume || 0) > THRESH);
          } else {
            const talking = speakers.filter((s) => (s.volume || 0) > THRESH).map((s) => s.uid);
            setSpeakingUids((prev) => {
              const same = prev.length === talking.length && prev.every((u) => talking.includes(u));
              return same ? prev : talking;
            });
          }
        },
        // Audio routing change (speaker ↔ headphones ↔ Bluetooth) forces
        // the SDK to re-init the recording device, which silently drops
        // any previously-set muteLocalAudioStream(true). Re-assert the
        // user's intent on the next tick (the SDK rejects calls fired
        // synchronously from inside the routing event on some Androids).
        onAudioRoutingChanged: () => {
          if (cancelled) return;
          setTimeout(() => {
            try { engineRef.current?.muteLocalAudioStream(desiredMuteRef.current); } catch (_) {}
          }, 50);
        },
        // Local audio state machine. State 1 = Recording (mic just
        // started/restarted). If the user wanted the mic muted, the
        // restart will have lost that — re-apply.
        onLocalAudioStateChanged: (_conn, state) => {
          if (cancelled) return;
          if (state === 1 && desiredMuteRef.current) {
            setTimeout(() => {
              try { engineRef.current?.muteLocalAudioStream(true); } catch (_) {}
            }, 50);
          }
        },
        onError: handleAgoraError,
      });
      try { engine.enableAudioVolumeIndication(500, 3, true); } catch (_) {}
      // If onJoinChannelSuccess already fired during the warm, flip
      // the joined flag now so consumers don't have to wait for the
      // next event.
      if (adopted.joined) setJoined(true);

      return () => {
        cancelled = true;
        const eng = engineRef.current;
        if (eng) {
          try { eng.leaveChannel(); } catch (_) {}
          try { eng.unregisterEventHandler?.(); } catch (_) {}
          try { eng.release(); } catch (_) {}
          engineRef.current = null;
        }
        setJoined(false);
        setRemoteUids([]);
        setVideoOffUids([]);
      };
    }

    (async () => {
      try {
        const initialRole = roleRef.current;
        const isPublisher = initialRole === 'publisher';

        // 1. Token + appId
        const creds = await fetchAgoraToken(channelName, initialRole);
        if (!creds) { setError('Could not get streaming token'); return; }
        if (cancelled) return;
        setAppId(creds.appId);

        // 2. Create + init engine
        const engine = createAgoraRtcEngine();
        engineRef.current = engine;
        engine.initialize({
          appId: creds.appId,
          channelProfile: ChannelProfileType.ChannelProfileLiveBroadcasting,
        });

        // 3. Event handlers
        engine.registerEventHandler({
          onJoinChannelSuccess: () => {
            if (!cancelled) { setJoined(true); setLocalUid(creds.uid); setError(null); }
          },
          onTokenPrivilegeWillExpire: renewAgoraToken,
          onRequestToken: renewAgoraToken,
          onRejoinChannelSuccess: () => {
            if (cancelled) return;
            setJoined(true);
            setError(null);
            restoreMediaAfterReconnect();
          },
          onConnectionStateChanged: (_conn, state) => {
            if (cancelled) return;
            if (state === 3) {
              setJoined(true);
              setError(null);
              restoreMediaAfterReconnect();
            } else if (state === 5) {
              setJoined(false);
              setError('Live connection lost');
            }
          },
          onUserJoined: (_conn, uid) => {
            if (!cancelled) setRemoteUids((prev) => prev.includes(uid) ? prev : [...prev, uid]);
          },
          onUserOffline: (_conn, uid) => {
            if (!cancelled) {
              setRemoteUids((prev) => prev.filter((u) => u !== uid));
              setVideoOffUids((prev) => prev.filter((u) => u !== uid));
            }
          },
          onUserMuteVideo: (_conn, uid, muted) => {
            if (cancelled) return;
            setVideoOffUids((prev) => muted
              ? (prev.includes(uid) ? prev : [...prev, uid])
              : prev.filter((u) => u !== uid));
          },
          onRemoteVideoStateChanged: (_conn, uid, state) => {
            if (cancelled) return;
            const off = state === 0 || state === 4; // Stopped / Failed
            setVideoOffUids((prev) => off
              ? (prev.includes(uid) ? prev : [...prev, uid])
              : prev.filter((u) => u !== uid));
          },
          // Real "who is talking" — fires every ~300ms with each speaker's
          // volume (0-255). uid 0 = the local user; others are remote.
          onAudioVolumeIndication: (_conn, speakers) => {
            if (cancelled || !Array.isArray(speakers)) return;
            const THRESH = 5; // anything above ~5 counts as talking
            const hasLocal = speakers.some((s) => s.uid === 0);
            if (hasLocal) {
              const me = speakers.find((s) => s.uid === 0);
              setLocalSpeaking((me?.volume || 0) > THRESH);
            } else {
              const talking = speakers.filter((s) => (s.volume || 0) > THRESH).map((s) => s.uid);
              setSpeakingUids((prev) => {
                const same = prev.length === talking.length && prev.every((u) => talking.includes(u));
                return same ? prev : talking;
              });
            }
          },
          // See warm-path comment — Agora silently drops mute on route
          // change and on local-audio-state restart. Re-apply the user's
          // intent the moment the SDK reports it has finished the swap.
          onAudioRoutingChanged: () => {
            if (cancelled) return;
            setTimeout(() => {
              try { engineRef.current?.muteLocalAudioStream(desiredMuteRef.current); } catch (_) {}
            }, 50);
          },
          onLocalAudioStateChanged: (_conn, state) => {
            if (cancelled) return;
            if (state === 1 && desiredMuteRef.current) {
              setTimeout(() => {
                try { engineRef.current?.muteLocalAudioStream(true); } catch (_) {}
              }, 50);
            }
          },
          onError: handleAgoraError,
        });

        // Report speaking volumes every 500ms (smoothing 3, with VAD).
        // 300ms was firing ~3.3 callbacks per second per room and each one
        // could re-render the seat grid + speaking pulse for every active
        // speaker. Bumping to 500ms cuts CPU/render churn by ~40% with no
        // perceivable lag on the "who is talking" indicator.
        try { engine.enableAudioVolumeIndication(500, 3, true); } catch (_) {}

        // 4. Video / audio setup
        if (isVideo) {
          engine.enableVideo();

          // Explicit encoder config tuned for portrait phone live-streaming.
          //
          // Previous config (480x360 @ 24fps, 600 kbps, MaintainFramerate)
          // was thermally safe but the 4:3 landscape feed looked soft and
          // boxy on a 9:16 phone canvas. The numbers below are the new
          // baseline used by most BD/SEA live-streaming apps — large
          // enough to look crisp on a 6.5" screen, small enough that a
          // Snapdragon 6-series still stays comfortable.
          //
          //   540×960 portrait        — proper 9:16, ~3x the pixel count
          //                             but most viewers full-screen the
          //                             host so the bump is what they see.
          //   24 fps                   — smooth motion, half the encoder
          //                             work of 30 fps.
          //   900 kbps target          — 50% bump for visible clarity.
          //   degradationPreference: MaintainBalanced
          //                            — under thermal/network stress
          //                              shed framerate AND resolution
          //                              evenly instead of just dropping
          //                              resolution (which was making the
          //                              feed muddy when the phone got
          //                              warm).
          //   OrientationModeAdaptive  — auto-rotate if a host streams
          //                              in landscape (rare but possible).
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
            } catch (e) {
              if (__DEV__) console.warn('Agora encoder config failed:', e?.message);
            }
            engine.startPreview();
            bumpVideoEpoch();
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
      } catch (e) {
        if (__DEV__) console.warn('Agora init failed:', e?.message);
        setError(e?.message || 'Agora init failed');
        // If init/join blew up mid-setup we may already hold a half-built
        // engine. Tear it down so the next attempt starts from a clean slate
        // instead of leaking a dead instance into the ref.
        const half = engineRef.current;
        if (half) {
          try { half.leaveChannel(); } catch (_) {}
          try { half.unregisterEventHandler?.(); } catch (_) {}
          try { half.release(); } catch (_) {}
          engineRef.current = null;
        }
      }
    })();

    return () => {
      cancelled = true;
      const engine = engineRef.current;
      if (engine) {
        try { engine.leaveChannel(); } catch (_) {}
        try { engine.unregisterEventHandler?.(); } catch (_) {}
        try { engine.release(); } catch (_) {}
        engineRef.current = null;
      }
      setJoined(false);
      setRemoteUids([]);
      setVideoOffUids([]);
    };
    // Deliberately exclude `role` — role changes are applied live below.
  }, [enabled, channelName, isVideo, renewAgoraToken, restoreMediaAfterReconnect]);

  // --- Apply role changes live (after the initial join) ---
  const lastAppliedRole = useRef(role);
  useEffect(() => {
    if (!joined) return;
    if (lastAppliedRole.current === role) return;
    lastAppliedRole.current = role;
    applyRole(role);
  }, [role, joined, applyRole]);

  // --- Controls ---
  const setMuted = useCallback((muted) => {
    desiredMuteRef.current = !!muted;
    try { engineRef.current?.muteLocalAudioStream(!!muted); } catch (_) {}
  }, []);

  // Re-apply the desired mute state. Called from event handlers that
  // detect the SDK has reset itself (audio routing changes, local audio
  // state going back to Recording after a transient error, etc.).
  const reapplyMute = useCallback(() => {
    try { engineRef.current?.muteLocalAudioStream(desiredMuteRef.current); } catch (_) {}
  }, []);

  const setCameraEnabled = useCallback((on) => {
    try {
      const engine = engineRef.current;
      if (!engine) return;
      engine.enableLocalVideo(on);
      engine.muteLocalVideoStream(!on);
      // Re-enabling the capturer rebuilds the pipeline; effects must be re-applied.
      if (on) bumpVideoEpoch();
      engine.updateChannelMediaOptions({
        publishMicrophoneTrack: true,
        publishCameraTrack: !!on && isVideo,
        autoSubscribeAudio: true,
        autoSubscribeVideo: isVideo,
      });
    } catch (_) {}
  }, [isVideo]);

  const setRemoteVideoPaused = useCallback((paused) => {
    try {
      const engine = engineRef.current;
      if (!engine || !isVideo) return;
      engine.muteAllRemoteVideoStreams(!!paused);
      engine.updateChannelMediaOptions({
        autoSubscribeAudio: true,
        autoSubscribeVideo: !paused,
      });
    } catch (_) {}
  }, [isVideo]);

  // Android tears the camera down when the app is backgrounded and rebuilds it
  // on resume, which also clears video effects. Nothing else observes that, so
  // the epoch has to cover it too.
  useEffect(() => {
    if (!isVideo) return undefined;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') bumpVideoEpoch();
    });
    return () => { try { sub?.remove(); } catch (_) {} };
  }, [isVideo, bumpVideoEpoch]);

  const switchCamera = useCallback(() => {
    // Flipping cameras swaps the capture source and clears engine-side effects.
    try { engineRef.current?.switchCamera(); } catch (_) {}
    bumpVideoEpoch();
  }, [bumpVideoEpoch]);

  // Explicit publish toggle (kept for callers that want to force it)
  const setPublishing = useCallback((publish) => {
    applyRole(publish ? 'publisher' : 'subscriber');
  }, [applyRole]);

  return {
    engine: engineRef,
    appId,
    channelName,
    joined,
    localUid,
    remoteUids,
    videoOffUids,
    speakingUids,
    localSpeaking,
    error,
    setMuted,
    setCameraEnabled,
    setRemoteVideoPaused,
    switchCamera,
    setPublishing,
    videoEpoch,
  };
}
