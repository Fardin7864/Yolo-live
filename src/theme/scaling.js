import { Dimensions, PixelRatio } from 'react-native';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Guideline sizes are based on standard iPhone 11/12 screen
const guidelineBaseWidth = 375;
const guidelineBaseHeight = 812;

const horizontalScale = (size) => (SCREEN_WIDTH / guidelineBaseWidth) * size;
const verticalScale = (size) => (SCREEN_HEIGHT / guidelineBaseHeight) * size;
const moderateScale = (size, factor = 0.5) => size + (horizontalScale(size) - size) * factor;

/**
 * Responsive Scaling Utility
 * 
 * use horizontalScale for width, marginLeft, marginRight, paddingLeft, extra
 * use verticalScale for height, marginTop, marginBottom, paddingTop, line-height
 * use moderateScale for font-size, border-radius
 */
export { horizontalScale, verticalScale, moderateScale, SCREEN_WIDTH, SCREEN_HEIGHT };
