import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Image } from 'react-native';
import LogoLoader from '../../src/components/LogoLoader';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import { supabase } from '../../src/api/supabase';

export default function NetworkScreen() {
  const router = useRouter();
  const { tab } = useLocalSearchParams();
  const { user, followUser } = useGlobalState();

  const [activeTab, setActiveTab] = useState(
    ['Followers', 'Following', 'Friends'].includes(tab) ? tab : 'Followers'
  );
  const [loading, setLoading] = useState(true);
  const [followers, setFollowers] = useState([]); // profiles who follow me
  const [following, setFollowing] = useState([]); // profiles I follow
  const [friends, setFriends] = useState([]);      // mutual
  const [followingIds, setFollowingIds] = useState(new Set());

  const load = useCallback(async () => {
    if (!user?.id) { setLoading(false); return; }
    setLoading(true);

    const [followingRes, followerRes] = await Promise.all([
      supabase.from('follows').select('following_id').eq('follower_id', user.id),
      supabase.from('follows').select('follower_id').eq('following_id', user.id),
    ]);

    const followingIdList = (followingRes.data || []).map((r) => r.following_id);
    const followerIdList = (followerRes.data || []).map((r) => r.follower_id);
    const allIds = Array.from(new Set([...followingIdList, ...followerIdList]));

    const profileMap = {};
    if (allIds.length) {
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url, level, display_id')
        .in('id', allIds);
      (profs || []).forEach((p) => { profileMap[p.id] = p; });
    }

    const followingSet = new Set(followingIdList);
    const followerSet = new Set(followerIdList);
    const toProfiles = (ids) => ids.map((id) => profileMap[id]).filter(Boolean);

    setFollowingIds(followingSet);
    setFollowing(toProfiles(followingIdList));
    setFollowers(toProfiles(followerIdList));
    setFriends(toProfiles(followingIdList.filter((id) => followerSet.has(id))));
    setLoading(false);
  }, [user?.id]);

  useEffect(() => { load(); }, [load]);

  const getFilteredUsers = () => {
    if (activeTab === 'Following') return following;
    if (activeTab === 'Friends') return friends;
    return followers;
  };

  const handleAction = async (u) => {
    if (followingIds.has(u.id)) {
      router.push(`/main/chat/${u.id}?name=${encodeURIComponent(u.full_name || 'User')}`);
    } else {
      const ok = await followUser(u.id);
      if (ok) setFollowingIds((prev) => new Set(prev).add(u.id));
    }
  };

  const filteredData = getFilteredUsers();

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Network</Text>
        <View style={{ width: 28 }} />
      </View>

      {/* Tabs */}
      <View style={styles.tabContainer}>
        {['Followers', 'Following', 'Friends'].map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.tabBtn, activeTab === t && styles.tabBtnActive]}
            onPress={() => setActiveTab(t)}
          >
            <Text style={[styles.tabText, activeTab === t && styles.tabTextActive]}>{t}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* User List */}
      {loading ? (
        <View style={styles.emptyState}>
          <LogoLoader size="medium" />
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          {filteredData.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="people-circle-outline" size={64} color="#374151" />
              <Text style={styles.emptyText}>
                {activeTab === 'Following' ? "You're not following anyone yet."
                  : activeTab === 'Friends' ? 'No mutual friends yet.'
                  : 'No followers yet.'}
              </Text>
            </View>
          ) : (
            filteredData.map((u) => (
              <View key={u.id} style={styles.userCard}>
                <TouchableOpacity style={styles.userInfo} onPress={() => router.push(`/main/user/${u.id}`)}>
                  <Image
                    source={{ uri: u.avatar_url || `https://i.pravatar.cc/100?u=${u.id}` }}
                    style={styles.avatar}
                  />
                  <View>
                    <Text style={styles.userName}>{u.full_name || 'User'}</Text>
                    <LinearGradient
                      colors={['#F59E0B', '#FCD34D']}
                      style={styles.levelBadge}
                      start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                    >
                      <Text style={styles.levelText}>Lv. {u.level || 1}</Text>
                    </LinearGradient>
                  </View>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.actionBtn, followingIds.has(u.id) ? styles.actionBtnOutlined : styles.actionBtnSolid]}
                  onPress={() => handleAction(u)}
                >
                  <Text style={styles.actionBtnText}>
                    {followingIds.has(u.id) ? 'Message' : 'Follow'}
                  </Text>
                </TouchableOpacity>
              </View>
            ))
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0E111E' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#251B45' },
  backBtn: { padding: 4 },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },

  tabContainer: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#251B45', backgroundColor: '#1E1A34' },
  tabBtn: { flex: 1, paddingVertical: 16, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabBtnActive: { borderBottomColor: '#00E5FF' },
  tabText: { color: '#9CA3AF', fontSize: 14, fontWeight: '600' },
  tabTextActive: { color: '#00E5FF', fontWeight: 'bold' },

  content: { padding: 16 },

  userCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#1E1A34', padding: 16, borderRadius: 16, marginBottom: 12 },
  userInfo: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  avatar: { width: 50, height: 50, borderRadius: 25, marginRight: 12 },
  userName: { color: '#FFFFFF', fontSize: 16, fontWeight: 'bold', marginBottom: 4 },

  levelBadge: { alignSelf: 'flex-start', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 },
  levelText: { color: '#1E1B4B', fontSize: 10, fontWeight: 'bold' },

  actionBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 20 },
  actionBtnSolid: { backgroundColor: '#F43F5E' },
  actionBtnOutlined: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#374151' },
  actionBtnText: { color: '#FFFFFF', fontWeight: 'bold', fontSize: 13 },

  emptyState: { marginTop: 100, alignItems: 'center', justifyContent: 'center', flex: 1 },
  emptyText: { color: '#6B7280', marginTop: 16, fontSize: 14 },
});