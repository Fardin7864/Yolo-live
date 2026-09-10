import React, { useState, useEffect } from 'react';
import { View, Text, Image, ImageBackground, TouchableOpacity, ActivityIndicator, Alert, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import Svg, { Path } from 'react-native-svg';
import { LinearGradient } from 'expo-linear-gradient';
import { supabase } from '../../src/api/supabase';
import { TENANT_CONFIG } from '../../tenant.config';

const AUTH_BACKGROUND = require('../../assets/onboarding/google-auth-background.webp');

GoogleSignin.configure({
  webClientId: TENANT_CONFIG.googleAuth.webClientId || undefined,
  iosClientId: TENANT_CONFIG.googleAuth.iosClientId || undefined,
  offlineAccess: false,
});

const GOOGLE_ANDROID_SHA1S = [
  '5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25',
  'A8:41:C4:BA:89:0C:97:25:6E:24:CF:1E:85:F0:9F:9F:C0:CB:89:06',
];

function getGoogleIdToken(response) {
  if (response?.type && response.type !== 'success') return null;
  return response?.data?.idToken || response?.idToken || null;
}

function GoogleLogo() {
  return (
    <Svg width={28} height={28} viewBox="0 0 48 48" accessibilityLabel="Google">
      <Path fill="#FFC107" d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12c0-6.627,5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24c0,11.045,8.955,20,20,20c11.045,0,20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z" />
      <Path fill="#FF3D00" d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z" />
      <Path fill="#4CAF50" d="M24,44c5.166,0,9.86-1.977,13.409-5.192l-6.19-5.238C29.211,35.091,26.715,36,24,36c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z" />
      <Path fill="#1976D2" d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571c0.001-0.001,0.002-0.001,0.003-0.002l6.19,5.238C36.971,39.205,44,34,44,24C44,22.659,43.862,21.35,43.611,20.083z" />
    </Svg>
  );
}

const LoginScreen = () => {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  // Safety net for the entry-redirect timeout in `app/index.js`. If a
  // slow cold-start pushed `getSession()` past the timeout, the user
  // ends up here even though their session is still valid in
  // AsyncStorage. Re-check on mount and forward to main so they don't
  // have to re-type credentials. The race winner in app/index.js is
  // `/auth/login` only as a fallback; the source of truth is the
  // stored session.
  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession()
      .then(({ data }) => {
        if (mounted && data?.session) {
          router.replace('/main/(tabs)');
        }
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, [router]);

  const handleGoogle = async () => {
    if (!TENANT_CONFIG.googleAuth.webClientId) {
      Alert.alert(
        'Google Sign-In setup needed',
        'Add EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID to the app environment, then rebuild the app.'
      );
      return;
    }

    setLoading(true);
    try {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      const response = await GoogleSignin.signIn();

      const idToken = getGoogleIdToken(response);
      if (!idToken) throw new Error('Google did not return an ID token.');

      const { error } = await supabase.auth.signInWithIdToken({
        provider: 'google',
        token: idToken,
      });
      if (error) throw error;

      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData?.session) {
        throw new Error('Google login completed, but the app could not save the session.');
      }
      if (typeof supabase.rpc === 'function') {
        try {
          await supabase.rpc('ensure_my_profile');
        } catch (_) {}
      }

      router.replace('/main/(tabs)');
    } catch (error) {
      const message = error?.message || 'Google sign-in could not complete.';
      if (String(message).includes('DEVELOPER_ERROR')) {
        Alert.alert(
          'Google sign-in setup needed',
          `Android Google Sign-In is not authorized for this build yet.\n\nRegister these SHA-1 fingerprints for the configured Android package in Google Cloud Console, then rebuild:\n${GOOGLE_ANDROID_SHA1S.join('\n')}`
        );
        return;
      }

      Alert.alert('Google sign-in failed', message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <ImageBackground source={AUTH_BACKGROUND} resizeMode="cover" style={styles.background}>
      <View style={styles.scrim} />
      <SafeAreaView style={styles.container}>
        <View style={styles.content}>
          <View style={styles.brandBlock}>
            <Image
              source={require('../../assets/splash-icon.png')}
              style={styles.logo}
              resizeMode="contain"
            />
            <Text style={styles.title}>Welcome to {TENANT_CONFIG.appName}</Text>
            <Text style={styles.subtitle}>Live, connect, and share moments that matter.</Text>
          </View>

          <View style={styles.authBlock}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Continue with Google"
              activeOpacity={0.88}
              disabled={loading}
              onPress={handleGoogle}
              style={styles.googleButton}
            >
              <LinearGradient
                colors={[
                  'rgba(255, 62, 211, 0.72)',
                  'rgba(123, 76, 255, 0.68)',
                  'rgba(36, 211, 255, 0.68)',
                ]}
                start={{ x: 0, y: 0.3 }}
                end={{ x: 1, y: 0.7 }}
                style={styles.googleGlass}
              >
                <View style={styles.glassHighlight} />
                {loading ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <>
                    <View style={styles.googleMark}><GoogleLogo /></View>
                    <Text style={styles.googleText}>Continue with Google</Text>
                    <View style={styles.buttonBalance} />
                  </>
                )}
              </LinearGradient>
            </TouchableOpacity>
            <Text style={styles.legal}>
              By continuing, you confirm you are 18 or older and agree to our{' '}
              <Text style={styles.legalLink} onPress={() => router.push('/main/terms')}>Terms</Text>
              {' '}and{' '}
              <Text style={styles.legalLink} onPress={() => router.push('/main/privacy')}>Privacy Policy</Text>.
            </Text>
          </View>
        </View>
      </SafeAreaView>
    </ImageBackground>
  );
};

const styles = StyleSheet.create({
  background: { flex: 1, backgroundColor: '#5128B8' },
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(38, 11, 92, 0.15)',
  },
  container: { flex: 1 },
  content: {
    flex: 1,
    paddingHorizontal: 26,
    paddingTop: 72,
    paddingBottom: 28,
    justifyContent: 'space-between',
  },
  brandBlock: {
    alignItems: 'center',
  },
  logo: {
    width: 104,
    height: 104,
    borderRadius: 28,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 30,
    fontWeight: '800',
    textAlign: 'center',
    marginTop: 22,
    textShadowColor: 'rgba(72, 14, 114, 0.45)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },
  subtitle: {
    color: 'rgba(255,255,255,0.92)',
    marginTop: 10,
    fontSize: 16,
    fontWeight: '500',
    textAlign: 'center',
  },
  authBlock: {
    position: 'absolute',
    top: '56%',
    left: 26,
    right: 26,
    alignItems: 'center',
  },
  googleButton: {
    width: '100%',
    minHeight: 58,
    borderRadius: 29,
    shadowColor: '#F03DFF',
    shadowOpacity: 0.62,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 7 },
    elevation: 12,
  },
  googleGlass: {
    minHeight: 58,
    borderRadius: 29,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.82)',
    overflow: 'hidden',
  },
  glassHighlight: {
    position: 'absolute',
    left: 22,
    right: 22,
    top: 3,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.78)',
  },
  googleMark: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.95)',
  },
  googleText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '800',
    textShadowColor: 'rgba(48, 13, 91, 0.65)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  buttonBalance: { width: 34 },
  legal: {
    color: '#FFFFFF',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 18,
    paddingHorizontal: 10,
    textShadowColor: 'rgba(50, 10, 85, 0.65)',
    textShadowRadius: 5,
  },
  legalLink: { fontWeight: '800', textDecorationLine: 'underline' },
});

export default LoginScreen;
