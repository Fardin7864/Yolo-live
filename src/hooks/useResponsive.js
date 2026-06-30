import { useWindowDimensions } from 'react-native';

/**
 * Returns breakpoint flags + helpful sizing primitives that adapt when
 * the device rotates or screen size changes (e.g. tablet split-screen).
 *
 * Breakpoints:
 *   phone        : width <  600
 *   tablet       : width >= 600 && < 900
 *   largeTablet  : width >= 900
 *
 * `maxContentWidth` is meant for centered cards / forms on tablets so
 * text lines don't stretch awkwardly wide.
 */
export function useResponsive() {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;

  let device = 'phone';
  if (width >= 900)      device = 'largeTablet';
  else if (width >= 600) device = 'tablet';

  const isPhone       = device === 'phone';
  const isTablet      = device === 'tablet' || device === 'largeTablet';
  const isLargeTablet = device === 'largeTablet';

  // Recommended cap for centered single-column content on tablets
  const maxContentWidth = isLargeTablet ? 720 : isTablet ? 600 : width;

  // Grid columns for a 2-up-on-phone, 3-up-on-tablet, 4-up-on-large-tablet feed
  const gridColumns = isLargeTablet ? 4 : isTablet ? 3 : 2;

  return {
    width, height, isLandscape,
    device, isPhone, isTablet, isLargeTablet,
    maxContentWidth, gridColumns,
  };
}