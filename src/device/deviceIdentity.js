import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { TENANT_CONFIG } from '../../tenant.config';

const INSTALLATION_ID_KEY = '@popular_live/installation_id/v1';

function randomInstallationId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

async function getInstallationId() {
  let id = await AsyncStorage.getItem(INSTALLATION_ID_KEY);
  if (!id) {
    id = randomInstallationId();
    await AsyncStorage.setItem(INSTALLATION_ID_KEY, id);
  }
  return id;
}

async function getPlatformDeviceId() {
  if (Platform.OS === 'android') return Application.getAndroidId();
  if (Platform.OS === 'ios') return Application.getIosIdForVendorAsync();
  return `unsupported-${Platform.OS}`;
}

export async function getDeviceIdentity() {
  const [platformId, installationId] = await Promise.all([
    getPlatformDeviceId(),
    getInstallationId(),
  ]);
  if (!platformId) throw new Error('The operating system did not provide a device identifier.');

  return {
    deviceId: `${TENANT_CONFIG.bundleId}:${platformId}`,
    installationId,
    platform: Platform.OS,
    deviceModel: String(Platform.constants?.Model || Platform.constants?.model || 'Unknown'),
    osVersion: String(Platform.Version || ''),
    appVersion: Application.nativeApplicationVersion || Constants.expoConfig?.version || 'unknown',
  };
}
