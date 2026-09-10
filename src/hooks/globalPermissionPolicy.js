export const GLOBAL_PERMISSION_ONBOARDING_VERSION = 1;
export const GLOBAL_PERMISSION_ONBOARDING_KEY =
  `@popular-live/global-permissions/v${GLOBAL_PERMISSION_ONBOARDING_VERSION}`;

export const ANDROID_PERMISSION_GROUPS = Object.freeze([
  Object.freeze({ id: 'camera', label: 'Camera' }),
  Object.freeze({ id: 'microphone', label: 'Microphone' }),
  Object.freeze({ id: 'location', label: 'Location' }),
  Object.freeze({ id: 'media', label: 'Photos, videos and audio' }),
]);

export function getAndroidMediaPermissionNames(apiLevel) {
  if (Number(apiLevel) >= 33) {
    return [
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_AUDIO',
      ...(Number(apiLevel) >= 34
        ? ['android.permission.READ_MEDIA_VISUAL_USER_SELECTED']
        : []),
    ];
  }
  return ['android.permission.READ_EXTERNAL_STORAGE'];
}

export function getAndroidMediaGranularPermissions(apiLevel) {
  return Number(apiLevel) >= 33 ? ['photo', 'video', 'audio'] : undefined;
}
