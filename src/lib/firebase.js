import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { supabase } from '../api/supabase';

const APP_VERSION = Constants.expoConfig?.version
  ?? Constants.manifest?.version
  ?? '0.0.0';

const FIREBASE_SUPPORTED = Platform.OS === 'android' || Platform.OS === 'ios';
let messagingUnsubscribe = null;

function getAnalyticsApi() {
  if (!FIREBASE_SUPPORTED) return null;
  try {
    return require('@react-native-firebase/analytics');
  } catch (_) {
    return null;
  }
}

function getCrashlyticsApi() {
  if (!FIREBASE_SUPPORTED) return null;
  try {
    return require('@react-native-firebase/crashlytics');
  } catch (_) {
    return null;
  }
}

function getMessagingApi() {
  if (!FIREBASE_SUPPORTED) return null;
  try {
    return require('@react-native-firebase/messaging');
  } catch (_) {
    return null;
  }
}

function normalizeError(error) {
  if (error instanceof Error) return error;
  return new Error(typeof error === 'string' ? error : JSON.stringify(error));
}

function toStringMap(input = {}) {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined && value !== null)
      .slice(0, 20)
      .map(([key, value]) => [key, String(value).slice(0, 120)]),
  );
}

function analyticsPayload(input = {}) {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, typeof value === 'number' ? value : String(value).slice(0, 100)]),
  );
}

async function upsertPushToken(token) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.id || !token) return;

  await supabase.rpc('register_my_push_token', {
    p_fcm_token: token,
    p_platform: Platform.OS,
    p_app_build: APP_VERSION,
    p_device_name: Constants.deviceName || null,
  });
}

export async function logAnalyticsEvent(name, params = {}) {
  const analyticsApi = getAnalyticsApi();
  if (!analyticsApi) return;

  try {
    const { getAnalytics, logEvent } = analyticsApi;
    await logEvent(getAnalytics(), name, analyticsPayload(params));
  } catch (_) {}
}

export async function trackScreenView(pathname) {
  const analyticsApi = getAnalyticsApi();
  if (!analyticsApi || !pathname) return;

  try {
    const { getAnalytics, logEvent } = analyticsApi;
    await logEvent(getAnalytics(), 'screen_view', {
      screen_name: pathname,
      screen_class: pathname,
    });
  } catch (_) {}
}

export async function identifyFirebaseUser(user) {
  if (!user?.id) return;

  const analyticsApi = getAnalyticsApi();
  const crashlyticsApi = getCrashlyticsApi();

  try {
    if (analyticsApi) {
      const { getAnalytics, setUserId, setUserProperty } = analyticsApi;
      const analytics = getAnalytics();
      await setUserId(analytics, user.id);
      await setUserProperty(analytics, 'role', user.role || 'user');
      await setUserProperty(analytics, 'vip_type', user.vipType || 'none');
    }

    if (crashlyticsApi) {
      const { getCrashlytics, setUserId, setAttributes, log } = crashlyticsApi;
      const crashlytics = getCrashlytics();
      await setUserId(crashlytics, user.id);
      await setAttributes(crashlytics, toStringMap({
        role: user.role || 'user',
        vip_type: user.vipType || 'none',
        app_version: APP_VERSION,
      }));
      log(crashlytics, `identified user ${user.id}`);
    }
  } catch (_) {}
}

export async function clearFirebaseUser() {
  const analyticsApi = getAnalyticsApi();
  const crashlyticsApi = getCrashlyticsApi();

  try {
    if (analyticsApi) {
      const { getAnalytics, setUserId, setUserProperty } = analyticsApi;
      const analytics = getAnalytics();
      await setUserId(analytics, null);
      await setUserProperty(analytics, 'role', null);
      await setUserProperty(analytics, 'vip_type', null);
    }

    if (crashlyticsApi) {
      const { getCrashlytics, setUserId, setAttributes } = crashlyticsApi;
      const crashlytics = getCrashlytics();
      await setUserId(crashlytics, 'signed_out');
      await setAttributes(crashlytics, toStringMap({
        role: 'signed_out',
        vip_type: 'none',
      }));
    }
  } catch (_) {}
}

