import { useCallback } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Camera } from 'expo-camera';
import * as Location from 'expo-location';
import * as MediaLibrary from 'expo-media-library';
import {
    GLOBAL_PERMISSION_ONBOARDING_KEY,
    getAndroidMediaGranularPermissions,
} from './globalPermissionPolicy';

let requestInFlight = null;

const requestIfNeeded = async (getCurrent, request) => {
    const current = await getCurrent();
    if (current?.status === 'granted' || current?.granted === true) return current;
    if (current?.canAskAgain === false) return current;
    return request();
};

export const useGlobalPermissions = () => {
    const requestAllPermissions = useCallback(async ({ force = false } = {}) => {
        if (Platform.OS !== 'android') return { skipped: true, reason: 'not-android' };
        if (requestInFlight) return requestInFlight;

        requestInFlight = (async () => {
            if (!force) {
                const completed = await AsyncStorage.getItem(GLOBAL_PERMISSION_ONBOARDING_KEY);
                if (completed === 'completed') return { skipped: true, reason: 'already-completed' };

                // Persist the attempt before opening Android's native sheets.
                // A denial, interruption, or app restart must not turn this into
                // a popup sequence on every later launch.
                await AsyncStorage.setItem(GLOBAL_PERMISSION_ONBOARDING_KEY, 'completed');
            }

            const results = {};
            const granularMediaPermissions = getAndroidMediaGranularPermissions(Platform.Version);

            // Android only presents one dangerous-permission dialog at a time.
            // Awaiting every request keeps the sequence deterministic and avoids
            // one system sheet swallowing another on slower devices.
            const steps = [
                ['camera',
                    Camera.getCameraPermissionsAsync,
                    Camera.requestCameraPermissionsAsync],
                ['microphone',
                    Camera.getMicrophonePermissionsAsync,
                    Camera.requestMicrophonePermissionsAsync],
                ['location',
                    Location.getForegroundPermissionsAsync,
                    Location.requestForegroundPermissionsAsync],
                ['media',
                    () => MediaLibrary.getPermissionsAsync(false, granularMediaPermissions),
                    () => MediaLibrary.requestPermissionsAsync(false, granularMediaPermissions)],
            ];

            for (const [id, getCurrent, request] of steps) {
                try {
                    results[id] = await requestIfNeeded(getCurrent, request);
                } catch (error) {
                    results[id] = {
                        status: 'denied',
                        canAskAgain: true,
                        requestFailed: true,
                        error: error?.message || 'Permission request failed',
                    };
                    if (__DEV__) console.warn(`[Permissions] ${id} request failed:`, error?.message);
                }
            }

            return { skipped: false, results };
        })().catch((error) => {
            if (__DEV__) console.warn('[Permissions] onboarding failed:', error?.message);
            return { skipped: false, error };
        }).finally(() => {
            requestInFlight = null;
        });

        return requestInFlight;
    }, []);

    return { requestAllPermissions };
};
