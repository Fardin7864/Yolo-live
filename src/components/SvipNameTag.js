import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

export default function SvipNameTag({ vipType, compact = false }) {
  if (vipType !== 'SVIP') return null;
  return (
    <LinearGradient
      colors={['#FCD34D', '#F59E0B']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.tag, compact && styles.compact]}
    >
      <Text style={[styles.text, compact && styles.compactText]}>SVIP</Text>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  tag: {
    height: 18,
    paddingHorizontal: 7,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,.32)',
  },
  compact: {
    height: 15,
    paddingHorizontal: 5,
    borderRadius: 8,
  },
  text: {
    color: '#3B2300',
    fontSize: 9,
    fontWeight: '900',
  },
  compactText: {
    fontSize: 8,
  },
});
