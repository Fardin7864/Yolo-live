import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking, Platform, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
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
 * - The "Update now" button downloads the signed APK from the direct
 *   release URL and launches Android's package installer. Android still
 *   asks the user to confirm the update, as required by the OS.
 *
 * If both keys are absent (e.g. before migration 56 runs), the gate
 * stays open and the app renders normally.
 */
export default function ForceUpdateGate({ children }) {
  const { systemSettings } = useGlobalState();

  const isPlayStoreBuild = Constants.expoConfig?.extra?.distributionChannel === 'play-store';
  const playStoreUrl = 'https://play.google.com/store/apps/details?id=com.greenlive.app';

  const currentVersion = Constants.expoConfig?.version
    ?? Constants.manifest?.version
    ?? '0.0.0';

  const minVersion    = String(systemSettings?.min_supported_app_version || '').trim();
  const latestVersion = String(systemSettings?.latest_app_version        || '').trim();
  const storeUrlAndroid = String(systemSettings?.store_url_android || '').trim();
  const storeUrlIos     = String(systemSettings?.store_url_ios     || '').trim();
  const storeUrl = isPlayStoreBuild
    ? playStoreUrl
    : (Platform.OS === 'ios' ? storeUrlIos : storeUrlAndroid);
  const releaseNotes = String(systemSettings?.app_update_notes || '').trim();
  const [downloadError, setDownloadError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [showOptional, setShowOptional] = useState(true);

  useEffect(() => {
    setShowOptional(true);
    setDownloadError('');
    setDownloading(false);
    setDownloadProgress(0);
  }, [latestVersion]);

  // Don't block when the setting is missing or empty — better to render
  // the app than lock everyone out of a misconfigured key.
  const mustUpdate = useMemo(
    () => !!minVersion && isBelowMin(currentVersion, minVersion),
    [currentVersion, minVersion]
  );

  const startUpdate = async () => {
    if (!storeUrl || downloading) return;
    setDownloadError('');
    setDownloading(true);
    setDownloadProgress(0);
    try {
      if (isPlayStoreBuild || Platform.OS !== 'android') {
        const opened = await Linking.openURL(storeUrl);
        if (opened === false) throw new Error('The update page could not be opened.');
        return;
      }

      const destination = `${FileSystem.cacheDirectory}popular-live-${latestVersion || 'update'}.apk`;
      await FileSystem.deleteAsync(destination, { idempotent: true });
      const download = FileSystem.createDownloadResumable(
        storeUrl,
        destination,
        {},
        ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
          if (totalBytesExpectedToWrite > 0) {
            setDownloadProgress(totalBytesWritten / totalBytesExpectedToWrite);
          }
        },
      );
      const result = await download.downloadAsync();
      if (!result?.uri) throw new Error('The APK download did not complete.');

      const contentUri = await FileSystem.getContentUriAsync(result.uri);
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: contentUri,
        flags: 1,
        type: 'application/vnd.android.package-archive',
      });
    } catch (error) {
      console.warn('APK update link:', error?.message || error);
      setDownloadError('The update could not be downloaded or opened. Check your connection and try again.');
    } finally {
      setDownloading(false);
    }
  };

  const hasOptionalUpdate = !!latestVersion
    && compareVersions(currentVersion, latestVersion) < 0
    && !!storeUrl;

  if (!mustUpdate) {
    return (
      <>
        {children}
        <UpdateModal
          visible={hasOptionalUpdate && showOptional}
          required={false}
          currentVersion={currentVersion}
          latestVersion={latestVersion}
          releaseNotes={releaseNotes}
          error={downloadError}
          downloading={downloading}
          downloadProgress={downloadProgress}
          onUpdate={startUpdate}
          onLater={() => setShowOptional(false)}
          isPlayStoreBuild={isPlayStoreBuild}
        />
      </>
    );
  }

  return (
    <View style={s.container}>
      <View style={s.icon}>
        <Ionicons name="cloud-download" size={42} color="#FFF" />
      </View>
      <Text style={s.title}>Update required</Text>
      <Text style={s.body}>
        A newer version of Popular Live is available with security and
        stability fixes. Please update to continue using the app.
      </Text>
      {!!releaseNotes && <Text style={s.notes}>{releaseNotes}</Text>}
      <Text style={s.versionRow}>
        Your version: {currentVersion}{'\n'}
        Minimum supported: {minVersion}
      </Text>
      {storeUrl ? (
        <>
          {downloading && <DownloadProgress progress={downloadProgress} />}
          <TouchableOpacity style={[s.btn, downloading && s.btnDisabled]} onPress={startUpdate} disabled={downloading}>
            <Ionicons name={downloading ? 'hourglass-outline' : 'cloud-download-outline'} size={18} color="#FFF" />
            <Text style={s.btnText}>{downloading ? 'Downloading update…' : (isPlayStoreBuild ? 'Open Play Store' : 'Download update')}</Text>
          </TouchableOpacity>
        </>
      ) : (
        <Text style={s.fallback}>Please visit the Play Store to update.</Text>
      )}
      {!!downloadError && <Text style={s.error}>{downloadError}</Text>}
    </View>
  );
}

