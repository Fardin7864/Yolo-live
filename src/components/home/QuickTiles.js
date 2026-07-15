/**
 * QuickTiles
 * ==========
 * Three colourful jump-off tiles that sit between the top banner and
 * the live grid on the home tab. Style matches the Streamkar-style
 * reference: rounded squares with a bright gradient + an icon glyph +
 * a label, three abreast across the screen.
 *
 * The destinations are existing screens — swap the route/icon/label
 * here to point at a different feature without touching the home
 * page itself.
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';

const { width } = Dimensions.get('window');
// 16px outer padding on each side + 10px gaps between four tiles.
const TILE_W = Math.floor((width - 32 - 30) / 4);

const TILES = [
  {
    key:    'tasks',
    label:  'Tasks',
    icon:   'gift',
    colors: ['#FF6BCB', '#EC38C9'],         // pink → magenta
    route:  '/main/tasks',
  },
  {
    key:    'vip',
    label:  'VIP',
    icon:   'star',
    colors: ['#FFD43A', '#FFA33A'],         // yellow → orange
    route:  '/main/vip',
  },
  {
    key:    'svip',
    label:  'SVIP',
    icon:   'shield-checkmark',
    colors: ['#FCD34D', '#F59E0B'],
    route:  '/main/svip',
  },
  {
    key:    'network',
    label:  'Network',
    icon:   'people',
    colors: ['#A78BFA', '#8E4AD7'],         // light violet → purple
    route:  '/main/network',
  },
];

export default function QuickTiles() {
  const router = useRouter();

  return (
    <View style={styles.row}>
      {TILES.map((t) => (
        <TouchableOpacity
          key={t.key}
          activeOpacity={0.85}
          onPress={() => router.push(t.route)}
          style={styles.tileTouch}
        >
          <LinearGradient
            colors={t.colors}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.tile}
          >
            <View style={styles.iconBubble}>
              <Ionicons name={t.icon} size={22} color={t.colors[1]} />
            </View>
            <Text style={styles.label}>{t.label}</Text>
          </LinearGradient>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    gap: 10,
  },
  tileTouch: {
    width: TILE_W,
    aspectRatio: 1.45,
    borderRadius: 16,
    overflow: 'hidden',
    // Soft drop shadow so the tiles sit "above" the white surface
    // instead of melting into it — matches the lifted feel in the
    // Streamkar reference.
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 3,
  },
  tile: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 12,
    justifyContent: 'space-between',
  },
  iconBubble: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  label: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
});
