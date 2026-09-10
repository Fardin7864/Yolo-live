import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assignedIntroFromProfile,
  introSourceKey,
  normalizeIntroSource,
  resolveAssignedIntroFromPackageCatalogs,
  shouldUseIntroFallback,
} from './introPlaybackPolicy';

test('fresh admin intro assignment overrides stale in-memory profile data', () => {
  assert.deepEqual(assignedIntroFromProfile({
    id: 'user-1',
    full_name: 'Admin intro user',
    selected_mall_intro: 'dragon',
    selected_mall_intro_video_url: ' https://cdn.example.com/dragon.mp4 ',
    selected_mall_intro_thumbnail_url: null,
  }, {
    id: 'user-1',
    name: 'Old name',
    selectedMallIntro: null,
    selectedMallIntroVideoUrl: null,
    selectedMallIntroThumbnailUrl: 'https://cdn.example.com/old.webp',
  }), {
    id: 'user-1',
    name: 'Admin intro user',
    selectedMallIntro: 'dragon',
    selectedMallIntroVideoUrl: ' https://cdn.example.com/dragon.mp4 ',
    selectedMallIntroThumbnailUrl: null,
  });
});

test('fresh admin unequip clears a stale cached intro assignment', () => {
  const assignment = assignedIntroFromProfile({
    id: 'user-1',
    selected_mall_intro: null,
    selected_mall_intro_video_url: null,
    selected_mall_intro_thumbnail_url: null,
  }, {
    id: 'user-1',
    selectedMallIntro: 'old-intro',
    selectedMallIntroVideoUrl: 'https://cdn.example.com/old.mp4',
  });
  assert.equal(assignment.selectedMallIntro, null);
  assert.equal(assignment.selectedMallIntroVideoUrl, null);
});

test('intro sources trim stored URLs and repair scheme-relative personal URLs', () => {
  assert.deepEqual(normalizeIntroSource('  //cdn.example.com/personal.mp4  '), {
    uri: 'https://cdn.example.com/personal.mp4',
  });
  assert.deepEqual(normalizeIntroSource({ uri: ' https://cdn.example.com/standard.mp4 ' }), {
    uri: 'https://cdn.example.com/standard.mp4',
  });
});

test('intro resolution rejects empty sources and keeps bundled assets', () => {
  assert.equal(normalizeIntroSource('  '), null);
  assert.equal(normalizeIntroSource(null), null);
  assert.equal(normalizeIntroSource(42), 42);
});

test('a failed personal intro uses a distinct bundled fallback only once', () => {
  const personal = { uri: 'https://cdn.example.com/personal.mp4' };
  assert.equal(shouldUseIntroFallback(personal, 42), true);
  assert.equal(shouldUseIntroFallback(42, 42), false);
  assert.equal(introSourceKey(personal), '{"uri":"https://cdn.example.com/personal.mp4"}');
});

test('legacy package intro IDs resolve without denormalized profile URLs', () => {
  assert.deepEqual(resolveAssignedIntroFromPackageCatalogs({
    introId: 'vip:gold:intro',
    vipSubscriptions: [{
      id: 'gold',
      intro_video_url: 'bundled://football-cup.m4v',
      intro_thumbnail_url: 'bundled://football-cup.webp',
    }],
  }), {
    introId: 'vip:gold:intro',
    videoUrl: 'bundled://football-cup.m4v',
    thumbnailUrl: 'bundled://football-cup.webp',
  });

  assert.equal(resolveAssignedIntroFromPackageCatalogs({
    introId: 'svip:royal:intro:2',
    svipSubscriptions: [{ id: 'royal', intro2_video_url: 'bundled://blue-roses.m4v' }],
  }).videoUrl, 'bundled://blue-roses.m4v');
});

test('personal intro IDs remain fallbackable when catalog URL is unavailable', () => {
  assert.deepEqual(resolveAssignedIntroFromPackageCatalogs({ introId: 'personal-intro-id' }), {
    introId: 'personal-intro-id',
    videoUrl: null,
    thumbnailUrl: null,
  });
});
