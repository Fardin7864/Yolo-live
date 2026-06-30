import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BRAND } from '../theme/brand';

// We only ask the user once per install. Asking on every boot is a
// Play Store red flag and trains people to deny by reflex.
const ASKED_KEY = 'yl/asked_notifications_v1';

/**
 * Politely request the POST_NOTIFICATIONS permission on Android 13+
 * (and the equivalent prompt on iOS). Fire-and-forget — never throws.
 *
 *   - Skips if we've already prompted on this device.
 *   - Skips if the OS already granted it.
 *   - Sets up a default Android channel because Android 13+ won't
 *     show ANY notifications without one even when permission is
 *     granted.
 */
export async function ensureNotificationPermission() {
  try {
    // Default channel (Android only). Safe to call multiple times.
    if (Platform.OS === 'android') {
      try {
        await Notifications.setNotificationChannelAsync('default', {
          name: 'General',
          importance: Notifications.AndroidImportance?.DEFAULT ?? 3,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: BRAND.primary,
        });
      } catch (_) {}
    }

    const already = await AsyncStorage.getItem(ASKED_KEY);
    if (already === '1') return;

    const { status: existing } = await Notifications.getPermissionsAsync();
    if (existing === 'granted') {
      await AsyncStorage.setItem(ASKED_KEY, '1');
      return;
    }
    if (existing === 'denied') {
      // User previously denied via OS settings; don't re-prompt — that
      // would only annoy them. Mark asked so we stop trying.
      await AsyncStorage.setItem(ASKED_KEY, '1');
      return;
    }

    await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
      },
    });
    await AsyncStorage.setItem(ASKED_KEY, '1');
  } catch (_) {
    // Silent — not worth surfacing to the user.
  }
}