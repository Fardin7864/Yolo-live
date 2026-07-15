import React from 'react';
import { View, Text, Image, StyleSheet, TouchableOpacity, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { BRAND } from '../../theme/brand';
import { flagFor } from '../../utils/countryFlag';
import SvipNameTag from '../SvipNameTag';

const { width } = Dimensions.get('window');
const CARD_WIDTH = (width - 48) / 2; // 2-col grid with 16px outer + 16px gutter

const StreamCard = ({ stream, siblings, myIdx, isCelebrity = false }) => {
  const router = useRouter();

  const handleJoin = () => {
    router.push({
      pathname: `/broadcast/${stream.id}`,
      params: {
        type:     stream.streamType,
        siblings: Array.isArray(siblings) ? siblings.join(',') : '',
        myIdx:    typeof myIdx === 'number' ? String(myIdx) : '',
      },
    });
  };

  const viewerLabel = stream.viewerCount >= 1000
    ? `${(stream.viewerCount / 1000).toFixed(1)}k`
    : String(stream.viewerCount || 0);
  const flag = flagFor(stream.country);

  return (
    <TouchableOpacity activeOpacity={0.9} style={styles.outer} onPress={handleJoin}>
      {/* The visual card — cover image fills the frame with badges on top */}
      <View style={styles.card}>
        <Image source={{ uri: stream.coverUrl }} style={styles.image} />

        {/* Top-right: CELEBRITY badge (gold pill, only for top-5% earners) */}
        {isCelebrity && (
          <View style={styles.celebrityWrap}>
            <LinearGradient
              colors={['#FFD43A', '#FFA33A']}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              style={styles.celebrityPill}
            >
              <Ionicons name="star" size={9} color="#7A4500" />
              <Text style={styles.celebrityText}>CELEBRITY</Text>
            </LinearGradient>
          </View>
        )}

        {/* Bottom-left: Live + viewer count pill (matches reference brown chip) */}
        <View style={styles.liveBadge}>
          <Ionicons
            name={stream.streamType === 'audio' ? 'mic' : 'home'}
            size={11}
            color="#FFF"
          />
          <Text style={styles.liveBadgeText}>Live</Text>
          <View style={styles.viewerDivider} />
          <Ionicons name="person" size={10} color="#FFF" />
          <Text style={styles.viewerNum}>{viewerLabel}</Text>
        </View>

        {/* Bottom-right: country flag — silent skip if unknown */}
        {!!flag && (
          <View style={styles.flagWrap}>
            <Text style={styles.flagEmoji}>{flag}</Text>
          </View>
        )}
      </View>

      {/* Below the card: tiny avatar + host name (reference layout) */}
      <View style={styles.hostRow}>
        <Image
          source={{ uri: stream.broadcasterAvatar || `https://i.pravatar.cc/80?u=${stream.id}` }}
          style={styles.hostAvatar}
        />
        <Text style={styles.hostName} numberOfLines={1}>
          ☆{stream.broadcasterName}
        </Text>
        <SvipNameTag vipType={stream.vipType} compact />
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  outer: {
    width: CARD_WIDTH,
    marginBottom: 14,
  },

  card: {
    width: CARD_WIDTH,
    height: CARD_WIDTH * 1.05, // close to square — matches the reference
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#E5E7EB',
  },
  image: { width: '100%', height: '100%', resizeMode: 'cover' },

  // CELEBRITY badge — gold gradient pill, top-right
  celebrityWrap: { position: 'absolute', top: 6, right: 6 },
  celebrityPill: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 7, paddingVertical: 2.5,
    borderRadius: 999,
    gap: 3,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.25, shadowRadius: 2,
    elevation: 2,
  },
  celebrityText: {
    color: '#7A4500',
    fontSize: 8.5,
    fontWeight: '900',
    letterSpacing: 0.4,
  },

  // Bottom-left brown Live pill — reference uses muted brown, on-brand here
  liveBadge: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(78, 51, 25, 0.82)',
    paddingHorizontal: 7,
    paddingVertical: 3.5,
    borderRadius: 7,
    gap: 3,
  },
  liveBadgeText: { color: '#FFF', fontSize: 10, fontWeight: '700' },
  viewerDivider: { width: 1, height: 9, backgroundColor: 'rgba(255,255,255,0.35)', marginHorizontal: 2 },
  viewerNum: { color: '#FFF', fontSize: 10, fontWeight: '700' },

  // Country flag — small square chip bottom-right
  flagWrap: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    width: 22,
    height: 16,
    borderRadius: 3,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  flagEmoji: { fontSize: 14 },

  // Below-card host row
  hostRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    paddingHorizontal: 2,
    gap: 6,
  },
  hostAvatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#E5E7EB',
  },
  hostName: {
    color: '#374151',
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
  },
});

export default StreamCard;
