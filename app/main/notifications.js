import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import LogoLoader from '../../src/components/LogoLoader';
import { supabase } from '../../src/api/supabase';
import { BRAND } from '../../src/theme/brand';
import {
  buildLiveAnnouncementDestination,
  canOpenLuckyBagForUser,
} from '../../src/api/liveAnnouncements';

const ACTIVITY_TYPES = ['gift_received', 'follow', 'topup_confirmed', 'agency_invite', 'agency_join_request', 'agency_release', 'payout_paid'];

const FILTER_LABEL = {
  system:   { label: 'System',     icon: 'megaphone' },
  activity: { label: 'Activities', icon: 'gift'      },
};

// Map notification.type → icon + colour
const TYPE_VISUAL = {
  gift_received:   { icon: 'gift',                color: BRAND.primary },
  follow:          { icon: 'person-add',          color: '#FCD34D' },
  topup_confirmed: { icon: 'wallet',              color: '#34D399' },
  agency_invite:   { icon: 'shield-checkmark',    color: '#6B4EFF' },
  agency_join_request: { icon: 'person-add',       color: '#34D399' },
  agency_release:  { icon: 'exit',                color: '#F43F5E' },
  payout_paid:     { icon: 'cash',                color: '#34D399' },
  system:          { icon: 'information-circle',  color: '#6B4EFF' },
};

const relativeTime = (iso) => {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60)       return 'just now';
  if (diff < 3600)     return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)    return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800)   return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
};

export default function NotificationsScreen() {
  const router = useRouter();
  const { filter } = useLocalSearchParams();
  const activeFilter = filter === 'system' || filter === 'activity' ? filter : null;
  const { user } = useGlobalState();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Apply the filter chip selection to the loaded list.
  const visibleItems = activeFilter === 'system'
    ? items.filter((n) => n.type === 'system')
    : activeFilter === 'activity'
      ? items.filter((n) => ACTIVITY_TYPES.includes(n.type))
      : items;

  const load = useCallback(async () => {
    if (!user?.id) { setLoading(false); return; }
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) console.warn('notifications fetch:', error.message);
    setItems(data || []);
    setLoading(false);
  }, [user?.id]);

  useEffect(() => { load(); }, [load]);

  // Realtime — push new notifications to the top, mark unread
  useEffect(() => {
    if (!user?.id) return;
    const ch = supabase
      .channel(`notifs-${user.id}-${Date.now()}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` },
        (payload) => setItems((prev) => [payload.new, ...prev])
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user?.id]);

  // Mark all visible as read on screen open. Old code used .then() with
  // no error handler, so an RLS denial or network blip would silently
  // leave the list reading "unread" forever. Now we log on failure and
  // only flip local state when the update actually landed.
  useEffect(() => {
    if (!user?.id || items.length === 0) return;
    const unreadIds = items.filter((n) => !n.is_read).map((n) => n.id);
    if (unreadIds.length === 0) return;
    supabase
      .from('notifications')
      .update({ is_read: true })
      .in('id', unreadIds)
      .then(({ error }) => {
        if (error) {
          console.warn('notifications mark-read:', error.message);
          return;
        }
        setItems((prev) => prev.map((n) => (unreadIds.includes(n.id) ? { ...n, is_read: true } : n)));
      });
  }, [items.length]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const renderItem = ({ item }) => {
    const visual = TYPE_VISUAL[item.type] || TYPE_VISUAL.system;
    const isLuckyBag = item.type === 'lucky_bag' || item.type === 'lucky_bag_drop';
    const destination = isLuckyBag ? buildLiveAnnouncementDestination(item.payload) : null;
    return (
      <TouchableOpacity
        activeOpacity={destination ? 0.75 : 1}
        disabled={!destination}
        onPress={async () => {
          if (!destination || !(await canOpenLuckyBagForUser(user?.id))) return;
          router.push(destination);
        }}
        style={[styles.notificationItem, !item.is_read && styles.unread]}
      >
        <View style={[styles.iconContainer, { backgroundColor: visual.color + '20' }]}>
          <Ionicons name={visual.icon} size={24} color={visual.color} />
        </View>
        <View style={styles.textContainer}>
          <Text style={styles.title}>{item.title || item.type}</Text>
          {item.body ? <Text style={styles.desc}>{item.body}</Text> : null}
        </View>
        <Text style={styles.time}>{relativeTime(item.created_at)}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Notifications</Text>
        <View style={{ width: 28 }} />
      </View>

      {/* Filter chip — present only when entering via System / Activities */}
      {activeFilter && (
        <View style={styles.filterChipRow}>
          <View style={styles.filterChip}>
            <Ionicons name={FILTER_LABEL[activeFilter].icon} size={12} color={BRAND.primary} />
            <Text style={styles.filterChipText}>{FILTER_LABEL[activeFilter].label}</Text>
            <TouchableOpacity
              onPress={() => router.replace('/main/notifications')}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="close" size={13} color="rgba(255,255,255,0.65)" />
            </TouchableOpacity>
          </View>
        </View>
      )}

      {loading ? (
        <View style={styles.centerBox}><LogoLoader size="medium" /></View>
      ) : (
        <FlatList
          data={visibleItems}
          keyExtractor={(it) => it.id}
          contentContainerStyle={visibleItems.length === 0 ? styles.emptyList : styles.list}
          renderItem={renderItem}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BRAND.primary} />}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Ionicons name="notifications-off-outline" size={56} color="rgba(255,255,255,0.2)" />
              <Text style={styles.emptyText}>
                {activeFilter ? `No ${FILTER_LABEL[activeFilter].label.toLowerCase()} yet` : 'No notifications yet'}
              </Text>
              <Text style={styles.emptySub}>You'll see gifts, follows and system alerts here.</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BRAND.splashBg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#251B45',
  },
  backBtn: { padding: 4 },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },
  filterChipRow: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 12 },
  filterChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: `${BRAND.primary}1F`, borderWidth: 1, borderColor: BRAND.primary, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14 },
  filterChipText: { color: BRAND.primary, fontSize: 11, fontWeight: '700' },
  centerBox: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  list: { padding: 16 },
  emptyList: { flexGrow: 1, justifyContent: 'center' },
  notificationItem: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#251B45', padding: 16, borderRadius: 16, marginBottom: 12,
  },
  unread: { borderWidth: 1, borderColor: `${BRAND.primary}66` },
  iconContainer: {
    width: 48, height: 48, borderRadius: 24,
    justifyContent: 'center', alignItems: 'center', marginRight: 12,
  },
  textContainer: { flex: 1 },
  title: { color: '#FFFFFF', fontSize: 15, fontWeight: 'bold', marginBottom: 4 },
  desc: { color: '#9CA3AF', fontSize: 13 },
  time: { color: '#9CA3AF', fontSize: 11, marginLeft: 8 },
  emptyBox: { alignItems: 'center', padding: 40 },
  emptyText: { color: 'rgba(255,255,255,0.6)', marginTop: 14, fontSize: 15 },
  emptySub: { color: 'rgba(255,255,255,0.4)', marginTop: 6, fontSize: 12, textAlign: 'center' },
});
