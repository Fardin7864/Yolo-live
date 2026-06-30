import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import { horizontalScale } from '../../src/theme/scaling';

// Fallback tier ranges used while level_tiers hydrates. Same shape as
// the admin-managed catalogue: id, name, color, icon, min/max level.
const TIERS_FALLBACK = [
  { id: 'bronze',   name: 'Bronze',         color: '#CD7F32', icon: 'star-outline',       min_level: 1,   max_level: 19  },
  { id: 'silver',   name: 'Silver',         color: '#9CA3AF', icon: 'star-half-outline',  min_level: 20,  max_level: 39  },
  { id: 'gold',     name: 'Gold',           color: '#FBBF24', icon: 'star',               min_level: 40,  max_level: 59  },
  { id: 'platinum', name: 'Platinum',       color: '#60A5FA', icon: 'diamond-outline',    min_level: 60,  max_level: 79  },
  { id: 'diamond',  name: 'Diamond',        color: '#00E5FF', icon: 'diamond',            min_level: 80,  max_level: 99  },
  { id: 'supreme',  name: 'Supreme Legend', color: '#D946EF', icon: 'flame',              min_level: 100, max_level: 100 },
];

// Map a level number to its tier using the admin-managed `level_tiers`
// rows. Renders the same data the old hardcoded ladder did.
const buildLevelsData = (tiers) => Array.from({ length: 100 }, (_, i) => {
  const lvl = i + 1;
  // Prefer an exact range match; fall back to the lowest tier so a
  // misconfigured catalogue still renders something readable.
  const tier =
    tiers.find((t) => lvl >= t.min_level && lvl <= t.max_level) ||
    tiers[0] ||
    TIERS_FALLBACK[0];
  return { lvl, title: tier.name, color: tier.color, icon: tier.icon };
});

