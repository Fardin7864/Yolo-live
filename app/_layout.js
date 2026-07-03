import { useEffect } from 'react';
import { ImageBackground, StyleSheet } from 'react-native';
import { Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { GlobalStateProvider, useGlobalState } from '../src/context/GlobalStateContext';
import MaintenanceGate from '../src/components/MaintenanceGate';
import { CuteAlertHost } from '../src/components/CuteAlert';
import ErrorBoundary from '../src/components/ErrorBoundary';
import ForceUpdateGate from '../src/components/ForceUpdateGate';
import RemoteSplashGate from '../src/components/RemoteSplashGate';
import { installGlobalErrorHandler } from '../src/utils/crashReport';
import { ensureNotificationPermission } from '../src/utils/notifPermission';
import { configureAudioSession } from '../src/audio/audioSession';
import {
  clearFirebaseUser,
  identifyFirebaseUser,
  startFirebaseMessagingListeners,
  syncCurrentPushToken,
  trackScreenView,
  unregisterCurrentPushToken,
} from '../src/lib/firebase';
import "../global.css";

const APP_BACKGROUND = require('../assets/backgrounds/neon-space.png');

// Phase B: install the JS-side crash hook ONCE per process. The handler
// is a no-op when re-called (the helper is idempotent), so module-level
// call is fine even with fast refresh in dev.
installGlobalErrorHandler();

// Configure the expo-audio session ONCE so:
//   - iOS:    SFX plays even when the ringer/silent switch is on (users
//             expect in-app gift sounds to be audible regardless)
//   - Android: gift SFX briefly ducks Spotify/other music instead of
//             muting it entirely or fighting for the audio focus
// Idempotent — safe to call on every fast-refresh.
configureAudioSession();

// Keep the native splash up until RemoteSplashGate has painted its
// first frame. Without this, Expo auto-hides the native splash the
// instant the JS bundle finishes loading, exposing the home screen
// for ~50ms before our overlay covers it — a visible black flash on
// budget Androids. By preventing auto-hide here and explicitly
// calling hideAsync() after the overlay mounts (see useEffect below),
// the handoff is seamless. Errors are non-fatal — if the call fails
// the native splash just hides as normal.
SplashScreen.preventAutoHideAsync().catch(() => {});

function RootContent() {
  const pathname = usePathname();
  const { user, role } = useGlobalState();

  useEffect(() => {
    // Hide the native splash one frame after mount. By this point the
    // RemoteSplashGate sibling has already painted its first frame
    // (either a cached splash or the bundled-icon fallback), so the
    // user sees a smooth crossfade rather than the home screen
    // flashing through.
    const t = setTimeout(() => {
      SplashScreen.hideAsync().catch(() => {});
    }, 50);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    trackScreenView(pathname);
  }, [pathname]);

  useEffect(() => {
    const stop = startFirebaseMessagingListeners();
    return () => {
      try { stop?.(); } catch (_) {}
    };
  }, []);

  useEffect(() => {
    if (user?.id) {
      identifyFirebaseUser({
        id: user.id,
        role,
        vipType: user.vipType,
      });
    } else {
      clearFirebaseUser();
    }
  }, [user?.id, user?.vipType, role]);

  useEffect(() => {
    if (!user?.id) return;

    if (user.pushNotificationsEnabled === false) {
      unregisterCurrentPushToken();
      return;
    }

    ensureNotificationPermission()
      .then(() => syncCurrentPushToken())
      .catch(() => {});
  }, [user?.id, user?.pushNotificationsEnabled]);

  return (
    <KeyboardProvider>
      <SafeAreaProvider>
        <ImageBackground source={APP_BACKGROUND} resizeMode="cover" style={styles.appBackground}>
        {/* Global status bar style. App background is dark (#1A1230)
            everywhere outside the broadcast room, so battery / SIM /
            time icons need to render LIGHT (white) to stay legible.
            Without this, edge-to-edge mode falls back to the system
            default which on many Androids renders dark icons that
            disappear against our purple background. Per-screen
            <StatusBar> usage (e.g. the broadcast room) still overrides
            this on those screens. */}
        <StatusBar style="light" translucent backgroundColor="transparent" />
        {/* ForceUpdateGate sits ABOVE MaintenanceGate so an older binary
            sees the update screen before it tries to render anything
            that might reference an RPC signature it doesn't know. */}
        <ForceUpdateGate>
          <MaintenanceGate>
            <Stack screenOptions={{ headerShown: false, contentStyle: styles.transparentScene }}>
              <Stack.Screen name="index" options={{ headerShown: false }} />
              <Stack.Screen name="auth/login" options={{ headerShown: false }} />
              <Stack.Screen name="auth/signup" options={{ headerShown: false }} />
              <Stack.Screen name="main/(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="main/notifications" options={{ headerShown: false }} />
              <Stack.Screen
                name="broadcast/[id]"
                options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'none' }}
              />
            </Stack>
          </MaintenanceGate>
        </ForceUpdateGate>
        <CuteAlertHost />
        {/* Remote splash overlay — admin-controlled seasonal artwork.
            Sits as a sibling of the Stack (not a wrapper) so the
            navigation tree keeps warming up while the splash is
            visible. Self-dismisses after its configured duration. */}
        <RemoteSplashGate />
        </ImageBackground>
      </SafeAreaProvider>
    </KeyboardProvider>
  );
}

const styles = StyleSheet.create({
  appBackground: { flex: 1, backgroundColor: '#07062B' },
  transparentScene: { backgroundColor: 'transparent' },
});

export default function RootLayout() {
  // The outermost ErrorBoundary catches even GlobalStateProvider errors;
  // anything below it gets logged + a friendly retry screen instead of
  // a white-on-black blank.
  return (
    <ErrorBoundary name="RootLayout">
      <GlobalStateProvider>
        <RootContent />
      </GlobalStateProvider>
    </ErrorBoundary>
  );
}
