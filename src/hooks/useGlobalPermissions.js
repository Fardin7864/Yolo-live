import { Alert } from 'react-native';
import { Camera } from 'expo-camera';
import * as MediaLibrary from 'expo-media-library';
import Constants from 'expo-constants';

/**
 * useGlobalPermissions
 * A hook to request all necessary permissions sequentially.
 * Fixes: 
 * 1. TypeError by using named 'Camera' export (SDK 54).
 * 2. Crash in Expo Go by removing top-level expo-notifications import.
 */
export const useGlobalPermissions = () => {
    
    const requestAllPermissions = async () => {
        try {
            if (__DEV__) console.log('[Permissions] starting global request');
            const isExpoGo = Constants.appOwnership === 'expo';

            // 1. Camera & Microphone
            try {
                const camRes = await Camera.requestCameraPermissionsAsync();
                const micRes = await Camera.requestMicrophonePermissionsAsync();
                if (__DEV__) console.log('[Permissions] camera:', camRes.status, 'mic:', micRes.status);
            } catch (cameraErr) {
                if (__DEV__) console.warn('Camera/Mic permission failed:', cameraErr.message);
            }

            // 2. Media Library
            try {
                const mediaRes = await MediaLibrary.requestPermissionsAsync();
                if (__DEV__) console.log('[Permissions] media:', mediaRes.status);
            } catch (mediaErr) {
                if (__DEV__) console.warn('Media Library permission failed:', mediaErr.message);
            }

            // 3. Notifications (skipped in Expo Go because expo-notifications
            //    triggers a top-level side effect that crashes Expo Go SDK 54+)
            if (!isExpoGo) {
                try {
                    const Notifications = require('expo-notifications');
                    const { status: existingStatus } = await Notifications.getPermissionsAsync();
                    if (existingStatus !== 'granted') {
                        await Notifications.requestPermissionsAsync();
                    }
                } catch (notiErr) {
                    if (__DEV__) console.warn('Notification permission failed:', notiErr.message);
                }
            }

            if (__DEV__) console.log('[Permissions] finished');

        } catch (error) {
            if (__DEV__) console.error('Critical Error in useGlobalPermissions:', error);
            Alert.alert("Permission Hub Error", "App could not initialize permissions correctly.");
        }
    };

    return { requestAllPermissions };
};
