import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, KeyboardAvoidingView, Platform, Dimensions, Image, Share, Animated, Easing } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { useGlobalState } from '../../../src/context/GlobalStateContext';
import { showCuteAlert } from '../../../src/components/CuteAlert';
import { prewarmAgora, disposeWarmAgora } from '../../../src/api/agoraPrewarm';
import { BRAND } from '../../../src/theme/brand';

const { width, height } = Dimensions.get('window');

export default function LiveSetupScreen() {
  const router = useRouter();
  const { user, startLiveStream } = useGlobalState();
  const [title, setTitle] = useState('');
  const [activeTag, setActiveTag] = useState('Chat');
  const [broadcastType, setBroadcastType] = useState('Video Live');
  // Holds the live_streams row id once it's been pre-created during the
  // countdown. Saves a 200-400ms RPC roundtrip on the broadcast room
  // side — by the time we navigate, the row already exists and the
  // host's "Going live" spinner has one less round-trip to wait on.
  const prewarmedStreamIdRef = useRef(null);
  
  // Camera & Mic Permissions
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [microphonePermission, requestMicrophonePermission] = useMicrophonePermissions();

  // Request all permissions on mount
  useEffect(() => {
    (async () => {
        if (!cameraPermission || !cameraPermission.granted) {
            await requestCameraPermission();
        }
        if (!microphonePermission || !microphonePermission.granted) {
            await requestMicrophonePermission();
        }
    })();
  }, []);
  
  // Countdown States — premium multi-layer animation system.
  //   countdownAnim — drives the per-tick number bounce (scale + opacity)
  //   ring1/2/3    — staggered radar-pulse rings expanding outward
  //   liveFlashAnim — the brief "LIVE!" flash at the end before routing
  // All animations use the native driver so the JS thread stays free to
  // handle the router transition without a frame hitch.
  const [countdown, setCountdown] = useState(null);
  const countdownAnim = useRef(new Animated.Value(0)).current;
  const ring1Anim     = useRef(new Animated.Value(0)).current;
  const ring2Anim     = useRef(new Animated.Value(0)).current;
  const ring3Anim     = useRef(new Animated.Value(0)).current;
  const liveFlashAnim = useRef(new Animated.Value(0)).current;

  const tags = ['Chat', 'Music', 'Gaming', 'Dance'];
  const broadcastTypes = ['Video Live', 'Audio Live'];

  // Radar-ring pulse loop. Runs the whole time the countdown is on
  // screen (3 → 2 → 1 → 0) so the rings feel like a continuous
  // breathing effect rather than restarting on each tick.
  useEffect(() => {
    if (countdown === null) return undefined;
    // Reset to start state before kicking off.
    ring1Anim.setValue(0);
    ring2Anim.setValue(0);
    ring3Anim.setValue(0);
    const makeRing = (anim, delay) => Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(anim, {
          toValue: 1, duration: 1600,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(anim, {
          toValue: 0, duration: 0, useNativeDriver: true,
        }),
      ])
    );
    const loops = Animated.parallel([
      makeRing(ring1Anim, 0),
      makeRing(ring2Anim, 500),
      makeRing(ring3Anim, 1000),
    ]);
    loops.start();
    return () => { loops.stop(); };
  }, [countdown !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-warm the live_streams DB row AND the Agora engine in parallel
  // with the countdown. Both fire once at countdown=3 and run in the
  // background; the broadcast room adopts both when it mounts.
  //
  //   - live_streams row     ~200-400ms saved
  //   - Agora token + join   ~1000-1500ms saved
  //
  // Combined, the "Going live" spinner that used to follow the
  // countdown now flashes for ~100ms (or skips entirely).
  useEffect(() => {
    if (countdown !== 3 || !user?.id || prewarmedStreamIdRef.current) return;
    (async () => {
      try {
        const newId = await startLiveStream(
          broadcastType === 'Audio Live' ? 'audio' : 'video',
          (title || '').trim() || 'New Live',
          activeTag || 'Chat',
          user?.avatar || null,
        );
        prewarmedStreamIdRef.current = newId || null;
      } catch (_) {
        // Pre-warm is best-effort. If it fails, broadcast/[id] will
        // just create the row itself on mount as before.
      }
    })();
    // Fire-and-forget Agora warm — channelName equals the user's id
    // because that's what broadcast/[id] passes to useAgoraEngine.
    prewarmAgora({
      channelName: String(user.id),
      isVideo:     broadcastType !== 'Audio Live',
      role:        'publisher',
    }).catch(() => { /* best effort */ });
  }, [countdown, user?.id, broadcastType, title, activeTag, startLiveStream]);

  // Safety: if this screen unmounts (user navigates away) before the
  // broadcast room ever adopts the warm engine, release it — otherwise
  // the channel stays joined in the background using bandwidth + battery.
  useEffect(() => {
    return () => {
      if (prewarmedStreamIdRef.current === null && countdown === null) {
        // No live in flight, nothing to clean up.
        return;
      }
      // Always safe to call — no-op if there's no warm engine.
      disposeWarmAgora();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (countdown !== null && countdown > 0) {
      // Per-tick number animation. Three phases:
      //   • Pop in:   scale 0.4 → 1.05 (overshoot), opacity 0 → 1, 250ms
      //   • Hold:     stays full size for 500ms so the digit reads cleanly
      //   • Fade out: scale 1.05 → 1.35 (grows into a "puff"), opacity → 0
      countdownAnim.setValue(0);
      Animated.sequence([
        Animated.spring(countdownAnim, {
          toValue: 1, friction: 5, tension: 140, useNativeDriver: true,
        }),
        Animated.delay(500),
        Animated.timing(countdownAnim, {
          toValue: 2, duration: 250,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();

      const timer = setTimeout(() => {
        setCountdown(prev => prev - 1);
      }, 1000);
      return () => clearTimeout(timer);
    } else if (countdown === 0) {
        if (!user?.id) {
          showCuteAlert('Error', 'User not loaded yet. Please try again.');
          setCountdown(null);
          return;
        }
        // Fire the LIVE! flash AND the router push in parallel. The
        // flash plays on this screen during the ~300ms fullScreenModal
        // slide-up. Meanwhile, broadcast/[id] mounts and starts warming
        // Agora in the background — so by the time the modal fully
        // covers this screen, the host is already publishing instead
        // of staring at a "Going live" spinner.
        liveFlashAnim.setValue(0);
        Animated.sequence([
          Animated.spring(liveFlashAnim, {
            toValue: 1, friction: 4, tension: 150, useNativeDriver: true,
          }),
          Animated.delay(400),
          Animated.timing(liveFlashAnim, {
            toValue: 0, duration: 220,
            easing: Easing.in(Easing.cubic),
            useNativeDriver: true,
          }),
        ]).start();
        router.push({
          pathname: `/broadcast/${user.id}`,
          params: {
            mode: 'host',
            type: broadcastType === 'Audio Live' ? 'audio' : 'video',
            title: title.trim(),
            tag: activeTag,
            // Hand off the pre-warmed live_streams row id (if it
            // resolved in time). broadcast/[id] uses this instead of
            // calling start_live_stream itself, shaving another
            // ~200-400ms off the host's perceived cold start.
            ...(prewarmedStreamIdRef.current
              ? { streamId: String(prewarmedStreamIdRef.current) }
              : {}),
          },
        });
        // Reset countdown state for next time. Cleared after the navigation
        // dispatch so the overlay doesn't blink off before the modal slide
        // begins.
        setCountdown(null);
        prewarmedStreamIdRef.current = null;
    }
  }, [countdown]);

  const handleStartLive = async () => {
     // Check if permissions are granted before starting
     if (broadcastType !== 'Audio Live') {
       if (!cameraPermission?.granted || !microphonePermission?.granted) {
          showCuteAlert("Permissions Required", "Please allow camera and microphone access to start video live.");
          return;
       }
     } else {
       if (!microphonePermission?.granted) {
          showCuteAlert("Permission Required", "Please allow microphone access to start audio live.");
          return;
       }
     }
    setCountdown(3);
  };

  // Camera flip on this preview screen isn't meaningful (the actual camera
  // mounts inside the broadcast screen). Keep the button visible only when
  // we have something useful to do later.

  // 3. Close Warning Logic
  const handleClose = () => {
    showCuteAlert(
      "Warning",
      "Do you want to close?",
      [
        { text: "No", style: "cancel" },
        { text: "Yes", onPress: () => router.push('/main/(tabs)/') }
      ]
    );
  };

  // Cover image is locked to user's avatar — guide them to Edit Profile to change it
  const handleCoverPress = () => {
    showCuteAlert(
      "Cover Image",
      "Your live cover is your profile picture. Update it from Edit Profile.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Edit Profile", onPress: () => router.push('/main/edit-profile') },
      ]
    );
  };

  // 5. Share Logic
  const handleShare = async () => {
    try {
      await Share.share({
        message: `Join my awesome ${broadcastType} on Yolo-Live! Download the app now.`,
      });
    } catch (error) {
      showCuteAlert("Error", error.message);
    }
  };

  
  const renderCountdown = () => {
    if (countdown === null) return null;

    // Per-number tier palette + label. Reads as a building-anticipation
    // arc: cool cyan → warm amber → energetic pink → final victory glow.
    const STEPS = {
      3: { colors: ['#22D3EE', '#0EA5E9'], glow: '#22D3EE', label: 'Get ready'   },
      2: { colors: ['#FB923C', '#F59E0B'], glow: '#FB923C', label: 'Almost there'},
      1: { colors: [BRAND.primary, BRAND.primaryAlt], glow: BRAND.primary, label: 'Going live'  },
      0: { colors: ['#4ADE80', '#22D3EE'], glow: '#4ADE80', label: 'LIVE!'       },
    };
    const step = STEPS[countdown] || STEPS[1];

    // Number transform — countdownAnim drives a 3-phase animation:
    //   0 → 1: pop in   (scale 0.4 → 1.0, opacity 0 → 1)
    //   1 → 2: fade out (scale 1.0 → 1.35, opacity 1 → 0)
    const numberScale = countdownAnim.interpolate({
      inputRange:  [0, 1, 2],
      outputRange: [0.4, 1.0, 1.35],
    });
    const numberOpacity = countdownAnim.interpolate({
      inputRange:  [0, 1, 2],
      outputRange: [0, 1, 0],
    });
    // Slight tilt for cinematic feel.
    const numberRotate = countdownAnim.interpolate({
      inputRange:  [0, 1, 2],
      outputRange: ['-15deg', '0deg', '15deg'],
    });

    // Ring transforms — each ring grows from 0.6 to 2.4 while fading
    // out, creating a radar pulse.
    const makeRingStyle = (anim) => ({
      opacity: anim.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 0.55, 0] }),
      transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 2.4] }) }],
    });

    // Final "LIVE!" overlay shown briefly after 0 hits.
    const flashScale = liveFlashAnim.interpolate({
      inputRange: [0, 1], outputRange: [0.6, 1.0],
    });
    const showLiveFlash = countdown === 0;

    return (
      <View style={styles.countdownOverlay} pointerEvents="none">
        {/* Soft vignette gradient behind everything. Layered over the
            backdrop colour so the splash is dramatic but not flat. */}
        <LinearGradient
          colors={['rgba(10,5,30,0.55)', 'rgba(10,5,30,0.92)']}
          start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFillObject}
        />

        {/* Radar pulse rings — borderColor inherits the step's accent
            so the rings shift hue per countdown tick along with the
            central number. */}
        <View style={styles.ringStage} pointerEvents="none">
          <Animated.View style={[styles.pulseRing, { borderColor: step.glow }, makeRingStyle(ring1Anim)]} />
          <Animated.View style={[styles.pulseRing, { borderColor: step.glow }, makeRingStyle(ring2Anim)]} />
          <Animated.View style={[styles.pulseRing, { borderColor: step.glow }, makeRingStyle(ring3Anim)]} />
        </View>

        {/* Central digit. Shown only while the number is 1–3; on 0 we
            swap to the LIVE! flash card below. */}
        {!showLiveFlash && (
          <Animated.View
            style={[
              styles.countdownCircleNew,
              { shadowColor: step.glow },
              {
                transform: [{ scale: numberScale }, { rotate: numberRotate }],
                opacity: numberOpacity,
              },
            ]}
          >
            <LinearGradient
              colors={step.colors}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              style={styles.circleGradientNew}
            >
              <Text style={styles.countdownValueNew}>{countdown}</Text>
            </LinearGradient>
          </Animated.View>
        )}

        {/* LIVE! finale — a pill that snaps in for ~600ms before the
            router push to the broadcast room. Different shape from the
            count digits so the user feels the transition. */}
        {showLiveFlash && (
          <Animated.View
            style={[
              styles.livePillWrap,
              { shadowColor: step.glow },
              { transform: [{ scale: flashScale }], opacity: liveFlashAnim },
            ]}
          >
            <LinearGradient
              colors={step.colors}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              style={styles.livePill}
            >
              <View style={styles.liveDotInner} />
              <Text style={styles.livePillText}>LIVE</Text>
            </LinearGradient>
          </Animated.View>
        )}

        {/* Dynamic label — fades in/out with the number so it reads as
            one cohesive moment. */}
        {!showLiveFlash && (
          <Animated.Text style={[styles.prepareTextNew, { opacity: numberOpacity }]}>
            {step.label}
          </Animated.Text>
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {renderCountdown()}
      <LinearGradient
        colors={[BRAND.splashBg, '#2A1B45', BRAND.splashBg]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFillObject}
      />
      {/* Soft pink glow blob behind the avatar — purely decorative */}
      <View pointerEvents="none" style={styles.glowBlob} />

      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        {/* Top: just a close button on the right */}
        <View style={styles.headerMini}>
          <TouchableOpacity style={styles.closeBtn} onPress={handleClose}>
            <Ionicons name="close" size={22} color="#FFFFFF" />
          </TouchableOpacity>
        </View>

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1, justifyContent: 'space-between' }}
        >
          {/* Centre stack — avatar + title + tags */}
          <View style={styles.centerStack}>
            <TouchableOpacity activeOpacity={0.85} onPress={handleCoverPress} style={styles.avatarRing}>
              <Image
                source={{ uri: user?.avatar || 'https://picsum.photos/seed/yolo/200/200' }}
                style={styles.avatarImg}
              />
              <View style={styles.avatarEditPill}>
                <Ionicons name="pencil" size={11} color="#FFF" />
              </View>
            </TouchableOpacity>

            <TextInput
              style={styles.titleInputNew}
              placeholder="Add a title…"
              placeholderTextColor="rgba(255,255,255,0.35)"
              maxLength={25}
              value={title}
              onChangeText={setTitle}
            />
            <View style={styles.titleUnderline} />

            <View style={styles.tagsRow}>
              {tags.map((tag) => {
                const active = activeTag === tag;
                return (
                  <TouchableOpacity
                    key={tag}
                    style={[styles.tagPill, active && styles.tagPillActive]}
                    onPress={() => setActiveTag(tag)}
                  >
                    <Text style={[styles.tagPillText, active && styles.tagPillTextActive]}>
                      {tag}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Bottom: mode toggle, share, big button */}
          <View style={styles.bottomStack}>
            {/* Segmented mode toggle */}
            <View style={styles.segWrap}>
              {broadcastTypes.map((type) => {
                const active = broadcastType === type;
                return (
                  <TouchableOpacity
                    key={type}
                    style={[styles.segBtn, active && styles.segBtnActive]}
                    activeOpacity={0.85}
                    onPress={() => setBroadcastType(type)}
                  >
                    <Ionicons
                      name={type === 'Audio Live' ? 'mic' : 'videocam'}
                      size={14}
                      color={active ? '#FFF' : 'rgba(255,255,255,0.6)'}
                    />
                    <Text style={[styles.segText, active && styles.segTextActive]}>
                      {type === 'Audio Live' ? 'Audio' : 'Video'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Share row — minimal */}
            <View style={styles.shareRowNew}>
              <Text style={styles.shareLabel}>Share</Text>
              <TouchableOpacity style={styles.shareIcon} onPress={() => handleShare('Facebook')}>
                <Ionicons name="logo-facebook" size={16} color="#1877F2" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.shareIcon} onPress={() => handleShare('WhatsApp')}>
                <Ionicons name="logo-whatsapp" size={16} color="#25D366" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.shareIcon} onPress={() => handleShare('Twitter')}>
                <Ionicons name="logo-twitter" size={16} color="#1DA1F2" />
              </TouchableOpacity>
            </View>

            {/* Go Live */}
            <TouchableOpacity
              activeOpacity={0.9}
              style={styles.goLiveWrapperNew}
              onPress={handleStartLive}
              disabled={countdown !== null}
            >
              <LinearGradient
                colors={broadcastType === 'Audio Live' ? ['#A855F7', '#6B4EFF'] : [BRAND.primary, BRAND.primaryAlt]}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                style={styles.goLiveBtnNew}
              >
                <Ionicons name="radio" size={16} color="#FFF" />
                <Text style={styles.goLiveTextNew}>
                  Go live
                </Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  /* ── Minimal redesign ───────────────────────────────────────────── */
  glowBlob: {
    position: 'absolute',
    top: height * 0.12,
    left: width / 2 - 130,
    width: 260, height: 260,
    borderRadius: 130,
    backgroundColor: `${BRAND.primary}2E`,
  },
  headerMini: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingTop: 6,
  },
  closeBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.10)',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  centerStack: {
    alignItems: 'center',
    paddingHorizontal: 28,
    marginTop: 12,
  },
  avatarRing: {
    width: 112, height: 112, borderRadius: 56,
    borderWidth: 2, borderColor: BRAND.primary,
    padding: 4,
    backgroundColor: 'rgba(0,0,0,0.25)',
    shadowColor: BRAND.primary, shadowOpacity: 0.5,
    shadowRadius: 18, shadowOffset: { width: 0, height: 0 },
    elevation: 12,
    marginBottom: 22,
  },
  avatarImg: { width: '100%', height: '100%', borderRadius: 50 },
  avatarEditPill: {
    position: 'absolute', bottom: 0, right: 0,
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: BRAND.primary,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: BRAND.splashBg,
  },
  titleInputNew: {
    color: '#FFF',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    paddingVertical: 6,
    minWidth: 200,
  },
  titleUnderline: {
    width: 80, height: 1.5, borderRadius: 1,
    backgroundColor: 'rgba(255,255,255,0.15)',
    marginBottom: 22,
  },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
  },
  tagPill: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
  },
  tagPillActive: {
    backgroundColor: `${BRAND.primary}2E`,
    borderColor: BRAND.primary,
  },
  tagPillText: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 12, fontWeight: '600',
  },
  tagPillTextActive: { color: BRAND.primary },
  bottomStack: {
    paddingHorizontal: 24,
    // Tab bar is absolutely-positioned (height 64 + ~16 bottom offset). The
    // SafeAreaView already covers the system inset, so we just need to add
    // the tab-bar height on top so the Go-Live button sits clearly above it.
    paddingBottom: Platform.OS === 'ios' ? 110 : 96,
    gap: 16,
  },
  segWrap: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 22,
    padding: 4,
    alignSelf: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  segBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 18, paddingVertical: 7,
    borderRadius: 18,
  },
  segBtnActive: { backgroundColor: `${BRAND.primary}2E` },
  segText: { color: 'rgba(255,255,255,0.6)', fontWeight: '600', fontSize: 12 },
  segTextActive: { color: '#FFF' },
  shareRowNew: {
    flexDirection: 'row',
    alignSelf: 'center',
    alignItems: 'center',
    gap: 10,
  },
  shareLabel: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 11, fontWeight: '600',
    marginRight: 4,
  },
  shareIcon: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.08)',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
  },
  goLiveWrapperNew: {
    height: 52,
    borderRadius: 26,
    shadowColor: BRAND.primary, shadowOpacity: 0.45,
    shadowRadius: 16, shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  goLiveBtnNew: {
    height: '100%',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8,
    borderRadius: 26,
  },
  goLiveTextNew: {
    color: '#FFF', fontSize: 16, fontWeight: '700', letterSpacing: 0.3,
  },

  /* ── Legacy styles kept for back-compat ─────────────────────────── */
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  cameraBackground: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  topGradient: {
    position: 'absolute',
    top: 0,
    width: '100%',
    height: 150,
  },
  bottomGradient: {
    position: 'absolute',
    bottom: 0,
    width: '100%',
    height: 400,
  },
  safeArea: {
    flex: 1,
    justifyContent: 'space-between',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  rightIcons: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  iconButton: {
    alignItems: 'center',
    width: 44,
  },
  iconText: {
    color: '#FFFFFF',
    fontSize: 10,
    marginTop: 4,
    fontWeight: '600',
  },
  bottomSection: {
    width: '100%',
  },
  typeSelectorContainer: {
    marginBottom: 20,
  },
  typeScroll: {
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  typeBtn: {
    marginRight: 24,
    alignItems: 'center',
  },
  typeText: {
    color: '#9CA3AF',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 6,
  },
  activeTypeText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: 'bold',
  },
  activeTypeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: BRAND.primary,
  },
  setupContainer: {
    paddingHorizontal: 16,
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
  },
  titleBox: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 16,
    padding: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  coverImagePlaceholder: {
    width: 60,
    height: 60,
    borderRadius: 8,
    marginRight: 12,
  },
  lockedBadge: {
    position: 'absolute',
    bottom: 4,
    right: 16,
    backgroundColor: 'rgba(0,0,0,0.6)',
    padding: 4,
    borderRadius: 10,
  },
  titleInput: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 16,
    textAlignVertical: 'top',
  },
  tagsContainer: {
    flexDirection: 'row',
    marginBottom: 24,
    flexWrap: 'wrap',
  },
  tagBadge: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    marginRight: 8,
    marginBottom: 8,
  },
  activeTagBadge: {
    backgroundColor: BRAND.primary,
  },
  tagText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 13,
  },
  activeTagText: {
    color: '#FFFFFF',
  },
  shareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 24,
  },
  shareTitle: {
    color: '#E5E7EB',
    fontSize: 14,
    fontWeight: '500',
  },
  socialIconsRow: {
    flexDirection: 'row',
  },
  socialCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 12,
  },
  goLiveWrapper: {
    width: '100%',
    height: 56,
    borderRadius: 28,
    shadowColor: BRAND.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 10,
    marginBottom: Platform.OS === 'ios' ? 90 : 80,
  },
  goLiveButton: {
    width: '100%',
    height: '100%',
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
  },
  goLiveText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 1,
  },
  /* Countdown Styles */
  countdownOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(10,5,30,0.78)',
    zIndex: 1000,
    justifyContent: 'center',
    alignItems: 'center',
  },
  countdownAura: {
    position: 'absolute',
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: `${BRAND.primary}2E`,
    transform: [{ scale: 1.1 }],
  },
  countdownCircle: {
    width: 90,
    height: 90,
    borderRadius: 45,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
    shadowColor: BRAND.primary,
    shadowOpacity: 0.6,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
  circleGradient: {
    width: '100%',
    height: '100%',
    borderRadius: 45,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  countdownValue: {
    color: '#FFFFFF',
    fontSize: 44,
    fontWeight: '800',
    textShadowColor: 'rgba(0,0,0,0.3)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  prepareText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1.2,
    marginTop: 4,
  },

  /* ── Premium countdown — new styles ─────────────────────────────
     Multi-ring radar pulse + larger central digit + per-tier glow +
     final "LIVE!" pill. Sized for portrait phones; clamped responsive
     so tablets don't get a comically huge number. */
  ringStage: {
    position: 'absolute',
    width: 220,
    height: 220,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseRing: {
    position: 'absolute',
    width: 90,
    height: 90,
    borderRadius: 45,
    borderWidth: 2,
  },
  countdownCircleNew: {
    width: 120,
    height: 120,
    borderRadius: 60,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 32,
    shadowOpacity: 0.7,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 0 },
    elevation: 18,
  },
  circleGradientNew: {
    width: '100%',
    height: '100%',
    borderRadius: 60,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  countdownValueNew: {
    color: '#FFFFFF',
    fontSize: 64,
    fontWeight: '900',
    letterSpacing: -2,
    textShadowColor: 'rgba(0,0,0,0.35)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
    // Slight nudge up so the optical centre of the glyph aligns with
    // the geometric centre of the circle.
    marginTop: -4,
  },
  prepareTextNew: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 2.4,
    textTransform: 'uppercase',
    marginTop: 12,
    opacity: 0.85,
  },
  livePillWrap: {
    shadowOpacity: 0.8,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 0 },
    elevation: 20,
  },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 30,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.45)',
  },
  liveDotInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#FFF',
    marginRight: 12,
    shadowColor: '#FFF',
    shadowOpacity: 0.9,
    shadowRadius: 6,
  },
  livePillText: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 4,
  },
});
