export const ANNOUNCEMENT_FRAMES = [
  require('../../assets/notifications/announcement-frame-1.webp'),
  require('../../assets/notifications/announcement-frame-2.webp'),
  require('../../assets/notifications/announcement-frame-3.webp'),
  require('../../assets/notifications/announcement-frame-4.webp'),
  require('../../assets/notifications/announcement-frame-5.webp'),
  require('../../assets/notifications/announcement-frame-6.webp'),
  require('../../assets/notifications/announcement-frame-7.webp'),
];

export const BOT_PROFILE_IMAGES = [
  require('../../assets/bot-profiles/profile-01.webp'),
  require('../../assets/bot-profiles/profile-02.webp'),
  require('../../assets/bot-profiles/profile-03.webp'),
  require('../../assets/bot-profiles/profile-04.webp'),
  require('../../assets/bot-profiles/profile-05.webp'),
  require('../../assets/bot-profiles/profile-06.webp'),
  require('../../assets/bot-profiles/profile-07.webp'),
  require('../../assets/bot-profiles/profile-08.webp'),
  require('../../assets/bot-profiles/profile-09.webp'),
  require('../../assets/bot-profiles/profile-10.webp'),
  require('../../assets/bot-profiles/profile-11.webp'),
  require('../../assets/bot-profiles/profile-12.webp'),
  require('../../assets/bot-profiles/profile-13.webp'),
  require('../../assets/bot-profiles/profile-14.webp'),
  require('../../assets/bot-profiles/profile-15.webp'),
  require('../../assets/bot-profiles/profile-16.webp'),
  require('../../assets/bot-profiles/profile-17.webp'),
  require('../../assets/bot-profiles/profile-18.webp'),
  require('../../assets/bot-profiles/profile-19.webp'),
  require('../../assets/bot-profiles/profile-20.webp'),
  require('../../assets/bot-profiles/profile-21.webp'),
  require('../../assets/bot-profiles/profile-22.webp'),
  require('../../assets/bot-profiles/profile-23.webp'),
  require('../../assets/bot-profiles/profile-24.webp'),
  require('../../assets/bot-profiles/profile-25.webp'),
];

export const stableAssetIndex = (identity, length) => {
  const value = String(identity || 'announcement');
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % Math.max(1, length);
};

export const announcementFrameFor = (identity) => (
  ANNOUNCEMENT_FRAMES[stableAssetIndex(identity, ANNOUNCEMENT_FRAMES.length)]
);

export const botProfileFor = (identity) => (
  BOT_PROFILE_IMAGES[stableAssetIndex(identity, BOT_PROFILE_IMAGES.length)]
);
