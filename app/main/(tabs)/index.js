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

const LOCAL_HERO = require('../../../assets/onboarding/welcome-loading.webp');
const LOCAL_AVATAR = require('../../../assets/splash-icon.png');
const APP_BACKGROUND = require('../../../assets/backgrounds/neon-space.png');
const AUTH_BACKGROUND = require('../../../assets/onboarding/google-auth-background.webp');
const SECTION_ICONS = {
  events: require('../../../assets/home/icons/events.png'),
  nearby: require('../../../assets/home/icons/nearby.png'),
  popular: require('../../../assets/home/icons/popular.png'),
};
const ACTION_ICONS = {
  network: require('../../../assets/home/icons/network.png'),
  vip: require('../../../assets/home/icons/vip.png'),
  tasks: require('../../../assets/home/icons/tasks.png'),
};
const EMPTY_BACKGROUNDS = {
  events: require('../../../assets/home/empty/events.png'),
  nearby: require('../../../assets/home/empty/nearby.png'),
  live: require('../../../assets/home/empty/live.png'),
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
];

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
  return (
    <View style={styles.header}>
      <TouchableOpacity onPress={onProfile} activeOpacity={0.82} style={styles.avatarTouch}>
        <LinearGradient colors={['#20D8FF', '#8B43FF', '#F62AD9']} style={styles.avatarRing}>
          <SafeImage uri={user?.avatar} style={styles.headerAvatar} />
        </LinearGradient>
        <View style={styles.onlineDot} />
        <View style={styles.crownBubble}>
          <Text style={styles.crownText}>👑</Text>
        </View>
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
    }, 5500);
    return () => clearInterval(timer);
  }, [slideWidth, slides.length]);

  return (
    <View style={[styles.heroShell, compact && styles.secondaryCarousel]}>
      <FlatList
        ref={listRef}
        horizontal
        pagingEnabled
        data={slides}
        keyExtractor={(item) => item.id}
        showsHorizontalScrollIndicator={false}
        onTouchStart={() => { paused.current = true; }}
        onTouchEnd={() => { setTimeout(() => { paused.current = false; }, 5000); }}
        onMomentumScrollEnd={(e) => setActive(Math.round(e.nativeEvent.contentOffset.x / slideWidth))}
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
          <Text style={styles.quickSubtitle} numberOfLines={1}>{item.subtitle}</Text>
          <Text style={[styles.quickMeta, item.key === 'network' && styles.quickMetaGreen]} numberOfLines={1} adjustsFontSizeToFit>{item.meta}</Text>
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

function LiveStreamCard({ stream, onPress }) {
  return (
    <TouchableOpacity activeOpacity={0.88} onPress={onPress} style={styles.liveCard}>
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
          <Ionicons name="checkmark-circle" size={12} color="#8A63FF" />
        </View>
        <View style={styles.tagPill}><Text style={styles.tagText}>{stream.tags?.[0] || 'Live'}</Text></View>
      </View>
    </TouchableOpacity>
  );
}

function NearbyHostCard({ host, index, onPress }) {
  const borderColors = ['#7E48FF', '#16C8E5', '#F339B2', '#683CFF'];
  return (
    <TouchableOpacity activeOpacity={0.88} onPress={onPress} style={[styles.nearbyCard, { borderColor: borderColors[index % borderColors.length] }]}>
      <SafeImage uri={host.avatar_url} style={styles.nearbyImage} />
      <LinearGradient colors={['transparent', 'rgba(7,6,38,.97)']} style={styles.nearbyShade} />
      <View style={styles.distancePill}><Text style={styles.distanceText}>{host.distance}</Text></View>
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
  const { user, homeBanners } = useGlobalState();
  const [activeCategory, setActiveCategory] = useState('Trending');
  const [liveStreams, setLiveStreams] = useState([]);
  const [nearbyHosts, setNearbyHosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const topBanners = (homeBanners || []).filter((b) => (b.position || 'top') === 'top' && b.is_active !== false);
  const eventBanners = (homeBanners || []).filter((b) => b.position === 'bottom' && b.is_active !== false);

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

  const fetchLiveStreams = useCallback(async () => {
    try { await supabase.rpc('cleanup_stale_live_streams'); } catch (_) {}
    let query = supabase.from('live_streams')
      .select('id, broadcaster_id, type, title, tag, cover_url, current_viewers, peak_viewers, total_gifts, last_heartbeat_at, profiles:broadcaster_id(full_name, avatar_url, is_banned, country)')
      .eq('status', 'live')
      .gt('last_heartbeat_at', new Date(Date.now() - 90_000).toISOString())
      .order('current_viewers', { ascending: false })
      .order('total_gifts', { ascending: false })
      .limit(30);
    if (activeCategory === 'Audio') query = query.eq('type', 'audio');
    else if (!['Trending', 'Nearby'].includes(activeCategory)) query = query.eq('tag', activeCategory);
    const { data, error } = await query;
    if (error) throw error;
    setLiveStreams((data || []).filter((item) => !item.profiles?.is_banned).map((item) => ({
      id: item.broadcaster_id,
      streamId: item.id,
      title: item.title,
      broadcasterName: item.profiles?.full_name || 'Streamer',
      broadcasterAvatar: item.profiles?.avatar_url,
      viewerCount: item.current_viewers ?? item.peak_viewers ?? 0,
      coverUrl: item.cover_url || item.profiles?.avatar_url,
      tags: [item.tag, item.type === 'audio' ? 'Audio' : 'Live'].filter(Boolean),
      streamType: item.type,
      country: item.profiles?.country,
    })));
  }, [activeCategory]);

  const fetchNearbyHosts = useCallback(async () => {
    let query = supabase.from('profiles').select('id, full_name, avatar_url, country, level').eq('is_banned', false).limit(12);
    if (user?.country) query = query.eq('country', user.country);
    if (user?.id) query = query.neq('id', user.id);
    const { data } = await query;
    setNearbyHosts((data || []).map((host, index) => ({
      ...host,
      distance: `${(0.2 + index * 0.2).toFixed(1)} km`,
      points: Math.max(120, Number(host.level || 1) * 210),
    })));
  }, [user?.country, user?.id]);

  const fetchAll = useCallback(async () => {
    await Promise.all([fetchLiveStreams(), fetchNearbyHosts()]);
  }, [fetchLiveStreams, fetchNearbyHosts]);

  useEffect(() => {
    setLoading(true);
    fetchAll().finally(() => setLoading(false));
  }, [fetchAll]);

  const liveFetchRef = useRef(fetchLiveStreams);
  useEffect(() => { liveFetchRef.current = fetchLiveStreams; }, [fetchLiveStreams]);
  useEffect(() => {
    const channel = supabase.channel(`premium-home-live-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'live_streams' }, () => liveFetchRef.current?.())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
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

        <SectionHeader asset={SECTION_ICONS.popular} title="Popular Live" onViewAll={() => router.push('/main/(tabs)/explore')} />
        {loading ? (
          <View style={styles.loader}><LogoLoader size="small" /></View>
        ) : liveStreams.length ? (
          <FlatList
            horizontal
            data={liveStreams}
            keyExtractor={(item) => item.streamId}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.horizontalRow}
            renderItem={({ item, index }) => <LiveStreamCard stream={item} onPress={() => openStream(item, index)} />}
          />
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

        <SectionHeader asset={SECTION_ICONS.nearby} title="Nearby Hosts" onViewAll={() => router.push('/main/network')} />
        {nearbyHosts.length ? (
          <FlatList
            horizontal
            data={nearbyHosts}
            keyExtractor={(item) => item.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.horizontalRow}
            renderItem={({ item, index }) => <NearbyHostCard host={item} index={index} onPress={() => router.push(`/main/user/${item.id}`)} />}
          />
        ) : (
          <EmptySection
            background={EMPTY_BACKGROUNDS.nearby}
            title="No nearby hosts"
            subtitle="Try again later or explore other categories."
            action="Explore"
            onPress={() => router.push('/main/(tabs)/explore')}
          />
        )}

        <ImageCarousel banners={eventBanners} width={width} onPress={openHero} compact reverseFallback />

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
  avatarTouch: { width: 52, height: 52 },
  avatarRing: { width: 52, height: 52, borderRadius: 26, padding: 2.5 },
  headerAvatar: { width: '100%', height: '100%', borderRadius: 24, backgroundColor: '#17133F' },
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
  categoryList: { paddingHorizontal: 16, paddingVertical: 8 },
  categoryTouch: { marginRight: 9, borderRadius: 22 },
  categoryPill: {
    height: 43, minWidth: 86, borderRadius: 22, paddingHorizontal: 15,
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
  heroCard: { height: 224 },
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
  quickRow: { height: 102, flexDirection: 'row', alignItems: 'stretch', paddingHorizontal: 14, gap: 8, marginTop: 15 },
  quickTouch: { flex: 1, height: 102, borderRadius: 21 },
  quickCard: {
    height: 102, borderRadius: 21, paddingHorizontal: 7, paddingVertical: 10,
    borderWidth: 1.2, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', gap: 6,
    shadowOpacity: .42, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 7,
  },
  quickGlow: { position: 'absolute', width: 82, height: 82, borderRadius: 41, left: -24, top: -24 },
  quickIconShell: {
    width: 44, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(19,10,67,.30)', borderWidth: 1,
  },
  quickAsset: { width: 43, height: 52 },
  quickCopy: { flex: 1, minWidth: 0 },
  quickTitle: { color: '#FFF', fontSize: 13, fontWeight: '900', textShadowColor: 'rgba(18,5,54,.55)', textShadowRadius: 4 },
  quickSubtitle: { color: '#F3EFFF', fontSize: 9.5, marginTop: 3 },
  quickMeta: { color: '#FFE34F', fontSize: 10.5, fontWeight: '900', marginTop: 5 },
  quickMetaGreen: { color: '#46FFAE' },
  sectionHeader: { marginTop: 23, marginBottom: 10, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionAsset: { width: 28, height: 28 },
  sectionTitle: { color: '#FFF', fontSize: 20, fontWeight: '800' },
  viewAll: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  viewAllText: { color: '#AAA9CA', fontSize: 13 },
  horizontalRow: { paddingHorizontal: 16, gap: 10 },
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
  nearbyCard: { width: 124, height: 170, borderRadius: 18, overflow: 'hidden', borderWidth: 1.3, backgroundColor: '#17113E' },
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