export function recordFirebaseError(error, context = {}) {
  const crashlyticsApi = getCrashlyticsApi();
  if (!crashlyticsApi) return;

  try {
    const normalized = normalizeError(error);
    const { getCrashlytics, log, recordError, setAttributes } = crashlyticsApi;
    const crashlytics = getCrashlytics();

    log(crashlytics, `${context.screen || 'app'}: ${normalized.message}`);
    setAttributes(crashlytics, toStringMap({
      screen: context.screen || 'unknown',
      fatal: context.isFatal ? 'true' : 'false',
      ...context.context,
    })).catch(() => {});
    recordError(crashlytics, normalized);
  } catch (_) {}
}

export async function syncCurrentPushToken() {
  const messagingApi = getMessagingApi();
  if (!messagingApi || Platform.OS !== 'android') return;

  try {
    const { getMessaging, getToken, setAutoInitEnabled } = messagingApi;
    const messaging = getMessaging();
    await setAutoInitEnabled(messaging, true);
    const token = await getToken(messaging);
    if (!token) return;

    await upsertPushToken(token);
    await logAnalyticsEvent('push_token_synced', { platform: Platform.OS });
  } catch (error) {
    recordFirebaseError(error, { screen: 'push_token_sync' });
  }
}

export async function unregisterCurrentPushToken() {
  const messagingApi = getMessagingApi();
  if (!messagingApi || Platform.OS !== 'android') return;

  try {
    const { getMessaging, getToken, deleteToken } = messagingApi;
    const messaging = getMessaging();
    const token = await getToken(messaging).catch(() => null);

    if (token) {
      await supabase.rpc('unregister_my_push_token', {
        p_fcm_token: token,
      });
    }

    await deleteToken(messaging).catch(() => {});
  } catch (_) {}
}

async function showForegroundNotification(remoteMessage) {
  const title = remoteMessage?.notification?.title;
  const body = remoteMessage?.notification?.body;
  if (!title && !body) return;

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: title || 'New message',
        body: body || '',
        data: remoteMessage?.data || {},
      },
      trigger: null,
    });
  } catch (_) {}
}

function extractPushAnalytics(remoteMessage) {
  return {
    has_notification: remoteMessage?.notification ? 'true' : 'false',
    from: remoteMessage?.from || 'unknown',
    message_id: remoteMessage?.messageId || 'unknown',
  };
}

export function startFirebaseMessagingListeners() {
  const messagingApi = getMessagingApi();
  if (!messagingApi || Platform.OS !== 'android' || messagingUnsubscribe) {
    return messagingUnsubscribe || (() => {});
  }

  const {
    getMessaging,
    onMessage,
    onNotificationOpenedApp,
    onTokenRefresh,
    getInitialNotification,
  } = messagingApi;
  const messaging = getMessaging();

  const stopForeground = onMessage(messaging, async (remoteMessage) => {
    await logAnalyticsEvent('push_foreground_received', extractPushAnalytics(remoteMessage));
    await showForegroundNotification(remoteMessage);
  });

  const stopOpened = onNotificationOpenedApp(messaging, async (remoteMessage) => {
    await logAnalyticsEvent('push_opened', extractPushAnalytics(remoteMessage));
  });

  const stopRefresh = onTokenRefresh(messaging, async (token) => {
    try {
      await upsertPushToken(token);
    } catch (error) {
      recordFirebaseError(error, { screen: 'push_token_refresh' });
    }
  });

  getInitialNotification(messaging)
    .then((remoteMessage) => {
      if (remoteMessage) {
        void logAnalyticsEvent('push_opened_cold', extractPushAnalytics(remoteMessage));
      }
    })
    .catch(() => {});

  messagingUnsubscribe = () => {
    try { stopForeground?.(); } catch (_) {}
    try { stopOpened?.(); } catch (_) {}
    try { stopRefresh?.(); } catch (_) {}
    messagingUnsubscribe = null;
  };

  return messagingUnsubscribe;
}

export async function logBackgroundPushMessage(remoteMessage) {
  await logAnalyticsEvent('push_background_received', extractPushAnalytics(remoteMessage));
}
