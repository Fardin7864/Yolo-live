/**
 * brand.js
 * ========
 * Central brand-colour palette. Reads from tenant.config.js so a
 * single edit there shifts the palette for the whole app.
 *
 * USAGE
 *   import { BRAND } from '../theme/brand';
 *   <View style={{ backgroundColor: BRAND.primary }} />
 *
 * MIGRATION NOTE
 *   Some legacy screens still inline `#FF2E7E` (the old Yolo pink) or
 *   `#D946EF`. Replace those with BRAND.primary / BRAND.primaryAlt
 *   when you touch the surrounding code — see SAAS_ONBOARDING.md
 *   "Brand depth" for the recommended progression. Untouched legacy
 *   colours still work; they're just off-palette for Care Live.
 */
import { TENANT_CONFIG } from '../../tenant.config';

export const BRAND = {
  primary:      TENANT_CONFIG.primaryColor,    // Main accent (#1163C6 — Care Live blue)
  primaryAlt:   TENANT_CONFIG.primaryAlt,      // Gradient companion (#20C8C8 — cyan)
  splashBg:     TENANT_CONFIG.splashBg,        // Deep dark surface (#112E93)
  success:      TENANT_CONFIG.successColor,    // Claim / completed states (#8DEB53)
  warning:      TENANT_CONFIG.warningColor,    // Beans pill / caution (#FFA33A)
  error:        TENANT_CONFIG.errorColor,      // Failed states (#EC38C9 — magenta)

  // Extended accents — situational use, all driven from tenant.config
  // so future re-skins stay a single-file edit.
  vvip:         TENANT_CONFIG.vvipColor,       // Purple — premium / VVIP highlight
  coin:         TENANT_CONFIG.coinColor,       // Yellow — diamond / bean visual cue
  muted:        TENANT_CONFIG.mutedColor,      // Light blue — secondary surface tint
  textHigh:     TENANT_CONFIG.textHighColor,   // Off-white — body text on dark

  // Frequently-used semi-transparent shades derived from primary —
  // mirrors the inline rgba(X,Y,Z,A) usages scattered around the app.
  // Components can import these instead of writing the rgba literal
  // by hand. Care Live blue (#1163C6) gives soft, calming washes.
  primary10:    `${TENANT_CONFIG.primaryColor}1A`,  // ~10% alpha
  primary20:    `${TENANT_CONFIG.primaryColor}33`,  // ~20% alpha
  primary30:    `${TENANT_CONFIG.primaryColor}4D`,  // ~30% alpha
  primaryAlt20: `${TENANT_CONFIG.primaryAlt}33`,    // cyan-tinted hover/active
};
