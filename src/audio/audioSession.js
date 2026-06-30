/**
 * Audio session configuration
 * ---------------------------
 * Called once at app start from app/_layout.js. expo-audio's defaults
 * are sensible for music apps but wrong for a live-streaming gift
 * SFX scenario:
 *
 *   iOS default:    SFX is silenced when the ringer switch is on
 *                   (`playsInSilentMode: false`). For gift SFX users
 *                   expect to hear the celebration even on silent —
 *                   it's a UI affordance, not music. So we flip it on.
 *
 *   Android default: when another app (Spotify) is playing, our SFX
 *                    grabs full audio focus. That's antisocial. We
 *                    switch to `duckOthers` so background music dips
 *                    for ~1s while our SFX plays, then comes back.
 *
 * `staysActiveInBackground: false` is intentional — if the user
 * switches apps mid-gift, the sound should stop with everything else.
 *
 * Retry strategy: on some Android versions (notably MIUI / OxygenOS
 * customisations) the very first setAudioModeAsync call right at app
 * start can lose to the system's audio service still booting and
 * silently fail. We retry up to 3 times with exponential backoff;
 * if all retries fail we accept the platform defaults and move on
 * (gift SFX will still play, just won't duck other audio cleanly).
 */
import * as Audio from 'expo-audio';

let configured = false;

const MODE = {
  playsInSilentMode:           true,            // iOS — let SFX through silent switch
  shouldPlayInBackground:      false,
  interruptionMode:            'mixWithOthers', // baseline — coexist
  interruptionModeAndroid:     'duckOthers',    // Android — duck Spotify etc
  allowsRecordingIOS:          false,
  shouldRouteThroughEarpiece:  false,
};

async function tryConfigure(attempt = 1) {
  try {
    await Audio.setAudioModeAsync(MODE);
    if (__DEV__ && attempt > 1) {
      console.log(`[audioSession] configured on attempt ${attempt}`);
    }
    return true;
  } catch (err) {
    if (__DEV__) {
      console.warn(`[audioSession] attempt ${attempt} failed:`, err?.message || err);
    }
    if (attempt >= 3) return false;
    // 200ms, 600ms backoff before next attempt — covers the system
    // audio service warm-up window without taking long enough to
    // matter on app start.
    await new Promise((r) => setTimeout(r, attempt * 200 + 100));
    return tryConfigure(attempt + 1);
  }
}

export function configureAudioSession() {
  if (configured) return;
  configured = true;
  // Fire and forget — the caller doesn't await this.
  tryConfigure().then((ok) => {
    if (!ok && __DEV__) {
      console.warn('[audioSession] gave up after 3 attempts; using OS defaults');
    }
  });
}
