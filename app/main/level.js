import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import { supabase } from '../../src/api/supabase';
import { WEALTH_LEVEL_THRESHOLDS, getWealthProgress, wealthVisualForLevel } from '../../src/utils/wealthLevels';

const formatCost = (value) => Number(value || 0).toLocaleString('en-US');

function LevelBadge({ level, active = false }) {
  const visual = wealthVisualForLevel(level);
  return (
    <LinearGradient
      colors={[visual.color, visual.dark]}
      start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
      style={[styles.levelBadge, active && styles.levelBadgeActive]}
    >
      <Ionicons name={visual.icon} size={14} color="#FFF7B2" />
      <Text style={styles.levelBadgeText}>{level}</Text>
    </LinearGradient>
  );
}

export default function LevelScreen() {
  const router = useRouter();
  const { user } = useGlobalState();
  const [thresholds, setThresholds] = useState(WEALTH_LEVEL_THRESHOLDS);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const { data } = await supabase.from('level_thresholds').select('level,min_exp').order('level');
      if (mounted && Array.isArray(data) && data.length >= 110) setThresholds(data.slice(0, 110));
    };
    load();
    const channel = supabase.channel(`wealth-levels-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'level_thresholds' }, load)
      .subscribe();
    return () => { mounted = false; supabase.removeChannel(channel); };
  }, []);

  const giftedDiamonds = Math.max(0, Number(user?.lifetimeDiamondsSpent) || 0);
  const wealth = useMemo(() => getWealthProgress(giftedDiamonds, thresholds), [giftedDiamonds, thresholds]);
  const { level: currentLevel, progress, remaining } = wealth;
  const next = wealth.nextLevel;
  const currentVisual = wealthVisualForLevel(currentLevel);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={27} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Level</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <LinearGradient colors={['#261064', '#100735', '#080523']} style={styles.hero}>
          <View style={styles.wealthTitleRow}>
            <Ionicons name="trophy" size={24} color="#FFD83D" />
            <Text style={styles.wealthTitle}>WEALTH LEVEL</Text>
            <Ionicons name="trophy" size={24} color="#FFD83D" />
          </View>
          <View style={styles.ribbon}><Text style={styles.ribbonText}>GIFT COIN COST TABLE</Text></View>
          <LevelBadge level={currentLevel} active />
          <Text style={[styles.rankName, { color: currentVisual.color }]}>{currentVisual.name} Level</Text>
          <Text style={styles.giftedLabel}>Total gifted diamonds</Text>
          <Text style={styles.giftedValue}>{formatCost(giftedDiamonds)}</Text>

          <View style={styles.progressBox}>
            <View style={styles.progressHeader}>
              <Text style={styles.progressText}>Lv.{currentLevel}</Text>
              <Text style={styles.progressText}>{next ? `Lv.${next}` : 'MAX'}</Text>
            </View>
            <View style={styles.track}><LinearGradient colors={[currentVisual.color, '#FFE24B']} style={[styles.fill, { width: `${progress}%` }]} /></View>
            <Text style={styles.progressHelp}>
              {next ? `Send gifts worth ${formatCost(remaining)} more diamonds to level up` : 'Highest wealth level achieved'}
            </Text>
          </View>
          <Text style={styles.ruleText}>Only diamonds spent sending gifts to another user increase your level.</Text>
        </LinearGradient>

        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.tableHeaderText, styles.levelColumn]}>LEVEL</Text>
            <Text style={[styles.tableHeaderText, styles.costColumn]}>UPGRADE GIFT COIN COST</Text>
          </View>
          {thresholds.map((row) => {
            const level = Number(row.level);
            const active = level === currentLevel;
            const reached = level < currentLevel;
            return (
              <View key={level} style={[styles.tableRow, active && styles.activeRow]}>
                <View style={styles.levelColumn}><LevelBadge level={level} active={active} /></View>
                <View style={styles.costColumn}>
                  <Text style={[styles.costText, active && styles.activeCost]}>{formatCost(row.min_exp)}</Text>
                  {active ? <Text style={styles.youText}>CURRENT</Text> : reached ? <Ionicons name="checkmark-circle" size={17} color="#55DB8A" /> : null}
                </View>
              </View>
            );
          })}
        </View>
        <View style={styles.footerTip}>
          <Ionicons name="sparkles" size={15} color="#FFD83D" />
          <Text style={styles.footerText}>Keep gifting to unlock more status and amazing rewards!</Text>
          <Ionicons name="sparkles" size={15} color="#FFD83D" />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#05031B' },
  header: { height: 55, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: '#33226E' },
  backButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '900' },
  headerSpacer: { width: 38 },
  content: { padding: 12, paddingBottom: 42 },
  hero: { borderRadius: 20, padding: 18, alignItems: 'center', borderWidth: 1, borderColor: '#6043B2', shadowColor: '#8A45FF', shadowOpacity: .45, shadowRadius: 15, elevation: 8 },
  wealthTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  wealthTitle: { color: '#FFD83D', fontSize: 25, fontWeight: '900', textShadowColor: '#B46900', textShadowRadius: 7, letterSpacing: .5 },
  ribbon: { marginTop: 5, marginBottom: 15, backgroundColor: '#50169A', paddingHorizontal: 22, paddingVertical: 5, borderRadius: 4 },
  ribbonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900', letterSpacing: 1.1 },
  levelBadge: { minWidth: 58, height: 30, borderRadius: 15, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderWidth: 1, borderColor: 'rgba(255,255,255,.35)' },
  levelBadgeActive: { borderColor: '#FFF19B', shadowColor: '#FFD83D', shadowOpacity: .9, shadowRadius: 8, elevation: 7 },
  levelBadgeText: { color: '#FFFFFF', fontSize: 14, fontWeight: '900', textShadowColor: '#000', textShadowRadius: 2 },
  rankName: { fontSize: 17, fontWeight: '900', marginTop: 7 },
  giftedLabel: { color: '#AFA8D1', fontSize: 11, marginTop: 10 },
  giftedValue: { color: '#FFFFFF', fontSize: 21, fontWeight: '900', marginTop: 2 },
  progressBox: { width: '100%', marginTop: 14, borderRadius: 13, padding: 12, backgroundColor: 'rgba(0,0,0,.32)' },
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  progressText: { color: '#EAE7FF', fontSize: 11, fontWeight: '900' },
  track: { height: 9, borderRadius: 5, backgroundColor: '#302751', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 5 },
  progressHelp: { color: '#D2CDEA', fontSize: 11, textAlign: 'center', marginTop: 9 },
  ruleText: { color: '#F6D56B', fontSize: 10.5, lineHeight: 15, textAlign: 'center', marginTop: 12, maxWidth: 280 },
  table: { marginTop: 17, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: '#51418D', backgroundColor: '#0A0B2D' },
  tableHeader: { minHeight: 46, flexDirection: 'row', alignItems: 'center', backgroundColor: '#241052', borderBottomWidth: 1, borderBottomColor: '#6655A1' },
  tableHeaderText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900', textAlign: 'center' },
  tableRow: { minHeight: 49, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#34365C' },
  activeRow: { backgroundColor: 'rgba(255,211,55,.12)', borderColor: '#E7B931', borderWidth: 1 },
  levelColumn: { width: '36%', alignItems: 'center', justifyContent: 'center' },
  costColumn: { width: '64%', minHeight: 49, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: '#45476D' },
  costText: { color: '#F4F2FF', fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  activeCost: { color: '#FFE66B', fontWeight: '900' },
  youText: { color: '#FFE66B', fontSize: 8, fontWeight: '900' },
  footerTip: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 14, borderRadius: 18, borderWidth: 1, borderColor: '#51418D', padding: 9, backgroundColor: '#17103E' },
  footerText: { flexShrink: 1, color: '#F3EEFF', fontSize: 10.5, fontWeight: '700', textAlign: 'center' },
});
