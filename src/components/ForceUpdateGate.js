import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useGlobalState } from '../context/GlobalStateContext';
import { isBelowMin, compareVersions } from '../utils/versionCompare';
import { BRAND } from '../theme/brand';

/**
 * Blocks the entire app behind an "Update Required" screen when the
 * installed build is older than `system_settings.min_supported_app_version`.
 *
 * - Reads the live setting from GlobalStateContext (already subscribed
 *   to system_settings realtime), so flipping the value in the admin
 *   panel kicks every connected client out immediately.
 * - Compares against the version baked into app.json via
 *   Constants.expoConfig.version.
 * - The "Update now" button deep-links to the Play Store URL stored
 *   alongside the version setting, so the admin can change the URL
 *   without an app push.
 *
 * If both keys are absent (e.g. before migration 56 runs), the gate
 * stays open and the app renders normally.
 */
export default function ForceUpdateGate({ children }) {
  const { systemSettings } = useGlobalState();

  const currentVersion = Constants.expoConfig?.version
    ?? Constants.manifest?.version
    ?? '0.0.0';

  const minVersion    = String(systemSettings?.min_supported_app_version || '').trim();
  const latestVersion = String(systemSettings?.latest_app_version        || '').trim();
  const storeUrlAndroid = String(systemSettings?.store_url_android || '').trim();
  const storeUrlIos     = String(systemSettings?.store_url_ios     || '').trim();
  const storeUrl = Platform.OS === 'ios' ? storeUrlIos : storeUrlAndroid;

  // Don't block when the setting is missing or empty — better to render
  // the app than lock everyone out of a misconfigured key.
  const mustUpdate = useMemo(
    () => !!minVersion && isBelowMin(currentVersion, minVersion),
    [currentVersion, minVersion]
  );

  if (!mustUpdate) {
    return (
      <>
        {/* Optional soft "update available" banner — only if there is
            a newer (non-blocking) version and a store URL to open. */}
        {latestVersion && compareVersions(currentVersion, latestVersion) < 0 && storeUrl ? (
          <SoftUpdateBanner storeUrl={storeUrl} />
        ) : null}
        {children}
      </>
    );
  }

  const openStore = () => {
    if (storeUrl) {
      Linking.openURL(storeUrl).catch(() => {});
    }
  };

  return (
    <View style={s.container}>
      <View style={s.icon}>
        <Ionicons name="cloud-download" size={42} color="#FFF" />
      </View>
      <Text style={s.title}>Update required</Text>
      <Text style={s.body}>
        A newer version of Care Live is available with security and
        stability fixes. Please update to continue using the app.
      </Text>
      <Text style={s.versionRow}>
        Your version: {currentVersion}{'\n'}
        Minimum supported: {minVersion}
      </Text>
      {storeUrl ? (
        <TouchableOpacity style={s.btn} onPress={openStore}>
          <Ionicons name="download" size={18} color="#FFF" />
          <Text style={s.btnText}>Update now</Text>
        </TouchableOpacity>
      ) : (
        <Text style={s.fallback}>Please visit the Play Store to update.</Text>
      )}
    </View>
  );
}

function SoftUpdateBanner({ storeUrl }) {
  // Non-blocking "tap to update" pill at the top — informational only.
  return (
    <TouchableOpacity
      style={s.softBanner}
      onPress={() => Linking.openURL(storeUrl).catch(() => {})}
    >
      <Ionicons name="sparkles" size={14} color="#FFF" />
      <Text style={s.softBannerText}>A new version is available — tap to update</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: '#0E111E',
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 28,
  },
  icon: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: BRAND.primary,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 24,
    shadowColor: BRAND.primary, shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: { width: 0, height: 8 },
  },
  title:      { color: '#FFF', fontSize: 24, fontWeight: '900', marginBottom: 10 },
  body:       { color: 'rgba(255,255,255,0.7)', fontSize: 14, textAlign: 'center', lineHeight: 21, marginBottom: 20 },
  versionRow: { color: 'rgba(255,255,255,0.45)', fontSize: 12, textAlign: 'center', marginBottom: 30, lineHeight: 18 },
  btn:        { flexDirection: 'row', gap: 8, alignItems: 'center', backgroundColor: BRAND.primary, paddingVertical: 12, paddingHorizontal: 24, borderRadius: 14 },
  btnText:    { color: '#FFF', fontSize: 15, fontWeight: '800' },
  fallback:   { color: 'rgba(255,255,255,0.4)', fontSize: 12, marginTop: 10 },

  softBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: `${BRAND.primary}26`,
    borderBottomWidth: 1, borderBottomColor: BRAND.primary30,
    paddingVertical: 6, paddingHorizontal: 12,
  },
  softBannerText: { color: '#FFF', fontSize: 12, fontWeight: '600' },
});
