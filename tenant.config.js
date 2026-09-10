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
  appName:   'Popular Live',               // Title under the launcher icon
  shortName: 'Popular Live',               // Short version used in tight UI
  bundleId:  'com.greenlive.app',          // Android applicationId / iOS bundle id — MUST be globally unique on the store
  scheme:    'green-live',                 // Deep-link scheme (green-live://path)
  slug:      'green-live',                 // Expo project slug — must match the linked EAS project. Display name comes from `appName`.
  owner:     'yoloteam',                   // EAS organisation/team account

  // ============================================================
  // 2. BRANDING — colours + share-link text
  // ============================================================
  // Existing product palette. Identity assets and display copy use Popular Live.
  primaryColor:   '#36B911',               // Green — primary CTAs, brand anchor
  primaryAlt:     '#19D6DB',               // Cyan — gradient companion
  splashBg:       '#061226',               // Deep navy — splash / dark surfaces
  successColor:   '#B5F600',               // Lime — claim ticks, success states
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
    url:     'https://wahnvplqftkqtvtpwztq.supabase.co',
    anonKey: 'sb_publishable_AziPqXs0b4ZRSe0PQNVThg_WU4yfyL0',
  },

  // Google Sign-In uses the native Google account picker. The Web client ID
  // is required so Google returns an ID token that Supabase can verify.
  googleAuth: {
    webClientId: '665156075474-r0lhhsfsrb5pi7h8cdtflc5snef3892e.apps.googleusercontent.com',
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
