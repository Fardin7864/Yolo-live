/**
 * LogoLoader — branded replacement for the system ActivityIndicator.
 *
 * Renders a looping GIF of the Yolo-live logo at a sensible size for
 * whatever surface the loader sits on:
 *
 *   <LogoLoader size="small"  />   40px — inline next to text (joining/loading rows)
 *   <LogoLoader size="medium" />   80px — page section loaders
 *   <LogoLoader size="large"  />   128px — full-screen "joining" / "starting" loaders
 *   <LogoLoader size={64} />        any pixel value
 *
 * Logos need more visual space than a hairline ActivityIndicator spinner
 * to read as the brand — the defaults below are deliberately chunkier
 * than the system spinner sizes they replaced.
 *
 * Why a single component instead of dropping <Image> everywhere:
 *   - One source of truth for the GIF asset — if the logo updates,
 *     we change one require() statement.
 *   - Consistent sizing taxonomy so screens don't drift to bespoke
 *     pixel values that look mismatched next to each other.
 *   - A simple swap path from ActivityIndicator — same prop shape
 *     (size, color/tint) so the diff stays minimal.
 *
 * Performance:
 *   The GIF is required() once at module-load time; React Native
 *   caches the decoded frames so mounting the loader on many screens
 *   doesn't re-decode. fadeDuration={0} skips the cross-fade on first
 *   paint so it appears instantly.
 */
import React from 'react';
import { Image, View, StyleSheet } from 'react-native';

// The required source — Metro inlines this at build time, so the GIF
// MUST exist at this path before bundling. If you see "Cannot find
// module 'assets/loader/logo-loader.gif'" during dev, drop the file
// in place and restart Metro.
const LOGO_SOURCE = require('../../assets/popular-live-logo.png');

const SIZE_MAP = {
  small:  40,
  medium: 80,
  large:  128,
};

function resolveSize(input) {
  if (typeof input === 'number') return input;
  return SIZE_MAP[input] || SIZE_MAP.medium;
}

/**
 * @param {object} props
 * @param {'small'|'medium'|'large'|number} [props.size='medium']  Diameter in dp or a preset.
 * @param {string} [props.tint]                                    Optional iOS-only tint colour
 *                                                                 applied to the image.
 * @param {object} [props.style]                                   Extra style overrides for the
 *                                                                 wrapper View (centring, margin).
 */
export default function LogoLoader({ size = 'medium', tint, style }) {
  const dim = resolveSize(size);
  return (
    <View style={[styles.wrap, style]}>
      <Image
        source={LOGO_SOURCE}
        // `contain` keeps a square logo crisp at any size; `cover` would
        // crop the edges on non-square loaders.
        resizeMode="contain"
        fadeDuration={0}
        style={[
          { width: dim, height: dim },
          tint ? { tintColor: tint } : null,
        ]}
        accessibilityLabel="Loading"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems:    'center',
    justifyContent:'center',
  },
});
