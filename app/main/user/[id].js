import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ImageBackground,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import LogoLoader from '../../../src/components/LogoLoader';
import { useGlobalState } from '../../../src/context/GlobalStateContext';
import { supabase } from '../../../src/api/supabase';
import { flagFor } from '../../../src/utils/countryFlag';
import ProfileIdentityBadges from '../../../src/components/ProfileIdentityBadges';

const PROFILE_ASSETS = {
  background: require('../../../assets/public-profile/cosmic-background.webp'),
  back: require('../../../assets/public-profile/back.webp'),
  menu: require('../../../assets/public-profile/menu.webp'),
};

const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
const formatCount = (value) => value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value || 0);
const formatJoined = (value) => {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' }).format(new Date(value));
};

function NeonCard({ children, style, contentStyle }) {
  return (
    <LinearGradient
      colors={['rgba(223,46,255,.95)', 'rgba(62,111,255,.8)', 'rgba(223,46,255,.95)']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.cardBorder, style]}
    >
      <View style={[styles.cardInner, contentStyle]}>{children}</View>
    </LinearGradient>
  );
}

function Stat({ icon, iconColor, value, label }) {
  return (
    <View style={styles.stat}>
      <Ionicons name={icon} size={24} color={iconColor} />
      <Text style={styles.statNumber}>{formatCount(value)}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export default function PublicProfileScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams();
  const { user, followUser, unfollowUser, isFollowing } = useGlobalState();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [following, setFollowing] = useState(false);
  const [counts, setCounts] = useState({ followers: 0, followingCount: 0 });
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const loadProfile = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    let query = supabase.from('profiles').select('*');
    query = isUuid(id) ? query.eq('id', id) : query.eq('display_id', id);
    const { data, error } = await query.maybeSingle();
    if (error) {
      setLoadError(error.message || 'Could not load profile.');
      setProfile(null);
      setLoading(false);
      return;
    }
    setProfile(data || null);
    if (data?.id) {
      const [followers, followingResult, amIFollowing] = await Promise.all([
        supabase.from('follows').select('id', { count: 'exact', head: true }).eq('following_id', data.id),
        supabase.from('follows').select('id', { count: 'exact', head: true }).eq('follower_id', data.id),
        isFollowing(data.id),
      ]);
      setCounts({ followers: followers?.count || 0, followingCount: followingResult?.count || 0 });
      setFollowing(amIFollowing);
    }
    setLoading(false);
  }, [id, isFollowing]);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  const toggleFollow = async () => {
    if (!profile?.id || busy) return;
    setBusy(true);
    const success = following ? await unfollowUser(profile.id) : await followUser(profile.id);
    if (success) {
      setFollowing((current) => !current);
      setCounts((current) => ({
        ...current,
        followers: Math.max(0, current.followers + (following ? -1 : 1)),
      }));
    }
    setBusy(false);
  };

  if (loading) {
    return (
      <View style={styles.loading}>
        <LogoLoader size="medium" />
      </View>
    );
  }

  if (!profile) {
    return (
      <SafeAreaView style={styles.empty}>
        <TouchableOpacity style={styles.fallbackBack} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#fff" />
        </TouchableOpacity>
        <View style={styles.emptyCenter}>
          <Ionicons name={loadError ? 'cloud-offline-outline' : 'person-circle-outline'} size={68} color="#7559ad" />
          <Text style={styles.emptyText}>{loadError ? 'Could not reach the server.' : 'User not found.'}</Text>
          {!!loadError && (
            <TouchableOpacity onPress={loadProfile} style={styles.retry}>
              <Ionicons name="refresh" size={17} color="#fff" />
              <Text style={styles.retryText}>Try again</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    );
  }

  const isSelf = profile.id === user?.id;
  const avatarUri = profile.avatar_url || `https://i.pravatar.cc/400?u=${profile.id}`;
  const countryFlag = flagFor(profile.country);
  const visitors = profile.visitor_count ?? profile.visitors ?? 0;
  const languages = profile.languages || profile.language || (profile.country === 'Bangladesh' ? 'বাংলা, English' : 'English');
  const interests = [
    ['chatbubbles', 'Chat', '#c65cff'],
    ['musical-notes', 'Music', '#ff50c8'],
    ['game-controller', 'Gaming', '#42c8ff'],
    ['body', 'Dance', '#b961ff'],
  ];

  return (
    <ImageBackground source={PROFILE_ASSETS.background} style={styles.background} resizeMode="cover">
      <View style={styles.tint} />
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <View style={styles.topBar}>
            <TouchableOpacity onPress={() => router.back()} activeOpacity={0.8}>
              <Image source={PROFILE_ASSETS.back} style={styles.navImage} />
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.8}>
              <Image source={PROFILE_ASSETS.menu} style={styles.navImage} />
            </TouchableOpacity>
          </View>

          <View style={styles.hero}>
            <LinearGradient
              colors={['#ff27e2', '#ff72ca', '#7258ff', '#23baff']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.avatarGlow}
            >
              <View style={styles.avatarShell}>
                <Image source={{ uri: avatarUri }} style={styles.avatar} />
              </View>
            </LinearGradient>

            <View style={styles.nameRow}>
              <Text style={styles.userName}>♠ {profile.full_name || 'User'} ♠</Text>
            </View>
            <ProfileIdentityBadges vipType={profile.vip_type} level={profile.level} nickname={profile.nickname} centered />
            <LinearGradient colors={['transparent', '#b739ff', '#56a4ff', 'transparent']} style={styles.divider} />
            <View style={styles.idRow}>
              <Text style={styles.meta}>ID: {profile.display_id || '—'}</Text>
              <View style={styles.metaDivider} />
              <Text style={styles.meta}>{countryFlag ? `${countryFlag}  ` : ''}{profile.country || 'Global'}</Text>
            </View>
            <Text style={styles.bio}>{profile.bio || 'No bio yet.'}</Text>
          </View>

          <NeonCard style={styles.statsCard} contentStyle={styles.statsContent}>
            <Stat icon="person" iconColor="#f05cff" value={counts.followers} label="Followers" />
            <View style={styles.statDivider} />
            <Stat icon="people" iconColor="#56afff" value={counts.followingCount} label="Following" />
            <View style={styles.statDivider} />
            <Stat icon="eye" iconColor="#a763ff" value={visitors} label="Visitors" />
          </NeonCard>

          <View style={styles.interests}>
            {interests.map(([icon, label, color]) => (
              <View key={label} style={[styles.interestPill, { borderColor: color, shadowColor: color }]}>
                <Ionicons name={icon} size={19} color={color} />
                <Text style={styles.interestText}>{label}</Text>
              </View>
            ))}
          </View>

          {!isSelf && (
            <View style={styles.actions}>
              <TouchableOpacity
                style={styles.messageBorder}
                onPress={() => router.push(`/main/chat/${profile.id}?name=${encodeURIComponent(profile.full_name || 'User')}`)}
              >
                <View style={styles.messageButton}>
                  <Ionicons name="chatbubble-ellipses-outline" size={25} color="#fff" />
                  <Text style={styles.actionText}>Message</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity onPress={toggleFollow} disabled={busy} style={styles.followTouch}>
                <LinearGradient
                  colors={following ? ['#594376', '#382b62'] : ['#ff0792', '#ff3c78', '#ff7429']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.followButton}
                >
                  {busy ? <ActivityIndicator color="#fff" /> : (
                    <>
                      <Ionicons name={following ? 'checkmark' : 'person-add'} size={23} color="#fff" />
                      <Text style={styles.actionText}>{following ? 'Following' : 'Follow'}</Text>
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}

          <NeonCard style={styles.aboutCard}>
            <View style={styles.aboutTitle}>
              <Ionicons name="person-outline" size={21} color="#fff" />
              <Text style={styles.aboutTitleText}>About me</Text>
            </View>
            <View style={styles.aboutRule} />
            <View style={styles.aboutRow}>
              <Ionicons name="calendar-outline" size={21} color="#c9bfff" />
              <Text style={styles.aboutLabel}>Joined</Text>
              <Text style={styles.aboutValue}>{formatJoined(profile.created_at)}</Text>
            </View>
            <View style={styles.aboutRule} />
            <View style={styles.aboutRow}>
              <Ionicons name="location-outline" size={22} color="#c9bfff" />
              <Text style={styles.aboutLabel}>Location</Text>
              <Text style={styles.aboutValue}>{profile.country || 'Global'}</Text>
            </View>
            <View style={styles.aboutRule} />
            <View style={styles.aboutRow}>
              <Ionicons name="globe-outline" size={22} color="#c9bfff" />
              <Text style={styles.aboutLabel}>Language</Text>
              <Text style={styles.aboutValue}>{Array.isArray(languages) ? languages.join(', ') : languages}</Text>
            </View>
          </NeonCard>
        </ScrollView>
      </SafeAreaView>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  background: { flex: 1, backgroundColor: '#06002b' },
  tint: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(3,0,36,.12)' },
  safe: { flex: 1 },
  scrollContent: { paddingHorizontal: 22, paddingBottom: 42 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#08002f' },
  empty: { flex: 1, backgroundColor: '#08002f' },
  fallbackBack: { padding: 20 },
  emptyCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyText: { color: '#cfc5df', fontSize: 16, marginTop: 14 },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 20, borderRadius: 22, paddingHorizontal: 22, paddingVertical: 11, backgroundColor: '#a827de' },
  retryText: { color: '#fff', fontWeight: '800' },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  navImage: { width: 52, height: 52 },
  hero: { alignItems: 'center', marginTop: -2 },
  avatarGlow: { width: 190, height: 190, borderRadius: 95, padding: 4, shadowColor: '#e42dff', shadowOpacity: .85, shadowRadius: 18, elevation: 18 },
  avatarShell: { flex: 1, borderRadius: 91, padding: 3, backgroundColor: '#10062b' },
  avatar: { width: '100%', height: '100%', borderRadius: 88, backgroundColor: '#12052e' },
  nameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 20, gap: 10 },
  userName: { color: '#fff', fontSize: 27, fontWeight: '900', textShadowColor: 'rgba(91,51,255,.8)', textShadowRadius: 9 },
  nicknameBadge: { marginTop: 7, paddingHorizontal: 13, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: '#8B5CF6', backgroundColor: 'rgba(76,29,149,.5)' },
  nicknameBadgeText: { color: '#E9D5FF', fontSize: 12, fontWeight: '900' },
  levelBadge: { borderRadius: 15, paddingVertical: 6, paddingHorizontal: 13, shadowColor: '#ffbf27', shadowOpacity: .55, shadowRadius: 8 },
  levelText: { color: '#251200', fontWeight: '900', fontSize: 13 },
  divider: { width: '58%', height: 2, marginTop: 13, marginBottom: 13 },
  idRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  meta: { color: '#b7b1d2', fontSize: 14 },
  metaDivider: { width: 1, height: 19, backgroundColor: '#aaa1c7', marginHorizontal: 13 },
  bio: { color: '#f4efff', fontSize: 17, lineHeight: 25, textAlign: 'center', marginTop: 18, paddingHorizontal: 20 },
  cardBorder: { padding: 1, borderRadius: 20, shadowColor: '#b726ff', shadowOpacity: .45, shadowRadius: 9 },
  cardInner: { flex: 1, borderRadius: 19, backgroundColor: 'rgba(12,2,67,.88)' },
  statsCard: { height: 112, marginTop: 24 },
  statsContent: { flexDirection: 'row', alignItems: 'center' },
  stat: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  statNumber: { color: '#fff', fontSize: 23, lineHeight: 29, fontWeight: '900' },
  statLabel: { color: '#aaa1ca', fontSize: 13 },
  statDivider: { width: 1, height: 62, backgroundColor: 'rgba(199,189,228,.4)' },
  interests: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 16, paddingVertical: 10, paddingHorizontal: 8, borderRadius: 20, backgroundColor: 'rgba(10,1,58,.7)' },
  interestPill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderWidth: 1, borderRadius: 18, paddingVertical: 8, paddingHorizontal: 10, shadowOpacity: .45, shadowRadius: 7 },
  interestText: { color: '#f8f5ff', fontSize: 13, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 14, marginTop: 18 },
  messageBorder: { flex: 1, borderWidth: 1.5, borderColor: '#8f55ff', borderRadius: 28, padding: 1, shadowColor: '#674eff', shadowOpacity: .6, shadowRadius: 9 },
  messageButton: { minHeight: 56, borderRadius: 26, flexDirection: 'row', gap: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(17,6,76,.92)' },
  followTouch: { flex: 1, shadowColor: '#ff3c86', shadowOpacity: .6, shadowRadius: 11 },
  followButton: { minHeight: 59, borderRadius: 29, flexDirection: 'row', gap: 9, alignItems: 'center', justifyContent: 'center' },
  actionText: { color: '#fff', fontSize: 17, fontWeight: '900' },
  aboutCard: { marginTop: 20, minHeight: 205 },
  aboutTitle: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingTop: 17, paddingBottom: 12 },
  aboutTitleText: { color: '#fff', fontSize: 16, fontWeight: '900' },
  aboutRule: { height: 1, backgroundColor: 'rgba(165,146,210,.18)', marginHorizontal: 17 },
  aboutRow: { minHeight: 49, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18 },
  aboutLabel: { color: '#aaa1ca', fontSize: 14, marginLeft: 11 },
  aboutValue: { flex: 1, textAlign: 'right', color: '#bdb5d5', fontSize: 14 },
});
