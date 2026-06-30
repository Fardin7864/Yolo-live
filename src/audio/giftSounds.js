/**
 * Gift sound resolver
 * -------------------
 * Mirrors src/theme/giftAnimations.js but for SFX. Same constraint —
 * Metro can't dynamically require() a string at runtime, so every
 * bundled MP3 must appear in the BUNDLED map below.
 *
 *   `sound_url`  on the gifts row → fetched at runtime (admin can ship
 *                                    new sounds without an app build)
 *   `sound_path` on the gifts row → bundled key, resolved here
 *
 * Mapping strategy:
 *   - The DB `sound_path` is a CLEAN, ABSTRACT key (e.g. "audio/gifts/rose.mp3").
 *   - The require() points to the ACTUAL on-disk filename which is
 *     allowed to differ (descriptive search-keyword names from Pixabay,
 *     etc.). This indirection means if we ever rename files, only this
 *     map updates — the DB stays clean.
 *
 * Falls back to NULL when no key matches, so the broadcast send-gift
 * handler simply skips SFX rather than crashing.
 */

const BUNDLED = {
  // ─── Classic tier ───────────────────────────────────────────────
  'audio/gifts/rose.mp3':         require('../../assets/audio/magic sparkle short.mp3'),
  'audio/gifts/clap.mp3':         require('../../assets/audio/clap small applause.mp3'),
  'audio/gifts/lollipop.mp3':     require('../../assets/audio/cute pop bubble.mp3'),
  'audio/gifts/pigeon.mp3':       require('../../assets/audio/pigeon wing flap.mp3'),
  'audio/gifts/runner.mp3':       require('../../assets/audio/running fast whoosh.mp3'),
  'audio/gifts/heartbeat.mp3':    require('../../assets/audio/heartbeat romantic.mp3'),

  // ─── Premium tier ───────────────────────────────────────────────
  'audio/gifts/poop.mp3':         require('../../assets/audio/funny plop comedy.mp3'),
  'audio/gifts/love_blind.mp3':   require('../../assets/audio/romantic chime soft.mp3'),
  'audio/gifts/feel_in_love.mp3': require('../../assets/audio/harp glissando love.mp3'),
  'audio/gifts/gaming.mp3':       require('../../assets/audio/8bit level up retro.mp3'),
  'audio/gifts/ghost.mp3':        require('../../assets/audio/cute ghost boo.mp3'),
  'audio/gifts/violin.mp3':       require('../../assets/audio/violin short riff.mp3'),
  'audio/gifts/guitar.mp3':       require('../../assets/audio/acoustic guitar strum.mp3'),
  'audio/gifts/violin_male.mp3':  require('../../assets/audio/dramatic violin riff.mp3'),
  'audio/gifts/ghibli.mp3':       require('../../assets/audio/magical chime fairy.mp3'),
  'audio/gifts/totoro.mp3':       require('../../assets/audio/wood chime forest.mp3'),
  'audio/gifts/dancer.mp3':       require('../../assets/audio/dance beat short.mp3'),
  'audio/gifts/spider.mp3':       require('../../assets/audio/string pluck twang.mp3'),
  'audio/gifts/peace.mp3':        require('../../assets/audio/peaceful pad soft.mp3'),
  'audio/gifts/peacock.mp3':      require('../../assets/audio/exotic flute short.mp3'),

  // ─── Exclusive tier ─────────────────────────────────────────────
  'audio/gifts/plane.mp3':        require('../../assets/audio/jet flyby fast.mp3'),
  'audio/gifts/love_birds.mp3':   require('../../assets/audio/birds chirp magical.mp3'),
  'audio/gifts/racing_car.mp3':   require('../../assets/audio/car engine rev short.mp3'),
  'audio/gifts/luxury_car.mp3':   require('../../assets/audio/luxury car engine.mp3'),
  'audio/gifts/jet_departure.mp3':require('../../assets/audio/jet takeoff.mp3'),
  'audio/gifts/guardian.mp3':     require('../../assets/audio/shield power up.mp3'),
  'audio/gifts/wedding.mp3':      require('../../assets/audio/wedding bells fanfare.mp3'),
};

/**
 * Resolve a gift row to an expo-audio compatible source.
 * @param {object} gift  Row from the `gifts` table or merged GIFT_ITEMS shape.
 * @returns {{ uri: string } | number | null}  null if no sound is configured.
 */
export function resolveGiftSound(gift) {
  if (!gift) return null;

  // Remote URL takes priority — admin can ship sounds without an app build.
  const url = gift.sound_url;
  if (typeof url === 'string' && url.length > 0) {
    return { uri: url };
  }

  const path = gift.sound_path;
  if (path && BUNDLED[path]) return BUNDLED[path];

  return null;
}

export const BUNDLED_GIFT_SOUNDS = BUNDLED;
