import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  ANDROID_PERMISSION_GROUPS,
  GLOBAL_PERMISSION_ONBOARDING_KEY,
  getAndroidMediaPermissionNames,
  getAndroidMediaGranularPermissions,
} from './globalPermissionPolicy';

test('permission onboarding has a persisted, versioned storage key', () => {
  assert.match(GLOBAL_PERMISSION_ONBOARDING_KEY, /global-permissions\/v\d+$/);
  assert.deepEqual(ANDROID_PERMISSION_GROUPS.map(({ id }) => id), [
    'camera',
    'microphone',
    'location',
    'media',
  ]);
});

test('media permission policy follows Android storage API changes', () => {
  assert.deepEqual(getAndroidMediaPermissionNames(32), [
    'android.permission.READ_EXTERNAL_STORAGE',
  ]);
  assert.deepEqual(getAndroidMediaPermissionNames(33), [
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.READ_MEDIA_VIDEO',
    'android.permission.READ_MEDIA_AUDIO',
  ]);
  assert.deepEqual(getAndroidMediaPermissionNames(34), [
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.READ_MEDIA_VIDEO',
    'android.permission.READ_MEDIA_AUDIO',
    'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
  ]);
  assert.equal(getAndroidMediaGranularPermissions(32), undefined);
  assert.deepEqual(getAndroidMediaGranularPermissions(33), ['photo', 'video', 'audio']);
});

test('first launch directly opens native permission requests only once', () => {
  const hook = fs.readFileSync(
    path.join(process.cwd(), 'src/hooks/useGlobalPermissions.js'),
    'utf8',
  );
  assert.equal(hook.includes('Alert.alert'), false);
  assert.equal(hook.includes('showPermissionIntroduction'), false);
  assert.equal(hook.includes('showDenialSummary'), false);
  assert.ok(
    hook.indexOf("AsyncStorage.setItem(GLOBAL_PERMISSION_ONBOARDING_KEY, 'completed')")
      < hook.indexOf('for (const [id, getCurrent, request] of steps)'),
  );
});

test('Expo config and checked-in Android manifest declare every requested permission', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const appConfig = require('../../app.config')().expo;
  const declared = new Set(appConfig.android.permissions);
  [
    'CAMERA',
    'RECORD_AUDIO',
    'ACCESS_COARSE_LOCATION',
    'ACCESS_FINE_LOCATION',
    'READ_MEDIA_IMAGES',
    'READ_MEDIA_VIDEO',
    'READ_MEDIA_AUDIO',
    'READ_MEDIA_VISUAL_USER_SELECTED',
  ].forEach((permission) => assert.equal(declared.has(permission), true, permission));

  const manifest = fs.readFileSync(
    path.join(process.cwd(), 'android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );
  [
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.READ_MEDIA_VIDEO',
    'android.permission.READ_MEDIA_AUDIO',
  ].forEach((permission) => assert.equal(manifest.includes(permission), true, permission));
  assert.match(manifest, /READ_EXTERNAL_STORAGE[^>]+maxSdkVersion="32"/);
});
