import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Image, ImageBackground,
  RefreshControl, ScrollView, useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import LogoLoader from '../../../src/components/LogoLoader';
import { useGlobalState } from '../../../src/context/GlobalStateContext';
import { supabase } from '../../../src/api/supabase';
import SvipNameTag from '../../../src/components/SvipNameTag';

const LOCAL_HERO = require('../../../assets/onboarding/welcome-loading.webp');
const LOCAL_AVATAR = require('../../../assets/splash-icon.png');
const APP_BACKGROUND = require('../../../assets/backgrounds/neon-space.webp');
const AUTH_BACKGROUND = require('../../../assets/onboarding/google-auth-background.webp');
const SECTION_ICONS = {
  events: require('../../../assets/home/icons/events.png'),
  nearby: require('../../../assets/home/icons/nearby.png'),
  popular: require('../../../assets/home/icons/popular.png'),
};
const ACTION_ICONS = {
  network: require('../../../assets/home/icons/network.png'),
  vip: require('../../../assets/home/icons/vip.png'),
  svip: require('../../../assets/home/icons/svip.png'),
  tasks: require('../../../assets/home/icons/tasks.png'),
};
const EMPTY_BACKGROUNDS = {
  events: require('../../../assets/home/empty/events.webp'),
  nearby: require('../../../assets/home/empty/nearby.webp'),
  live: require('../../../assets/home/empty/live.webp'),
};
const HOME_PROFILE_FRAMES = {
  'heart-fantasy': require('../../../assets/mall/frames/heart-fantasy.webp'),
  'angel-wing': require('../../../assets/mall/frames/angel-wing.webp'),
  'royal-gold': require('../../../assets/mall/frames/royal-gold.webp'),
};
const FALLBACK_CAROUSEL = [
  LOCAL_HERO, AUTH_BACKGROUND, APP_BACKGROUND, EMPTY_BACKGROUNDS.live, EMPTY_BACKGROUNDS.nearby,
  EMPTY_BACKGROUNDS.events, LOCAL_HERO, APP_BACKGROUND, AUTH_BACKGROUND, EMPTY_BACKGROUNDS.live,
];

const CATEGORY_ITEMS = [
  { key: 'Trending', icon: 'flame' },
  { key: 'Audio', icon: 'musical-notes' },
  { key: 'Nearby', icon: 'location' },
  { key: 'Gaming', icon: 'game-controller' },
  { key: 'Music', icon: 'headset' },
  { key: 'Chat', icon: 'chatbubble-ellipses' },
];

const QUICK_ACTIONS = [
  { key: 'tasks', title: 'Tasks', subtitle: 'Complete & earn', meta: '🪙 120', colors: ['#5C1BC6', '#B914D1', '#F00CB8'], glow: '#FF55E6', route: '/main/tasks' },
  { key: 'vip', title: 'VIP', subtitle: 'Exclusive perks', meta: 'VIP 3', colors: ['#7C283E', '#B55527', '#E18A19'], glow: '#FFB53D', route: '/main/vip' },
  { key: 'network', title: 'Network', subtitle: 'Grow your circle', meta: '+ New people', colors: ['#1645A8', '#0079AE', '#00A7A4'], glow: '#35E7FF', route: '/main/network' },
  { key: 'svip', title: 'SVIP', subtitle: 'Super privileges', meta: 'SVIP', colors: ['#4D1D95', '#8B2AE6', '#D97706'], glow: '#FCD34D', route: '/main/svip' },
];

const GAME_ITEMS = [
  {
    key: 'fruit_roulette',
    title: 'Fruit Roulette',
    subtitle: 'Pick a fruit. Win up to 8x.',
    icon: 'disc',
    emoji: '🍓',
    colors: ['#FF336A', '#7B2DFF', '#1C1162'],
    chip: 'Multiplayer',
  },
  {
    key: 'teen_patti',
    title: 'Teen Patti',
    subtitle: 'Bet on A, B or C. Winner pays 2x.',
    icon: 'albums',
    emoji: '🃏',
    colors: ['#0EA5E9', '#5137E8', '#160C5A'],
    chip: 'Cards',
  },
  {
    key: 'greedy_lion',
    title: 'Greedy Lion',
    subtitle: 'Pick up to 6 foods. Pizza or Salad wins.',
    icon: 'trophy',
    emoji: '🦁',
    colors: ['#F59E0B', '#B91C9B', '#11115F'],
    chip: 'Native',
  },
  {
    key: 'tin_patti_pro',
    title: 'Tin Patti Pro',
    subtitle: 'One shared pro card table.',
    icon: 'albums',
    emoji: 'TP',
    colors: ['#F59E0B', '#0F8A5F', '#5C1BC6'],
    chip: 'Global',
  },
];

const PAGE_SIZE = 10;

const formatCount = (value) => {
  const n = Number(value) || 0;
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n);
};

const imageSource = (uri, fallback = LOCAL_AVATAR) => uri ? { uri } : fallback;

function SafeImage({ uri, style, fallback = LOCAL_AVATAR }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [uri]);
  return <Image source={!failed && uri ? { uri } : fallback} style={style} onError={() => setFailed(true)} />;
}

