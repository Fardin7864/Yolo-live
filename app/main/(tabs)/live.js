import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, KeyboardAvoidingView, Platform, Dimensions, Image, ImageBackground, Share, Animated, Easing } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { useGlobalState } from '../../../src/context/GlobalStateContext';
import { showCuteAlert } from '../../../src/components/CuteAlert';
import { prewarmAgora, disposeWarmAgora } from '../../../src/api/agoraPrewarm';
import { BRAND } from '../../../src/theme/brand';
import { supabase } from '../../../src/api/supabase';

const { width, height } = Dimensions.get('window');
const LIVE_BACKGROUND = require('../../../assets/live-setup/background.webp');
const GO_LIVE_BUTTON = require('../../../assets/live-setup/go-live-button.webp');
const CLOSE_BUTTON = require('../../../assets/live-setup/close-button.webp');

export default function LiveSetupScreen() {
  const router = useRouter();
  const { user, ownedAgency, startLiveStream } = useGlobalState();
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
  const tagIcons = {
    Chat: 'chatbubble-ellipses',
    Music: 'musical-notes',
    Gaming: 'game-controller',
    Dance: 'body',
  };
  const broadcastTypes = ['Video Live', 'Audio Live'];

  // Radar-ring pulse loop. Runs the whole time the countdown is on
  // screen (5 → 4 → 3 → 2 → 1) so the rings feel like a continuous
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
  // with the countdown. Both fire once at countdown=5 and run in the
  // background; the broadcast room adopts both when it mounts.
  //
  //   - live_streams row     ~200-400ms saved
  //   - Agora token + join   ~1000-1500ms saved
  //
  // Combined, the "Going live" spinner that used to follow the
  // countdown now flashes for ~100ms (or skips entirely).
  useEffect(() => {
    if (countdown !== 5 || !user?.id || prewarmedStreamIdRef.current) return;
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
    // Fast client-side explanation. The start_live_stream RPC repeats this
    // check authoritatively so old/modified APKs cannot bypass it.
    const normalizedRole = String(user?.role || 'user').trim().toLowerCase();
    const requiresAgencyMembership = normalizedRole === 'user' && !ownedAgency;
    if (requiresAgencyMembership) {
      const { data: membership } = await supabase
        .from('agency_members')
        .select('agency_id, agencies:agency_id(status)')
        .eq('host_id', user?.id)
        .eq('status', 'active')
        .maybeSingle();
      if (!membership || membership.agencies?.status !== 'verified') {
        showCuteAlert(
          'Agency required',
          'You need an approved agency membership before starting audio or video live.',
          [
            { text: 'Not now', style: 'cancel' },
            { text: 'View Agencies', onPress: () => router.push('/main/agency') },
          ],
        );
        return;
      }
    }
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
    setCountdown(5);
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
        message: `Join my awesome ${broadcastType} on Popular Live! Download the app now.`,
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
      5: { colors: ['#7C3AED', '#2563EB'], glow: '#7C3AED', label: 'Setting the stage' },
      4: { colors: ['#A855F7', '#4F46E5'], glow: '#A855F7', label: 'Preparing camera' },
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
        <LinearGradient
          colors={['rgba(7,3,34,0.72)', 'rgba(5,3,35,0.94)']}
          start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFillObject}
        />

        {!showLiveFlash && (
          <View style={styles.countdownCard}>
            <View style={styles.countdownEyebrow}>
              <View style={[styles.countdownLiveDot, { backgroundColor: step.glow }]} />
              <Text style={styles.countdownEyebrowText}>PREPARING YOUR LIVE</Text>
            </View>

            <View style={styles.countdownStage}>
              <View style={styles.ringStage} pointerEvents="none">
                <Animated.View style={[styles.pulseRing, { borderColor: step.glow }, makeRingStyle(ring1Anim)]} />
                <Animated.View style={[styles.pulseRing, { borderColor: step.glow }, makeRingStyle(ring2Anim)]} />
                <Animated.View style={[styles.pulseRing, { borderColor: step.glow }, makeRingStyle(ring3Anim)]} />
              </View>
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
            </View>

            <Animated.Text style={[styles.prepareTextNew, { opacity: numberOpacity }]}>
              {step.label}
            </Animated.Text>
            <Text style={styles.countdownHint}>Camera, microphone and stream are warming up</Text>
            <View style={styles.countdownProgress}>
              {[5, 4, 3, 2, 1].map((value) => (
                <View
                  key={value}
                  style={[
                    styles.countdownProgressDot,
                    value >= countdown && { backgroundColor: step.glow, borderColor: step.glow },
                  ]}
                />
              ))}
            </View>
          </View>
        )}

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
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {renderCountdown()}
      <Image source={LIVE_BACKGROUND} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
      <View pointerEvents="none" style={styles.backgroundShade} />

      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <View style={styles.headerMini}>
          <TouchableOpacity style={styles.closeBtn} onPress={handleClose} activeOpacity={0.8}>
            <Image source={CLOSE_BUTTON} style={styles.closeAsset} resizeMode="contain" />
          </TouchableOpacity>
        </View>

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.liveContent}
        >
          <View style={styles.centerStack}>
            <LinearGradient
              colors={['#FF27EC', '#923CFF', '#20C9FF']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.avatarOuterRing}
            >
              <TouchableOpacity activeOpacity={0.85} onPress={handleCoverPress} style={styles.avatarRing}>
                <Image
                  source={{ uri: user?.avatar || 'https://picsum.photos/seed/yolo/300/300' }}
                  style={styles.avatarImg}
                />
              </TouchableOpacity>
            </LinearGradient>
            <TouchableOpacity style={styles.avatarEditPill} onPress={handleCoverPress}>
              <LinearGradient colors={['#D725EE', '#553CFF']} style={styles.avatarEditGradient}>
                <Ionicons name="pencil" size={17} color="#FFF" />
              </LinearGradient>
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
                    {active ? (
                      <LinearGradient colors={['#9923FF', '#EE17DA']} style={StyleSheet.absoluteFillObject} />
                    ) : null}
                    <Ionicons name={tagIcons[tag]} size={17} color={active ? '#FFF' : '#C8C5E4'} />
                    <Text style={[styles.tagPillText, active && styles.tagPillTextActive]}>
                      {tag}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={styles.bottomStack}>
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
                    {active ? (
                      <LinearGradient
                        colors={['#EB1FDF', '#663CFF', '#169FFF']}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={styles.segActiveGradient}
                      />
                    ) : null}
                    <Ionicons
                      name={type === 'Audio Live' ? 'mic' : 'videocam'}
                      size={22}
                      color={active ? '#FFF' : 'rgba(255,255,255,0.6)'}
                    />
                    <Text style={[styles.segText, active && styles.segTextActive]}>
                      {type === 'Audio Live' ? 'Audio' : 'Video'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.sharePanel}>
              <Text style={styles.shareLabel}>Share</Text>
              <View style={styles.shareIcons}>
                <TouchableOpacity style={[styles.shareIcon, styles.facebookIcon]} onPress={handleShare}>
                  <Ionicons name="logo-facebook" size={25} color="#2393FF" />
                </TouchableOpacity>
                <TouchableOpacity style={[styles.shareIcon, styles.whatsappIcon]} onPress={handleShare}>
                  <Ionicons name="logo-whatsapp" size={25} color="#25E984" />
                </TouchableOpacity>
                <TouchableOpacity style={[styles.shareIcon, styles.twitterIcon]} onPress={handleShare}>
                  <Ionicons name="logo-twitter" size={24} color="#29A9FF" />
                </TouchableOpacity>
                <TouchableOpacity style={[styles.shareIcon, styles.linkIcon]} onPress={handleShare}>
                  <Ionicons name="link" size={25} color="#FFFFFF" />
                </TouchableOpacity>
              </View>
            </View>

            <TouchableOpacity
              activeOpacity={0.88}
              style={styles.goLiveWrapperNew}
              onPress={handleStartLive}
              disabled={countdown !== null}
            >
              <ImageBackground
                source={GO_LIVE_BUTTON}
                resizeMode="stretch"
                style={styles.goLiveBtnNew}
                imageStyle={styles.goLiveImage}
              >
                <Ionicons name="radio" size={25} color="#FFF" />
                <Text style={styles.goLiveTextNew}>Go live</Text>
              </ImageBackground>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  backgroundShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(4, 3, 42, 0.08)',
  },
  headerMini: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 17,
    height: 52,
  },
  closeBtn: {
    width: 52, height: 52,
    justifyContent: 'center', alignItems: 'center',
  },
  closeAsset: { width: 52, height: 52 },
  liveContent: { flex: 1, justifyContent: 'space-between' },
  centerStack: {
    alignItems: 'center',
    paddingHorizontal: 18,
    marginTop: -2,
  },
  avatarOuterRing: {
    width: 140, height: 140, borderRadius: 70,
    padding: 3,
    shadowColor: '#E82CFF', shadowOpacity: 0.85,
    shadowRadius: 18, shadowOffset: { width: 0, height: 0 },
    elevation: 14,
    marginBottom: 14,
  },
  avatarRing: {
    flex: 1,
    borderRadius: 67,
    padding: 7,
    backgroundColor: '#140757',
  },
  avatarImg: { width: '100%', height: '100%', borderRadius: 60, backgroundColor: '#1B0A64' },
  avatarEditPill: {
    position: 'absolute', top: 99, left: width / 2 + 38,
    width: 42, height: 42, borderRadius: 21,
    padding: 2,
    backgroundColor: '#73D9FF',
    justifyContent: 'center', alignItems: 'center',
    elevation: 16,
  },
  avatarEditGradient: {
    width: '100%', height: '100%', borderRadius: 19,
    justifyContent: 'center', alignItems: 'center',
  },
  titleInputNew: {
    color: '#FFF',
    fontSize: 25,
    fontWeight: '800',
    textAlign: 'center',
    paddingVertical: 4,
    minWidth: 230,
    maxWidth: '90%',
  },
  titleUnderline: {
    width: 104, height: 3, borderRadius: 2,
    backgroundColor: '#8C5DFF',
    shadowColor: '#EE24FF', shadowOpacity: 1, shadowRadius: 6,
    marginTop: 1, marginBottom: 16,
  },
  tagsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 7,
    width: '100%',
  },
  tagPill: {
    height: 40,
    minWidth: 72,
    maxWidth: 92,
    flex: 1,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: 'rgba(14, 8, 71, 0.72)',
    borderWidth: 1, borderColor: 'rgba(127, 78, 239, 0.68)',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  tagPillActive: {
    borderColor: '#FF55F2',
    shadowColor: '#EF2CFF', shadowOpacity: 0.85, shadowRadius: 9,
    elevation: 8,
  },
  tagPillText: {
    color: '#D8D5ED',
    fontSize: 13, fontWeight: '700',
  },
  tagPillTextActive: { color: '#FFFFFF' },
  bottomStack: {
    paddingHorizontal: 22,
    paddingBottom: 144,
    gap: 13,
  },
  segWrap: {
    flexDirection: 'row',
    width: '82%',
    height: 54,
    backgroundColor: 'rgba(14, 7, 72, 0.82)',
    borderRadius: 27,
    padding: 4,
    alignSelf: 'center',
    borderWidth: 1, borderColor: 'rgba(125, 67, 232, 0.55)',
  },
  segBtn: {
    flex: 1,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    justifyContent: 'center',
    borderRadius: 23,
    overflow: 'hidden',
  },
  segBtnActive: {
    shadowColor: '#F32CEC', shadowOpacity: 0.8,
    shadowRadius: 10, elevation: 8,
  },
  segActiveGradient: { ...StyleSheet.absoluteFillObject, borderRadius: 23 },
  segText: { color: 'rgba(255,255,255,0.65)', fontWeight: '700', fontSize: 16 },
  segTextActive: { color: '#FFF' },
  sharePanel: {
    alignSelf: 'center',
    width: '86%',
    height: 94,
    borderRadius: 18,
    backgroundColor: 'rgba(10, 8, 70, 0.62)',
    borderWidth: 1,
    borderColor: '#663BEB',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
  },
  shareLabel: {
    color: '#C9C4E0',
    fontSize: 16, fontWeight: '700',
  },
  shareIcons: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  shareIcon: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: '#11125D',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 1.2,
    shadowOpacity: 0.75, shadowRadius: 8, elevation: 7,
  },
  facebookIcon: { borderColor: '#2B7AFF', shadowColor: '#2B7AFF' },
  whatsappIcon: { borderColor: '#22D98A', shadowColor: '#22D98A' },
  twitterIcon: { borderColor: '#248CFF', shadowColor: '#248CFF' },
  linkIcon: { borderColor: '#B438FF', shadowColor: '#B438FF' },
  goLiveWrapperNew: {
    height: 66,
    borderRadius: 33,
    shadowColor: '#E82DFF', shadowOpacity: 0.9,
    shadowRadius: 18, shadowOffset: { width: 0, height: 5 },
    elevation: 14,
  },
  goLiveBtnNew: {
    height: '100%',
    width: '100%',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 12,
    borderRadius: 33,
  },
  goLiveImage: { borderRadius: 33 },
  goLiveTextNew: {
    color: '#FFF', fontSize: 26, fontWeight: '800',
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
  countdownCard: {
    width: Math.min(width - 42, 390),
    paddingHorizontal: 24,
    paddingTop: 22,
    paddingBottom: 24,
    borderRadius: 28,
    backgroundColor: 'rgba(17, 9, 69, 0.88)',
    borderWidth: 1,
    borderColor: 'rgba(163, 83, 255, 0.62)',
    alignItems: 'center',
    shadowColor: '#8B3DFF',
    shadowOpacity: 0.65,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 0 },
    elevation: 20,
  },
  countdownEyebrow: {
    height: 30,
    borderRadius: 15,
    paddingHorizontal: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  countdownLiveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  countdownEyebrowText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.6,
  },
  countdownStage: {
    width: 220,
    height: 210,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
    opacity: 0.85,
  },
  countdownHint: {
    color: 'rgba(224, 220, 246, 0.68)',
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    marginTop: 8,
  },
  countdownProgress: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 18,
  },
  countdownProgressDot: {
    width: 26,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.13)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
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
