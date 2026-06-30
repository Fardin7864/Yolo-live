import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, ScrollView, Dimensions } from 'react-native';
import LogoLoader from '../../../src/components/LogoLoader';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useGlobalState } from '../../../src/context/GlobalStateContext';
import { supabase } from '../../../src/api/supabase';
import { BRAND } from '../../../src/theme/brand';

const { width } = Dimensions.get('window');

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

export default function PublicProfileScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams(); // UUID (from in-app nav) or display_id (from search)
  const { user, followUser, unfollowUser, isFollowing } = useGlobalState();

  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [following, setFollowing] = useState(false);
  const [counts, setCounts] = useState({ followers: 0, followingCount: 0 });
  const [busy, setBusy] = useState(false);

  // Track WHY profile is null so we can show "User not found" vs.
  // "Network error" — old code rendered the same generic empty state
  // for both, which made a flaky connection look like a missing user.
  const [loadError, setLoadError] = useState(null);

  const loadProfile = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    let q = supabase.from('profiles').select('*');
    q = isUuid(id) ? q.eq('id', id) : q.eq('display_id', id);
    const { data, error } = await q.maybeSingle();
    if (error) {
      setLoadError(error.message || 'Could not load profile.');
      setProfile(null);
      setLoading(false);
      return;
    }
    setProfile(data || null);

    if (data?.id) {
      const [followers, followingRes, amIFollowing] = await Promise.all([
        supabase.from('follows').select('id', { count: 'exact', head: true }).eq('following_id', data.id),
        supabase.from('follows').select('id', { count: 'exact', head: true }).eq('follower_id', data.id),
        isFollowing(data.id),
      ]);
      setCounts({ followers: followers?.count || 0, followingCount: followingRes?.count || 0 });
      setFollowing(amIFollowing);
    }
    setLoading(false);
  }, [id, isFollowing]);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  const toggleFollow = async () => {
    if (!profile?.id || busy) return;
    setBusy(true);
    const ok = following ? await unfollowUser(profile.id) : await followUser(profile.id);
    if (ok) {
      setFollowing(!following);
      setCounts((c) => ({ ...c, followers: Math.max(0, c.followers + (following ? -1 : 1)) }));
    }
    setBusy(false);
  };

  const isSelf = profile?.id && profile.id === user?.id;

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]} edges={['top']}>
        <LogoLoader size="medium" />
      </SafeAreaView>
    );
  }

  if (!profile) {
    const networkFailed = !!loadError;
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.topBar}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 }}>
          <Ionicons
            name={networkFailed ? 'cloud-offline-outline' : 'person-circle-outline'}
            size={64}
            color="#374151"
          />
          <Text style={{ color: '#9CA3AF', marginTop: 16, textAlign: 'center' }}>
            {networkFailed ? 'Could not reach the server.' : 'User not found.'}
          </Text>
          {networkFailed && (
            <TouchableOpacity
              onPress={loadProfile}
              style={{
                marginTop: 20,
                backgroundColor: BRAND.primary,
                paddingHorizontal: 24,
                paddingVertical: 10,
                borderRadius: 999,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Ionicons name="refresh" size={16} color="#FFF" />
              <Text style={{ color: '#FFF', fontWeight: '700' }}>Try again</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    );
  }

  const formatCount = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  const avatarUri = profile.avatar_url || `https://i.pravatar.cc/200?u=${profile.id}`;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

        <View style={styles.topBar}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn}>
            <Ionicons name="ellipsis-horizontal" size={24} color="#FFFFFF" />
          </TouchableOpacity>
        </View>

        {/* Profile Info */}
        <View style={styles.headerContainer}>
          <Image source={{ uri: avatarUri }} style={styles.avatar} />

          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
            <Text style={styles.userName}>{profile.full_name || 'User'}</Text>
            <LinearGradient
              colors={['#F59E0B', '#FCD34D']}
              style={styles.levelBadge}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            >
              <Text style={styles.levelText}>Lv. {profile.level || 1}</Text>
            </LinearGradient>
            {(() => {
              const exp = profile.vip_expires_at && new Date(profile.vip_expires_at);
              const active = profile.vip_type && exp && exp.getTime() > Date.now();
              if (!active) return null;
              const themes = {
                VIP:  { colors: ['#94A3B8', '#475569'], icon: 'star',             label: 'VIP'  },
                SVIP: { colors: ['#F59E0B', '#B45309'], icon: 'shield-checkmark', label: 'SVIP' },
                VVIP: { colors: ['#FF007A', '#5A46B5'], icon: 'diamond',          label: 'VVIP' },
              };
              const t = themes[profile.vip_type] || themes.VIP;
              return (
                <LinearGradient
                  colors={t.colors}
                  style={[styles.levelBadge, { marginLeft: 6, flexDirection: 'row', alignItems: 'center', gap: 3 }]}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                >
                  <Ionicons name={t.icon} size={10} color="#FFF" />
                  <Text style={[styles.levelText, { color: '#FFF' }]}>{t.label}</Text>
                </LinearGradient>
              );
            })()}
          </View>

          <View style={styles.idRow}>
            <Text style={styles.userId}>ID: {profile.display_id || '—'}</Text>
            {!!profile.country && (
              <Text style={styles.country}>{profile.country}</Text>
            )}
          </View>

          <Text style={styles.bio}>{profile.bio || 'No bio yet.'}</Text>
        </View>

        {/* Stats */}
        <View style={styles.statsContainer}>
          <View style={styles.statBox}>
            <Text style={styles.statNumber}>{formatCount(counts.followers)}</Text>
            <Text style={styles.statLabel}>Followers</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statBox}>
            <Text style={styles.statNumber}>{formatCount(counts.followingCount)}</Text>
            <Text style={styles.statLabel}>Following</Text>
          </View>
        </View>

        {/* Action Buttons (hidden for own profile) */}
        {!isSelf && (
          <View style={styles.actionRow}>
            <TouchableOpacity
              style={styles.msgBtn}
              onPress={() => router.push(`/main/chat/${profile.id}?name=${encodeURIComponent(profile.full_name || 'User')}`)}
            >
              <Ionicons name="chatbubble-ellipses-outline" size={20} color="#FFFFFF" style={{ marginRight: 6 }} />
              <Text style={styles.msgBtnText}>Message</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.followBtn, following && { backgroundColor: '#374151' }]}
              onPress={toggleFollow}
              disabled={busy}
            >
              <Ionicons name={following ? 'checkmark' : 'person-add'} size={18} color="#FFFFFF" style={{ marginRight: 6 }} />
              <Text style={styles.followBtnText}>{following ? 'Following' : 'Follow'}</Text>
            </TouchableOpacity>
          </View>
        )}

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0E111E',
  },
  scrollContent: {
    paddingBottom: 20,
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  iconBtn: {
    padding: 8,
  },
  headerContainer: {
    alignItems: 'center',
    marginBottom: 20,
    marginTop: 10,
  },
  avatar: {
    width: 110,
    height: 110,
    borderRadius: 55,
    borderWidth: 3,
    borderColor: '#F43F5E',
    marginBottom: 16,
  },
  userName: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: 'bold',
  },
  levelBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
    marginLeft: 8,
  },
  levelText: {
    color: '#1E1B4B',
    fontSize: 10,
    fontWeight: '900',
    fontStyle: 'italic',
  },
  idRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    marginTop: 6,
  },
  userId: {
    color: '#9CA3AF',
    fontSize: 14,
    marginRight: 8,
  },
  country: {
    color: '#9CA3AF',
    fontSize: 14,
  },
  bio: {
    color: '#D1D5DB',
    fontSize: 14,
    marginTop: 8,
  },
  statsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 30,
  },
  statBox: {
    alignItems: 'center',
    width: 100,
  },
  statNumber: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  statLabel: {
    color: '#6B7280',
    fontSize: 12,
  },
  statDivider: {
    width: 1,
    height: 24,
    backgroundColor: '#374151',
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 16,
  },
  msgBtn: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#374151'
  },
  msgBtnText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 16,
  },
  followBtn: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: '#F43F5E',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 24,
  },
  followBtnText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 16,
  }
});
