/**
 * app.config.js
 * =============
 * Replaces app.json — Expo will prefer this file when both are present.
 * Reading values from tenant.config.js means a single edit there
 * propagates to every native-side identifier (app name, package id,
 * scheme, splash colour, EAS project, permission strings).
 *
 * The shape returned below is identical to what the previous app.json
 * declared, so anything Expo Router or the dev client did before
 * continues to work unchanged.
 */
const { TENANT_CONFIG } = require('./tenant.config');

// Helper: substitute %appName% in permission strings so we don't
// hardcode the brand name three times in tenant.config.js.
const fill = (str) => String(str || '').replace(/%appName%/g, TENANT_CONFIG.appName);

module.exports = () => ({
  expo: {
    name:                TENANT_CONFIG.appName,
    slug:                TENANT_CONFIG.slug,
    version:             '1.0.0',
    orientation:         'portrait',
    icon:                './assets/app-icon.png',
    userInterfaceStyle:  'dark',
    scheme:              TENANT_CONFIG.scheme,
    newArchEnabled:      true,
    splash: {
      image:            './assets/splash-icon.png',
      resizeMode:       'contain',
      backgroundColor:  TENANT_CONFIG.splashBg,
    },
    ios: {
      supportsTablet:   true,
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/app-icon.png',
        backgroundColor: '#FFFFFF',
      },
      edgeToEdgeEnabled: true,
      googleServicesFile: './android/app/google-services.json',
      permissions: [
        'CAMERA',
        'RECORD_AUDIO',
        'READ_MEDIA_IMAGES',
        'READ_MEDIA_VIDEO',
        'READ_MEDIA_AUDIO',
        'READ_MEDIA_VISUAL_USER_SELECTED',
        'POST_NOTIFICATIONS',
      ],
      package: TENANT_CONFIG.bundleId,
    },
    web: {
      favicon: './assets/app-icon.png',
    },
    plugins: [
      'expo-router',
      'expo-video',
      [
        'expo-camera',
        {
          cameraPermission:       fill(TENANT_CONFIG.permissions.cameraReason),
          microphonePermission:   fill(TENANT_CONFIG.permissions.micReason),
          recordAudioPermission:  fill(TENANT_CONFIG.permissions.recordAudioReason),
        },
      ],
      [
        'expo-media-library',
        {
          photosPermission:      fill(TENANT_CONFIG.permissions.photosReason),
          savePhotosPermission:  fill(TENANT_CONFIG.permissions.savePhotosReason),
          isSelfHosted:          true,
        },
      ],
    ],
    extra: {
      router: {},
      eas: {
        projectId: TENANT_CONFIG.eas.projectId,
      },
      // Surface tenant identity to runtime code (used by api/supabase
      // and api/agora for bootstrap, since they can't `require` from
      // outside the bundle entry).
      tenant: {
        appName:            TENANT_CONFIG.appName,
        shareDomain:        TENANT_CONFIG.shareDomain,
        signupEmailDomain:  TENANT_CONFIG.signupEmailDomain,
      },
    },
    owner: TENANT_CONFIG.owner,
    runtimeVersion: {
      policy: 'appVersion',
    },
    updates: {
      url: TENANT_CONFIG.eas.updateUrl,
    },
  },
});