function UpdateModal({ visible, required, currentVersion, latestVersion, releaseNotes, error, downloading, downloadProgress, onUpdate, onLater, isPlayStoreBuild }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={required ? undefined : onLater}>
      <View style={s.modalBackdrop}>
        <View style={s.modalCard}>
          <View style={s.modalIcon}><Ionicons name="cloud-download" size={32} color="#FFF" /></View>
          <Text style={s.modalTitle}>Popular Live update available</Text>
          <Text style={s.modalBody}>Version {latestVersion} is ready. Download it now to update your existing app.</Text>
          {!!releaseNotes && <Text style={s.modalNotes}>{releaseNotes}</Text>}
          <Text style={s.modalVersion}>Installed: {currentVersion}  •  New: {latestVersion}</Text>
          {!!error && <Text style={s.error}>{error}</Text>}
          {downloading && <DownloadProgress progress={downloadProgress} />}
          <TouchableOpacity style={[s.btn, downloading && s.btnDisabled]} onPress={onUpdate} disabled={downloading}>
            <Ionicons name={downloading ? 'hourglass-outline' : 'cloud-download-outline'} size={18} color="#FFF" />
            <Text style={s.btnText}>{downloading ? 'Downloading update…' : (isPlayStoreBuild ? 'Open Play Store' : 'Download update')}</Text>
          </TouchableOpacity>
          {!required && !downloading && <TouchableOpacity style={s.laterBtn} onPress={onLater}><Text style={s.laterText}>Later</Text></TouchableOpacity>}
        </View>
      </View>
    </Modal>
  );
}

function DownloadProgress({ progress }) {
  const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
  return (
    <View style={s.progressWrap}>
      <View style={s.progressTrack}>
        <View style={[s.progressFill, { width: `${percent}%` }]} />
      </View>
      <Text style={s.progressText}>{percent}%</Text>
    </View>
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
  btnDisabled: { opacity: 0.65 },
  btnText:    { color: '#FFF', fontSize: 15, fontWeight: '800' },
  fallback:   { color: 'rgba(255,255,255,0.4)', fontSize: 12, marginTop: 10 },
  notes: { color: '#E9D5FF', fontSize: 12, textAlign: 'center', lineHeight: 18, marginBottom: 16 },
  error: { color: '#FDA4AF', fontSize: 11, textAlign: 'center', marginTop: 10 },
  progressWrap: { width: '100%', marginBottom: 14 },
  progressTrack: { width: '100%', height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.14)' },
  progressFill: { height: '100%', borderRadius: 4, backgroundColor: '#34D399' },
  progressText: { color: 'rgba(255,255,255,0.72)', fontSize: 11, fontWeight: '700', textAlign: 'center', marginTop: 6 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.78)', alignItems: 'center', justifyContent: 'center', padding: 22 },
  modalCard: { width: '100%', maxWidth: 420, borderRadius: 24, padding: 24, alignItems: 'center', backgroundColor: '#1D1636', borderWidth: 1, borderColor: 'rgba(168,85,247,0.55)' },
  modalIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: BRAND.primary, marginBottom: 16 },
  modalTitle: { color: '#FFF', fontSize: 21, fontWeight: '900', textAlign: 'center' },
  modalBody: { color: 'rgba(255,255,255,0.72)', fontSize: 13, lineHeight: 20, textAlign: 'center', marginTop: 8 },
  modalNotes: { width: '100%', color: '#E9D5FF', fontSize: 12, lineHeight: 18, backgroundColor: 'rgba(139,92,246,0.13)', borderRadius: 12, padding: 12, marginTop: 14 },
  modalVersion: { color: 'rgba(255,255,255,0.45)', fontSize: 11, marginVertical: 16 },
  laterBtn: { paddingVertical: 11, paddingHorizontal: 24, marginTop: 4 },
  laterText: { color: 'rgba(255,255,255,0.62)', fontSize: 13, fontWeight: '700' },
});
