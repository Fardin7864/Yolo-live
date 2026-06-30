import React, { useEffect, useRef } from 'react';
import { View, Image, Animated, Easing, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

/**
 * Tier-themed gradient avatar with a slow rotating ring + tier badge.
 *
 * `intense=true` adds a stronger outer glow and a slow-pulsing aura for
 * use in the entrance banner where the VIP needs presence ("ভাব").
 */
const TIER = {
  VVIP: {
    colors: ['#F472B6', '#A855F7', '#3B82F6', '#A855F7', '#F472B6'],
    badge: 'diamond',
    badgeColor: '#D946EF',
    glow: 'rgba(217, 70, 239, 0.55)',
  },
  SVIP: {
    colors: ['#FCD34D', '#F59E0B', '#FBBF24', '#F59E0B', '#FCD34D'],
    badge: 'shield-checkmark',
    badgeColor: '#F59E0B',
    glow: 'rgba(245, 158, 11, 0.5)',
  },
  VIP: {
    colors: ['#E5E7EB', '#9CA3AF', '#CBD5E1', '#9CA3AF', '#E5E7EB'],
    badge: 'star',
    badgeColor: '#94A3B8',
    glow: 'rgba(148, 163, 184, 0.45)',
  },
};

export default function VipAvatar({
  uri,
  vipType = 'VIP',
  size = 44,
  showBadge = true,
  intense = false,
  bgColor = '#0E111E',
}) {
  const rotate = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const config = TIER[vipType] || TIER.VIP;

  useEffect(() => {
    Animated.loop(
      Animated.timing(rotate, {
        toValue: 1,
        duration: 5000,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    ).start();

    if (intense) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 0, duration: 1200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ])
      ).start();
    }
  }, [intense]);

  const ringSize = size + (intense ? 12 : 8);
  const innerSize = size;
  const avatarSize = size - (intense ? 8 : 6);
  const badgeSize = Math.max(14, Math.round(size / 3.2));
  const ringRotate = rotate.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] });
  const pulseOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] });

  return (
    <View
      style={{
        width: ringSize + (intense ? 18 : 0),
        height: ringSize + (intense ? 18 : 0),
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      {/* Pulsing outer aura (intense only) */}
      {intense && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: ringSize + 26,
            height: ringSize + 26,
            borderRadius: (ringSize + 26) / 2,
            backgroundColor: config.glow,
            opacity: pulseOpacity,
            transform: [{ scale: pulseScale }],
          }}
        />
      )}

      {/* Static soft glow */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          width: ringSize + (intense ? 14 : 6),
          height: ringSize + (intense ? 14 : 6),
          borderRadius: (ringSize + (intense ? 14 : 6)) / 2,
          backgroundColor: config.glow,
          opacity: intense ? 0.45 : 0.25,
        }}
      />

      {/* Rotating gradient ring */}
      <Animated.View
        style={{
          position: 'absolute',
          width: ringSize,
          height: ringSize,
          transform: [{ rotate: ringRotate }],
        }}
      >
        <LinearGradient
          colors={config.colors}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ width: ringSize, height: ringSize, borderRadius: ringSize / 2 }}
        />
      </Animated.View>

      {/* Inner dark mask — creates the "ring" gap between gradient + avatar */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          width: innerSize,
          height: innerSize,
          borderRadius: innerSize / 2,
          backgroundColor: bgColor,
        }}
      />

      {/* Avatar */}
      <Image
        source={{ uri }}
        style={{ width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2 }}
      />

      {/* Tier badge */}
      {showBadge && (
        <View
          style={[
            styles.badge,
            {
              width: badgeSize,
              height: badgeSize,
              borderRadius: badgeSize / 2,
              borderColor: config.badgeColor,
              backgroundColor: bgColor,
            },
          ]}
        >
          <Ionicons name={config.badge} size={badgeSize - 8} color={config.badgeColor} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
  },
});