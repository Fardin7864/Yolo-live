/**
 * tenant.config.js
 * ================
 * Single source of truth for every tenant-specific value in the app.
 * Per-tenant deployment = edit THIS file, swap a couple of assets,
 * build. Nothing else.
 *
 * IMPORTANT: After editing this file you MUST do a clean rebuild
 * (`npx expo start --clear` or `eas build`). app.config.js and the
 * Supabase client both pull from this at build / cold-start time —
 * a Fast Refresh alone will not propagate the change.
 *
 * Read by:
 *   - app.config.js              → app name, bundle id, splash colour, EAS ids
 *   - src/api/supabase.js        → backend URL + anon key
 *   - src/api/agora.js           → derived Agora-token edge function URL
 *   - src/theme/brand.js         → primary / accent colours for new code
 *   - app/broadcast/[id].js      → share link text
 *   - app/auth/signup.js         → phone-as-email domain
 */

const TENANT_CONFIG = {
  // ============================================================
  // 1. IDENTITY — Play Store + OS-level
  // ============================================================
  appName:   'Care Live',                  // Title under the launcher icon
  shortName: 'Care Live',                  // Short version used in tight UI
  bundleId:  'com.carelive.app',           // Android applicationId / iOS bundle id — MUST be globally unique on the store
  scheme:    'care-live',                  // Deep-link scheme (care-live://path)
  slug:      'care-live',                  // Expo project slug — must match the linked EAS project. Display name comes from `appName`.
  owner:     'yoloteam',                   // EAS organisation/team account

  // ============================================================
  // 2. BRANDING — colours + share-link text
  // ============================================================
  // Care Live palette — Senior-visualisation pick from the brand
  // colour board. The primary→alt gradient (deep blue → cyan) reads
  // as "trust + freshness" on a dark surface, matching the "care"
  // identity without going saccharine. Accents (purple/yellow/etc.)
  // live in src/theme/brand.js for situational use (VVIP tier,
  // coin pills, light surfaces).
  primaryColor:   '#1163C6',               // Blue — primary CTAs, brand anchor
  primaryAlt:     '#20C8C8',               // Cyan — gradient companion
  splashBg:       '#112E93',               // Dark blue — splash / dark surfaces
  successColor:   '#8DEB53',               // Green — claim ticks, success states
  warningColor:   '#FFA33A',               // Orange — caution / warning pills
  errorColor:     '#EC38C9',               // Magenta — error states (on-brand vs. generic red)

  // Extended palette — exposed via src/theme/brand.js for new screens
  // that want richer surface variation. Keep them in tenant.config so
  // future re-skins stay a one-file edit.
  vvipColor:      '#8E4AD7',               // Purple — VVIP tier badge / premium
  coinColor:      '#FFD43A',               // Yellow — diamonds / beans visual cue
  mutedColor:     '#C5DDF0',               // Light blue — secondary surface tint
  textHighColor:  '#F2F2F2',               // Off-white — body text on dark surfaces

  // What the share button puts in the user's clipboard / message body.
  shareDomain:        'https://yolo.app',  // ${shareDomain}/live/<broadcasterId>

  // CRITICAL: signup uses "phone@signupEmailDomain" as the Supabase
  // auth email because we don't have real SMS OTP yet. Kept on the
  // legacy domain so existing user accounts keep resolving.
  signupEmailDomain:  'yolo.app',

  // ============================================================
  // 3. BACKEND — Supabase + EAS
  // ============================================================
  supabase: {
    url:     'https://pfuclgmmcpzvnzapktou.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmdWNsZ21tY3B6dm56YXBrdG91Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2NDUyMjgsImV4cCI6MjA5MzIyMTIyOH0.wNzz8_ZTw7m9_Qiikg9vM7mP7eh15YEjjsjJpYC3oz8',
  },

  // Google Sign-In uses the native Google account picker. The Web client ID
  // is still required because Supabase verifies the ID token Google returns;
  // no browser redirect is involved.
  googleAuth: {
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || '',
    iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || '',
  },

  eas: {
    projectId: '5eb8efa6-3b5d-4fb2-9ab0-5ec60e95ce25',
    updateUrl: 'https://u.expo.dev/5eb8efa6-3b5d-4fb2-9ab0-5ec60e95ce25',
  },

  // ============================================================
  // 4. PERMISSIONS — strings shown in OS dialogs
  // ============================================================
  permissions: {
    cameraReason:        'Allow %appName% to access your camera',
    micReason:           'Allow %appName% to access your microphone',
    recordAudioReason:   'Allow %appName% to record audio',
    photosReason:        'Allow %appName% to access your photos',
    savePhotosReason:    'Allow %appName% to save photos',
  },
};

module.exports = { TENANT_CONFIG };
