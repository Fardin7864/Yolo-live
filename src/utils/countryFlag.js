/**
 * countryFlag.js
 * ==============
 * Maps a country NAME (as stored in profiles.country, picked from the
 * CountryModal in edit-profile) to a Unicode flag emoji that renders
 * on the home-grid live cards (bottom-right corner of the card).
 *
 * Keep this list in lock-step with src/components/auth/CountryModal.js
 * — every entry there should have a corresponding flag here. Returns
 * an empty string when the country isn't recognised so the card just
 * skips rendering the flag (no broken question-mark glyph).
 */

const COUNTRY_FLAGS = {
  // Currently-shipped audience markets — match CountryModal.js entries
  'Bangladesh':   '🇧🇩',
  'Saudi Arabia': '🇸🇦',
  'UAE (Dubai)':  '🇦🇪',
  'Malaysia':     '🇲🇾',
  'Qatar':        '🇶🇦',
  'Oman':         '🇴🇲',

  // Common neighbours / future expansion — covered defensively in case
  // the picker grows. Add more as CountryModal grows.
  'India':        '🇮🇳',
  'Pakistan':     '🇵🇰',
  'Nepal':        '🇳🇵',
  'Sri Lanka':    '🇱🇰',
  'Indonesia':    '🇮🇩',
  'Philippines':  '🇵🇭',
  'Egypt':        '🇪🇬',
  'Kuwait':       '🇰🇼',
  'Bahrain':      '🇧🇭',
  'Jordan':       '🇯🇴',
};

export function flagFor(countryName) {
  if (!countryName) return '';
  return COUNTRY_FLAGS[countryName] || '';
}
