/**
 * Gift animation resolver
 * -----------------------
 * The mobile bundle can't dynamically require() a Lottie JSON at runtime —
 * Metro statically analyses every require call at build time, so a string
 * coming from the database (e.g. "animation/Rose.json") can never become a
 * live module reference.
 *
 * The pattern used here:
 *
 *   1. We keep ONE static map below from `animation_path` → require(...).
 *      Every Lottie JSON shipped in the binary must be listed here.
 *   2. The `gifts` table column `animation_path` stores the SAME key the
 *      map uses, so a DB row written by the admin panel maps cleanly to
 *      a bundled asset.
 *   3. `animation_url` (column on the same table) takes priority — it's
 *      a Supabase Storage URL that LottieView can fetch at runtime.
 *      This lets the admin ship NEW gifts after launch without a new app
 *      build.
 *
 * Usage from a component:
 *
 *   import { resolveGiftAnimation } from '../theme/giftAnimations';
 *
 *   const src = resolveGiftAnimation(gift);   // returns a Lottie source
 *   <LottieView source={src} autoPlay ... />
 *
 * Falls back to the Rose animation when nothing matches, so a missing
 * mapping degrades gracefully instead of crashing the gift menu.
 */

const BUNDLED = {
  // ─── Classic tier — cheap, looping gifts ───────────────────────────
  'animation/Rose.json':                              require('../../assets/animation/Rose.json'),
  'animation/rose flower.json':                       require('../../assets/animation/rose flower.json'),
  'animation/Pudgy Clap.json':                        require('../../assets/animation/Pudgy Clap.json'),
  'animation/Lollipop candy.json':                    require('../../assets/animation/Lollipop candy.json'),
  'animation/running pigeon.json':                    require('../../assets/animation/running pigeon.json'),
  'animation/Run Animation.json':                     require('../../assets/animation/Run Animation.json'),
  'animation/Heart Beating.json':                     require('../../assets/animation/Heart Beating.json'),

  // ─── Premium tier — themed mid-impact gifts ────────────────────────
  'animation/the world is poop.json':                 require('../../assets/animation/the world is poop.json'),
  'animation/Love is blind.json':                     require('../../assets/animation/Love is blind.json'),
  'animation/Feel in love.json':                      require('../../assets/animation/Feel in love.json'),
  'animation/gaming.json':                            require('../../assets/animation/gaming.json'),
  'animation/ghost.json':                             require('../../assets/animation/ghost.json'),
  'animation/violin.json':                            require('../../assets/animation/violin.json'),
  'animation/Guitar.json':                            require('../../assets/animation/Guitar.json'),
  'animation/Violin male.json':                       require('../../assets/animation/Violin male.json'),
  'animation/Gibli Tribute.json':                     require('../../assets/animation/Gibli Tribute.json'),
  'animation/Totoro Walk.json':                       require('../../assets/animation/Totoro Walk.json'),
  'animation/dancer-woman.json':                      require('../../assets/animation/dancer-woman.json'),
  'animation/Spider.json':                            require('../../assets/animation/Spider.json'),
  'animation/no war.json':                            require('../../assets/animation/no war.json'),
  'animation/peacock.json':                           require('../../assets/animation/peacock.json'),

  // ─── Exclusive tier — full-screen dramatic gifts ───────────────────
  'animation/Plane.json':                             require('../../assets/animation/Plane.json'),
  'animation/Bird pair love and flying sky.json':     require('../../assets/animation/Bird pair love and flying sky.json'),
  'animation/racing-car.json':                        require('../../assets/animation/racing-car.json'),
  'animation/Car Animation1.json':                    require('../../assets/animation/Car Animation1.json'),
  'animation/airplane-departure.json':                require('../../assets/animation/airplane-departure.json'),
  // "Guardian" gift is the AK47 asset under a safer name. We keep the
  // file as-is so we don't redownload, but the gift in /gifts shows as
  // "Guardian" and the icon is rebranded as a shield-style protection
  // gift — same animation, Play-Store-safe label.
  'animation/AK47.json':                              require('../../assets/animation/AK47.json'),
  // Wedding ships under the corrected filename now; the legacy typo key
  // is kept so already-seeded DB rows still resolve until they get
  // re-edited in the admin panel.
  'animation/wedding.json':                           require('../../assets/animation/wedding.json'),
  'animation/weddibng.json':                          require('../../assets/animation/wedding.json'),

  // ─── VIP profile-frame animations (reserved for future VIP feature,
  //     not sendable gifts). Listed so the admin can wire them to a
  //     future profile_frames table without an app deploy.
  'animation/Profile Avatar.json':                    require('../../assets/animation/Profile Avatar.json'),
  'animation/Profile Avatar  vip.json':               require('../../assets/animation/Profile Avatar  vip.json'),
  'animation/Profile Avatar  vvip.json':              require('../../assets/animation/Profile Avatar  vvip.json'),
};

// Sensible default used when neither animation_url nor animation_path
// resolves — keeps the LottieView mounted instead of crashing the menu.
const FALLBACK = BUNDLED['animation/Rose.json'];

/**
 * @param {object} gift  Row from the `gifts` table (or local GIFT_ITEMS).
 *                       Expected shape: { animation_url, animation_path, source }
 * @returns {{ uri: string } | number} A valid LottieView `source`.
 */
export function resolveGiftAnimation(gift) {
  if (!gift) return FALLBACK;

  // Inline `source` from the legacy hardcoded GIFT_ITEMS array — already a
  // require() reference, just hand it through.
  if (gift.source) return gift.source;

  // Remote storage URL takes priority so new admin-uploaded gifts work
  // without an app update.
  const url = gift.animation_url;
  if (typeof url === 'string' && url.length > 0) {
    return { uri: url };
  }

  const path = gift.animation_path;
  if (path && BUNDLED[path]) return BUNDLED[path];

  return FALLBACK;
}

export const BUNDLED_GIFT_ANIMATIONS = BUNDLED;