function HomeHeader({ user, unreadCount, onProfile, onSearch, onNotifications }) {
  const bundledFrameKey = user?.selectedProfileFrameUrl?.startsWith?.('bundled://')
    ? user.selectedProfileFrameUrl.replace('bundled://', '')
    : null;
  const purchasedFrame = user?.selectedProfileFrameUrl && !user.selectedProfileFrameUrl.startsWith('bundled://')
    ? { uri: user.selectedProfileFrameUrl }
    : HOME_PROFILE_FRAMES[bundledFrameKey || user?.selectedProfileFrame];

  return (
    <View style={styles.header}>
      <TouchableOpacity onPress={onProfile} activeOpacity={0.82} style={styles.avatarTouch}>
        <LinearGradient colors={['#20D8FF', '#8B43FF', '#F62AD9']} style={styles.avatarRing}>
          <SafeImage uri={user?.avatar} style={styles.headerAvatar} />
        </LinearGradient>
        {purchasedFrame ? (
          <Image pointerEvents="none" source={purchasedFrame} style={styles.headerProfileFrame} />
        ) : null}
        <View style={styles.onlineDot} />
        {!purchasedFrame ? (
          <View style={styles.crownBubble}>
            <Text style={styles.crownText}>👑</Text>
          </View>
        ) : null}
      </TouchableOpacity>
      <View style={styles.headerActions}>
        <TouchableOpacity accessibilityLabel="Search" onPress={onSearch} style={styles.headerIcon}>
          <Ionicons name="search" size={27} color="#FFFFFF" />
        </TouchableOpacity>
        <TouchableOpacity accessibilityLabel="Notifications" onPress={onNotifications} style={styles.headerIcon}>
          <Ionicons name="notifications-outline" size={28} color="#FFFFFF" />
          {unreadCount > 0 && (
            <View style={styles.notifBadge}>
              <Text style={styles.notifBadgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

function CategoryTabs({ active, onChange }) {
  return (
    <FlatList
      horizontal
      data={CATEGORY_ITEMS}
      showsHorizontalScrollIndicator={false}
      keyExtractor={(item) => item.key}
      contentContainerStyle={styles.categoryList}
      renderItem={({ item }) => {
        const selected = active === item.key;
        const body = (
          <>
            <Ionicons name={item.icon} size={16} color={selected ? '#FFF' : '#DAD8F7'} />
            <Text style={[styles.categoryText, selected && styles.categoryTextActive]}>{item.key}</Text>
          </>
        );
        return (
          <TouchableOpacity activeOpacity={0.84} onPress={() => onChange(item.key)} style={styles.categoryTouch}>
            {selected ? (
              <LinearGradient colors={['#7446FF', '#E126F2']} style={[styles.categoryPill, styles.categoryPillActive]}>{body}</LinearGradient>
            ) : (
              <View style={styles.categoryPill}>{body}</View>
            )}
          </TouchableOpacity>
        );
      }}
    />
  );
}

function ImageCarousel({ banners, width, onPress, compact = false, reverseFallback = false }) {
  const listRef = useRef(null);
  const [active, setActive] = useState(0);
  const paused = useRef(false);
  const resumeTimer = useRef(null);
  const slideWidth = width - 32;
  const slides = useMemo(() => {
    const fallback = reverseFallback ? [...FALLBACK_CAROUSEL].reverse() : FALLBACK_CAROUSEL;
    return Array.from({ length: 10 }, (_, index) => ({
      id: banners[index]?.id || `local-carousel-${compact ? 'secondary' : 'primary'}-${index}`,
      source: banners[index]?.image_url ? { uri: banners[index].image_url } : fallback[index],
      linkUrl: banners[index]?.link_url || null,
    }));
  }, [banners, compact, reverseFallback]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (paused.current || slides.length < 2) return;
      setActive((current) => {
        const next = (current + 1) % slides.length;
        listRef.current?.scrollToOffset({ offset: next * slideWidth, animated: true });
        return next;
      });
    }, compact ? 4000 : 5500);
    return () => {
      clearInterval(timer);
      if (resumeTimer.current) clearTimeout(resumeTimer.current);
    };
  }, [compact, slideWidth, slides.length]);

  const resumeAutoplay = () => {
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    resumeTimer.current = setTimeout(() => { paused.current = false; }, 3000);
  };

  return (
    <View style={[styles.heroShell, compact && styles.secondaryCarousel]}>
      <FlatList
        ref={listRef}
        horizontal
        pagingEnabled
        data={slides}
        keyExtractor={(item) => item.id}
        showsHorizontalScrollIndicator={false}
        onScrollBeginDrag={() => { paused.current = true; }}
        onScrollEndDrag={resumeAutoplay}
        onMomentumScrollEnd={(e) => {
          setActive(Math.round(e.nativeEvent.contentOffset.x / slideWidth));
          resumeAutoplay();
        }}
        renderItem={({ item }) => (
          <TouchableOpacity activeOpacity={0.96} onPress={() => onPress(item)} style={[styles.heroCard, compact && styles.secondarySlide, { width: slideWidth }]}>
            <Image source={item.source} style={styles.carouselImage} resizeMode="cover" />
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

function QuickActionCard({ item, onPress }) {
  return (
    <TouchableOpacity activeOpacity={0.86} onPress={onPress} style={styles.quickTouch}>
      <LinearGradient
        colors={item.colors}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.quickCard, { borderColor: `${item.glow}99`, shadowColor: item.glow }]}
      >
        <View style={[styles.quickGlow, { backgroundColor: `${item.glow}26` }]} />
        <View style={[styles.quickIconShell, { borderColor: `${item.glow}70` }]}>
          <Image source={ACTION_ICONS[item.key]} style={styles.quickAsset} resizeMode="contain" />
        </View>
        <View style={styles.quickCopy}>
          <Text style={styles.quickTitle} numberOfLines={1} adjustsFontSizeToFit>{item.title}</Text>
        </View>
      </LinearGradient>
    </TouchableOpacity>
  );
}

function SectionHeader({ asset, title, onViewAll }) {
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.sectionTitleRow}>
        <Image source={asset} style={styles.sectionAsset} resizeMode="contain" />
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      <TouchableOpacity onPress={onViewAll} style={styles.viewAll}>
        <Text style={styles.viewAllText}>View all</Text>
        <Ionicons name="chevron-forward" size={17} color="#AAA9CA" />
      </TouchableOpacity>
    </View>
  );
}

function LiveStreamCard({ stream, onPress, style }) {
  return (
    <TouchableOpacity activeOpacity={0.88} onPress={onPress} style={[styles.liveCard, style]}>
      <SafeImage uri={stream.coverUrl} style={styles.liveCover} />
      <LinearGradient colors={['transparent', 'rgba(4,5,28,.96)']} style={styles.liveShade} />
      <View style={styles.cardLivePill}><Text style={styles.cardLiveText}>LIVE</Text></View>
      <View style={styles.viewerPill}>
        <Ionicons name="eye" size={11} color="#FFF" />
        <Text style={styles.viewerText}>{formatCount(stream.viewerCount)}</Text>
      </View>
      <View style={styles.liveCardCopy}>
        <Text style={styles.liveCardTitle} numberOfLines={1}>{stream.title || stream.tags?.[0] || 'Live with me'}</Text>
        <View style={styles.hostLine}>
          <SafeImage uri={stream.broadcasterAvatar} style={styles.miniAvatar} />
          <Text style={styles.hostName} numberOfLines={1}>{stream.broadcasterName}</Text>
          <SvipNameTag vipType={stream.vipType} compact />
          <Ionicons name="checkmark-circle" size={12} color="#8A63FF" />
        </View>
        <View style={styles.tagPill}><Text style={styles.tagText}>{stream.tags?.[0] || 'Live'}</Text></View>
      </View>
    </TouchableOpacity>
  );
}

function HostProfileCard({ host, index, onPress, nearby = false, style }) {
  const borderColors = ['#7E48FF', '#16C8E5', '#F339B2', '#683CFF'];
  return (
    <TouchableOpacity activeOpacity={0.88} onPress={onPress} style={[styles.hostCard, { borderColor: borderColors[index % borderColors.length] }, style]}>
      <SafeImage uri={host.avatar_url} style={styles.nearbyImage} />
      <LinearGradient colors={['transparent', 'rgba(7,6,38,.97)']} style={styles.nearbyShade} />
      {nearby ? <View style={styles.distancePill}><Text style={styles.distanceText}>{host.distance}</Text></View> : null}
      <View style={styles.nearbyCopy}>
        <View style={styles.nearbyNameRow}>
          <Text style={styles.nearbyName} numberOfLines={1}>{host.full_name || 'Host'}</Text>
          <Ionicons name="checkmark-circle" size={13} color="#8A63FF" />
        </View>
        <View style={styles.pointsRow}>
          <Ionicons name="star" size={12} color="#FFD53D" />
          <Text style={styles.pointsText}>{formatCount(host.points)}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

function TwoColumnGrid({ items, renderItem, style }) {
  return (
    <View style={[styles.twoColumnGrid, style]}>
      {items.map((item, index) => renderItem(item, index))}
    </View>
  );
}

function ShowMoreButton({ loading, onPress }) {
  return (
    <TouchableOpacity activeOpacity={0.86} disabled={loading} onPress={onPress} style={styles.showMoreTouch}>
      <LinearGradient colors={['#7247FF', '#E02BEF']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.showMoreButton}>
        {loading ? <LogoLoader size={24} /> : <Text style={styles.showMoreText}>Show more</Text>}
      </LinearGradient>
    </TouchableOpacity>
  );
}

function GamesHeader() {
  return (
    <View style={styles.gamesHeader}>
      <View style={styles.gamesHeaderIcon}>
        <Ionicons name="game-controller" size={19} color="#FFFFFF" />
      </View>
      <Text style={styles.gamesHeaderTitle}>All Games</Text>
    </View>
  );
}

function GameCard({ game, onPress, style }) {
  return (
    <TouchableOpacity activeOpacity={0.88} onPress={onPress} style={[styles.gameCardTouch, style]}>
      <LinearGradient colors={game.colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.gameCard}>
        <View style={styles.gameCardGlow} />
        <View style={styles.gameIconBubble}>
          <Text style={styles.gameEmoji}>{game.emoji}</Text>
        </View>
        <Ionicons name={game.icon} size={52} color="rgba(255,255,255,.18)" style={styles.gameWatermark} />
        <View style={styles.gameCardCopy}>
          <Text style={styles.gameCardTitle} numberOfLines={1}>{game.title}</Text>
          <Text style={styles.gameCardSubtitle} numberOfLines={2}>{game.subtitle}</Text>
        </View>
        <View style={styles.gameCardFooter}>
          <Text style={styles.gameChipText}>{game.chip}</Text>
          <Ionicons name="chevron-forward" size={16} color="#FFFFFF" />
        </View>
      </LinearGradient>
    </TouchableOpacity>
  );
}

function EventCard({ event, index, onPress }) {
  const themes = [
    ['#64105E', '#3926A8', '#07113D'],
    ['#003968', '#063B86', '#120B58'],
    ['#6C0A92', '#38119A', '#07113D'],
  ];
  const names = ['SING OFF', 'GAME NIGHT', 'DANCE BATTLE'];
  const icons = ['mic', 'game-controller', 'accessibility'];
  const times = ['Today 8:00 PM', 'Tonight 9:00 PM', 'Sat 10:00 PM'];
  return (
    <TouchableOpacity activeOpacity={0.88} onPress={onPress} style={styles.eventTouch}>
      <LinearGradient colors={themes[index % themes.length]} style={styles.eventCard}>
        {event?.image_url ? <Image source={{ uri: event.image_url }} style={styles.eventImage} /> : null}
        <LinearGradient colors={['rgba(8,5,40,.08)', 'rgba(4,4,26,.84)']} style={styles.eventShade} />
        <Ionicons name={icons[index % icons.length]} size={66} color="rgba(137,213,255,.42)" style={styles.eventIcon} />
        <Text style={styles.eventTitle}>{event?.title || names[index % names.length]}</Text>
        <View style={styles.eventLabel}><Text style={styles.eventLabelText}>LIVE EVENT</Text></View>
        <Text style={styles.eventTime}>{event?.subtitle || times[index % times.length]}</Text>
        <View style={styles.attendeeRow}>
          {[0, 1, 2].map((n) => <Image key={n} source={LOCAL_AVATAR} style={[styles.attendeeAvatar, n > 0 && { marginLeft: -7 }]} />)}
          <Text style={styles.attendeeText}>{event?.attendees || `${6 + index * 3}.2K`}</Text>
        </View>
      </LinearGradient>
    </TouchableOpacity>
  );
}

function EmptySection({ background, title, subtitle, action, actionIcon, onPress }) {
  return (
    <ImageBackground source={background} style={styles.emptyCard} imageStyle={styles.emptyBackground}>
      <LinearGradient colors={['rgba(5,6,43,.12)', 'rgba(7,8,50,.68)']} style={styles.emptyOverlay}>
        <View style={styles.emptyContent}>
          <Text style={styles.emptyTitle}>{title}</Text>
          <Text style={styles.emptySubtitle}>{subtitle}</Text>
          <TouchableOpacity onPress={onPress} activeOpacity={0.86}>
            <LinearGradient
              colors={['#F43DBD', '#6845F5']}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={styles.emptyAction}
            >
              {actionIcon ? <Ionicons name={actionIcon} size={18} color="#FFFFFF" /> : null}
              <Text style={styles.emptyActionText}>{action}</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </LinearGradient>
    </ImageBackground>
  );
}

export default function PremiumHomeScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { user, homeBanners, gameSettings } = useGlobalState();
  const [activeCategory, setActiveCategory] = useState('Trending');
  const [liveStreams, setLiveStreams] = useState([]);
  const [liveHasMore, setLiveHasMore] = useState(false);
  const [loadingMoreLive, setLoadingMoreLive] = useState(false);
  const [hosts, setHosts] = useState([]);
  const [nearbyHosts, setNearbyHosts] = useState([]);
  const [hostHasMore, setHostHasMore] = useState(false);
  const [loadingMoreHosts, setLoadingMoreHosts] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const topBanners = (homeBanners || []).filter((b) => (b.position || 'top') === 'top' && b.is_active !== false);
  const eventBanners = (homeBanners || []).filter((b) => b.position === 'bottom' && b.is_active !== false);
  const isGaming = activeCategory === 'Gaming';
  const showNearby = activeCategory === 'Nearby';
  const games = useMemo(
    () => GAME_ITEMS.filter((game) => gameSettings?.[game.key]?.is_active !== false),
    [gameSettings],
  );
  const liveFirstPage = liveStreams.slice(0, 4);
  const liveRest = liveStreams.slice(4);
  const hostList = showNearby ? nearbyHosts : hosts;
  const hostFirstPage = hostList.slice(0, 4);
  const hostRest = hostList.slice(4);

  useEffect(() => {
    if (!user?.id) return undefined;
    const loadUnread = async () => {
      const { data } = await supabase.rpc('get_unread_notification_count');
      setUnreadCount(typeof data === 'number' ? data : 0);
    };
    loadUnread();
    const channel = supabase.channel(`home-notifs-${user.id}-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` }, loadUnread)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user?.id]);

  const fetchLiveStreams = useCallback(async ({ reset = false, offset = 0 } = {}) => {
    try { await supabase.rpc('cleanup_stale_live_streams'); } catch (_) {}
    const pageOffset = reset ? 0 : offset;
    let query = supabase.from('live_streams')
      .select('id, broadcaster_id, type, title, tag, cover_url, current_viewers, peak_viewers, total_gifts, last_heartbeat_at, profiles:broadcaster_id(full_name, avatar_url, is_banned, country, vip_type)')
      .eq('status', 'live')
      .gt('last_heartbeat_at', new Date(Date.now() - 90_000).toISOString())
      .order('current_viewers', { ascending: false })
      .order('total_gifts', { ascending: false })
      .range(pageOffset, pageOffset + PAGE_SIZE);
    if (activeCategory === 'Audio') query = query.eq('type', 'audio');
    else if (!['Trending', 'Nearby'].includes(activeCategory)) query = query.eq('tag', activeCategory);
    const { data, error } = await query;
    if (error) throw error;
    const rows = data || [];
    setLiveHasMore(rows.length > PAGE_SIZE);
    const nextStreams = rows.slice(0, PAGE_SIZE).filter((item) => !item.profiles?.is_banned).map((item) => ({
      id: item.broadcaster_id,
      streamId: item.id,
      title: item.title,
      broadcasterName: item.profiles?.full_name || 'Streamer',
      broadcasterAvatar: item.profiles?.avatar_url,
      vipType: item.profiles?.vip_type || null,
      viewerCount: item.current_viewers ?? item.peak_viewers ?? 0,
      coverUrl: item.cover_url || item.profiles?.avatar_url,
      tags: [item.tag, item.type === 'audio' ? 'Audio' : 'Live'].filter(Boolean),
      streamType: item.type,
      country: item.profiles?.country,
    }));
    setLiveStreams((current) => reset ? nextStreams : [...current, ...nextStreams]);
  }, [activeCategory]);

  const fetchNearbyHosts = useCallback(async ({ reset = false, offset = 0 } = {}) => {
    const pageOffset = reset ? 0 : offset;
    let query = supabase.from('profiles')
      .select('id, full_name, avatar_url, country, level')
      .eq('is_banned', false)
      .order('level', { ascending: false })
      .range(pageOffset, pageOffset + PAGE_SIZE);
    if (user?.country) query = query.eq('country', user.country);
    if (user?.id) query = query.neq('id', user.id);
    const { data } = await query;
    const rows = data || [];
    setHostHasMore(rows.length > PAGE_SIZE);
    const nextHosts = rows.slice(0, PAGE_SIZE).map((host, index) => ({
      ...host,
      distance: `${(0.2 + (pageOffset + index) * 0.2).toFixed(1)} km`,
      points: Math.max(120, Number(host.level || 1) * 210),
    }));
    setNearbyHosts((current) => reset ? nextHosts : [...current, ...nextHosts]);
  }, [user?.country, user?.id]);

  const fetchHosts = useCallback(async ({ reset = false, offset = 0 } = {}) => {
    const pageOffset = reset ? 0 : offset;
    let query = supabase.from('profiles')
      .select('id, full_name, avatar_url, country, level')
      .eq('is_banned', false)
      .order('level', { ascending: false })
      .range(pageOffset, pageOffset + PAGE_SIZE);
    if (user?.id) query = query.neq('id', user.id);
    const { data } = await query;
    const rows = data || [];
    setHostHasMore(rows.length > PAGE_SIZE);
    const nextHosts = rows.slice(0, PAGE_SIZE).map((host) => ({
      ...host,
      points: Math.max(120, Number(host.level || 1) * 210),
    }));
    setHosts((current) => reset ? nextHosts : [...current, ...nextHosts]);
  }, [user?.id]);

  const fetchAll = useCallback(async () => {
    if (isGaming) return;
    await Promise.all([
      fetchLiveStreams({ reset: true }),
      showNearby ? fetchNearbyHosts({ reset: true }) : fetchHosts({ reset: true }),
    ]);
  }, [fetchHosts, fetchLiveStreams, fetchNearbyHosts, isGaming, showNearby]);

  useEffect(() => {
    setLoading(true);
    fetchAll().finally(() => setLoading(false));
  }, [fetchAll]);

  const liveFetchRef = useRef(fetchLiveStreams);
  useEffect(() => { liveFetchRef.current = fetchLiveStreams; }, [fetchLiveStreams]);
  useEffect(() => {
    const channel = supabase.channel(`premium-home-live-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'live_streams' }, () => liveFetchRef.current?.({ reset: true }))
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  };

  const loadMoreLive = async () => {
    if (loadingMoreLive || !liveHasMore) return;
    setLoadingMoreLive(true);
    await fetchLiveStreams({ offset: liveStreams.length }).finally(() => setLoadingMoreLive(false));
  };

  const loadMoreHosts = async () => {
    if (loadingMoreHosts || !hostHasMore) return;
    setLoadingMoreHosts(true);
    const loader = showNearby ? fetchNearbyHosts : fetchHosts;
    await loader({ offset: hostList.length }).finally(() => setLoadingMoreHosts(false));
  };

  const openStream = (stream, index) => router.push({
    pathname: `/broadcast/${stream.id}`,
    params: {
      type: stream.streamType,
      siblings: liveStreams.map((item) => item.id).join(','),
      myIdx: String(index),
    },
  });

  const openHero = (slide) => {
    if (slide.linkUrl) router.push(slide.linkUrl);
    else if (liveStreams[0]) openStream(liveStreams[0], 0);
    else router.push('/main/(tabs)/live');
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <StatusBar style="light" />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.page}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor="#DA31F1" />}
      >
        <HomeHeader
          user={user}
          unreadCount={unreadCount}
          onProfile={() => router.push('/main/(tabs)/profile')}
          onSearch={() => router.push('/main/(tabs)/explore')}
          onNotifications={() => router.push('/main/notifications')}
        />
        <CategoryTabs active={activeCategory} onChange={setActiveCategory} />
        <ImageCarousel banners={topBanners} width={width} onPress={openHero} />

        <View style={styles.quickRow}>
          {QUICK_ACTIONS.map((item) => <QuickActionCard key={item.key} item={item} onPress={() => router.push(item.route)} />)}
        </View>

        {isGaming ? (
          <>
            <GamesHeader />
            {games.length ? (
              <TwoColumnGrid
                items={games}
                style={styles.gamesGrid}
                renderItem={(item) => <GameCard key={item.key} game={item} style={styles.gridCard} onPress={() => router.push(`/main/game/${item.key}`)} />}
              />
            ) : (
              <EmptySection
                background={EMPTY_BACKGROUNDS.events}
                title="No games available"
                subtitle="Games will appear here when they are enabled."
                action="Explore"
                actionIcon="game-controller"
                onPress={() => router.push('/main/(tabs)/explore')}
              />
            )}
          </>
        ) : (
          <>
            <SectionHeader asset={SECTION_ICONS.popular} title="Popular Live" onViewAll={() => router.push('/main/(tabs)/explore')} />
            {loading ? (
              <View style={styles.loader}><LogoLoader size="small" /></View>
            ) : liveStreams.length ? (
              <>
                <TwoColumnGrid
                  items={liveFirstPage}
                  renderItem={(item, index) => (
                    <LiveStreamCard
                      key={item.streamId}
                      stream={item}
                      style={styles.gridCard}
                      onPress={() => openStream(item, index)}
                    />
                  )}
                />
                {liveRest.length ? <ImageCarousel banners={eventBanners} width={width} onPress={openHero} compact reverseFallback /> : null}
                {liveRest.length ? (
                  <TwoColumnGrid
                    items={liveRest}
                    style={styles.gridAfterCarousel}
                    renderItem={(item, index) => (
                      <LiveStreamCard
                        key={item.streamId}
                        stream={item}
                        style={styles.gridCard}
                        onPress={() => openStream(item, index + 4)}
                      />
                    )}
                  />
                ) : null}
                {liveHasMore ? <ShowMoreButton loading={loadingMoreLive} onPress={loadMoreLive} /> : null}
              </>
            ) : (
              <EmptySection
                background={EMPTY_BACKGROUNDS.live}
                title="No live streams right now"
                subtitle="Be the first to go live and start entertaining!"
                action="Go Live"
                actionIcon="videocam"
                onPress={() => router.push('/main/(tabs)/live')}
              />
            )}

            {!loading && (hostList.length ? (
              <>
                <TwoColumnGrid
                  items={liveStreams.length ? hostList : hostFirstPage}
                  style={styles.hostGridNoHeader}
                  renderItem={(item, index) => (
                    <HostProfileCard
                      key={item.id}
                      host={item}
                      index={index}
                      nearby={showNearby}
                      style={styles.gridCard}
                      onPress={() => router.push(`/main/user/${item.id}`)}
                    />
                  )}
                />
                {!liveStreams.length && hostFirstPage.length >= 4 ? (
                  <ImageCarousel banners={eventBanners} width={width} onPress={openHero} compact reverseFallback />
                ) : null}
                {!liveStreams.length && hostRest.length ? (
                  <TwoColumnGrid
                    items={hostRest}
                    style={styles.gridAfterCarousel}
                    renderItem={(item, index) => (
                      <HostProfileCard
                        key={item.id}
                        host={item}
                        index={index + 4}
                        nearby={showNearby}
                        style={styles.gridCard}
                        onPress={() => router.push(`/main/user/${item.id}`)}
                      />
                    )}
                  />
                ) : null}
                {hostHasMore ? <ShowMoreButton loading={loadingMoreHosts} onPress={loadMoreHosts} /> : null}
              </>
            ) : (
              <EmptySection
                background={showNearby ? EMPTY_BACKGROUNDS.nearby : EMPTY_BACKGROUNDS.live}
                title={showNearby ? 'No nearby hosts' : 'No hosts to show'}
                subtitle={showNearby ? 'Try again later or explore other categories.' : 'Profiles will appear here when hosts are available.'}
                action="Explore"
                onPress={() => router.push('/main/(tabs)/explore')}
              />
            ))}

            <SectionHeader asset={SECTION_ICONS.events} title="Top Events" onViewAll={() => router.push('/main/(tabs)/explore')} />
            {eventBanners.length ? (
              <FlatList
                horizontal
                data={eventBanners}
                keyExtractor={(item) => item.id}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.horizontalRow}
                renderItem={({ item, index }) => <EventCard event={item} index={index} onPress={() => item.link_url && router.push(item.link_url)} />}
              />
            ) : (
              <EmptySection
                background={EMPTY_BACKGROUNDS.events}
                title="No events at the moment"
                subtitle="Check back soon for exciting events and competitions!"
                action="Explore Events"
                onPress={() => router.push('/main/(tabs)/explore')}
              />
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: 'transparent' },
  page: { paddingBottom: 132 },
  header: {
    height: 76, paddingHorizontal: 18, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'space-between',
  },
  avatarTouch: { width: 62, height: 62, alignItems: 'center', justifyContent: 'center' },
  avatarRing: { width: 48, height: 48, borderRadius: 24, padding: 2.5 },
  headerAvatar: { width: '100%', height: '100%', borderRadius: 24, backgroundColor: '#17133F' },
  headerProfileFrame: { position: 'absolute', width: 62, height: 62, resizeMode: 'contain' },
  onlineDot: {
    position: 'absolute', right: 0, bottom: 1, width: 13, height: 13,
    borderRadius: 7, backgroundColor: '#25E875', borderWidth: 2, borderColor: '#17103F',
  },
  crownBubble: { position: 'absolute', right: -9, top: -6, transform: [{ rotate: '13deg' }] },
  crownText: { color: '#FFD64A', fontSize: 17, fontWeight: '900', textShadowColor: '#FF9B19', textShadowRadius: 5 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 15 },
  headerIcon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  notifBadge: {
    position: 'absolute', right: 1, top: 2, minWidth: 18, height: 18,
    borderRadius: 9, paddingHorizontal: 4, backgroundColor: '#F32A91',
    borderWidth: 1.5, borderColor: '#16103E', alignItems: 'center', justifyContent: 'center',
  },
  notifBadgeText: { color: '#FFF', fontSize: 9, fontWeight: '900' },
  categoryList: { paddingHorizontal: 16, paddingVertical: 6 },
  categoryTouch: { marginRight: 9, borderRadius: 18 },
  categoryPill: {
    height: 36, minWidth: 86, borderRadius: 18, paddingHorizontal: 15,
    flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(22,25,70,.64)', borderWidth: 1, borderColor: 'rgba(187,169,255,.26)',
  },
  categoryPillActive: {
    borderColor: '#F17BFF', shadowColor: '#E62BFF',
    shadowOpacity: .8, shadowRadius: 11, elevation: 8,
  },
  categoryText: { color: '#DAD8F7', fontSize: 14, fontWeight: '600' },
  categoryTextActive: { color: '#FFF', fontWeight: '800' },
  heroShell: { marginTop: 11, marginHorizontal: 16, borderRadius: 23, overflow: 'hidden', borderWidth: 1.2, borderColor: '#8739FF' },
  heroCard: { height: 142 },
  carouselImage: { width: '100%', height: '100%', backgroundColor: '#0A083A' },
  secondaryCarousel: { marginTop: 24, borderRadius: 19, borderColor: 'rgba(111,87,255,.72)' },
  secondarySlide: { height: 142 },
  heroOverlay: { flex: 1, padding: 18, justifyContent: 'center' },
  heroGlowOrb: {
    position: 'absolute', width: 190, height: 190, borderRadius: 95, right: -30, top: -35,
    backgroundColor: 'rgba(66,225,255,.13)', shadowColor: '#22E4FF', shadowRadius: 35, shadowOpacity: 1,
  },
  heroWatermark: { position: 'absolute', right: 30, top: 55 },
  liveLabel: { alignSelf: 'flex-start', backgroundColor: '#F32983', borderRadius: 7, paddingHorizontal: 10, paddingVertical: 4, marginBottom: 9 },
  liveLabelText: { color: '#FFF', fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  heroTitle: { color: '#FFF', fontSize: 31, lineHeight: 35, fontWeight: '900', maxWidth: '77%', letterSpacing: .3, textShadowColor: '#4D2B9E', textShadowRadius: 7 },
  heroLine: { color: '#F5F2FF', fontSize: 13, lineHeight: 19, marginTop: 7, fontWeight: '500' },
  watchButton: { marginTop: 12, height: 36, borderRadius: 18, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 7, alignSelf: 'flex-start' },
  watchText: { color: '#FFF', fontSize: 13, fontWeight: '800' },
  heroDots: { position: 'absolute', bottom: 11, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 6 },
  heroDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: 'rgba(255,255,255,.4)' },
  heroDotActive: { width: 18, backgroundColor: '#FFF' },
  slideCount: { position: 'absolute', right: 16, bottom: 10, color: '#FFF', fontWeight: '800', fontSize: 12 },
  quickRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'stretch',
    paddingHorizontal: 12,
    rowGap: 6,
    marginTop: 8,
  },
  quickTouch: { width: '48.7%', height: 44, borderRadius: 12 },
  quickCard: {
    height: 44, borderRadius: 12, paddingHorizontal: 7, paddingVertical: 4,
    borderWidth: 1, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', gap: 7,
    shadowOpacity: .35, shadowRadius: 7, shadowOffset: { width: 0, height: 3 }, elevation: 5,
  },
  quickGlow: { position: 'absolute', width: 52, height: 52, borderRadius: 26, left: -14, top: -14 },
  quickIconShell: {
    width: 35, height: 35, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(19,10,67,.30)', borderWidth: 1,
  },
  quickAsset: { width: 33, height: 35 },
  quickCopy: { flex: 1, minWidth: 0 },
  quickTitle: { color: '#FFF', fontSize: 15, fontWeight: '900', textShadowColor: 'rgba(18,5,54,.55)', textShadowRadius: 4 },
  sectionHeader: { marginTop: 23, marginBottom: 10, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionAsset: { width: 28, height: 28 },
  sectionTitle: { color: '#FFF', fontSize: 20, fontWeight: '800' },
  viewAll: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  viewAllText: { color: '#AAA9CA', fontSize: 13 },
  gamesHeader: {
    marginTop: 23,
    marginBottom: 12,
    paddingHorizontal: 17,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  gamesHeaderIcon: {
    width: 31,
    height: 31,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(116,70,255,.82)',
    borderWidth: 1,
    borderColor: 'rgba(242,120,255,.68)',
  },
  gamesHeaderTitle: { color: '#FFF', fontSize: 20, fontWeight: '900' },
  horizontalRow: { paddingHorizontal: 16, gap: 10 },
  twoColumnGrid: {
    paddingHorizontal: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 12,
  },
  gridCard: { width: '48.5%' },
  gridAfterCarousel: { marginTop: 12 },
  hostGridNoHeader: { marginTop: 18 },
  gamesGrid: { rowGap: 13 },
  gameCardTouch: { height: 178, borderRadius: 18 },
  gameCard: {
    flex: 1,
    borderRadius: 18,
    padding: 13,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,.22)',
    shadowColor: '#D946EF',
    shadowOpacity: .28,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 7,
  },
  gameCardGlow: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    right: -32,
    top: -36,
    backgroundColor: 'rgba(255,255,255,.16)',
  },
  gameIconBubble: {
    width: 54,
    height: 54,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,.28)',
  },
  gameEmoji: { fontSize: 30 },
  gameWatermark: { position: 'absolute', right: 12, top: 20, transform: [{ rotate: '-10deg' }] },
  gameCardCopy: { flex: 1, justifyContent: 'flex-end', paddingBottom: 10 },
  gameCardTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '900' },
  gameCardSubtitle: { color: 'rgba(255,255,255,.76)', fontSize: 11, lineHeight: 15, marginTop: 5 },
  gameCardFooter: {
    minHeight: 27,
    borderRadius: 14,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(8,5,40,.34)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,.16)',
  },
  gameChipText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900', textTransform: 'uppercase' },
  showMoreTouch: { alignSelf: 'center', marginTop: 16, marginBottom: 2, borderRadius: 18, overflow: 'hidden' },
  showMoreButton: {
    minWidth: 132,
    height: 38,
    borderRadius: 18,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  showMoreText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
  loader: { height: 120, alignItems: 'center', justifyContent: 'center' },
  liveCard: {
    width: 148, height: 216, borderRadius: 18, overflow: 'hidden',
    backgroundColor: '#17113E', borderWidth: 1, borderColor: '#6838E8',
  },
  liveCover: { width: '100%', height: '100%' },
  liveShade: { ...StyleSheet.absoluteFillObject, top: '38%' },
  cardLivePill: { position: 'absolute', top: 8, left: 8, backgroundColor: '#F42472', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  cardLiveText: { color: '#FFF', fontSize: 10, fontWeight: '900' },
  viewerPill: { position: 'absolute', top: 8, right: 7, flexDirection: 'row', gap: 4, alignItems: 'center', backgroundColor: 'rgba(10,8,36,.72)', borderRadius: 9, paddingHorizontal: 6, paddingVertical: 3 },
  viewerText: { color: '#FFF', fontSize: 10, fontWeight: '700' },
  liveCardCopy: { position: 'absolute', left: 10, right: 8, bottom: 9 },
  liveCardTitle: { color: '#FFF', fontSize: 14, fontWeight: '800' },
  hostLine: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 7 },
  miniAvatar: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#2C2456' },
  hostName: { color: '#DCD9EE', fontSize: 10.5, maxWidth: 83 },
  tagPill: { alignSelf: 'flex-start', marginTop: 6, backgroundColor: 'rgba(115,84,167,.42)', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
  tagText: { color: '#E5DDF7', fontSize: 9.5 },
  hostCard: { width: 124, height: 188, borderRadius: 18, overflow: 'hidden', borderWidth: 1.3, backgroundColor: '#17113E' },
  nearbyImage: { width: '100%', height: '100%' },
  nearbyShade: { ...StyleSheet.absoluteFillObject, top: '45%' },
  distancePill: { position: 'absolute', top: 7, left: 7, backgroundColor: 'rgba(9,7,40,.78)', borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3 },
  distanceText: { color: '#FFF', fontSize: 9.5, fontWeight: '700' },
  nearbyCopy: { position: 'absolute', left: 9, right: 8, bottom: 9 },
  nearbyNameRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  nearbyName: { color: '#FFF', fontSize: 14, fontWeight: '800', maxWidth: 87 },
  pointsRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  pointsText: { color: '#E5E1F4', fontSize: 10 },
  eventTouch: { width: 245, height: 128, borderRadius: 18 },
  eventCard: { flex: 1, borderRadius: 18, padding: 13, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(90,107,255,.75)' },
  eventImage: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  eventShade: { ...StyleSheet.absoluteFillObject },
  eventIcon: { position: 'absolute', right: 17, top: 23, transform: [{ rotate: '-8deg' }] },
  eventTitle: { color: '#FFF', fontSize: 20, fontWeight: '900', maxWidth: 155 },
  eventLabel: { alignSelf: 'flex-start', backgroundColor: 'rgba(239,38,152,.63)', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, marginTop: 3 },
  eventLabelText: { color: '#FFF', fontSize: 8, fontWeight: '900' },
  eventTime: { color: '#F5F1FF', fontSize: 10.5, marginTop: 5 },
  attendeeRow: { flexDirection: 'row', alignItems: 'center', marginTop: 5 },
  attendeeAvatar: { width: 17, height: 17, borderRadius: 9, borderWidth: 1, borderColor: '#FFF' },
  attendeeText: { color: '#FFF', fontSize: 10, marginLeft: 5, fontWeight: '700' },
  emptyCard: { marginHorizontal: 16, minHeight: 112, borderRadius: 18, borderWidth: 1, borderColor: 'rgba(145,100,255,.42)', overflow: 'hidden' },
  emptyBackground: { borderRadius: 18 },
  emptyOverlay: { flex: 1, minHeight: 112, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 86, paddingVertical: 12 },
  emptyContent: { alignItems: 'center', maxWidth: 235 },
  emptyTitle: { color: '#FFFFFF', fontSize: 14, lineHeight: 18, fontWeight: '700', textAlign: 'center', textShadowColor: '#08062B', textShadowRadius: 5 },
  emptySubtitle: { color: '#9FD7FF', fontSize: 11, lineHeight: 15, fontWeight: '500', textAlign: 'center', marginTop: 4, marginBottom: 8, textShadowColor: '#08062B', textShadowRadius: 4 },
  emptyAction: { minWidth: 92, minHeight: 30, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  emptyActionText: { color: '#FFF', fontSize: 12, lineHeight: 16, fontWeight: '800' },
});
