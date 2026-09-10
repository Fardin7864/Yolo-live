import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Dimensions, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../api/supabase';
import { useGlobalState } from '../context/GlobalStateContext';
import {
  LIVE_ANNOUNCEMENT_DISPLAY_MS,
  LIVE_ANNOUNCEMENT_THRESHOLDS,
  appendLiveAnnouncementFifo,
  buildLiveAnnouncementDestination,
  canOpenLuckyBagForUser,
  globalAnnouncementEventId,
  subscribeGlobalLiveAnnouncements,
} from '../api/liveAnnouncements';
import { announcementFrameFor, botProfileFor } from '../theme/announcementAssets';

const amountText = (value) => Number(value || 0).toLocaleString('en-US');

export default function GlobalAnnouncementHost() {
  const { user } = useGlobalState();
  const router = useRouter();
  const pathname = usePathname();
  const routeParams = useGlobalSearchParams();
  const isBroadcastRoute = pathname?.startsWith('/broadcast/');
  const routeHostId = Array.isArray(routeParams?.id) ? routeParams.id[0] : routeParams?.id;
  const routeMode = Array.isArray(routeParams?.mode) ? routeParams.mode[0] : routeParams?.mode;
  const isActiveHostRoute = isBroadcastRoute
    && (routeMode === 'host' || (routeHostId && String(routeHostId) === String(user?.id)));
  const insets = useSafeAreaInsets();
  const width = Dimensions.get('window').width;
  const translateX = useRef(new Animated.Value(width)).current;
  const seen = useRef(new Set());
  const [queue, setQueue] = useState([]);
  const [current, setCurrent] = useState(null);

  const enqueue = (type, payload = {}) => {
    const amount = Number(payload.totalCost || payload.amount || 0);
    if (type === 'gift' && amount < LIVE_ANNOUNCEMENT_THRESHOLDS.gift) return;
    if (type === 'game_win' && amount < LIVE_ANNOUNCEMENT_THRESHOLDS.gameWin) return;
    const eventName = type === 'lucky_bag' ? 'lucky_bag_in_live' : `${type}_in_live`;
    const id = globalAnnouncementEventId(eventName, payload);
    if (seen.current.has(id)) return;
    seen.current.add(id);
    if (seen.current.size > 2000) seen.current.delete(seen.current.values().next().value);
    setQueue((items) => appendLiveAnnouncementFifo(items, { id, type, payload }));
  };

  useEffect(() => {
    if (!user?.id) return undefined;
    return subscribeGlobalLiveAnnouncements((event, payload) => {
      // Live rooms retain their existing gift/game-win presentation, while
      // Lucky Bags use this single root overlay on every route.
      if (event === 'lucky_bag_in_live' || event === 'lucky_bag_drop_global') enqueue('lucky_bag', payload);
      else if (!isBroadcastRoute && event === 'gift_in_live') enqueue('gift', payload);
      else if (!isBroadcastRoute && event === 'game_win_in_live') enqueue('game_win', payload);
    });
  }, [user?.id, isBroadcastRoute]);

  useEffect(() => {
    if (!user?.id) return undefined;
    let cancelled = false;
    const publishRow = async (row) => {
      if (!row?.bag_id || cancelled) return;
      const [{ data: live }, { data: dropper }, { data: host }] = await Promise.all([
        supabase.from('live_streams').select('type,status').eq('id', row.stream_id).maybeSingle(),
        supabase.from('profiles').select('full_name,avatar_url').eq('id', row.dropper_id).maybeSingle(),
        supabase.from('profiles').select('full_name,avatar_url').eq('id', row.room_host_id).maybeSingle(),
      ]);
      if (cancelled || live?.status !== 'live') return;
      enqueue('lucky_bag', {
        eventId: `lucky-bag-${row.bag_id}`,
        roomId: row.room_host_id,
        roomHostId: row.room_host_id,
        streamId: row.stream_id,
        dropperId: row.dropper_id,
        dropperName: dropper?.full_name || 'Someone',
        hostName: host?.full_name || 'Host',
        hostAvatar: host?.avatar_url || null,
        prizeDiamonds: row.prize_diamonds,
        bagId: row.bag_id,
        expiresAt: row.expires_at,
        mode: 'viewer',
        type: live?.type || 'audio',
      });
    };
    const channel = supabase.channel(`global-lucky-bag-rows-${Date.now()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'lucky_bag_global_announcements' }, ({ new: row }) => {
        publishRow(row);
      })
      .subscribe();
    // Recover an announcement that was inserted just before this component
    // subscribed (app resume / transient websocket reconnect).
    const loadLatestActiveBag = () => supabase.from('lucky_bag_global_announcements').select('*')
      .gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => publishRow(data));
    loadLatestActiveBag();
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') loadLatestActiveBag();
    });
    return () => {
      cancelled = true;
      appStateSubscription.remove();
      try { supabase.removeChannel(channel); } catch (_) {}
    };
  }, [user?.id]);

  useEffect(() => {
    if (current || queue.length === 0) return;
    setCurrent(queue[0]);
    setQueue((items) => items.slice(1));
  }, [current, queue]);

  useEffect(() => {
    if (!current) return;
    translateX.setValue(width);
    const enterDuration = 300;
    const exitDuration = 400;
    Animated.sequence([
      Animated.timing(translateX, { toValue: 0, duration: enterDuration, useNativeDriver: true }),
      Animated.delay(LIVE_ANNOUNCEMENT_DISPLAY_MS - enterDuration - exitDuration),
      Animated.timing(translateX, { toValue: -width, duration: exitDuration, useNativeDriver: true }),
    ]).start(() => setCurrent(null));
  }, [current, translateX, width]);

  const display = useMemo(() => {
    if (!current) return null;
    const p = current.payload || {};
    if (current.type === 'gift') return {
      avatar: p.senderAvatar || p.sender_avatar,
      icon: '🎁', title: p.senderName || 'Someone',
      body: `sent ${p.giftName || 'a gift'} worth ${amountText(p.totalCost || p.amount)} 💎`,
    };
    if (current.type === 'lucky_bag') return {
      avatar: p.hostAvatar || p.host_avatar,
      icon: '🧧', title: p.dropperName || 'Someone',
      body: `dropped a ${amountText(p.prizeDiamonds || (Number(p.perWinner || 0) * Number(p.winnerCount || 0)))} 💎 Lucky Bag — tap to join`,
    };
    return {
      avatar: p.isBot ? botProfileFor(p.winnerId || p.winnerName) : (p.winnerAvatar || p.winner_avatar),
      avatarIsLocal: p.isBot === true,
      icon: '🏆', title: p.winnerName || 'Someone',
      body: `won ${amountText(p.amount)} 💎 in ${p.gameName || 'a game'}`,
    };
  }, [current]);

  if (!current || !display) return null;
  const p = current.payload || {};
  const destination = current.type === 'lucky_bag'
    ? buildLiveAnnouncementDestination(p)
    : null;
  const canNavigate = !!destination && !isActiveHostRoute;
  const frameSource = announcementFrameFor(current.id);
  const avatarSource = display.avatar
    ? display.avatarIsLocal ? display.avatar : { uri: display.avatar }
    : null;
  return (
    <Animated.View pointerEvents="box-none" style={[styles.host, { top: insets.top + 8, transform: [{ translateX }] }]}>
      <TouchableOpacity disabled={!canNavigate} activeOpacity={0.9} style={styles.card} onPress={async () => {
        if (!canNavigate || !(await canOpenLuckyBagForUser(user?.id))) return;
        setCurrent(null);
        if (isBroadcastRoute) router.replace(destination);
        else router.push(destination);
      }}>
        <Image source={frameSource} style={styles.frame} resizeMode="stretch" pointerEvents="none" />
        <View style={styles.content} pointerEvents="none">
          <View style={styles.avatarWrap}>
            {avatarSource ? <Image source={avatarSource} style={styles.avatar} /> : <Text style={styles.icon}>{display.icon}</Text>}
          </View>
          <View style={styles.copy}>
            <Text style={styles.title} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{display.title}</Text>
            <Text style={styles.body} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>{display.body}</Text>
          </View>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: 4, right: 4, zIndex: 100000, elevation: 100000 },
  card: { width: '100%', aspectRatio: 3, position: 'relative' },
  frame: { ...StyleSheet.absoluteFillObject, width: undefined, height: undefined },
  content: { position: 'absolute', left: '19%', right: '19%', top: '35%', bottom: '34%', flexDirection: 'row', alignItems: 'center' },
  avatarWrap: { width: 34, height: 34, borderRadius: 17, borderWidth: 1.5, borderColor: '#D9A62E', overflow: 'hidden', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  avatar: { width: 31, height: 31 },
  icon: { fontSize: 20 },
  copy: { flex: 1, minWidth: 0, marginLeft: 7 },
  title: { color: '#522B16', fontSize: 13, lineHeight: 15, fontWeight: '900' },
  body: { color: '#5D3823', fontSize: 10.5, lineHeight: 12, fontWeight: '800', marginTop: 1 },
});
