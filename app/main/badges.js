import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Image, FlatList } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { horizontalScale } from '../../src/theme/scaling';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import { supabase } from '../../src/api/supabase';

// Fallback list used only on cold start; once the `badges` catalogue
// hydrates from GlobalStateContext the live list takes over.
const FALLBACK_BADGES = [
  { id: 'first_streamer', name: 'First Streamer', icon_url: 'https://cdn-icons-png.flaticon.com/512/3112/3112946.png', description: 'Completed your first live stream.' },
  { id: 'millionaire',    name: 'Millionaire',    icon_url: 'https://cdn-icons-png.flaticon.com/512/9181/9181081.png', description: 'Earned 1,000,000 beans.' },
];

export default function BadgesScreen() {
  const router = useRouter();
  const { user, badges: dbBadges } = useGlobalState();
  const [activeTab, setActiveTab] = useState('All');
  const [unlockedSet, setUnlockedSet] = useState(new Set());

  // Pull the user's earned badges from user_badges. Done with a one-shot
  // fetch + realtime subscription so unlocks flow in live.
  React.useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    const load = async () => {
      const { data, error } = await supabase
        .from('user_badges')
        .select('badge_id')
        .eq('user_id', user.id);
      if (cancelled || error) return;
      setUnlockedSet(new Set((data || []).map((r) => r.badge_id)));
    };
    load();
    const ch = supabase
      .channel(`my-badges-${user.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'user_badges', filter: `user_id=eq.${user.id}` },
        () => load()
      )
      .subscribe();
    return () => { cancelled = true; try { supabase.removeChannel(ch); } catch (_) {} };
  }, [user?.id]);

  // Project each catalogue row into the legacy { id, name, icon, desc,
  // unlocked } shape this screen already renders.
  const allBadges = React.useMemo(() => {
    const rows = Array.isArray(dbBadges) && dbBadges.length > 0 ? dbBadges : FALLBACK_BADGES;
    return rows.map((b) => ({
      id:       b.id,
      name:     b.name,
      icon:     b.icon_url,
      desc:     b.description || b.criteria || '',
      unlocked: unlockedSet.has(b.id),
    }));
  }, [dbBadges, unlockedSet]);

  const filteredBadges = activeTab === 'All'
    ? allBadges
    : allBadges.filter(b => activeTab === 'Unlocked' ? b.unlocked : !b.unlocked);

  const renderBadge = ({ item }) => (
    <View style={[styles.badgeCard, !item.unlocked && styles.badgeLocked]}>
      <Image source={{ uri: item.icon }} style={[styles.badgeIcon, !item.unlocked && {tintColor: '#4B5563', opacity: 0.5}]} />
      <Text style={styles.badgeName}>{item.name}</Text>
      <Text style={styles.badgeDesc}>{item.desc}</Text>
      {item.unlocked ? (
        <View style={styles.unlockedTag}>
          <Text style={styles.unlockedText}>Unlocked</Text>
        </View>
      ) : (
        <View style={styles.lockedTag}>
          <Ionicons name="lock-closed" size={10} color="#9CA3AF" />
          <Text style={styles.lockedText}>Locked</Text>
        </View>
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Badges Inventory</Text>
        <View style={{ width: horizontalScale(28) }} />
      </View>

      <View style={styles.tabBar}>
        {['All', 'Unlocked', 'Locked'].map(tab => (
          <TouchableOpacity 
            key={tab} 
            style={[styles.tabItem, activeTab === tab && styles.tabActive]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>{tab}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList 
        data={filteredBadges}
        keyExtractor={item => item.id.toString()}
        renderItem={renderBadge}
        numColumns={2}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0E111E' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#251B45' },
  backBtn: { padding: 4 },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },

  tabBar: { flexDirection: 'row', backgroundColor: '#1E1A34', padding: 4, margin: 16, borderRadius: 12 },
  tabItem: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 10 },
  tabActive: { backgroundColor: '#374151' },
  tabText: { color: '#9CA3AF', fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: '#FFFFFF' },

  listContent: { padding: 8 },
  badgeCard: { flex: 1, backgroundColor: '#1E1A34', margin: 8, padding: 16, borderRadius: 20, alignItems: 'center' },
  badgeLocked: { opacity: 0.7 },
  badgeIcon: { width: 60, height: 60, marginBottom: 12 },
  badgeName: { color: '#FFFFFF', fontSize: 14, fontWeight: 'bold', textAlign: 'center', marginBottom: 4 },
  badgeDesc: { color: '#9CA3AF', fontSize: 10, textAlign: 'center', marginBottom: 12, height: 30 },
  
  unlockedTag: { backgroundColor: 'rgba(16, 185, 129, 0.2)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
  unlockedText: { color: '#10B981', fontSize: 10, fontWeight: 'bold' },
  
  lockedTag: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(156, 163, 175, 0.1)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
  lockedText: { color: '#9CA3AF', fontSize: 10, fontWeight: 'bold', marginLeft: 4 }
});
