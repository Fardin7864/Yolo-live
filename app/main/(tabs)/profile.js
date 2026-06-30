import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, Image, ImageBackground, TouchableOpacity,
  ScrollView, useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useGlobalState } from '../../../src/context/GlobalStateContext';
import { supabase } from '../../../src/api/supabase';
import { useResponsive } from '../../../src/hooks/useResponsive';

const PROFILE_ASSETS = {
  background: require('../../../assets/profile/background.png'),
  vipBanner: require('../../../assets/profile/vip-banner.png'),
  avatarFrame: require('../../../assets/profile/avatar-frame.png'),
  verified: require('../../../assets/profile/verified.png'),
  settings: require('../../../assets/profile/settings.png'),
  visitors: require('../../../assets/profile/visitors.png'),
  friends: require('../../../assets/profile/friends.png'),
  following: require('../../../assets/profile/following.png'),
  fans: require('../../../assets/profile/fans.png'),
  agency: require('../../../assets/profile/agency.png'),
  reseller: require('../../../assets/profile/reseller.png'),
  hostStats: require('../../../assets/profile/host-stats.png'),
  level: require('../../../assets/profile/level.png'),
  tasks: require('../../../assets/profile/tasks.png'),
  badges: require('../../../assets/profile/badges.png'),
  invites: require('../../../assets/profile/invites.png'),
  history: require('../../../assets/profile/history.png'),
  wallet: require('../../../assets/profile/wallet.png'),
  diamonds: require('../../../assets/profile/diamonds.png'),
  topup: require('../../../assets/profile/topup.png'),
  rewards: require('../../../assets/profile/rewards.png'),
  mall: require('../../../assets/profile/mall.png'),
  props: require('../../../assets/profile/props.png'),
};

const PURCHASED_PROFILE_FRAMES = {
  'heart-fantasy': require('../../../assets/mall/frames/heart-fantasy.webp'),
  'angel-wing': require('../../../assets/mall/frames/angel-wing.webp'),
  'royal-gold': require('../../../assets/mall/frames/royal-gold.webp'),
};

const formatNumber = (value) => {
  const number = Number(value) || 0;
  if (number >= 1000000) return `${(number / 1000000).toFixed(1)}M`;
  if (number >= 1000) return `${(number / 1000).toFixed(1)}K`;
  return String(number);
};

