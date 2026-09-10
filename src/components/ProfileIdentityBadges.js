import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

const MEMBERSHIP_FRAMES = {
  VIP: require('../../assets/chat-identity/vip-membership.png'),
  VVIP: require('../../assets/chat-identity/vvip-membership.png'),
  SVIP: require('../../assets/chat-identity/svip-membership.png'),
};

const LEVEL_FRAMES = {
  normal: require('../../assets/chat-identity/normal-level.png'),
  VIP: require('../../assets/chat-identity/vip-level.png'),
  VVIP: require('../../assets/chat-identity/vvip-level.png'),
  SVIP: require('../../assets/chat-identity/svip-level.png'),
};

const NICKNAME_FRAMES = {
  VIP: require('../../assets/chat-identity/vip-name.png'),
  VVIP: require('../../assets/chat-identity/vvip-name.png'),
  SVIP: require('../../assets/chat-identity/svip-name.png'),
};

export default function ProfileIdentityBadges({ vipType, level = 1, nickname, centered = false }) {
  const rawTier = String(vipType || '').toUpperCase();
  const tier = ['VIP', 'VVIP', 'SVIP'].includes(rawTier) ? rawTier : null;
  const safeLevel = Math.max(1, Number(level) || 1);

  return (
    <View style={[styles.container, centered && styles.centered]}>
      <View style={[styles.row, centered && styles.centeredRow]}>
        {tier ? (
          <View style={[styles.plate, styles.membershipPlate]}>
            <Image source={MEMBERSHIP_FRAMES[tier]} style={styles.frame} resizeMode="stretch" />
            <Text style={styles.membershipText}>{tier}</Text>
          </View>
        ) : null}
        <View style={[styles.plate, styles.levelPlate]}>
          <Image source={LEVEL_FRAMES[tier || 'normal']} style={styles.frame} resizeMode="stretch" />
          <Text style={styles.levelText}>Lv.{safeLevel}</Text>
        </View>
      </View>

      {nickname ? (
        <View style={[styles.plate, styles.nicknamePlate]}>
          <Image source={tier ? NICKNAME_FRAMES[tier] : LEVEL_FRAMES.normal} style={styles.frame} resizeMode="stretch" />
          <Text style={styles.nicknameText} numberOfLines={1}>{nickname}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignSelf: 'flex-start', marginTop: 5 },
  centered: { alignSelf: 'center', alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 27 },
  centeredRow: { justifyContent: 'center' },
  plate: { alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
  frame: { ...StyleSheet.absoluteFillObject, width: undefined, height: undefined },
  membershipPlate: { width: 103, height: 27 },
  levelPlate: { width: 76, height: 27 },
  nicknamePlate: { width: 160, height: 32, marginTop: 2 },
  membershipText: { color: '#FFF', fontSize: 9, fontWeight: '900', marginLeft: 16, textShadowColor: '#000', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
  levelText: { color: '#FFF', fontSize: 9, fontWeight: '900', marginLeft: 10, textShadowColor: '#000', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
  nicknameText: { color: '#FFF', fontSize: 10, fontWeight: '800', maxWidth: 105, marginLeft: 22, textShadowColor: '#000', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
});