export default function LevelScreen() {
  const router = useRouter();
  const { user, levelTiers, systemSettings } = useGlobalState();

  // Live tier ladder. Memoised so a stable scroll list survives renders.
  const levelsData = React.useMemo(() => {
    const tiers = Array.isArray(levelTiers) && levelTiers.length > 0
      ? [...levelTiers].sort((a, b) => (a.min_level || 0) - (b.min_level || 0))
      : TIERS_FALLBACK;
    return buildLevelsData(tiers);
  }, [levelTiers]);

  // Admin-tunable EXP cost per level (system_settings.level_exp_multiplier).
  const expMultiplier = Number(systemSettings?.level_exp_multiplier) || 1500;

  // Total EXP = lifetime diamonds the user has spent on gifts. Maintained
  // by trigger trg_gift_exp (migration 50) so this is always authoritative.
  const userExp = Math.max(0, Number(user?.lifetimeDiamondsSpent) || 0);

  // Level = FLOOR(exp / multiplier) + 1, capped at 100. Mirrors the
  // recalc_user_level RPC so the screen agrees with the server even
  // before the realtime UPDATE lands.
  const derivedLevel = Math.max(1, Math.min(100, Math.floor(userExp / expMultiplier) + 1));
  const currentLvl = Math.max(derivedLevel, Math.max(1, Math.min(100, user?.level || 1)));
  const userCurrentLevelObj = levelsData.find(l => l.lvl === currentLvl);
  const nextLvl = Math.min(100, currentLvl + 1);

  // Each level spans `multiplier` EXP. Progress within the current level
  // is exp minus the floor of that band; bar fills as the user gifts more.
  const expCurrent  = (currentLvl - 1) * expMultiplier;
  const expNext     = currentLvl * expMultiplier;
  const progressPct = currentLvl >= 100
    ? 100
    : Math.max(0, Math.min(100, Math.round(((userExp - expCurrent) / Math.max(1, expNext - expCurrent)) * 100)));
  const expRemaining = currentLvl >= 100 ? 0 : Math.max(0, expNext - userExp);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Level</Text>
        <View style={{ width: horizontalScale(28) }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        
        {/* User Current Level Highlight */}
        <LinearGradient colors={['#2D1B36', '#1E1A34']} style={styles.heroCard}>
          <Text style={styles.heroSubTitle}>YOUR CURRENT LEVEL</Text>
          <View style={styles.lvlCircle}>
            <Text style={styles.lvlCircleText}>Lv.{currentLvl}</Text>
          </View>
          <Text style={[styles.lvlRankText, {color: userCurrentLevelObj?.color}]}>
            {userCurrentLevelObj?.title} Rank
          </Text>

          {/* Progress Bar */}
          <View style={styles.progressContainer}>
            <View style={styles.progressHeader}>
              <Text style={styles.expText}>EXP: {userExp.toLocaleString()} / {expNext.toLocaleString()}</Text>
              <Text style={styles.expText}>Lv.{nextLvl}</Text>
            </View>
            <View style={styles.trackBar}>
              <View style={[styles.fillBar, { width: `${progressPct}%` }]} />
            </View>
            <Text style={styles.helperText}>
              {currentLvl >= 100
                ? 'You have reached the highest level!'
                : <>Earn <Text style={{color: '#00E5FF', fontWeight: 'bold'}}>{expRemaining.toLocaleString()} more EXP</Text> to reach the next level!</>}
            </Text>
          </View>
        </LinearGradient>

        <Text style={styles.sectionTitle}>Level Tier List (1-100)</Text>

        {/* Level List 1-100 */}
        <View style={styles.listContainer}>
          {levelsData.map((item) => (
            <View 
              key={item.lvl} 
              style={[
                styles.listItem, 
                item.lvl === currentLvl && styles.listItemActive
              ]}
            >
              <View style={styles.listItemLeft}>
                <View style={[styles.badgeIcon, {backgroundColor: item.color}]}>
                  <Ionicons name={item.icon} size={16} color="#111827" />
                </View>
                <Text style={styles.lvlNumber}>Level {item.lvl}</Text>
                {item.lvl === currentLvl && (
                  <View style={styles.youIndicator}><Text style={styles.youText}>YOU</Text></View>
                )}
              </View>
              <Text style={[styles.rankBadge, {color: item.color, borderColor: item.color}]}>
                {item.title}
              </Text>
            </View>
          ))}
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0E111E' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#251B45' },
  backBtn: { padding: 4 },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },
  content: { padding: 16 },
  
  heroCard: { borderRadius: 20, padding: 24, alignItems: 'center', marginBottom: 24, borderWidth: 1, borderColor: '#374151' },
  heroSubTitle: { color: '#9CA3AF', fontSize: 12, fontWeight: 'bold', letterSpacing: 2, marginBottom: 16 },
  lvlCircle: { width: 100, height: 100, borderRadius: 50, backgroundColor: 'rgba(251, 191, 36, 0.1)', borderWidth: 3, borderColor: '#FBBF24', justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  lvlCircleText: { color: '#FBBF24', fontSize: 24, fontWeight: '900', fontStyle: 'italic' },
  lvlRankText: { fontSize: 18, fontWeight: 'bold', marginBottom: 24 },
  
  progressContainer: { width: '100%', backgroundColor: 'rgba(0,0,0,0.3)', padding: 16, borderRadius: 16 },
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  expText: { color: '#E5E7EB', fontSize: 12, fontWeight: 'bold' },
  trackBar: { width: '100%', height: 8, backgroundColor: '#374151', borderRadius: 4, marginBottom: 12, overflow: 'hidden' },
  fillBar: { height: '100%', backgroundColor: '#FBBF24', borderRadius: 4 },
  helperText: { color: '#9CA3AF', fontSize: 12, textAlign: 'center' },
  
  sectionTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold', marginBottom: 16 },
  listContainer: { backgroundColor: '#1E1A34', borderRadius: 20, overflow: 'hidden', padding: 8 },
  listItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: '#251B45' },
  listItemActive: { backgroundColor: 'rgba(251, 191, 36, 0.1)', borderRadius: 12, borderBottomWidth: 0 },
  listItemLeft: { flexDirection: 'row', alignItems: 'center' },
  badgeIcon: { width: 28, height: 28, borderRadius: 14, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  lvlNumber: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  rankBadge: { fontSize: 12, fontWeight: 'bold', borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  youIndicator: { backgroundColor: '#E11D48', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginLeft: 8 },
  youText: { color: '#FFFFFF', fontSize: 10, fontWeight: 'bold' },
});