function GlassCard({ children, style }) {
  return (
    <View style={[styles.glassBorder, style]}>
      <LinearGradient
        colors={['rgba(45,20,96,.82)', 'rgba(8,15,64,.88)', 'rgba(35,11,74,.78)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.glassFill}
      >
        {children}
      </LinearGradient>
    </View>
  );
}

export default function ProfileScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { maxContentWidth, isTablet } = useResponsive();
  const { diamonds, beans, user, loading, myReseller, systemSettings } = useGlobalState();
  const [counts, setCounts] = useState({ followers: 0, following: 0, friends: 0 });
  const [countsStatus, setCountsStatus] = useState('loading');

  useEffect(() => {
    if (!user?.id) return undefined;
    let cancelled = false;
    setCountsStatus('loading');
    (async () => {
      try {
        const [followersRes, followingRes] = await Promise.all([
          supabase.from('follows').select('follower_id').eq('following_id', user.id),
          supabase.from('follows').select('following_id').eq('follower_id', user.id),
        ]);
        if (cancelled) return;
        if (followersRes.error || followingRes.error) throw followersRes.error || followingRes.error;
        const followerIds = (followersRes.data || []).map((row) => row.follower_id);
        const followingIds = (followingRes.data || []).map((row) => row.following_id);
        const followerSet = new Set(followerIds);
        setCounts({
          followers: followerIds.length,
          following: followingIds.length,
          friends: followingIds.filter((id) => followerSet.has(id)).length,
        });
        setCountsStatus('ready');
      } catch (error) {
        if (!cancelled) {
          console.warn('profile follows counts:', error?.message || error);
          setCountsStatus('error');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  if (loading || !user) {
    return (
      <SafeAreaView style={styles.loading}>
        <Text style={styles.loadingText}>Loading profile...</Text>
      </SafeAreaView>
    );
  }

  const contentWidth = Math.min(width, maxContentWidth);
  const level = Number(user.level) || 1;
  const expMultiplier = Number(systemSettings?.level_exp_multiplier) || 1500;
  const totalExp = Math.max(0, Number(user.lifetimeDiamondsSpent) || 0);
  const levelFloor = Math.max(0, (level - 1) * expMultiplier);
  const levelProgress = level >= 100
    ? 100
    : Math.min(100, Math.max(8, ((totalExp - levelFloor) / expMultiplier) * 100));
  const countValue = (value) => {
    if (countsStatus === 'loading') return '…';
    if (countsStatus === 'error') return '—';
    return formatNumber(value);
  };
  const visitors = user.visitorCount ?? user.visitors ?? 0;
  const resellerActive = !!myReseller?.id;
  const activeAvatarFrame = user.selectedProfileFrameUrl
    ? { uri: user.selectedProfileFrameUrl }
    : PURCHASED_PROFILE_FRAMES[user.selectedProfileFrame] || PROFILE_ASSETS.avatarFrame;

  const stats = [
    { label: 'Visitors', value: formatNumber(visitors), icon: PROFILE_ASSETS.visitors, route: '/main/network' },
    { label: 'Friends', value: countValue(counts.friends), icon: PROFILE_ASSETS.friends, route: '/main/network?tab=Friends' },
    { label: 'Following', value: countValue(counts.following), icon: PROFILE_ASSETS.following, route: '/main/network?tab=Following' },
    { label: 'Fans', value: countValue(counts.followers), icon: PROFILE_ASSETS.fans, route: '/main/network?tab=Followers' },
  ];

  const menuItems = [
    { label: 'My Agency', icon: PROFILE_ASSETS.agency, route: '/main/agency' },
    { label: resellerActive ? 'My Reseller' : 'Become Reseller', icon: PROFILE_ASSETS.reseller, route: '/main/reseller-dashboard' },
    { label: 'Host Stats', icon: PROFILE_ASSETS.hostStats, route: '/main/host-stats' },
    { label: 'My Level', icon: PROFILE_ASSETS.level, route: '/main/level' },
    { label: 'My Tasks', icon: PROFILE_ASSETS.tasks, route: '/main/tasks' },
    { label: 'My Badges', icon: PROFILE_ASSETS.badges, route: '/main/badges' },
    { label: 'Invites', icon: PROFILE_ASSETS.invites, route: '/main/my-invites' },
    { label: 'History', icon: PROFILE_ASSETS.history, route: '/main/host-stats' },
  ];

  const actionCards = [
    { title: 'My Wallet', subtitle: formatNumber(beans), artwork: PROFILE_ASSETS.wallet, colors: ['#A50083', '#4E0A6B'], route: '/main/wallet', coin: true },
    { title: 'Mall', subtitle: 'Shop Items', artwork: PROFILE_ASSETS.mall, colors: ['#D45224', '#8A164F'], route: '/main/mall' },
    { title: 'My Props', subtitle: 'View Collection', artwork: PROFILE_ASSETS.props, colors: ['#B57A08', '#7220A5'], route: '/main/mall?tab=props' },
    { title: 'My Diamonds', subtitle: formatNumber(diamonds), artwork: PROFILE_ASSETS.diamonds, colors: ['#C04A44', '#791647'], route: '/main/wallet', coin: true },
    { title: 'Top Up', subtitle: 'Get Diamonds', artwork: PROFILE_ASSETS.topup, colors: ['#7424CD', '#26108B'], route: '/main/wallet' },
    { title: 'Rewards', subtitle: 'Earn Gifts', artwork: PROFILE_ASSETS.rewards, colors: ['#0080B8', '#053B89'], route: '/main/tasks' },
  ];

  return (
    <ImageBackground source={PROFILE_ASSETS.background} style={styles.background} resizeMode="cover">
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <View style={[styles.content, isTablet && { width: contentWidth, alignSelf: 'center' }]}>
            <View style={styles.topActions}>
              <TouchableOpacity style={styles.assetAction} onPress={() => router.push('/main/settings')}>
                <Image source={PROFILE_ASSETS.settings} style={styles.settingsAsset} />
              </TouchableOpacity>
            </View>

            <View style={styles.hero}>
              <TouchableOpacity style={styles.avatarStage} onPress={() => router.push('/main/edit-profile')}>
                <Image source={{ uri: user.avatar }} style={styles.avatar} />
                <Image source={activeAvatarFrame} style={styles.avatarFrame} />
                <View style={styles.onlineDot} />
              </TouchableOpacity>
              <View style={styles.identity}>
                <View style={styles.nameRow}>
                  <Text style={styles.userName} numberOfLines={1}>{user.name || 'Yolo User'}</Text>
                  <Image source={PROFILE_ASSETS.verified} style={styles.verified} />
                </View>
                <View style={styles.badgeRow}>
                  <LinearGradient colors={['#FFAF28', '#FFD766']} style={styles.levelPill}>
                    <Ionicons name="star" size={12} color="#3C1B77" />
                    <Text style={styles.levelPillText}>Lv. {level}</Text>
                  </LinearGradient>
                  <LinearGradient colors={['#B312B9', '#441AD1']} style={styles.starPill}>
                    <Ionicons name="star" size={13} color="#FFE645" />
                    <Text style={styles.starPillText}>Super Star</Text>
                  </LinearGradient>
                </View>
                <Text style={styles.meta} numberOfLines={1}>
                  ID: {user.displayId || '...'}  •  {user.country || 'Global'}
                </Text>
                <Text style={styles.bio} numberOfLines={2}>
                  {user.bio || 'Living the moment, spreading the vibe ✨'}
                </Text>
              </View>
            </View>

            <GlassCard style={styles.statsCard}>
              <View style={styles.statsRow}>
                {stats.map((stat, index) => (
                  <React.Fragment key={stat.label}>
                    <TouchableOpacity style={styles.statItem} onPress={() => router.push(stat.route)}>
                      <Image source={stat.icon} style={styles.statIcon} />
                      <View>
                        <Text style={styles.statValue}>{stat.value}</Text>
                        <Text style={styles.statLabel}>{stat.label}</Text>
                      </View>
                    </TouchableOpacity>
                    {index < stats.length - 1 ? <View style={styles.statDivider} /> : null}
                  </React.Fragment>
                ))}
              </View>
            </GlassCard>

            <TouchableOpacity activeOpacity={0.9} onPress={() => router.push('/main/vip')} style={styles.vipBannerTouch}>
              <ImageBackground source={PROFILE_ASSETS.vipBanner} style={styles.vipBanner} imageStyle={styles.vipBannerImage} resizeMode="cover" />
            </TouchableOpacity>

            <View style={styles.actionRow}>
              {actionCards.map((card) => (
                <TouchableOpacity key={card.title} activeOpacity={0.88} style={styles.actionTouch} onPress={() => router.push(card.route)}>
                  <LinearGradient colors={card.colors} style={styles.actionCard}>
                    <Text style={styles.actionTitle} numberOfLines={1} adjustsFontSizeToFit>{card.title}</Text>
                    <Text style={styles.actionSubtitle} numberOfLines={1}>
                      {card.coin ? '🪙 ' : ''}{card.subtitle}
                    </Text>
                    <Image source={card.artwork} style={styles.actionArt} />
                    <View style={styles.arrowButton}><Ionicons name="arrow-forward" size={16} color="#6D35CA" /></View>
                  </LinearGradient>
                </TouchableOpacity>
              ))}
            </View>

            <GlassCard style={styles.levelCard}>
              <View style={styles.levelContent}>
                <Image source={PROFILE_ASSETS.level} style={styles.levelArtwork} />
                <View style={styles.levelDetails}>
                  <View style={styles.levelHeading}>
                    <Ionicons name="star" size={19} color="#FFD43C" />
                    <Text style={styles.levelTitle}>Super Star</Text>
                  </View>
                  <View style={styles.progressTrack}>
                    <LinearGradient
                      colors={['#FF5E9D', '#F20BC4']}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 0 }}
                      style={[styles.progressFill, { width: `${levelProgress}%` }]}
                    />
                  </View>
                  <Text style={styles.xpText}>
                    {Math.max(0, totalExp - levelFloor)} / {expMultiplier} XP
                  </Text>
                  <Text style={styles.encouragement}>Keep going! You’re doing great 💪</Text>
                </View>
                <TouchableOpacity style={styles.rewardBox} onPress={() => router.push('/main/tasks')}>
                  <Ionicons name="gift" size={31} color="#FFB13B" />
                  <Text style={styles.rewardText}>Next Reward</Text>
                </TouchableOpacity>
              </View>
            </GlassCard>

            <GlassCard style={styles.menuCard}>
              <View style={styles.menuGrid}>
                {menuItems.map((item, index) => (
                  <TouchableOpacity
                    key={item.label}
                    style={[
                      styles.menuItem,
                      index % 4 !== 3 && styles.menuRightBorder,
                      index < 4 && styles.menuBottomBorder,
                    ]}
                    onPress={() => router.push(item.route)}
                  >
                    <Image source={item.icon} style={styles.menuIcon} />
                    <Text style={styles.menuText} numberOfLines={2}>{item.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </GlassCard>
          </View>
          <View style={styles.bottomSpace} />
        </ScrollView>
      </SafeAreaView>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  background: { flex: 1, backgroundColor: '#05072D' },
  safe: { flex: 1 },
  loading: { flex: 1, backgroundColor: '#07072E', alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: '#FFFFFF' },
  scrollContent: { paddingTop: 8, paddingHorizontal: 16 },
  content: { width: '100%' },
  topActions: { height: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 10 },
  assetAction: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  settingsAsset: { width: 46, height: 46, resizeMode: 'contain' },
  hero: { minHeight: 132, flexDirection: 'row', alignItems: 'center', marginTop: -3, marginBottom: 10 },
  avatarStage: { width: 137, height: 137, alignItems: 'center', justifyContent: 'center', marginLeft: -3 },
  avatar: { width: 99, height: 99, borderRadius: 50, backgroundColor: '#211250' },
  avatarFrame: { position: 'absolute', width: 137, height: 137, resizeMode: 'contain' },
  onlineDot: { position: 'absolute', right: 12, bottom: 14, width: 19, height: 19, borderRadius: 10, backgroundColor: '#18D26E', borderWidth: 2, borderColor: '#FFFFFF' },
  identity: { flex: 1, minWidth: 0, paddingLeft: 7 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  userName: { color: '#FFFFFF', fontSize: 22, fontWeight: '900', maxWidth: '80%' },
  verified: { width: 25, height: 25, resizeMode: 'contain' },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  levelPill: { height: 25, borderRadius: 13, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 4 },
  levelPillText: { color: '#2E145F', fontSize: 11, fontWeight: '900' },
  starPill: { height: 25, borderRadius: 13, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: '#A54BFF' },
  starPillText: { color: '#FFFFFF', fontSize: 10.5, fontWeight: '800' },
  meta: { color: '#D1CCE8', fontSize: 11.5, marginTop: 8 },
  bio: { color: '#ECE8FA', fontSize: 11.5, lineHeight: 16, marginTop: 5 },
  glassBorder: { borderWidth: 1, borderColor: 'rgba(149,70,255,.62)', borderRadius: 18, overflow: 'hidden' },
  glassFill: { flex: 1 },
  statsCard: { height: 75, marginBottom: 14 },
  statsRow: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 7 },
  statItem: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  statIcon: { width: 34, height: 34, resizeMode: 'contain' },
  statValue: { color: '#FFFFFF', fontSize: 14, fontWeight: '900' },
  statLabel: { color: '#D7D0EC', fontSize: 9.5, marginTop: 2 },
  statDivider: { width: 1, height: 40, backgroundColor: 'rgba(185,157,237,.28)' },
  vipBannerTouch: { height: 94, borderRadius: 17, overflow: 'hidden', marginBottom: 14 },
  vipBanner: { flex: 1 },
  vipBannerImage: { borderRadius: 16 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 14 },
  actionTouch: { flexBasis: '48%', flexGrow: 1, height: 104, borderRadius: 18, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,80,224,.72)' },
  actionCard: { flex: 1, paddingLeft: 12, paddingTop: 12, overflow: 'hidden' },
  actionTitle: { color: '#FFFFFF', fontSize: 14.5, fontWeight: '900', maxWidth: '58%' },
  actionSubtitle: { color: '#FFFFFF', fontSize: 10.5, marginTop: 5, fontWeight: '600', maxWidth: '58%' },
  actionArt: { position: 'absolute', width: 82, height: 82, resizeMode: 'contain', right: -1, top: 11 },
  arrowButton: { position: 'absolute', left: 12, bottom: 9, width: 25, height: 25, borderRadius: 13, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  levelCard: { height: 123, marginBottom: 14 },
  levelContent: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  levelArtwork: { width: 105, height: 105, resizeMode: 'contain', marginLeft: -3 },
  levelDetails: { flex: 1, minWidth: 0, paddingHorizontal: 4 },
  levelHeading: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 11 },
  levelTitle: { color: '#FFFFFF', fontSize: 15, fontWeight: '900' },
  progressTrack: { height: 10, borderRadius: 5, borderWidth: 1, borderColor: '#9249F4', backgroundColor: '#160C48', overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 5 },
  xpText: { color: '#FF65CA', fontSize: 11, fontWeight: '800', marginTop: 7 },
  encouragement: { color: '#FFFFFF', fontSize: 9.5, marginTop: 5 },
  rewardBox: { width: 67, alignItems: 'center', justifyContent: 'center', borderLeftWidth: 1, borderLeftColor: 'rgba(142,91,219,.30)' },
  rewardText: { color: '#E9E3F8', fontSize: 9.5, textAlign: 'center', marginTop: 7 },
  menuCard: { height: 166 },
  menuGrid: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 5, paddingVertical: 4 },
  menuItem: { width: '25%', height: '50%', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  menuRightBorder: { borderRightWidth: 1, borderRightColor: 'rgba(175,143,232,.20)' },
  menuBottomBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(175,143,232,.16)' },
  menuIcon: { width: 47, height: 47, resizeMode: 'contain' },
  menuText: { color: '#FFFFFF', fontSize: 10.5, lineHeight: 13, textAlign: 'center', marginTop: 1 },
  bottomSpace: { height: 120 },
});
