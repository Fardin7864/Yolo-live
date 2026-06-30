/**
 * RemoteSplashGate
 * ----------------
 * Renders a full-screen splash overlay AFTER the JS bundle boots but
 * BEFORE the user gets to interact with the home screen.
 *
 *   • If the admin has shipped a seasonal splash (Supabase Storage,
 *     image or Lottie), we show that.
 *   • Otherwise we show a bundled fallback (the same splash-icon.png
 *     the native splash uses, on the same #1A1230 background) so
 *     EVERY launch — including first-ever install with no network —
 *     gets a consistent 1.8s branded moment.
 *
 * Why we always render something:
 *   The native splash auto-hides ~50ms after JS boot (see
 *   app/_layout.js's SplashScreen.hideAsync call). If we showed
 *   nothing, the user would land on the home screen ~1s after tapping
 *   the icon — too abrupt for the "branded launch" UX users expect.
 *
 * Mount as a SIBLING of the navigation Stack, not a wrapper, so the
 * tree below keeps initialising in the background while the splash is
 * up. By the time the overlay fades, the home screen is fully warm.
 *
 * State machine:
 *   resolving — first paint, deciding what to show (sync, ~5ms)
 *   showing   — overlay visible, holding for duration_ms
 *   fading    — opacity animating down, blocking taps via pointerEvents
 *   done      — unmounted, the gate is invisible
 */
import React, { useEffect, useRef, useState } from 'react';
import { Image, Animated, StyleSheet, StatusBar } from 'react-native';

const WELCOME_ART = require('../../assets/onboarding/welcome-loading.webp');
const HOLD_MS = 2600;
const FADE_OUT_MS = 350;

// Once dismissed in this app session, never re-show — even after a
// fast-refresh re-mount in dev. Outside the component so React state
// doesn't reset it.
let __shownThisSession = false;

export default function RemoteSplashGate() {
  const [phase, setPhase] = useState(__shownThisSession ? 'done' : 'showing');
  const fade = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (__shownThisSession) return undefined;
    __shownThisSession = true;
    return undefined;
  }, []);

  useEffect(() => {
    if (phase !== 'showing') return undefined;
    const t = setTimeout(() => {
      setPhase('fading');
      Animated.timing(fade, {
        toValue: 0, duration: FADE_OUT_MS, useNativeDriver: true,
      }).start(({ finished }) => { if (finished) setPhase('done'); });
    }, HOLD_MS);
    return () => clearTimeout(t);
  }, [phase, fade]);

  if (phase === 'done') return null;

  return (
    <Animated.View
      pointerEvents={phase === 'showing' ? 'auto' : 'none'}
      style={[styles.overlay, { opacity: fade }]}
    >
      <StatusBar translucent backgroundColor="transparent" barStyle="light-content" />
      <Image source={WELCOME_ART} style={styles.media} resizeMode="cover" />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    // zIndex above everything, including modals. Switches to
    // pointerEvents='none' during fade so a tap in the fade window
    // reaches the home screen, not the dying overlay.
    zIndex: 9999,
    elevation: 9999,
    justifyContent: 'center',
    alignItems: 'center',
  },
  media: { width: '100%', height: '100%' },
});
