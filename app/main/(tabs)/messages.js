import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, Image, TouchableOpacity, FlatList, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useGlobalState } from '../../../src/context/GlobalStateContext';
import LogoLoader from '../../../src/components/LogoLoader';
import { supabase } from '../../../src/api/supabase';
import { BRAND } from '../../../src/theme/brand';

// chat_messages.conversation_id is built as "minId__maxId"
const buildConvId = (a, b) => (a < b ? `${a}__${b}` : `${b}__${a}`);

const relativeTime = (iso) => {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60)     return 'now';
  if (diff < 3600)   return `${Math.floor(diff / 60)}m`;
  if (diff < 86400)  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff < 604800) return new Date(iso).toLocaleDateString([], { weekday: 'short' });
  return new Date(iso).toLocaleDateString();
};

export default function MessagesScreen() {
  const router = useRouter();
  const { user, myReseller, ownedAgency } = useGlobalState();
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Pinned "Super Admin Support" — only for resellers + agency owners,
  // so they can directly reach support after a bulk-stock request, etc.
  const showSupportPin = !!(myReseller?.id || ownedAgency?.id);
  const [supportAdmin, setSupportAdmin] = useState(null); // { id, full_name, avatar_url }
  useEffect(() => {
    if (!showSupportPin) return;
    (async () => {
      const { data: adminId } = await supabase.rpc('get_support_admin_id');
      if (!adminId) return;
      const { data: prof } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url')
        .eq('id', adminId)
        .maybeSingle();
      if (prof) setSupportAdmin(prof);
    })();
  }, [showSupportPin]);

  const loadConversations = useCallback(async () => {
    if (!user?.id) { setLoading(false); return; }

    // 1. Fetch all chat_messages that involve me, newest first
    const { data: msgs, error } = await supabase
      .from('chat_messages')
      .select('id, conversation_id, sender_id, receiver_id, content, type, is_read, created_at')
      .or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      console.warn('messages fetch:', error.message);
      setConversations([]);
      setLoading(false);
      return;
    }

    // 2. Group by conversation_id, keep most-recent message per conv
    const byConv = new Map();
    (msgs || []).forEach((m) => {
      if (!byConv.has(m.conversation_id)) {
        byConv.set(m.conversation_id, { last: m, unread: 0 });
      }
      const entry = byConv.get(m.conversation_id);
      if (m.receiver_id === user.id && !m.is_read) entry.unread += 1;
    });

    // 3. Resolve other-party profiles
    const otherIds = [];
    byConv.forEach((v) => {
      const otherId = v.last.sender_id === user.id ? v.last.receiver_id : v.last.sender_id;
      otherIds.push(otherId);
    });

    let profileMap = new Map();
    if (otherIds.length > 0) {
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url, role')
        .in('id', Array.from(new Set(otherIds)));
      if (profs) profileMap = new Map(profs.map((p) => [p.id, p]));
    }

    // 4. Build display rows
    const rows = [];
    byConv.forEach((v, convId) => {
      const otherId = v.last.sender_id === user.id ? v.last.receiver_id : v.last.sender_id;
      const profile = profileMap.get(otherId);
      rows.push({
        convId,
        otherId,
        name: profile?.full_name || 'User',
        avatar: profile?.avatar_url || `https://i.pravatar.cc/150?u=${otherId}`,
        isOfficial: profile?.role === 'admin' || profile?.role === 'super_admin',
        lastMessage: v.last.type === 'gift' ? '🎁 Gift'
                   : v.last.type === 'image' ? '📷 Photo'
                   : v.last.content || '',
        time: relativeTime(v.last.created_at),
        unread: v.unread,
        createdAt: v.last.created_at,
      });
    });

    rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    setConversations(rows);
    setLoading(false);
  }, [user?.id]);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  // Refresh every time the Messages tab gains focus — guarantees that
  // unread badges clear as soon as the user returns from a chat screen,
  // even if the realtime UPDATE event somehow misses.
  useFocusEffect(
    useCallback(() => {
      loadConversations();
    }, [loadConversations])
  );

  // Keep the latest loadConversations in a ref so the realtime listener
  // (registered once per user) always calls the freshest closure without
  // the effect re-running every time loadConversations is rebuilt — old
  // code listed it in deps and rapid re-renders would tear down + recreate
  // the channel on every render.
  const loadConversationsRef = useRef(loadConversations);
  useEffect(() => { loadConversationsRef.current = loadConversations; }, [loadConversations]);

  useEffect(() => {
    if (!user?.id) return;
    // Realtime postgres_changes filters don't support OR, so we attach
    // two .on() handlers to the same channel — one for messages I sent
    // and one for messages sent to me. The server filters at the DB
    // level so this user's app only receives events that actually
    // involve them. Previously the listener received every chat_message
    // in the entire platform and filtered client-side; at scale that
    // meant thousands of useless re-renders per minute.
    //
    // The channel name has a per-mount random suffix because supabase-js
    // caches channels by name as singletons — re-mounting the screen
    // with a stable name returns the previous (already-subscribed)
    // channel and any new `.on()` call throws "cannot add callbacks
    // after subscribe()". The cleanup `removeChannel` below disposes
    // the instance, so a fresh suffix per mount gives us a clean slate
    // without leaking anything.
    const channelKey = `messages-list-${user.id}-${Math.random().toString(36).slice(2, 8)}`;
    const ch = supabase
      .channel(channelKey)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'chat_messages', filter: `sender_id=eq.${user.id}` },
        () => loadConversationsRef.current?.()
      )
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'chat_messages', filter: `receiver_id=eq.${user.id}` },
        () => loadConversationsRef.current?.()
      )
      .subscribe();
    return () => { try { supabase.removeChannel(ch); } catch (_) {} };
  }, [user?.id]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadConversations();
    setRefreshing(false);
  };

  const renderHeader = () => (
    <View style={styles.headerContainer}>
      <Text style={styles.headerTitle}>Messages</Text>
      <View style={styles.headerActions}>
        <TouchableOpacity style={styles.iconBtn} onPress={() => router.push('/main/network')}>
          <Ionicons name="people-outline" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconBtn} onPress={() => router.push('/main/settings')}>
          <Ionicons name="settings-outline" size={24} color="#FFFFFF" />
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderTopActions = () => (
    <View style={styles.topActionsContainer}>
      {/* System notifications — official broadcasts, account alerts */}
      <TouchableOpacity
        style={styles.actionItem}
        onPress={() => router.push('/main/notifications?filter=system')}
      >
        <LinearGradient colors={['#F59E0B', '#EA580C']} style={styles.actionIconBox}>
          <Ionicons name="megaphone" size={24} color="#FFFFFF" />
        </LinearGradient>
        <Text style={styles.actionText}>System</Text>
      </TouchableOpacity>
      {/* Activities — gifts received, balance changes, agency events */}
      <TouchableOpacity
        style={styles.actionItem}
        onPress={() => router.push('/main/notifications?filter=activity')}
      >
        <LinearGradient colors={[BRAND.primary, BRAND.primaryAlt]} style={styles.actionIconBox}>
          <Ionicons name="gift" size={24} color="#FFFFFF" />
        </LinearGradient>
        <Text style={styles.actionText}>Activities</Text>
      </TouchableOpacity>
      {/* Followers — new followers list (already real via network screen) */}
      <TouchableOpacity
        style={styles.actionItem}
        onPress={() => router.push('/main/network?tab=Followers')}
      >
        <LinearGradient colors={['#3B82F6', '#2563EB']} style={styles.actionIconBox}>
          <Ionicons name="person-add" size={24} color="#FFFFFF" />
        </LinearGradient>
        <Text style={styles.actionText}>Followers</Text>
      </TouchableOpacity>
    </View>
  );

  const renderChatItem = ({ item }) => (
    <TouchableOpacity
      style={styles.chatRow}
      onPress={() => router.push(`/main/chat/${item.otherId}?name=${encodeURIComponent(item.name)}`)}
    >
      <View style={styles.avatarContainer}>
        <Image source={{ uri: item.avatar }} style={styles.chatAvatar} />
        {item.isOfficial && (
          <View style={styles.verifiedBadge}>
            <Ionicons name="checkmark-circle" size={14} color="#3B82F6" />
          </View>
        )}
      </View>
      <View style={styles.chatInfo}>
        <View style={styles.chatHeaderRow}>
          <Text style={[styles.chatName, item.unread > 0 && styles.chatNameUnread]}>{item.name}</Text>
          <Text style={[styles.chatTime, item.unread > 0 && styles.chatTimeUnread]}>{item.time}</Text>
        </View>
        <View style={styles.chatMessageRow}>
          <Text style={[styles.chatMessage, item.unread > 0 && styles.chatMessageUnread]} numberOfLines={1}>
            {item.lastMessage}
          </Text>
          {item.unread > 0 && (
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadText}>{item.unread}</Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {renderHeader()}
      {loading ? (
        <View style={styles.centerBox}><LogoLoader size="medium" /></View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(it) => it.convId}
          ListHeaderComponent={() => (
            <>
              {renderTopActions()}
              {showSupportPin && supportAdmin && (
                <TouchableOpacity
                  style={styles.supportPin}
                  onPress={() =>
                    router.push(`/main/chat/${supportAdmin.id}?name=${encodeURIComponent(supportAdmin.full_name || 'Super Admin')}`)
                  }
                >
                  <View style={styles.supportAvatarBox}>
                    <Image
                      source={{ uri: supportAdmin.avatar_url || `https://i.pravatar.cc/150?u=${supportAdmin.id}` }}
                      style={styles.supportAvatar}
                    />
                    <View style={styles.supportShield}>
                      <Ionicons name="shield-checkmark" size={11} color="#FFF" />
                    </View>
                  </View>
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={styles.supportName}>Super Admin Support</Text>
                      <View style={styles.priorityChip}>
                        <Text style={styles.priorityChipText}>PRIORITY</Text>
                      </View>
                    </View>
                    <Text style={styles.supportSub} numberOfLines={1}>
                      Tap to chat about stock requests, payouts, anything.
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.4)" />
                </TouchableOpacity>
              )}
            </>
          )}
          renderItem={renderChatItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BRAND.primary} />}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Ionicons name="chatbubbles-outline" size={56} color="rgba(255,255,255,0.2)" />
              <Text style={styles.emptyText}>No conversations yet</Text>
              <Text style={styles.emptySub}>Start chatting with someone from their profile.</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  centerBox: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  headerContainer: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14,
    backgroundColor: '#1E1A34', borderBottomWidth: 1, borderBottomColor: '#251B45',
  },
  headerTitle: { color: '#FFFFFF', fontSize: 22, fontWeight: 'bold' },
  headerActions: { flexDirection: 'row' },
  iconBtn: { marginLeft: 16 },
  topActionsContainer: {
    flexDirection: 'row', justifyContent: 'space-around',
    paddingVertical: 24, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: '#1E1A34',
  },
  actionItem: { alignItems: 'center' },
  actionIconBox: {
    width: 56, height: 56, borderRadius: 28,
    justifyContent: 'center', alignItems: 'center', marginBottom: 8,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 5, elevation: 8,
  },
  actionText: { color: '#E5E7EB', fontSize: 13, fontWeight: '500' },
  supportPin: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#1E1A34',
    borderWidth: 1, borderColor: 'rgba(251,191,36,0.4)',
    borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12,
    marginHorizontal: 16, marginBottom: 8,
    shadowColor: '#FBBF24', shadowOpacity: 0.18,
    shadowRadius: 10, shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  supportAvatarBox: { position: 'relative' },
  supportAvatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#251B45' },
  supportShield: {
    position: 'absolute', bottom: -2, right: -2,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: '#F59E0B',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 1.5, borderColor: '#1E1A34',
  },
  supportName: { color: '#FFF', fontSize: 14, fontWeight: '700' },
  priorityChip: {
    backgroundColor: 'rgba(251,191,36,0.18)',
    borderWidth: 1, borderColor: '#FBBF24',
    paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6,
  },
  priorityChipText: { color: '#FBBF24', fontSize: 8, fontWeight: '800', letterSpacing: 0.5 },
  supportSub: { color: 'rgba(255,255,255,0.55)', fontSize: 11, marginTop: 2 },
  listContent: { paddingBottom: 120 },
  chatRow: {
    flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 14,
    alignItems: 'center', borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.03)',
  },
  avatarContainer: { position: 'relative', marginRight: 16 },
  chatAvatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#1E1A34' },
  verifiedBadge: {
    position: 'absolute', bottom: -2, right: -2,
    backgroundColor: '#0E111E', borderRadius: 10, padding: 2,
  },
  chatInfo: { flex: 1, justifyContent: 'center' },
  chatHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  chatName: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  chatNameUnread: { fontWeight: 'bold' },
  chatTime: { color: '#6B7280', fontSize: 12 },
  chatTimeUnread: { color: BRAND.primary, fontWeight: 'bold' },
  chatMessageRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chatMessage: { color: '#9CA3AF', fontSize: 13, flex: 1, marginRight: 16 },
  chatMessageUnread: { color: '#FFFFFF', fontWeight: '500' },
  unreadBadge: {
    backgroundColor: BRAND.primary, minWidth: 20, height: 20, borderRadius: 10,
    justifyContent: 'center', alignItems: 'center', paddingHorizontal: 6,
  },
  unreadText: { color: '#FFFFFF', fontSize: 10, fontWeight: 'bold' },
  emptyBox: { alignItems: 'center', padding: 40, marginTop: 80 },
  emptyText: { color: 'rgba(255,255,255,0.6)', marginTop: 14, fontSize: 15 },
  emptySub: { color: 'rgba(255,255,255,0.4)', marginTop: 6, fontSize: 12, textAlign: 'center' },
});

export { buildConvId };
