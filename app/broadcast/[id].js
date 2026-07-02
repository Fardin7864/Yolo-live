import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, FlatList, TextInput, Platform, Dimensions, Modal, Alert, Keyboard, Animated, Easing, ScrollView, StatusBar, BackHandler, PanResponder, AppState } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardEvents } from 'react-native-keyboard-controller';
import { showCuteAlert, confirmCuteAlert } from '../../src/components/CuteAlert';
import { Ionicons } from '@expo/vector-icons';
import { useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { RtcSurfaceView } from 'react-native-agora';
import * as Linking from 'expo-linking';
import { LinearGradient } from 'expo-linear-gradient';
import * as Audio from 'expo-audio';
import * as MediaLibrary from 'expo-media-library';
import { VideoView } from 'expo-video';
import LottieView from 'lottie-react-native';
import VipAvatar from '../../src/components/VipAvatar';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useKeepAwake } from 'expo-keep-awake';
import FruitRoulette from '../../src/components/games/FruitRoulette';
import TeenPatti from '../../src/components/games/TeenPatti';
import Html5RoyalFeast from '../../src/components/games/Html5RoyalFeast';
import AudioTemplateSheet from '../../src/components/audio/AudioTemplateSheet';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import { resolveGiftAnimation } from '../../src/theme/giftAnimations';
import LogoLoader from '../../src/components/LogoLoader';
import { TENANT_CONFIG } from '../../tenant.config';
import { playGiftSound } from '../../src/audio/GiftSoundManager';
import { supabase } from '../../src/api/supabase';
import { useAgoraEngine } from '../../src/hooks/useAgoraEngine';
import { agoraUidFromId } from '../../src/api/agora';
import { BRAND } from '../../src/theme/brand';
import { useOneShotIntroPlayer } from '../../src/hooks/useOneShotIntroPlayer';
import { flagFor } from '../../src/utils/countryFlag';

const { width, height } = Dimensions.get('screen');
const MALL_INTRO_MAX_HEIGHT = height * 0.92;
const MALL_INTRO_WIDTH = width;
const MALL_INTRO_PLAYED_STORAGE_PREFIX = 'mall_intro_played_v1';

// ─────────────────────────────────────────────────────────────────────
// Lucky Bag asset
// ─────────────────────────────────────────────────────────────────────
// One-line swap path for the burlap-sack image. Drop your bag PNG/SVG
// into  assets/images/lucky-bag.png  and replace the `null` on the next
// line with the require() literal commented below. The render path
// already branches on this value, so no other edit is needed.
//
//   const LUCKY_BAG_IMAGE = require('../../assets/images/lucky-bag.png');
//
// While this is null we render a stylised emoji fallback that still
// looks like a sack (drawstring + body shading), so the feature ships
// before the asset is in place.
const LUCKY_BAG_IMAGE = null;
const AUDIO_ROOM_BACKGROUND = require('../../assets/audio-room/redesign/cosmic-background.webp');
const AUDIO_SEAT_FRAME = require('../../assets/audio-room/redesign/seat.webp');
const AUDIO_BACK_BUTTON = require('../../assets/audio-room/redesign/back.webp');
const AUDIO_MORE_BUTTON = require('../../assets/audio-room/redesign/more.webp');
const AUDIO_SVIP_BADGE = require('../../assets/audio-room/redesign/svip.webp');
const AUDIO_HOST_BANNER_BG = require('../../assets/audio-room/redesign/host-banner.png');
const PROFILE_FRAME_ASSETS = {
  'heart-fantasy': require('../../assets/mall/frames/heart-fantasy.webp'),
  'angel-wing': require('../../assets/mall/frames/angel-wing.webp'),
  'royal-gold': require('../../assets/mall/frames/royal-gold.webp'),
};
const BUNDLED_INTRO_ASSETS = {
  'football-cup.webp': require('../../assets/mall/intro/football-cup.webp'),
  'football-cup.m4v': require('../../assets/mall/intro/football-cup.m4v'),
  'blue-roses.webp': require('../../assets/mall/intro/blue-roses.webp'),
  'blue-roses.m4v': require('../../assets/mall/intro/blue-roses.m4v'),
};
const AUDIO_SEAT_SCALE = 0.72;
const AUDIO_SEAT_FRAME_SIZE = 88 * AUDIO_SEAT_SCALE;
const AUDIO_SEAT_AVATAR_SIZE = 58 * AUDIO_SEAT_SCALE;
const AUDIO_SEAT_EMPTY_SIZE = 62 * AUDIO_SEAT_SCALE;
const AUDIO_SEAT_PROFILE_FRAME_SIZE = 96 * AUDIO_SEAT_SCALE;
const AUDIO_SEAT_PULSE_SIZE = 70 * AUDIO_SEAT_SCALE;

const mallIntroMediaSource = (url) => {
  if (typeof url === 'number') return url;
  if (url?.startsWith?.('bundled://')) return BUNDLED_INTRO_ASSETS[url.replace('bundled://', '')];
  return url ? { uri: url } : null;
};

function MallIntroOverlay({ intro, source, onDone }) {
  const { player, ready } = useOneShotIntroPlayer(source, onDone);

  return (
    <View style={styles.mallIntroOverlay} pointerEvents="none">
      <VideoView
        player={player}
        style={[styles.mallIntroVideo, !ready && styles.mallIntroVideoHidden]}
        nativeControls={false}
        contentFit="contain"
        pointerEvents="none"
      />
      <View style={styles.mallIntroNamePill}>
        <Text style={styles.mallIntroNameText} numberOfLines={1}>{intro?.name || 'Special entrance'}</Text>
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Gift grid responsive sizing
// ─────────────────────────────────────────────────────────────────────
// Picked these breakpoints to cover the actual device shipment mix:
//   <360w  : budget Android (Galaxy A03s, Redmi 9A) — needs tighter tiles
//   360-420: 95% of phones (most Samsung/Xiaomi/iPhone non-Pro)
//   420-700: large phones (iPhone Pro Max, Pixel XL, Galaxy Ultra)
//   >700w  : tablets / foldables — 5 columns instead of 4
//
// One source of truth so every gift-grid style stays in lockstep when we
// tweak.
const GIFT_NUM_COLS   = width >= 700 ? 5 : 4;
const GIFT_GRID_HPAD  = 12;
const GIFT_TILE_W     = (width - GIFT_GRID_HPAD) / GIFT_NUM_COLS;
const GIFT_ICON_SIZE  = width < 360 ? 40 : width < 420 ? 46 : width < 700 ? 52 : 58;
const GIFT_LOTTIE     = GIFT_ICON_SIZE - 8;
const GIFT_NAME_FONT  = width < 360 ? 9  : 10;
const GIFT_PRICE_FONT = width < 360 ? 8  : 9;
const isSmallScreen = height < 720; // tighten the audio stage on shorter phones

// Agora's RtcSurfaceView handles its own aspect-ratio fill, so the manual
// camera-scale math used by the old expo-camera background is no longer needed.

const REPORT_REASONS = [
  { code: 'harassment',   label: 'Harassment or bullying' },
  { code: 'inappropriate', label: 'Inappropriate / sexual content' },
  { code: 'hate_speech',  label: 'Hate speech' },
  { code: 'spam',         label: 'Spam' },
  { code: 'scam',         label: 'Scam or fraud' },
  { code: 'underage',     label: 'Underage user' },
  { code: 'violence',     label: 'Violence or self-harm' },
  { code: 'other',        label: 'Other' },
];

const GIFT_CATEGORIES = ['Classic', 'Premium', 'Exclusive'];

// Local fallback used only on cold start when the gifts table hasn't
// hydrated yet. Keeps the gift menu mounted with a friendly default.
// Live gift pricing now comes from `gifts` table via GlobalStateContext;
// see resolveGiftAnimation() for DB row -> Lottie source mapping.
const GIFT_ITEMS_FALLBACK = [
  { id: '1', name: 'Rose', price: 10, category: 'Classic', loop: true, customDuration: 2500, source: require('../../assets/animation/Rose.json') },
];

const formatProfileCount = (value) => {
  const n = Number(value) || 0;
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
};

export default function BroadcastRoomScreen() {
  const { id, mode, type, title: urlTitle, tag, siblings: siblingsCsv, myIdx: myIdxStr, streamId: prewarmedStreamId } = useLocalSearchParams();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Security: Prevent Screen Capture (Screenshots/Recording)
  usePreventScreenCapture();

  // Keep the screen on while the user is in the broadcast room. Applies
  // to host (so a live doesn't end when the host's screen times out),
  // co-host on the mic, AND plain viewers — nobody wants their screen
  // dimming mid-stream just because they're not actively tapping.
  // Auto-deactivates on unmount (router navigation away from the room),
  // so the device's normal timeout resumes the moment the user leaves.
  useKeepAwake();

  // Camera / Microphone permissions — only the host needs these.
  // Viewers can watch + chat without these permissions.
  const [cameraPerm, requestCameraPerm] = useCameraPermissions();
  const [micPerm, requestMicPerm] = useMicrophonePermissions();
  const isHost = mode === 'host';
  const isVideoMode = type !== 'audio';

  useEffect(() => {
    if (!isHost) return;
    (async () => {
      if (isVideoMode && cameraPerm && !cameraPerm.granted && cameraPerm.canAskAgain) {
        await requestCameraPerm();
      }
      if (micPerm && !micPerm.granted && micPerm.canAskAgain) {
        await requestMicPerm();
      }
    })();
  }, [isHost, isVideoMode, cameraPerm?.granted, micPerm?.granted]);

  const camMissing = isHost && isVideoMode && cameraPerm && !cameraPerm.granted;
  const micMissing = isHost && micPerm && !micPerm.granted;

  const [chatMessage, setChatMessage] = useState('');
  const [chats, setChats] = useState([]);
  const [isFollowing, setIsFollowing] = useState(false);
  // True for a brief window right after the viewer taps Follow — drives
  // the fading checkmark badge shown next to the host name. Once the
  // window passes (or the viewer leaves and comes back), the indicator
  // is gone for good and only the absence of the Follow button signals
  // they're already following. Matches how Bigo / Likee handle it.
  const [justFollowedHost, setJustFollowedHost] = useState(false);
  const justFollowedTimerRef = useRef(null);
  const justFollowedFadeRef  = useRef(new Animated.Value(0));
  const [showHostModal, setShowHostModal] = useState(false);
  const [isKeyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Economy & Gifts System States (Global State)
  const {
    diamonds: myDiamonds, setDiamonds: setMyDiamonds, user,
    sendGiftSecurely, startLiveStream, endLiveStream,
    followUser, unfollowUser, isFollowing: checkFollowing,
    gameSettings,
    gifts: dbGifts,
    // Task center hooks — viewer-side watch progress + share claim
    bumpWatchProgress, claimShareTask,
    // Audio room backgrounds (mig 88)
    audioTemplates,
  } = useGlobalState();

  // Live values from the admin panel. When an admin toggles a game off,
  // these flip to false and the matching tile vanishes from the menu
  // without an app restart.
  const fruitActive    = gameSettings?.fruit_roulette?.is_active !== false;
  const teenPattiActive = gameSettings?.teen_patti?.is_active     !== false;
  const royalFeastActive = gameSettings?.royal_feast?.is_active !== false;

  // Gift catalogue, normalised from the DB into the legacy GIFT_ITEMS
  // shape the rest of this file already speaks. Falls back to the local
  // seed list while the table is still hydrating so the first frame
  // doesn't render an empty menu. Animation source is resolved through
  // the bundled-asset map in src/theme/giftAnimations.
  const GIFT_ITEMS = React.useMemo(() => {
    if (!Array.isArray(dbGifts) || dbGifts.length === 0) return GIFT_ITEMS_FALLBACK;
    return dbGifts.map((row) => ({
      id:              row.id,
      name:            row.name,
      price:           row.diamond_cost,
      category:        row.category,
      loop:            row.loop,
      customDuration:  row.custom_duration,
      required_vip_type: row.required_vip_type || null,
      source:          resolveGiftAnimation(row),
      // Preserve SFX hints so the GiftSoundManager resolver can find a
      // sound when this gift is sent. Either field can be null/undefined.
      sound_path:      row.sound_path || null,
      sound_url:       row.sound_url  || null,
    }));
  }, [dbGifts]);

  // Live stream DB record id (set when host starts or viewer joins)
  const [streamRecordId, setStreamRecordId] = useState(null);
  const [showGiftMenu, setShowGiftMenu] = useState(false);
  const [showTopUpModal, setShowTopUpModal] = useState(false);
  const [gameMenuState, setGameMenuState] = useState(null); // null, 'menu', 'fruit'
  const [activeGiftAnimation, setActiveGiftAnimation] = useState({ id: null, source: null, loop: false });
  const [activeGiftTab, setActiveGiftTab] = useState('Classic');
  const [activeMallIntro, setActiveMallIntro] = useState(null);
  const [mallIntroQueue, setMallIntroQueue] = useState([]);
  const playedMallIntroUserIdsRef = useRef(new Set());
  const sentMallIntroUserIdsRef = useRef(new Set());
  const activeMallIntroSource = useMemo(
    () => activeMallIntro ? mallIntroMediaSource(activeMallIntro.videoUrl || activeMallIntro.video_url) : null,
    [activeMallIntro]
  );

  const queueMallIntro = useCallback((intro) => {
    setMallIntroQueue((prev) => [...prev, intro]);
  }, []);

  useEffect(() => {
    if (activeMallIntro || mallIntroQueue.length === 0) return;
    const [nextIntro, ...rest] = mallIntroQueue;
    setMallIntroQueue(rest);
    setActiveMallIntro(nextIntro);
  }, [activeMallIntro, mallIntroQueue]);

  const finishActiveMallIntro = useCallback(() => {
    setActiveMallIntro(null);
  }, []);

  // Combo & Floating Toast System
  const [combo, setCombo] = useState({ active: false, count: 0, giftId: null });
  const [giftToast, setGiftToast] = useState(null);
  // Default recipient differs by role: viewers gift the host by default,
  // hosts can only gift their guests so we start them in "All" mode
  // (which means "all guests" when isHostView — the host tile is hidden
  // from their picker and stripped from broadcast targets).
  const [giftRecipients, setGiftRecipients] = useState(mode === 'host' ? ['all'] : ['host']);

  // If the host's picker is left in a state that points at 'host' (e.g.
  // from a deep link or a state-restoration edge case), normalise it
  // back to 'all' so they aren't quietly stuck on "send to myself".
  useEffect(() => {
    if (mode === 'host' && giftRecipients.includes('host')) {
      setGiftRecipients(['all']);
    }
  }, [mode, giftRecipients]);

  // Guest Call System States
  const [callRequestStatus, setCallRequestStatus] = useState('idle'); // idle, pending, accepted
  // Mirror of callRequestStatus for realtime handlers (their closure is stale)
  const callStatusRef = useRef('idle');
  // Latest host-controlled room state, read by broadcast helpers (avoids stale closures)
  const roomStateRef = useRef({});
  // Guards against repeated eject alerts when a blocked viewer is bounced
  const ejectedRef = useRef(false);
  // Latest seat layout, read by the (once-registered) presence handler
  const activeGuestsRef = useRef([]);
  const [activeGuests, setActiveGuests] = useState(new Array(7).fill(null)); // 7 guest seats (host occupies seat 1)
  const [audioSlotCount, setAudioSlotCount] = useState(8); // total audio slots, including host seat
  const [showSlotModal, setShowSlotModal] = useState(false);
  const [slotInput, setSlotInput] = useState('8');
  const [pendingRequests, setPendingRequests] = useState([]); // Real-time requests will populate this
  const [isSeatsLocked, setIsSeatsLocked] = useState(false);
  const [lockedSeats, setLockedSeats] = useState([]); // per-seat lock (seat indices 0-6)
  const [showManageCalls, setShowManageCalls] = useState(false);
  const [pinnedMessage, setPinnedMessage] = useState("Welcome to Care Live! 🔥 Please follow the community rules and have fun!");
  const [mutedGuests, setMutedGuests] = useState([]); // Array of guest IDs
  const [blockedUsers, setBlockedUsers] = useState([]); // Array of blocked IDs
  const [roomAdmins, setRoomAdmins] = useState([]); // Array of admin IDs
  const [reactions, setReactions] = useState([]); // For floating emojis
  const [showAdminMenu, setShowAdminMenu] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false); // bottom-bar "More" sheet
  const [showBlockedSheet, setShowBlockedSheet] = useState(false);
  const [blockedList, setBlockedList] = useState([]); // {blocked_id, name, avatar, reason, created_at}
  const [reportTarget, setReportTarget] = useState(null); // {id, name} of user being reported
  const [reportReason, setReportReason] = useState(null);
  const [reportNote, setReportNote] = useState('');
  const [showRankingSheet, setShowRankingSheet] = useState(false);
  const [gifterRanking, setGifterRanking] = useState([]); // [{sender_id, sender_name, sender_avatar, vip_type, total_diamonds, gift_count}]
  const [guardianIds, setGuardianIds] = useState([]); // top-3 gifters' user IDs (this host's guardians)
  // Per-receiver diamonds-this-session map: { [receiverId]: totalDiamonds }.
  // Populated from get_room_seat_earnings RPC on mount + every 30s, and
  // incremented optimistically on each gift broadcast event. Rendered as
  // a small "💎 1.2k" badge under each audio-room seat-holder's name.
  const [seatEarnings, setSeatEarnings] = useState({});
  const [showLuckyBagDrop, setShowLuckyBagDrop] = useState(false);
  const [luckyBagPrize, setLuckyBagPrize] = useState(500);
  const [luckyBagWinners, setLuckyBagWinners] = useState(5);
  // activeLuckyBag now carries the full reveal payload:
  //   { id, perWinner, winners, droppedBy, dropperName, dropAt (ISO),
  //     posX (0–1), posY (0–1) }
  // The 15-second "drop-then-reveal" countdown is derived from dropAt,
  // and posX/posY randomise where the bag lands so viewers can't
  // pre-position their thumb on a fixed spot.
  const [activeLuckyBag, setActiveLuckyBag] = useState(null);
  const [luckyBagClaiming, setLuckyBagClaiming] = useState(false);
  // 'idle' | 'pending' (15s countdown) | 'open' (claimable) | 'done' (this
  // user has already tapped — bag hides for them, others can still grab)
  const [luckyBagPhase, setLuckyBagPhase] = useState('idle');
  const [luckyBagCountdown, setLuckyBagCountdown] = useState(0);
  // Winners-list modal state. luckyBagMyResult shapes the modal header
  // (won / sorry / your-bag); luckyBagWinnersList is the rendered table.
  const [showLuckyBagWinners, setShowLuckyBagWinners] = useState(false);
  const [luckyBagWinnersList, setLuckyBagWinnersList] = useState([]);
  const [luckyBagMyResult, setLuckyBagMyResult] = useState(null);
  const [luckyBagLoadingWinners, setLuckyBagLoadingWinners] = useState(false);
  const [targetGuest, setTargetGuest] = useState(null);
  const [isSelfMuted, setIsSelfMuted] = useState(false);
  const [forcedMuted, setForcedMuted] = useState(false); // host force-muted this guest
  const [hostMuted, setHostMuted] = useState(false); // viewer-side: is the host muted
  const [roomTitle, setRoomTitle] = useState(urlTitle || ''); // synced from host
  const [giftMultiplier, setGiftMultiplier] = useState(1);
  const [liveGoal, setLiveGoal] = useState(500);
  const [showGoalModal, setShowGoalModal] = useState(false);
  const [tempGoal, setTempGoal] = useState("500");
  const [showSFXMenu, setShowSFXMenu] = useState(false);
  const [showViewerList, setShowViewerList] = useState(false); // Used in Manage Calls
  // Real friends list (mutual follows) loaded the first time the host
  // opens the Invite Friends tab. We lazy-load so non-host viewers and
  // hosts who never tap the tab don't pay the round-trip cost.
  // null = not yet loaded; [] = loaded empty; array = ready.
  const [inviteFriends, setInviteFriends]               = useState(null);
  const [loadingInviteFriends, setLoadingInviteFriends] = useState(false);

  // First time the tab opens, fetch the host's mutual follows. Two
  // queries (followers + following) intersected client-side gives us
  // the "friends" list — same definition used on the Profile screen.
  useEffect(() => {
    if (!showViewerList || inviteFriends !== null || !user?.id) return;
    let cancelled = false;
    setLoadingInviteFriends(true);
    (async () => {
      try {
        const [followersRes, followingRes] = await Promise.all([
          supabase.from('follows').select('follower_id').eq('following_id', user.id),
          supabase.from('follows').select('following_id').eq('follower_id', user.id),
        ]);
        if (cancelled) return;
        const followerSet = new Set((followersRes.data || []).map((r) => r.follower_id));
        const mutualIds   = (followingRes.data || [])
          .map((r) => r.following_id)
          .filter((id) => followerSet.has(id));
        if (mutualIds.length === 0) {
          if (!cancelled) setInviteFriends([]);
          return;
        }
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name, avatar_url')
          .in('id', mutualIds);
        if (cancelled) return;
        setInviteFriends((profs || []).map((p) => ({
          id:     p.id,
          name:   p.full_name || 'Friend',
          avatar: p.avatar_url || `https://i.pravatar.cc/150?u=${p.id}`,
        })));
      } catch (err) {
        if (cancelled) return;
        if (__DEV__) console.warn('invite friends fetch:', err?.message || err);
        setInviteFriends([]);
      } finally {
        if (!cancelled) setLoadingInviteFriends(false);
      }
    })();
    return () => { cancelled = true; };
  }, [showViewerList, inviteFriends, user?.id]);
  const [showViewersModal, setShowViewersModal] = useState(false); // New: General viewer list
  const [selectedViewer, setSelectedViewer] = useState(null); // New: Profile popup target
  const [profileModalLoading, setProfileModalLoading] = useState(false);
  const [isLiveEndedForViewer, setIsLiveEndedForViewer] = useState(false); // New: Show modal to viewer when host ends
  const [peakViewers, setPeakViewers] = useState(0);

  // Audio SFX Engine
  const soundRef = useRef(null);
  const recordingRef = useRef(null);
  const chatInputRef = useRef(null);
  const channelRef = useRef(null);
  const userRef = useRef(user);
  // Cross-live notification channel — global broadcast that every live
  // room subscribes to. Notable events (≥500💎 gifts, lucky bag drops)
  // fan out to every other room's chat list so viewers can hop between
  // hot rooms. Self-room events are filtered at the receiver.
  const globalEventsChannelRef = useRef(null);
  // Tracks the active cross-live notification id per source room so a
  // new notification from the same room replaces the old one instead
  // of stacking. Map<sourceRoomId, chatItemId>.
  const activeCrossLiveNotifsRef = useRef(new Map());
  // Presence sync can fire on every viewer join/leave (no built-in debounce).
  // We collapse rapid syncs into a 300ms window so React doesn't re-render
  // the seat grid + viewer list multiple times per second.
  const presenceSyncTimerRef = useRef(null);
  // Live mirror of agora.remoteUids — used by the host's presence
  // handler to cross-check whether a "missing from supabase presence"
  // guest is still actually connected on Agora. Android Doze kills
  // the supabase WebSocket but leaves Agora's audio session alive,
  // so a seated guest who's just listening with their screen off can
  // disappear from presence while still being on the call. Without
  // this cross-check the host kicks them at ~5-7 minutes; with it
  // they stay seated as long as Agora still has them.
  const agoraRemoteUidsRef = useRef([]);
  // Viewer-side guard: when the host vanishes from presence (force-quit
  // app, lost network entirely), we don't want to flip to "Live ended"
  // on the FIRST missing sync because a brief radio blip can drop the
  // host for 2-3 seconds and they reconnect fine. We arm an 8-second
  // grace timer the moment they disappear and cancel it if they come
  // back. If the timer fires, the live really is dead — show the
  // ended modal so the viewer doesn't sit on a ghost room until the
  // 90-second DB cleanup catches up.
  const hostMissingTimerRef = useRef(null);
  // Safety net for "Joining…" hangs. If a viewer enters a room and we
  // never successfully see the host publishing within JOIN_TIMEOUT,
  // we declare the live ended. Covers any failure mode the other
  // layers might miss (server bug, Agora handshake failed, network
  // routed but realtime broken, etc).
  const joinTimeoutRef = useRef(null);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const broadcastMallIntroForUser = useCallback(async (introUser = userRef.current) => {
    const liveStreamKey = streamRecordId ? String(streamRecordId) : null;
    if (!liveStreamKey || !channelRef.current || !introUser?.id || !introUser?.selectedMallIntro || !introUser?.selectedMallIntroVideoUrl) {
      return;
    }
    const userKey = `${liveStreamKey}:${introUser.id}`;
    if (sentMallIntroUserIdsRef.current.has(userKey)) return;
    sentMallIntroUserIdsRef.current.add(userKey);
    const storageKey = `${MALL_INTRO_PLAYED_STORAGE_PREFIX}:${userKey}`;
    try {
      const alreadyPlayed = await AsyncStorage.getItem(storageKey);
      if (alreadyPlayed) return;
      await AsyncStorage.setItem(storageKey, '1');
    } catch (e) {
      if (__DEV__) console.warn('mall intro played storage:', e?.message || e);
    }
    const payload = {
      id: introUser.id,
      ts: Date.now(),
      name: introUser.name || 'A viewer',
      liveStreamId: liveStreamKey,
      introId: introUser.selectedMallIntro,
      videoUrl: introUser.selectedMallIntroVideoUrl,
      thumbnailUrl: introUser.selectedMallIntroThumbnailUrl,
    };
    if (!playedMallIntroUserIdsRef.current.has(userKey)) {
      playedMallIntroUserIdsRef.current.add(userKey);
      queueMallIntro({
        id: `${payload.id}-${payload.ts}`,
        name: payload.name,
        videoUrl: payload.videoUrl,
        audioUrl: payload.audioUrl || payload.audio_url || null,
      });
    }
    channelRef.current.send({ type: 'broadcast', event: 'mall_intro', payload });
  }, [queueMallIntro, streamRecordId]);

  useEffect(() => {
    if (isHostView || !user?.id || !user?.selectedMallIntro || !user?.selectedMallIntroVideoUrl) return;
    broadcastMallIntroForUser(user);
  }, [
    broadcastMallIntroForUser,
    isHostView,
    streamRecordId,
    user?.id,
    user?.selectedMallIntro,
    user?.selectedMallIntroVideoUrl,
  ]);

  const SFX_ASSETS = {
    Clap: require('../../assets/audio/clap.mp3'),
    Laugh: require('../../assets/audio/laugh.mp3'),
    Surprise: require('../../assets/audio/surprise.mp3'),
    Drum: require('../../assets/audio/drum.mp3'),
    Fanfare: require('../../assets/audio/fanfare.mp3')
  };

  // Pool one AudioPlayer per SFX name and reuse it forever. The old code did
  // `createAudioPlayer(asset)` on every trigger and never released anything,
  // so 50 SFX plays leaked 50 dead native players.
  const sfxPoolRef = useRef({});

  // Local-only playback (used by both the sender and every receiver)
  const playSFX = async (name) => {
    try {
      const asset = SFX_ASSETS[name];
      if (!asset) return;
      let player = sfxPoolRef.current[name];
      if (!player) {
        player = Audio.createAudioPlayer(asset);
        sfxPoolRef.current[name] = player;
      }
      try { player.seekTo?.(0); } catch (e) { if (__DEV__) console.warn('broadcast cleanup:', e?.message); }
      player.play();
    } catch (error) {
      // SFX plays fire several times per second in a busy room. The
      // warn-on-every-failure path used to flood the production log
      // bridge and visibly stutter low-end devices when one SFX file
      // was malformed. Dev gets the message; prod stays silent.
      if (__DEV__) console.warn('SFX Playback Error:', error);
    }
  };

  // Release every pooled SFX player when the room unmounts.
  useEffect(() => {
    return () => {
      const pool = sfxPoolRef.current;
      Object.keys(pool).forEach((k) => {
        const p = pool[k];
        try { p.pause?.(); } catch (e) { if (__DEV__) console.warn('broadcast cleanup:', e?.message); }
        try { p.remove?.(); } catch (e) { if (__DEV__) console.warn('broadcast cleanup:', e?.message); }
      });
      sfxPoolRef.current = {};
    };
  }, []);

  // Triggered from the SFX menu — play locally AND broadcast to the room so
  // everyone (host, guests, viewers) hears the same sound.
  const triggerSFX = (name) => {
    playSFX(name);
    if (channelRef.current) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'sfx',
        payload: { name, by: user?.id },
      });
    }
  };

  // Video Live Enhanced States
  const [isCamOn, setIsCamOn] = useState(type !== 'audio');
  const [isFrontCam, setIsFrontCam] = useState(true); // Default to Selfie
  const [activeFilter, setActiveFilter] = useState('None'); // legacy RGB overlay (kept for back-compat; superseded by Beauty)
  // Real Agora beauty levels (0 = off, 4 = max). Default = StreamKar-ish "Natural".
  // Beauty filter starts OFF. Even the "Natural" preset costs 8-12% CPU
  // on a Snapdragon 6-series — leaving it ON by default heated up budget
  // phones the moment they tapped "Go Live". Hosts can re-enable via the
  // Beauty button; opt-in is the right default for thermal headroom.
  const [beautyLevels, setBeautyLevels] = useState({ smooth: 0, whiten: 0, redness: 0, sharp: 0 });
  const [showBeautySheet, setShowBeautySheet] = useState(false);
  // Single-button host-tools sheet. Replaces the 4-stack sidebar that
  // used to overlap the floating guest tiles on the right edge — now
  // there's just one circular trigger above the action bar, opening
  // a bottom sheet with Flip / Cam / Beauty / SFX in a 4-up grid.
  const [showHostTools, setShowHostTools] = useState(false);
  // Audio room background picker (mig 88). The Tools sheet opens this
  // in audio mode only — video rooms keep the existing 4-button layout.
  const [showAudioTemplates, setShowAudioTemplates] = useState(false);
  // Overflow menu for less-frequent host actions in audio mode (Music,
  // Background, SFX, Lock). Without this the bottom bar overflows on
  // narrow phones once we crossed ~7 buttons.
  const [showHostMoreMenu, setShowHostMoreMenu] = useState(false);
  // Currently-applied background. Source of truth = live_streams row's
  // active_template_id; we mirror it locally for instant render and
  // sync via realtime on the same stream-status channel that already
  // exists in this file.
  const [activeTemplateId, setActiveTemplateId] = useState(null);

  const comboTimeoutRef = useRef(null);
  const lottieTimeoutRef = useRef(null);
  const toastTimeoutRef = useRef(null);

  const comboAnim = useRef(new Animated.Value(1)).current;
  const toastAnimX = useRef(new Animated.Value(-width)).current;
  const toastAnimOpacity = useRef(new Animated.Value(0)).current;
  // Lucky Bag animations. dropAnim drives the bag's entrance (slide
  // from off-screen top, settle with a light bounce). pulseAnim runs
  // on a loop while the bag is open — glow halo expands + fades to
  // catch the eye without animating the bag's own geometry, which
  // would shift the tap target.
  const luckyDropAnim  = useRef(new Animated.Value(0)).current;
  const luckyPulseAnim = useRef(new Animated.Value(0)).current;

  // Transaction & Session Stats
  const [isProcessingGift, setIsProcessingGift] = useState(false);
  const [sessionFollows, setSessionFollows] = useState(0);

  // Set of user ids the current viewer is already following — drives
  // the toggle state of the "Follow / Following" button in the viewer
  // list modal. Hydrates when the modal opens so we don't fetch the
  // entire follows table on every render.
  const [followedIds, setFollowedIds] = useState(() => new Set());
  const [followBusyId, setFollowBusyId] = useState(null);
  // Same idea for the host pill in the live header.
  const [hostFollowBusy, setHostFollowBusy] = useState(false);

  // Real-time Presence & Viewer Management (Supabase Integrated)
  const [roomViewers, setRoomViewers] = useState([]);
  const [liveViewerCount, setLiveViewerCount] = useState(0);

  useEffect(() => {
    // Viewer count is updated whenever roomViewers (Presence Sync) changes
    setLiveViewerCount(roomViewers.length);
  }, [roomViewers]);

  // Role Simulation State.
  // Initial value comes from ?mode=host (the path the host took into
  // their own room when they tapped "Go Live"). When a logged-in user
  // re-enters their own live from the home grid — e.g. after a reload
  // that left the live_streams row not-yet-cleaned — the mode param
  // is missing and the route looks viewer-shaped. The useEffect below
  // promotes them to host whenever user.id matches the route id, so
  // they don't get stuck on the "Joining" spinner trying to view
  // their own ghost stream.
  const [isHostView, setIsHostView] = useState(mode === 'host');
  useEffect(() => {
    if (user?.id && id && user.id === id && !isHostView) {
      setIsHostView(true);
    }
  }, [user?.id, id, isHostView]);
  const [showSummary, setShowSummary] = useState(false);
  const [earnings, setEarnings] = useState(0);
  const [totalGiftsReceived, setTotalGiftsReceived] = useState(0);
  const [liveStartTime] = useState(Date.now());
  const [liveDuration, setLiveDuration] = useState(0);
  const [finalSummaryData, setFinalSummaryData] = useState(null);
  const [showMusicModal, setShowMusicModal] = useState(false);
  const [currentMusic, setCurrentMusic] = useState(null); // { id, title, artist, audio_url }
  const [musicTracks, setMusicTracks] = useState([]);
  const [musicLoading, setMusicLoading] = useState(false);
  // 'unknown' | 'granted' | 'denied' — drives the inline UI in the
  // music modal. 'denied' shows a "Grant permission" CTA so the host
  // can recover without leaving the room.
  const [musicPermStatus, setMusicPermStatus] = useState('unknown');
  const [isMusicPlaying, setIsMusicPlaying] = useState(false);
  const musicPlayerRef = useRef(null);

  // Load the host's DEVICE music library when they open the picker. We
  // request expo-media-library permission first (Android READ_MEDIA_AUDIO
  // is already declared in app.json; iOS asks at first call). Failed
  // permission becomes a CTA in the modal — see the render path below.
  //
  // Music plays locally on the host's device only. The Agora mic stream
  // captures the audio output naturally, so viewers hear it the same way
  // they'd hear a host DJ'ing in any other live-streaming app. We don't
  // broadcast file:// URIs because remote viewers can't fetch them
  // anyway — see the broadcast guard in playRoomMusic below.
  const loadDeviceMusic = useCallback(async () => {
    setMusicLoading(true);
    try {
      let perm = await MediaLibrary.getPermissionsAsync();
      if (perm.status !== 'granted' && perm.canAskAgain) {
        perm = await MediaLibrary.requestPermissionsAsync();
      }
      setMusicPermStatus(perm.status === 'granted' ? 'granted' : 'denied');
      if (perm.status !== 'granted') {
        setMusicTracks([]);
        return;
      }
      const result = await MediaLibrary.getAssetsAsync({
        mediaType: MediaLibrary.MediaType.audio,
        first: 200,
        sortBy: [MediaLibrary.SortBy.modificationTime],
      });
      // Map device asset shape → the track shape the rest of the room
      // code already speaks. filename minus extension is a sensible
      // title; artist + cover stay null because device assets don't
      // expose ID3 metadata reliably across iOS/Android.
      const tracks = (result.assets || []).map((a) => ({
        id:           a.id,
        title:        (a.filename || 'Untitled').replace(/\.[^.]+$/, ''),
        artist:       null,
        audio_url:    a.uri,
        cover_url:    null,
        duration_sec: Math.round(a.duration || 0),
      }));
      setMusicTracks(tracks);
    } catch (err) {
      if (__DEV__) console.warn('device music load:', err?.message);
      setMusicTracks([]);
    } finally {
      setMusicLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!showMusicModal) return;
    // Only refresh when modal opens with no tracks yet OR permission
    // was previously denied (so a re-open after granting works).
    if (musicTracks.length > 0 && musicPermStatus === 'granted') return;
    loadDeviceMusic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMusicModal]);

  // Play a track using expo-audio
  // Core playback — `broadcast=true` also tells the rest of the room to play
  // the same track (used when the host picks a track). Receivers call this
  // with broadcast=false from the channel listener.
  const playRoomMusic = (track, broadcast = true) => {
    try {
      if (musicPlayerRef.current) {
        try { musicPlayerRef.current.pause?.(); } catch (e) { if (__DEV__) console.warn('broadcast cleanup:', e?.message); }
        try { musicPlayerRef.current.remove?.(); } catch (e) { if (__DEV__) console.warn('broadcast cleanup:', e?.message); }
        musicPlayerRef.current = null;
      }
      const player = Audio.createAudioPlayer({ uri: track.audio_url });
      player.loop = true;
      player.volume = 0.5;
      player.play();
      musicPlayerRef.current = player;
      setCurrentMusic(track);
      setIsMusicPlaying(true);

      // Only broadcast when the audio_url is reachable by other viewers
      // (http/https). file:// and content:// URIs are local to the
      // host's device, so other clients can't fetch them. Device music
      // reaches viewers through the host's Agora mic stream instead,
      // which is how Bigo / Likee handle DJ playback too.
      const isShareableUrl = /^https?:\/\//i.test(String(track.audio_url || ''));
      if (broadcast && isShareableUrl && channelRef.current) {
        channelRef.current.send({
          type: 'broadcast',
          event: 'music',
          payload: { action: 'play', track, by: user?.id },
        });
      }
    } catch (err) {
      if (__DEV__) console.warn('Music play error:', err?.message);
      if (broadcast) showCuteAlert('Playback failed', 'Could not load this track.');
    }
  };

  // Host picks a track from the gallery — play + broadcast to room
  const playTrack = (track) => playRoomMusic(track, true);

  const togglePlayPause = () => {
    const player = musicPlayerRef.current;
    if (!player) return;
    try {
      if (isMusicPlaying) { player.pause(); setIsMusicPlaying(false); }
      else { player.play(); setIsMusicPlaying(true); }
    } catch (e) { if (__DEV__) console.warn('broadcast cleanup:', e?.message); }
  };

  const stopMusic = (broadcast = true) => {
    const player = musicPlayerRef.current;
    if (player) {
      try { player.pause?.(); } catch (e) { if (__DEV__) console.warn('broadcast cleanup:', e?.message); }
      try { player.remove?.(); } catch (e) { if (__DEV__) console.warn('broadcast cleanup:', e?.message); }
      musicPlayerRef.current = null;
    }
    setCurrentMusic(null);
    setIsMusicPlaying(false);

    if (broadcast && channelRef.current) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'music',
        payload: { action: 'stop', by: user?.id },
      });
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (musicPlayerRef.current) {
        try { musicPlayerRef.current.pause?.(); } catch (e) { if (__DEV__) console.warn('broadcast cleanup:', e?.message); }
        try { musicPlayerRef.current.remove?.(); } catch (e) { if (__DEV__) console.warn('broadcast cleanup:', e?.message); }
      }
    };
  }, []);
  const [isCameraReadyToMount, setIsCameraReadyToMount] = useState(false);
  const [entranceBanner, setEntranceBanner] = useState(null); // { name, type, level }
  const entranceAnimX = useRef(new Animated.Value(-width)).current;
  const entranceAnimOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (entranceBanner) {
      entranceAnimOpacity.setValue(0);
      Animated.sequence([
        // Slide In
        Animated.parallel([
          Animated.timing(entranceAnimX, {
            toValue: 0,
            duration: 1000,
            easing: Easing.out(Easing.back(1)),
            useNativeDriver: true,
          }),
          Animated.timing(entranceAnimOpacity, {
            toValue: 1,
            duration: 800,
            useNativeDriver: true,
          })
        ]),
        // Hold
        Animated.delay(3500),
        // Slide Out
        Animated.parallel([
          Animated.timing(entranceAnimX, {
            toValue: width,
            duration: 1000,
            easing: Easing.in(Easing.exp),
            useNativeDriver: true,
          }),
          Animated.timing(entranceAnimOpacity, {
            toValue: 0,
            duration: 800,
            useNativeDriver: true,
          })
        ])
      ]).start();
    } else {
      entranceAnimX.setValue(-width);
      entranceAnimOpacity.setValue(0);
    }
  }, [entranceBanner]);

  useEffect(() => {
    // Entrance logic for real viewers can be added here if needed
  }, [roomViewers]);

  // Duration counter for the host. Wraps setLiveDuration in a mounted
  // guard so a forced navigation (router.replace from end_live / ban /
  // network failure) can't fire a stale tick after the component has
  // already torn down — the old code would emit a "setState on unmounted
  // component" warning and, in dev mode, briefly resurrect the timer
  // ref via React's strict-mode double-effect.
  useEffect(() => {
    if (!isHostView) return undefined;
    let mounted = true;
    const interval = setInterval(() => {
      if (!mounted) return;
      setLiveDuration(prev => prev + 1);
    }, 1000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [isHostView]);

  // ----- LIVE STREAM DB LIFECYCLE -----
  // Host: create live_streams row when entering; end it on unmount.
  // Fast path: live.js pre-warms the row during the 3s countdown and
  // hands the id over via the `streamId` route param. When we see it
  // we adopt it directly and skip the RPC roundtrip, shaving another
  // ~300ms off the host's perceived go-live time.
  useEffect(() => {
    if (!isHostView || !user?.id || streamRecordId) return;
    if (prewarmedStreamId) {
      setStreamRecordId(String(prewarmedStreamId));
      return;
    }
    let mounted = true;
    (async () => {
      const newId = await startLiveStream(
        type === 'audio' ? 'audio' : 'video',
        urlTitle || 'New Live',
        tag || 'Chat',
        user?.avatar || null
      );
      if (mounted && newId) setStreamRecordId(newId);
    })();
    return () => { mounted = false; };
  }, [isHostView, user?.id, prewarmedStreamId]);

  // Viewer: find the active live_streams row for this broadcaster, for room context
  useEffect(() => {
    if (isHostView || !id) return;
    (async () => {
      // Check the most recent stream regardless of status — if it ended, show the modal.
      const { data } = await supabase
        .from('live_streams')
        .select('id, status, active_template_id')
        .eq('broadcaster_id', id)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!data) {
        // No stream at all
        setIsLiveEndedForViewer(true);
        return;
      }
      if (data.status !== 'live') {
        setIsLiveEndedForViewer(true);
        return;
      }
      setStreamRecordId(data.id);
      // Hydrate the current background so viewers see it before the
      // first realtime UPDATE on this row arrives (mig 88).
      setActiveTemplateId(data.active_template_id || null);
    })();
  }, [id, isHostView]);

  // Viewer-side realtime watcher: if the live_streams row flips to
  // anything other than 'live' (host pressed End, or
  // cleanup_stale_live_streams marked it ended after the host's app
  // crashed without heartbeat), trigger the "Live ended" modal
  // immediately instead of leaving viewers staring at a dead room.
  //
  // This is the SLOWER but more reliable detection layer — the
  // presence-based one below catches host crashes in ~8s, this one
  // catches everything else (clean exits, server-side cleanup,
  // admin force-end). Both running in parallel is intentional.
  // Host-side: keep the local activeTemplateId in sync with whatever
  // row exists on live_streams. Necessary because the host may apply a
  // template from another device, or reopen the app mid-stream. Mig 88
  // RLS lets the host read their own row, so this fetch + sub work
  // without any new policies.
  useEffect(() => {
    if (!isHostView || !streamRecordId) return undefined;
    (async () => {
      const { data } = await supabase
        .from('live_streams')
        .select('active_template_id')
        .eq('id', streamRecordId)
        .maybeSingle();
      if (data) setActiveTemplateId(data.active_template_id || null);
    })();
    const ch = supabase
      .channel(`host-bg-${streamRecordId}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'live_streams', filter: `id=eq.${streamRecordId}` },
        ({ new: row }) => {
          if (row && 'active_template_id' in row) {
            setActiveTemplateId(row.active_template_id || null);
          }
        })
      .subscribe();
    return () => { try { supabase.removeChannel(ch); } catch (_) {} };
  }, [isHostView, streamRecordId]);

  useEffect(() => {
    if (isHostView || !streamRecordId) return;
    const ch = supabase
      .channel(`stream-status-${streamRecordId}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'live_streams', filter: `id=eq.${streamRecordId}` },
        ({ new: row }) => {
          if (row && row.status && row.status !== 'live') {
            setIsLiveEndedForViewer(true);
          }
          // Mirror the room's active background (mig 88) so viewers see
          // the same template the host picked, in realtime.
          if (row && 'active_template_id' in row) {
            setActiveTemplateId(row.active_template_id || null);
          }
        }
      )
      .subscribe();
    return () => { try { supabase.removeChannel(ch); } catch (_) {} };
  }, [isHostView, streamRecordId]);

  // Global cross-live events — subscribe to the shared channel so we
  // hear about notable gifts + lucky bags happening in other rooms.
  // Self-room events are filtered out; per-source-room dedup keeps
  // the chat from filling with one source's spam.
  useEffect(() => {
    if (!user?.id || !id) return undefined;

    const handleNotification = (subType, payload) => {
      // Don't show notifications from the same room we're in.
      if (!payload || payload.roomId === id) return;
      const sourceRoomId = payload.roomId;
      // Per-source-room dedup: drop the previous notification from
      // this room (if any) before appending the new one.
      const prevId = activeCrossLiveNotifsRef.current.get(sourceRoomId);
      const notifId = `xlive-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      activeCrossLiveNotifsRef.current.set(sourceRoomId, notifId);
      setChats((prev) => {
        const filtered = prevId ? prev.filter((c) => c.id !== prevId) : prev;
        const next = [...filtered, {
          id: notifId,
          type: 'live_notification',
          subType,
          payload,
          ts: Date.now(),
        }];
        // Existing 50-item chat cap applies via the realtime chat
        // handler elsewhere; we slice here too so a notification
        // burst can't overrun.
        return next.length > 50 ? next.slice(next.length - 50) : next;
      });
    };

    const ch = supabase
      .channel('global-live-events')
      .on('broadcast', { event: 'gift_in_live' }, ({ payload }) => handleNotification('gift', payload))
      .on('broadcast', { event: 'lucky_bag_in_live' }, ({ payload }) => handleNotification('lucky_bag', payload))
      .subscribe();

    globalEventsChannelRef.current = ch;

    return () => {
      try { supabase.removeChannel(ch); } catch (_) {}
      globalEventsChannelRef.current = null;
      activeCrossLiveNotifsRef.current.clear();
    };
  }, [user?.id, id]);

  // Tracks whether the host has already explicitly ended the stream
  // (via the End Now button). If so, the unmount cleanup below skips
  // its endLiveStream call to avoid a redundant DB write.
  const streamEndedRef = useRef(false);

  // End live stream on unmount (host only) — defense in depth for the case
  // where the host backgrounds or force-quits without pressing End Now.
  useEffect(() => {
    return () => {
      if (isHostView && streamRecordId && !streamEndedRef.current) {
        endLiveStream(streamRecordId, peakViewers).catch(() => { });
      }
    };
  }, [isHostView, streamRecordId]);

  // Heartbeat — host pings every 30s so server can detect app-kill / crash.
  // If the app dies without unmount, cleanup_stale_live_streams() marks it
  // as 'ended' after 90s. Without this, ghost "live" rows would litter home.
  //
  // Two viewer signals get sent:
  //   p_viewer_count    → session peak (GREATEST-ed server-side)
  //   p_current_viewers → live concurrent count (overwritten server-side)
  //                       roomViewers.length is what the presence channel
  //                       reports; this is what the home grid sorts on.
  //
  // roomViewersRef is read instead of roomViewers so we don't have to
  // restart the interval on every viewer join/leave — the ping function
  // always sees the latest count without re-binding.
  const roomViewersCountRef = useRef(0);
  useEffect(() => { roomViewersCountRef.current = roomViewers.length; }, [roomViewers]);

  useEffect(() => {
    if (!isHostView || !streamRecordId) return;
    const ping = async () => {
      try {
        await supabase.rpc('live_stream_heartbeat', {
          p_stream_id:       streamRecordId,
          p_viewer_count:    peakViewers,
          p_current_viewers: roomViewersCountRef.current,
        });
      } catch (e) { if (__DEV__) console.warn('broadcast cleanup:', e?.message); }
    };
    ping(); // immediate
    const interval = setInterval(ping, 30000);
    return () => clearInterval(interval);
  }, [isHostView, streamRecordId, peakViewers]);

  // Viewer-side daily-watch-task ping. Calls bump_watch_progress(1)
  // every 60 seconds while the viewer is actually inside a live room
  // and the live is still going. Server-side clamp limits each call
  // to a max of 5 minutes per bump, so even a wildly out-of-spec
  // client can't inflate the task. Skipped on host view (host has
  // their own 'live' action task).
  useEffect(() => {
    if (isHostView || !streamRecordId || isLiveEndedForViewer) return undefined;
    if (typeof bumpWatchProgress !== 'function') return undefined;
    // Fire one tick on mount so the first minute doesn't get lost,
    // then a steady cadence after.
    bumpWatchProgress(1);
    const interval = setInterval(() => bumpWatchProgress(1), 60000);
    return () => clearInterval(interval);
  }, [isHostView, streamRecordId, isLiveEndedForViewer, bumpWatchProgress]);

  // Host earnings reconciliation. The local `earnings` / `totalGiftsReceived`
  // counters are updated from the realtime gift broadcast event, but if
  // the host's channel hiccups (network blip, brief backgrounding, etc.)
  // a gift can land server-side without firing the local listener. The
  // `live_streams` row is updated atomically inside send_gift(), so we
  // poll it every 30s and treat the DB as the source of truth. Worst
  // case the summary card may briefly under-report by one gift; with
  // this poll it self-corrects within half a minute.
  useEffect(() => {
    if (!isHostView || !streamRecordId) return undefined;
    let mounted = true;
    const sync = async () => {
      try {
        const { data, error } = await supabase
          .from('live_streams')
          .select('total_gifts, total_earnings')
          .eq('id', streamRecordId)
          .maybeSingle();
        if (!mounted || error || !data) return;
        // Monotonically advance — never roll back below what the local
        // state has already seen (a race where we read mid-write could
        // briefly return a slightly stale value).
        if (Number.isFinite(data.total_earnings)) {
          setEarnings((cur) => Math.max(cur, Number(data.total_earnings) || 0));
        }
        if (Number.isFinite(data.total_gifts)) {
          setTotalGiftsReceived((cur) => Math.max(cur, Number(data.total_gifts) || 0));
        }
      } catch (e) {
        if (__DEV__) console.warn('earnings sync:', e?.message);
      }
    };
    sync();
    const t = setInterval(sync, 30000);
    return () => { mounted = false; clearInterval(t); };
  }, [isHostView, streamRecordId]);

  const formatDuration = (totalSeconds) => {
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    return hrs > 0
      ? `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
      : `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const renderFilterOverlay = () => {
    if (activeFilter === 'None') return null;

    let overlayStyle = {};
    if (activeFilter === 'Natural') overlayStyle = { backgroundColor: 'rgba(255, 230, 200, 0.08)' };
    if (activeFilter === 'Glow') overlayStyle = { backgroundColor: 'rgba(255, 255, 255, 0.12)' };
    if (activeFilter === 'BW') overlayStyle = { backgroundColor: 'rgba(0,0,0,0.4)', saturation: 0 }; // Saturation is a placeholder concept here

    return (
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFillObject, overlayStyle, activeFilter === 'BW' && { backgroundColor: 'rgba(0,0,0,0.2)' }]}
      />
    );
  };

  const [broadcaster, setBroadcaster] = useState(null);

  useEffect(() => {
    if (id) fetchBroadcasterProfile();
  }, [id]);

  async function fetchBroadcasterProfile() {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', id)
        .single();

      if (data) {
        if (data.is_banned) {
          showCuteAlert("Access Denied", "This broadcaster has been suspended by Admin.");
          router.back();
          return;
        }
        setBroadcaster({
          id: data.id,
          broadcasterName: data.full_name || 'Broadcaster',
          coverUrl: data.avatar_url || `https://picsum.photos/seed/${data.id}/400/600`,
          isVIP: data.is_vip || true,
          vipType: data.vip_type || 'VVIP',
          selectedProfileFrame: data.selected_profile_frame || null,
          selectedProfileFrameUrl: data.selected_profile_frame_url || null,
        });
      }
    } catch (err) {
      console.error("Fetch Broadcaster Error:", err);
    }
  }

  // Real-time Ban Check Listener
  useEffect(() => {
    if (!id) return;
    // Unique channel name per mount — Supabase registry caches by name, and
    // a remount before async cleanup completes would otherwise return the
    // already-subscribed channel and `.on()` throws.
    const banChannel = supabase
      .channel(`ban-check-${id}-${Date.now()}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${id}` },
        (payload) => {
          if (payload.new.is_banned) {
            showCuteAlert("Stream Ended", "This session has been terminated by administration.");
            router.replace('/main/(tabs)');
          }
        }
      )
      .subscribe((status) => {
        // Log non-fatal subscription errors so production issues are visible
        // instead of a silently dead realtime listener.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('ban-check channel:', status);
        }
      });

    // removeChannel is a no-op for half-subscribed channels but always safe.
    return () => { try { supabase.removeChannel(banChannel); } catch (e) { if (__DEV__) console.warn('broadcast cleanup:', e?.message); } };
  }, [id]);

  const stream = isHostView ? {
    id: user?.id,
    broadcasterName: user?.name || 'Broadcaster',
    coverUrl: user?.avatar || 'https://picsum.photos/seed/myprofile/100/100',
    isVIP: true,
    vipType: 'VVIP',
    selectedProfileFrame: user?.selectedProfileFrame || null,
    selectedProfileFrameUrl: user?.selectedProfileFrameUrl || null,
    streamType: type
  } : (broadcaster || {
    broadcasterName: 'Loading...',
    id: id,
    coverUrl: `https://picsum.photos/seed/${id}/400/600`,
    vipType: 'VIP'
  });

  const isAudio = type === 'audio' || (stream.streamType === 'audio');

  // ----- AGORA REAL-TIME ENGINE -----
  // Host + accepted guests publish; everyone else subscribes. Channel name is
  // the broadcaster's id so host & viewers share one channel.
  const isAgoraPublisher = isHostView || callRequestStatus === 'accepted';
  // Permission guard: a publisher needs mic always, and camera too for video
  // rooms. Without the right grant we keep the engine OFF instead of joining
  // with no media — that path used to waste resources and confuse state.
  // Subscribers (regular viewers) need neither permission to join.
  const publisherHasMedia = isVideoMode
    ? (cameraPerm?.granted && micPerm?.granted)
    : (micPerm?.granted);
  const agoraEnabled = !!user?.id && !!id && (!isAgoraPublisher || publisherHasMedia);
  const agora = useAgoraEngine({
    channelName: String(id || ''),
    role: isAgoraPublisher ? 'publisher' : 'subscriber',
    isVideo: !isAudio,
    enabled: agoraEnabled,
  });
  // The broadcaster's deterministic Agora uid — used by viewers to render the
  // host's remote feed in the fullscreen background.
  const hostUid = agoraUidFromId(String(id || ''));

  // Viewer-side "Joining" safety timeout. Starts on mount, clears the
  // moment the host's Agora uid lights up in remoteUids (= the host
  // is actually publishing). If 15s elapses and we still haven't seen
  // the host, treat it as ended — covers the case where DB still says
  // 'live' but no media is flowing (host force-quit, app reload,
  // server hiccup, anything).
  //
  // Placed AFTER `const agora = useAgoraEngine(...)` above because the
  // dependency array reads agora.joined / agora.remoteUids at render
  // time — placing it before the useAgoraEngine call would hit the
  // temporal dead zone and throw "joined of undefined".
  useEffect(() => {
    if (isHostView) return undefined;
    // Already connected? No need for the timeout.
    if (agora.joined && agora.remoteUids.includes(hostUid)) {
      if (joinTimeoutRef.current) {
        clearTimeout(joinTimeoutRef.current);
        joinTimeoutRef.current = null;
      }
      return undefined;
    }
    // Start the timeout once. Don't restart it on every render — that
    // would mean a flaky 2-state oscillation keeps resetting the clock.
    if (joinTimeoutRef.current) return undefined;
    joinTimeoutRef.current = setTimeout(() => {
      joinTimeoutRef.current = null;
      // One last check — if the host showed up between the timer being
      // set and now, don't kill the room.
      if (!isHostView && !(agora.joined && agora.remoteUids.includes(hostUid))) {
        setIsLiveEndedForViewer(true);
        if (streamRecordId) {
          supabase.rpc('report_dead_stream', { p_stream_id: streamRecordId })
            .catch(() => { /* best effort */ });
        }
      }
    }, 15000);
    return undefined;
  }, [isHostView, agora.joined, agora.remoteUids, hostUid, streamRecordId]);

  // Keep the ref in sync so realtime handlers (registered once) read the
  // latest call status — used to detect being kicked off a seat.
  useEffect(() => { callStatusRef.current = callRequestStatus; }, [callRequestStatus]);

  // ── AppState: pause video encoding when the app backgrounds ──
  // When the user swipes the app away (or screen-off, or another
  // app opens), the camera + mic should stop publishing. Otherwise:
  //   • The phone keeps encoding 540×960 @ 24fps for nothing, which
  //     is the single biggest cause of "phone got hot in my pocket".
  //   • Battery drains ~15-20%/hour for an invisible stream.
  // Viewers don't need this — they just subscribe; OS pauses RTC for
  // backgrounded apps automatically. The publisher path is what we fix.
  //
  // On foreground we re-enable. If the user is still 'accepted' or the
  // host, publishing resumes. The realtime channel itself is left alone
  // (no need to re-subscribe), only the media tracks are toggled.
  const appStateRef = useRef(AppState.currentState);
  useEffect(() => {
    if (!isAgoraPublisher) return undefined;
    const sub = AppState.addEventListener('change', (next) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      const goingBg     = next.match(/inactive|background/);
      const comingFg    = prev.match(/inactive|background/) && next === 'active';
      try {
        if (goingBg) {
          if (isVideoMode) agora.setCameraEnabled?.(false);
          agora.setMuted?.(true);
        } else if (comingFg) {
          if (isVideoMode && isCamOn) agora.setCameraEnabled?.(true);
          // Unconditionally re-apply the user's mute intent. Previously
          // this only unmuted when the host was meant to be live, which
          // silently broke when Agora's ADM reset itself mid-cycle and
          // left the publish track unmuted. setMuted is idempotent so
          // re-asserting the muted state when already muted is free.
          agora.setMuted?.(isSelfMuted);
        }
      } catch (e) {
        if (__DEV__) console.warn('AppState handler:', e?.message);
      }
    });
    return () => { try { sub.remove(); } catch (_) {} };
  }, [isAgoraPublisher, isVideoMode, isCamOn, isSelfMuted, agora]);

  // Host-controlled room state, mirrored into a ref every render so the
  // broadcast helper (and once-registered handlers) always read fresh values.
  roomStateRef.current = {
    title: urlTitle || '',
    goal: liveGoal,
    locked: isSeatsLocked,
    lockedSeats, // per-seat lock array (seat indices)
    audioSlotCount,
    hostMuted: isSelfMuted,
    admins: roomAdmins,
    blockedUsers, // session-only block list (resets when host restarts the live)
    // Include the seat layout in the room-state payload so a viewer
    // who joins AFTER guests are already on call still receives the
    // current seat snapshot. Without this, late-joining viewers only
    // ever saw the host — the seat_update broadcasts that originally
    // populated activeGuests had already fired and don't get replayed
    // for late subscribers. The presence-sync path on the host
    // (line ~1279) re-broadcasts room_state on every new viewer join,
    // so this field reaches them within a couple hundred ms of entering.
    activeGuests,
  };
  activeGuestsRef.current = activeGuests;
  // Mirror Agora's remote uids into a ref so the presence handler (a
  // long-running supabase channel subscription, registered once with
  // [id, isHostView] deps) can read the latest list without capturing
  // a stale closure. Used as a secondary signal when deciding whether
  // to evict a seated guest — Supabase presence dies in Android Doze,
  // but Agora's audio session survives, so a guest is only truly
  // "gone" when both signals say so.
  agoraRemoteUidsRef.current = agora.remoteUids;

  // Push the current room state to everyone. Reads from the ref so it stays
  // correct even when called from a stale handler closure.
  const broadcastRoomState = () => {
    if (!isHostView || !channelRef.current) return;
    channelRef.current.send({
      type: 'broadcast',
      event: 'room_state',
      payload: roomStateRef.current,
    });
  };

  // Re-broadcast whenever the host changes a synced control.
  useEffect(() => {
    if (isHostView) broadcastRoomState();
  }, [isHostView, isSelfMuted, isSeatsLocked, lockedSeats, audioSlotCount, liveGoal, roomAdmins, blockedUsers]);

  // Sync mute state â†’ Agora mic
  useEffect(() => {
    if (agora.joined) agora.setMuted(isSelfMuted);
  }, [isSelfMuted, agora.joined]);

  // Broadcast a seated guest's own mute state so everyone sees their mic badge.
  useEffect(() => {
    if (callRequestStatus !== 'accepted' || !channelRef.current || !user?.id) return;
    channelRef.current.send({
      type: 'broadcast',
      event: 'guest_mute',
      payload: { guestId: user.id, muted: isSelfMuted },
    });
  }, [isSelfMuted, callRequestStatus]);

  // Broadcast camera on/off so everyone falls back to my avatar + audio mode
  // placeholder when I turn my video off mid-stream. (Video rooms only.)
  useEffect(() => {
    if (callRequestStatus !== 'accepted' || !channelRef.current || !user?.id || isAudio) return;
    channelRef.current.send({
      type: 'broadcast',
      event: 'guest_video',
      payload: { guestId: user.id, videoEnabled: isCamOn },
    });
  }, [isCamOn, callRequestStatus, isAudio]);

  // Sync camera on/off â†’ Agora local video (video rooms only)
  useEffect(() => {
    if (agora.joined && !isAudio) agora.setCameraEnabled(isCamOn);
  }, [isCamOn, agora.joined, isAudio]);

  // Real Agora beauty filter — built-in, free with the Video SDK we already
  // ship. Smoothness/Whiten/Redness/Sharpness map from 0..4 → 0.0..0.95.
  useEffect(() => {
    if (isAudio || !agora.joined) return;
    const engine = agora.engine?.current;
    if (!engine) return;
    const levelToValue = (lvl) => [0, 0.3, 0.55, 0.75, 0.95][Math.max(0, Math.min(4, lvl))] || 0;
    const anyOn = (beautyLevels.smooth + beautyLevels.whiten + beautyLevels.redness + beautyLevels.sharp) > 0;
    try {
      engine.setBeautyEffectOptions(anyOn, {
        // 1 = LighteningContrastNormal (default). Using the numeric value
        // avoids depending on the SDK's enum export being stable.
        lighteningContrastLevel: 1,
        lighteningLevel: levelToValue(beautyLevels.whiten),
        smoothnessLevel:  levelToValue(beautyLevels.smooth),
        rednessLevel:     levelToValue(beautyLevels.redness),
        sharpnessLevel:   levelToValue(beautyLevels.sharp),
      });
    } catch (e) {
      if (__DEV__) console.warn('Beauty effect failed:', e?.message);
    }
  }, [agora.joined, isAudio, beautyLevels]);

  // Reflect the real follow state for viewers when the room opens
  useEffect(() => {
    if (isHostView || !user?.id || !id) return;
    (async () => {
      const f = await checkFollowing(id);
      setIsFollowing(f);
    })();
  }, [isHostView, user?.id, id]);

  // Host: load the persistent block list from DB so blocks survive a restart.
  const refreshBlockedList = async () => {
    if (!isHostView || !user?.id) return;
    const { data } = await supabase.rpc('room_get_blocks', { room_host: user.id });
    if (Array.isArray(data)) {
      setBlockedList(data);
      setBlockedUsers(data.map(r => r.blocked_id));
    }
  };
  useEffect(() => { refreshBlockedList(); }, [isHostView, user?.id]);
  useEffect(() => { if (showBlockedSheet) refreshBlockedList(); }, [showBlockedSheet]);

  useEffect(() => {
    // react-native-keyboard-controller reports the true IME inset on
    // edge-to-edge Android (WindowInsets API), so the height is reliable.
    const keyboardDidShowListener = KeyboardEvents.addListener('keyboardDidShow', (e) => {
      setKeyboardVisible(true);
      setKeyboardHeight(e.height);
    });
    const keyboardDidHideListener = KeyboardEvents.addListener('keyboardDidHide', () => {
      setKeyboardVisible(false);
      setKeyboardHeight(0);
    });

    const timer = setTimeout(() => {
      // Host shows a local confirmation. Viewer entrances are broadcast from
      // the subscribe callback below so the host + everyone else see them too.
      if (isHostView) {
        const startMsgId = Date.now().toString();
        setChats(prev => [{
          id: startMsgId,
          user: 'System',
          type: 'entrance',
          message: 'Broadcast started successfully!',
          color: '#38BDF8',
        }, ...prev]);
        // Auto-disappear after 3s — consistent with viewer entrance badges.
        setTimeout(() => {
          setChats(prev => prev.filter(m => m.id !== startMsgId));
        }, 3000);
      }
      setIsCameraReadyToMount(true);
    }, 800);

    // ----- SUPABASE REALTIME SUBSCRIPTION -----
    // Room channel — use a stable id-based name so host & viewers all
    // land in the SAME channel (needed for chat/gift/seat events), but
    // guard against the remount race by removing any cached channel
    // with the same name from previous mounts first.
    const roomName = `room_${id}`;
    supabase.getChannels().forEach((ch) => {
      if (ch.topic === `realtime:${roomName}`) supabase.removeChannel(ch);
    });
    const channel = supabase.channel(roomName, {
      config: { broadcast: { self: true } }
    });

    channel
      .on('presence', { event: 'sync' }, () => {
        // Debounce: presence sync fires per join/leave + periodic refreshes.
        // In a busy room with 30 viewers churning, the old code re-rendered
        // the viewer list + seat grid 6-10 times per second. Collapsing
        // syncs into a 300ms window cuts that down to ~3/sec without any
        // user-visible delay.
        if (presenceSyncTimerRef.current) {
          clearTimeout(presenceSyncTimerRef.current);
        }
        presenceSyncTimerRef.current = setTimeout(() => {
          presenceSyncTimerRef.current = null;
          const state = channel.presenceState();
          // Build the raw presence list (every channel member tracks
          // themselves — host, guests on seats, plain viewers). We
          // need the FULL list for the host-disconnect detection a
          // few lines down, so we keep it around as `allMembers`.
          const allMembers = [];
          for (const presKey in state) {
            const entry = state[presKey][0];
            if (entry) allMembers.push(entry);
          }
          // Viewer list (and viewer COUNT) excludes the broadcaster.
          // The host appearing in their own "viewer list" was a
          // long-standing audit gap; the bottom heartbeat / current_viewers
          // also bumped by one because of it.
          const viewers = allMembers.filter((v) => v?.id !== id);
          setRoomViewers(viewers);
          setPeakViewers(prev => Math.max(prev, viewers.length));

          // Viewer-side fast host-disconnect detection. `id` is the
          // broadcaster's profile id (route param). If they're not in
          // the presence state for 8 consecutive seconds, treat the
          // live as ended. Catches force-quit / kill scenarios in ~8s
          // instead of waiting on the 90s heartbeat cleanup.
          //
          // IMPORTANT: check allMembers, not the filtered `viewers`
          // (which now excludes the host). Otherwise hostPresent would
          // always be false and the live would falsely "end" 8s after
          // every viewer joins.
          if (!isHostView && id) {
            const hostPresent = allMembers.some(v => v.id === id);
            if (hostPresent) {
              if (hostMissingTimerRef.current) {
                clearTimeout(hostMissingTimerRef.current);
                hostMissingTimerRef.current = null;
              }
            } else if (!hostMissingTimerRef.current) {
              hostMissingTimerRef.current = setTimeout(() => {
                hostMissingTimerRef.current = null;
                setIsLiveEndedForViewer(true);
                // Also report the dead stream so the DB row flips to
                // 'ended' for everyone. This stops other users from
                // seeing the same ghost in the home grid and trying
                // to join. The RPC's own staleness guard refuses to
                // end a live with a recent heartbeat, so a buggy
                // client can't kill a healthy room.
                if (streamRecordId) {
                  supabase.rpc('report_dead_stream', { p_stream_id: streamRecordId })
                    .catch(() => { /* best effort */ });
                }
              }, 8000);
            }
          }

          if (isHostView) {
            // Free any seat whose guest is GENUINELY gone — they
            // navigated away or closed the room. The eviction needs
            // TWO independent signals to agree, because either one
            // alone produces false positives in audio live:
            //
            //   1. supabase presence (`allMembers`)        — dies in
            //      Android Doze mode, which kicks in ~5 minutes after
            //      screen-off. A guest listening with their screen
            //      off is "missing" from presence but is absolutely
            //      still on the call.
            //
            //   2. Agora's remoteUids                       — keeps
            //      working in Doze because audio sessions are
            //      foreground-equivalent. Lags 30-60s on a force-
            //      quit, but that's the right grace window.
            //
            // Only when BOTH say a guest is gone do we kick them.
            // This eliminates the 5-7-minute auto-drop users reported
            // for audio listeners.
            const presentIds = new Set(allMembers.map(v => v.id).filter(Boolean));
            const agoraUidSet = new Set(agoraRemoteUidsRef.current || []);
            const cur = activeGuestsRef.current;
            let changed = false;
            const next = cur.map(g => {
              if (!g || !g.id) return g;
              const inPresence = presentIds.has(g.id);
              const inAgora    = agoraUidSet.has(agoraUidFromId(String(g.id)));
              if (!inPresence && !inAgora) { changed = true; return null; }
              return g;
            });
            if (changed) {
              setActiveGuests(next);
              channelRef.current?.send({
                type: 'broadcast',
                event: 'seat_update',
                payload: { activeGuests: next },
              });
            }
            // A (re)sync usually means someone just joined — push current room
            // state so late joiners see the right title/goal/lock/mute.
            broadcastRoomState();
          }
        }, 300);
      })
      .on('broadcast', { event: 'chat' }, ({ payload }) => {
        setChats(prev => [payload, ...prev].slice(0, 50));
        // Entrance messages auto-disappear after 3s so they feel like a
        // brief greeting instead of cluttering the chat history.
        if (payload?.type === 'entrance' && payload.id) {
          setTimeout(() => {
            setChats(prev => prev.filter(m => m.id !== payload.id));
          }, 3000);
        }
      })
      .on('broadcast', { event: 'gift' }, ({ payload }) => {
        if (payload.userId !== user?.id) {
          // Keep the Live Goal bar in sync for the host + all viewers
          if (payload.hostValue) {
            setEarnings(prev => prev + payload.hostValue);
            setTotalGiftsReceived(prev => prev + (payload.count || 1));
          }
          // Bump the per-seat earnings badge for every recipient the
          // sender included. Optimistic; the next 30s reconcile
          // overwrites with the authoritative DB aggregate.
          if (Array.isArray(payload.receivers) && payload.receivers.length) {
            setSeatEarnings((prev) => {
              const next = { ...prev };
              payload.receivers.forEach((r) => {
                if (!r?.id) return;
                next[r.id] = (next[r.id] || 0) + (Number(r.diamonds) || 0);
              });
              return next;
            });
          }
          // Look up the gift in our local catalogue. If the DB hasn't
          // finished hydrating GIFT_ITEMS yet (cold receive), or if the
          // sender used a newer gift we don't know about, fall back to
          // a placeholder so the toast still appears — the viewer sees
          // *something* instead of the gift silently vanishing.
          const found = GIFT_ITEMS.find(g => g.id === payload.giftId);
          const gift = found || {
            id:    payload.giftId,
            name:  payload.name || 'Gift',
            price: payload.price || 0,
            // No source / loop / sound — Lottie + SFX branches below
            // skip cleanly when those fields are missing.
          };
          if (gift) {
            // Reuse the slide-in animation pipeline so incoming gifts feel alive
            showFloatingToast(
              { ...gift, name: payload.name || gift.name },
              payload.count || 1,
              [payload.target || 'the Host'],
              payload.userName || 'Someone',
              payload.userAvatar
            );
            if (gift.source) {
              const animId = `recv-${Date.now()}`;
              setActiveGiftAnimation({ id: animId, source: gift.source, loop: gift.loop || false });
              // Mirror the sender — viewers/host hear the same SFX. The
              // `gift` object came from GIFT_ITEMS which now carries
              // sound_path/sound_url too, so the resolver finds the file.
              playGiftSound(gift);
              // Always clear after a duration — even looping gifts must stop on
              // the receiver side (otherwise they play forever for guests/viewers).
              if (lottieTimeoutRef.current) clearTimeout(lottieTimeoutRef.current);
              lottieTimeoutRef.current = setTimeout(() => {
                setActiveGiftAnimation((prev) => prev.id === animId ? { id: null, source: null, loop: false } : prev);
              }, gift.loop ? 4000 : (gift.customDuration || 3000));
            }
          }
        }
      })
      .on('broadcast', { event: 'call_request' }, ({ payload }) => {
        if (isHostView) {
          setPendingRequests(prev => {
            if (prev.find(r => r.id === payload.id)) return prev;
            return [...prev, payload];
          });
        }
      })
      .on('broadcast', { event: 'call_cancel' }, ({ payload }) => {
        // Guest withdrew their request before the host acted on it
        if (isHostView) {
          setPendingRequests(prev => prev.filter(r => r.id !== payload.id));
        }
      })
      .on('broadcast', { event: 'reaction' }, ({ payload }) => {
        // Someone tapped a reaction — show the floating animation for everyone
        // except the sender (who already saw it locally).
        if (payload?.by !== user?.id) {
          addReaction(payload.type || 'heart', false);
        }
      })
      .on('broadcast', { event: 'call_accepted' }, ({ payload }) => {
        if (typeof payload.audioSlotCount === 'number') setAudioSlotCount(payload.audioSlotCount);
        setActiveGuests(resizeGuestSeats(payload.activeGuests, payload.audioSlotCount || audioSlotCount));
        if (payload.guestId === user?.id) {
          // Just go live on the seat — no popup.
          setCallRequestStatus('accepted');
        }
      })
      .on('broadcast', { event: 'seat_update' }, ({ payload }) => {
        const nextSlotCount = typeof payload.audioSlotCount === 'number' ? payload.audioSlotCount : audioSlotCount;
        if (typeof payload.audioSlotCount === 'number') {
          setAudioSlotCount(nextSlotCount);
          setSlotInput(String(nextSlotCount));
        }
        setActiveGuests(resizeGuestSeats(payload.activeGuests, nextSlotCount));
        // If I was on a seat and I'm no longer in the new layout, the host
        // kicked/blocked me â†’ drop back to audience and stop publishing.
        if (!isHostView && callStatusRef.current === 'accepted' &&
          !resizeGuestSeats(payload.activeGuests, nextSlotCount).some(g => g && g.id === user?.id)) {
          setCallRequestStatus('idle');
          setIsSelfMuted(false);
          setForcedMuted(false);
          try { agora.setPublishing(false); } catch (e) { if (__DEV__) console.warn('broadcast cleanup:', e?.message); }
          showCuteAlert('Removed from call', 'The host has removed you from the call.');
        }
      })
      .on('broadcast', { event: 'force_mute' }, ({ payload }) => {
        // Host muted/unmuted a guest. Everyone updates the badge; the targeted
        // guest is actually muted on their own device.
        setMutedGuests(prev => payload.muted
          ? (prev.includes(payload.guestId) ? prev : [...prev, payload.guestId])
          : prev.filter(gid => gid !== payload.guestId));
        if (payload.guestId === user?.id) {
          setForcedMuted(payload.muted);
          setIsSelfMuted(payload.muted);
          if (payload.muted) showCuteAlert('Muted', 'The host has muted your mic.');
        }
      })
      .on('broadcast', { event: 'guest_mute' }, ({ payload }) => {
        // A guest muted/unmuted themselves — reflect their mic badge for all.
        setMutedGuests(prev => payload.muted
          ? (prev.includes(payload.guestId) ? prev : [...prev, payload.guestId])
          : prev.filter(gid => gid !== payload.guestId));
      })
      .on('broadcast', { event: 'guest_video' }, ({ payload }) => {
        // A guest toggled their camera mid-stream — flip their tile to / from
        // the audio-mode placeholder so the layout stays clean for everyone.
        setActiveGuests(prev => prev.map(g => (g && g.id === payload.guestId)
          ? { ...g, videoEnabled: !!payload.videoEnabled }
          : g));
      })
      .on('broadcast', { event: 'vip_entrance' }, ({ payload }) => {
        // A VIP/SVIP/VVIP just joined the room — animate the fullscreen
        // entrance banner. The dedupe key on `id + ts` keeps quick re-joins
        // from stacking. We trust the sender to only fire when active.
        if (!payload?.id || !payload?.type) return;
        setEntranceBanner({
          name: payload.name || 'VIP',
          type: payload.type,
          level: payload.level || 1,
          avatar: payload.avatar,
        });
      })
      .on('broadcast', { event: 'mall_intro' }, ({ payload }) => {
        if (!payload?.id || !payload?.videoUrl) return;
        const introLiveKey = String(payload.liveStreamId || streamRecordId || id);
        const userKey = `${introLiveKey}:${payload.id}`;
        if (playedMallIntroUserIdsRef.current.has(userKey)) return;
        playedMallIntroUserIdsRef.current.add(userKey);
        queueMallIntro({
          id: `${payload.id}-${payload.ts || Date.now()}`,
          name: payload.name || 'Special entrance',
          videoUrl: payload.videoUrl,
          audioUrl: payload.audioUrl || payload.audio_url || null,
        });
      })
      .on('broadcast', { event: 'room_state' }, ({ payload }) => {
        // Viewers/guests mirror the host's synced controls (title, goal,
        // seat-lock, host mute, admin list).
        if (isHostView) return;
        // Blocked for this live session â†’ bounce out of the room. The block
        // list is in-memory on the host, so it clears if the host restarts.
        if (Array.isArray(payload.blockedUsers) && payload.blockedUsers.includes(user?.id)) {
          if (!ejectedRef.current) {
            ejectedRef.current = true;
            try { agora.setPublishing(false); } catch (e) { if (__DEV__) console.warn('broadcast cleanup:', e?.message); }
            showCuteAlert('Removed', 'The host has blocked you from this live.');
            router.replace('/main/(tabs)/');
          }
          return;
        }
        if (typeof payload.title === 'string') setRoomTitle(payload.title);
        if (typeof payload.goal === 'number') setLiveGoal(payload.goal);
        setIsSeatsLocked(!!payload.locked);
        if (Array.isArray(payload.lockedSeats)) setLockedSeats(payload.lockedSeats);
        setHostMuted(!!payload.hostMuted);
        if (Array.isArray(payload.admins)) setRoomAdmins(payload.admins);
        if (typeof payload.audioSlotCount === 'number') {
          setAudioSlotCount(payload.audioSlotCount);
          setSlotInput(String(payload.audioSlotCount));
        }
        // Adopt the host's current seat snapshot. This is the late-
        // joining viewer's only chance to see who's already on call
        // before the next seat_update event fires. Guarded so an
        // accepted call user (who has authoritative local state from
        // having just claimed their seat) doesn't get overwritten by
        // a stale broadcast that hadn't yet rolled them in.
        if (Array.isArray(payload.activeGuests) && callStatusRef.current !== 'accepted') {
          setActiveGuests(resizeGuestSeats(payload.activeGuests, payload.audioSlotCount || audioSlotCount));
        }
      })
      .on('broadcast', { event: 'seat_leave' }, ({ payload }) => {
        // A guest left their seat (e.g. closed the room) — free their slot.
        setActiveGuests(prev => prev.map(g => (g && g.id === payload.guestId) ? null : g));
      })
      .on('broadcast', { event: 'lucky_bag_dropped' }, ({ payload }) => {
        // Someone in the room dropped a lucky bag. dropAt is the ISO
        // timestamp the dropper captured client-side; viewers compute
        // their own 15-second reveal countdown off it (network jitter
        // between clients is well under a second, so the countdown
        // stays roughly in sync without a server time sync). posX/posY
        // randomise where on the screen the bag will land after the
        // reveal — keeps players from camping a fixed tap target.
        // Falls back to "open immediately" if dropAt is missing (old
        // APK still in the room), so mixed-version rooms stay usable.
        if (!payload?.bagId) return;
        setActiveLuckyBag({
          id:          payload.bagId,
          perWinner:   payload.perWinner,
          winners:     payload.winners,
          droppedBy:   payload.droppedBy,
          dropperName: payload.dropperName,
          dropAt:      payload.dropAt || new Date().toISOString(),
          posX:        typeof payload.posX === 'number' ? payload.posX : 0.5,
          posY:        typeof payload.posY === 'number' ? payload.posY : 0.42,
        });
        // 60-second total visibility (15s reveal + 45s claim window
        // ish) — keep the local timeout so an idle bag eventually
        // disappears even for users who don't claim.
        setTimeout(() => setActiveLuckyBag(prev => (prev && prev.id === payload.bagId) ? null : prev), 75000);
      })
      .on('broadcast', { event: 'end_live' }, () => {
        if (!isHostView) {
          setIsLiveEndedForViewer(true);
        }
      })
      .on('broadcast', { event: 'sfx' }, ({ payload }) => {
        // Play the sound for everyone EXCEPT the sender (they already heard it
        // locally when they pressed it).
        if (payload?.by !== user?.id && payload?.name) {
          playSFX(payload.name);
        }
      })
      .on('broadcast', { event: 'music' }, ({ payload }) => {
        // Sync background music across the room. Sender already started it.
        if (payload?.by !== user?.id) {
          if (payload?.action === 'play' && payload.track) {
            playRoomMusic(payload.track, false);
          } else if (payload?.action === 'stop') {
            stopMusic(false);
          }
        }
      })
      .subscribe(async (status) => {
        // Surface REAL realtime failures. CLOSED is intentionally not
        // in this list — Supabase fires CLOSED on every clean unmount,
        // fast-refresh, and `supabase.removeChannel()` call. Treating
        // it as a warning made every normal exit look like a problem
        // in the prod log. CHANNEL_ERROR / TIMED_OUT are still loud
        // because they mean chat, presence, gifts and seat updates
        // are actually dead.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('room channel:', status);
          return;
        }
        if (status === 'CLOSED') {
          // Quiet breadcrumb only in dev so we can still trace
          // remount loops during debugging.
          if (__DEV__) console.log('[room] channel closed');
          return;
        }
        if (status === 'SUBSCRIBED') {
          await channel.track({
            id: user?.id,
            // Sequential 202xxx-style number from profiles.display_id —
            // shown everywhere "ID:" appears in the broadcast UI. Without
            // this in the presence payload, downstream consumers (viewer
            // popup, admin guest sheet) would fall back to slicing the
            // raw UUID and render "2d1814ff"-style strings that confuse
            // users who expect 202701-format IDs.
            displayId: user?.displayId || null,
            name: user?.name || 'Visitor',
            avatar: user?.avatar || 'https://picsum.photos/seed/visitor/100/100',
            level: user?.level || 1,
            isVIP: !!user?.vipType,
            vipType: user?.vipType || 'none',
            vipExpiresAt: user?.vipExpiresAt || null,
            selectedProfileFrame: user?.selectedProfileFrame || null,
            selectedProfileFrameUrl: user?.selectedProfileFrameUrl || null,
            selectedMallIntro: user?.selectedMallIntro || null,
            selectedMallIntroVideoUrl: user?.selectedMallIntroVideoUrl || null,
            selectedMallIntroThumbnailUrl: user?.selectedMallIntroThumbnailUrl || null,
          });

          // Host publishes its current room state so anyone already here syncs.
          if (isHostView) broadcastRoomState();

          // Announce a viewer's entrance to the WHOLE room (host + everyone).
          // self:true means the joining viewer also receives + shows it.
          if (!isHostView) {
            channel.send({
              type: 'broadcast',
              event: 'chat',
              payload: {
                id: `enter-${user?.id}-${Date.now()}`,
                user: 'System',
                type: 'entrance',
                message: `${user?.name || 'A viewer'} has entered the room`,
                color: '#38BDF8',
              },
            });

            broadcastMallIntroForUser(user);

            // VIP/SVIP/VVIP get a fullscreen entrance banner — the active-tier
            // check is done by the joiner so non-active VIPs don't spam.
            // Wrapped in a safety check: vipExpiresAt may be an Invalid Date
            // (NaN getTime), null, or a malformed string. Any failure means
            // "not VIP" — never crash the entrance broadcast.
            let vipActive = false;
            try {
              if (user?.vipType && user?.vipExpiresAt) {
                const expMs = new Date(user.vipExpiresAt).getTime();
                vipActive = Number.isFinite(expMs) && expMs > Date.now();
              }
            } catch (_) { vipActive = false; }
            if (vipActive) {
              channel.send({
                type: 'broadcast',
                event: 'vip_entrance',
                payload: {
                  id: user.id,
                  name: user.name || 'VIP',
                  type: user.vipType, // 'VIP' | 'SVIP' | 'VVIP'
                  level: user.level || 1,
                  avatar: user.avatar || `https://picsum.photos/seed/${user.id}/100/100`,
                },
              });
            }
          }
        }
      });

    channelRef.current = channel;

    return () => {
      clearTimeout(timer);
      // If I was seated and the screen is closing (navigated away without
      // pressing Leave), free my seat so I don't linger in this room.
      if (callStatusRef.current === 'accepted' && channelRef.current) {
        try {
          channelRef.current.send({
            type: 'broadcast',
            event: 'seat_leave',
            payload: { guestId: user?.id },
          });
        } catch (e) { if (__DEV__) console.warn('broadcast cleanup:', e?.message); }
      }
      if (channelRef.current) {
        try { supabase.removeChannel(channelRef.current); } catch (e) { if (__DEV__) console.warn('broadcast cleanup:', e?.message); }
        channelRef.current = null;
      }
      if (simulationIntervalRef.current) clearInterval(simulationIntervalRef.current);
      if (lottieTimeoutRef.current) clearTimeout(lottieTimeoutRef.current);
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
      if (comboTimeoutRef.current) clearTimeout(comboTimeoutRef.current);
      // Drop a pending presence-sync tick so it doesn't fire on an
      // unmounted component (would trigger setRoomViewers warnings).
      if (presenceSyncTimerRef.current) {
        clearTimeout(presenceSyncTimerRef.current);
        presenceSyncTimerRef.current = null;
      }
      // Cancel the host-missing grace timer too — otherwise leaving
      // the room mid-detection (e.g. user backed out before the 8s
      // elapsed) would still set "live ended" on a stale screen.
      if (hostMissingTimerRef.current) {
        clearTimeout(hostMissingTimerRef.current);
        hostMissingTimerRef.current = null;
      }
      // Same for the "Joining" safety timeout — leaving the room is
      // the user explicitly giving up, no need to mark anything dead.
      if (joinTimeoutRef.current) {
        clearTimeout(joinTimeoutRef.current);
        joinTimeoutRef.current = null;
      }
      // Cancel the just-followed badge fallback so it doesn't fire
      // post-unmount on a stale setJustFollowedHost reference.
      if (justFollowedTimerRef.current) {
        clearTimeout(justFollowedTimerRef.current);
        justFollowedTimerRef.current = null;
      }
      keyboardDidShowListener.remove();
      keyboardDidHideListener.remove();
    };
  }, [id, isHostView]);

  // Audio session setup. Speaking detection is now real (Agora audio-volume
  // indication via the engine hook) — no fake metering here.
  useEffect(() => {
    Audio.setAudioModeAsync({ playsInSilentMode: true }).catch((e) => {
      if (__DEV__) console.log("Audio Init Error:", e?.message);
    });
    return () => {
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => { });
      }
    };
  }, []);

  // ─── TikTok-style swipe between live streams ────────────────────────
  // Home page passes the visible list of live IDs + my index as route
  // params (`siblings=csv`, `myIdx=N`). Viewers can swipe up for the next
  // live and down for the previous one. Hosts are excluded (they can't
  // swipe out of their own stream). On navigation we use router.replace
  // so the broadcast screen unmounts cleanly — Agora teardown happens
  // automatically via the existing cleanup effect.
  const siblingIds = useMemo(
    () => (siblingsCsv ? String(siblingsCsv).split(',').filter(Boolean) : []),
    [siblingsCsv]
  );
  const currentIdx = useMemo(() => {
    const n = parseInt(String(myIdxStr || ''), 10);
    if (Number.isFinite(n)) return n;
    return siblingIds.indexOf(String(id));
  }, [myIdxStr, siblingIds, id]);

  const navigateToSibling = (delta) => {
    if (isHostView || siblingIds.length === 0) return;
    const nextIdx = currentIdx + delta;
    if (nextIdx < 0 || nextIdx >= siblingIds.length) return;
    const nextId = siblingIds[nextIdx];
    if (!nextId || nextId === String(id)) return;
    // router.replace cleans the current broadcast screen; the new one
    // mounts fresh with its own Agora session.
    router.replace({
      pathname: `/broadcast/${nextId}`,
      params: {
        siblings: siblingsCsv || '',
        myIdx:    String(nextIdx),
      },
    });
  };
  const navigateRef = useRef(navigateToSibling);
  useEffect(() => { navigateRef.current = navigateToSibling; });

  const panResponder = useRef(
    PanResponder.create({
      // Single taps + horizontal scrolls pass through; only sustained
      // vertical drags (> 30px, vertical-dominant by 1.5x) claim the
      // responder. The chat FlatList captures touches that start inside
      // it before this layer ever sees them.
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, gs) =>
        Math.abs(gs.dy) > 30 && Math.abs(gs.dy) > Math.abs(gs.dx) * 1.5,
      onPanResponderRelease: (_e, gs) => {
        if (gs.dy < -100)      navigateRef.current(1);  // swipe up   → next
        else if (gs.dy > 100)  navigateRef.current(-1); // swipe down → prev
      },
    })
  ).current;

  // Handle Hardware Back Button — same UX as the top-right X:
  //   • Host:   compact cute confirm before ending stream
  //   • Viewer: instant exit
  useEffect(() => {
    const backAction = () => {
      if (isHostView) {
        (async () => {
          const ok = await confirmCuteAlert(
            'End live?',
            'This will end your stream now.',
            { confirmText: 'End', cancelText: 'Cancel', destructive: true }
          );
          if (ok) await performEndLive();
        })();
        return true;
      }
      router.back();
      return true;
    };

    const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
    return () => backHandler.remove();
  }, [isHostView]);

  const simulationIntervalRef = useRef(null);

  const handleFollow = async () => {
    // Top-panel follow button — toggle following the broadcaster.
    // Busy ref prevents a double-tap during the in-flight RPC from
    // firing both follow + unfollow back-to-back.
    if (hostFollowBusy) return;
    setHostFollowBusy(true);
    try {
      if (isFollowing) {
        const ok = await unfollowUser(stream.id);
        if (ok) {
          setIsFollowing(false);
          setSessionFollows(prev => Math.max(0, prev - 1));
        }
      } else {
        const ok = await followUser(stream.id);
        if (ok) {
          setIsFollowing(true);
          setSessionFollows(prev => prev + 1);
          // Flash the checkmark badge: fade in fast, hold ~1s, fade out.
          // After the animation, justFollowedHost flips back to false
          // and the badge unmounts so nothing lingers in the UI.
          setJustFollowedHost(true);
          justFollowedFadeRef.current.setValue(0);
          Animated.sequence([
            Animated.timing(justFollowedFadeRef.current, { toValue: 1, duration: 220, useNativeDriver: true }),
            Animated.delay(1000),
            Animated.timing(justFollowedFadeRef.current, { toValue: 0, duration: 380, useNativeDriver: true }),
          ]).start(({ finished }) => { if (finished) setJustFollowedHost(false); });
          if (justFollowedTimerRef.current) clearTimeout(justFollowedTimerRef.current);
          // Hard fallback in case the animation callback never fires
          // (component unmount mid-sequence). 2s covers the full anim.
          justFollowedTimerRef.current = setTimeout(() => setJustFollowedHost(false), 2000);
        }
      }
    } finally {
      setHostFollowBusy(false);
    }
  };

  const getAudioVisitors = () => {
    if (!isAudio) return roomViewers;
    const seatedIds = new Set(activeGuests.filter(Boolean).map(g => g.id));
    return roomViewers.filter(v => v?.id && v.id !== stream.id && !seatedIds.has(v.id));
  };

  const openProfilePopup = async (person) => {
    const targetId = person?.id === 'host' ? stream.id : person?.id;
    if (!targetId) return;
    const fallback = {
      id: targetId,
      name: person?.name || person?.full_name || (targetId === stream.id ? stream.broadcasterName : 'User'),
      avatar: person?.avatar || person?.avatar_url || (targetId === stream.id ? stream.coverUrl : `https://i.pravatar.cc/150?u=${targetId}`),
      displayId: person?.displayId || person?.display_id || null,
      country: person?.country || null,
      bio: person?.bio || null,
      level: person?.level || 1,
      followers: 0,
      followingCount: 0,
      visitors: person?.visitorCount || person?.visitors || 0,
      following: followedIds.has(targetId),
      selectedProfileFrame: person?.selectedProfileFrame || null,
      selectedProfileFrameUrl: person?.selectedProfileFrameUrl || null,
      loading: true,
    };
    setSelectedViewer(fallback);
    setProfileModalLoading(true);
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', targetId)
        .maybeSingle();
      const [followersRes, followingRes, followingState] = await Promise.all([
        supabase.from('follows').select('id', { count: 'exact', head: true }).eq('following_id', targetId),
        supabase.from('follows').select('id', { count: 'exact', head: true }).eq('follower_id', targetId),
        targetId === user?.id ? Promise.resolve(false) : checkFollowing(targetId),
      ]);
      const next = {
        ...fallback,
        loading: false,
        name: profile?.full_name || fallback.name,
        avatar: profile?.avatar_url || fallback.avatar,
        displayId: profile?.display_id || fallback.displayId,
        country: profile?.country || fallback.country,
        bio: profile?.bio || fallback.bio,
        level: profile?.level || fallback.level,
        visitors: profile?.visitor_count ?? profile?.visitors ?? fallback.visitors,
        followers: followersRes?.count || 0,
        followingCount: followingRes?.count || 0,
        following: !!followingState,
        selectedProfileFrame: profile?.selected_profile_frame || profile?.selectedProfileFrame || fallback.selectedProfileFrame,
        selectedProfileFrameUrl: profile?.selected_profile_frame_url || profile?.selectedProfileFrameUrl || fallback.selectedProfileFrameUrl,
      };
      setSelectedViewer((current) => current?.id === targetId ? next : current);
      if (targetId !== user?.id && next.following) {
        setFollowedIds((prev) => new Set(prev).add(targetId));
      }
    } catch (err) {
      if (__DEV__) console.warn('profile popup fetch:', err?.message || err);
      setSelectedViewer((current) => current?.id === targetId ? { ...current, loading: false } : current);
    } finally {
      setProfileModalLoading(false);
    }
  };

  const handleViewersClick = async () => {
    setShowViewersModal(true);
    // Pre-fetch which of the current viewers / guests this user is
    // already following so each row in the list can render either
    // "Follow" or "Following" instantly when the modal opens.
    try {
      if (!user?.id) return;
      const candidateIds = new Set();
      roomViewers.forEach(v => { if (v?.id && v.id !== user.id) candidateIds.add(v.id); });
      activeGuests.forEach(g => { if (g?.id && g.id !== user.id) candidateIds.add(g.id); });
      const ids = Array.from(candidateIds);
      if (ids.length === 0) return;
      const { data } = await supabase
        .from('follows')
        .select('following_id')
        .eq('follower_id', user.id)
        .in('following_id', ids);
      if (data) setFollowedIds(new Set(data.map(r => r.following_id)));
    } catch (_) { /* silent */ }
  };

  // Toggle the follow state for a row in the viewer list. Optimistic so
  // the button flips instantly; rolls back on RPC failure.
  const toggleFollowFromList = async (targetId, targetName) => {
    if (!targetId || targetId === user?.id) return;
    if (followBusyId === targetId) return;
    setFollowBusyId(targetId);
    const wasFollowing = followedIds.has(targetId);
    // Optimistic flip
    setFollowedIds((prev) => {
      const next = new Set(prev);
      if (wasFollowing) next.delete(targetId); else next.add(targetId);
      return next;
    });
    const ok = wasFollowing
      ? await unfollowUser(targetId)
      : await followUser(targetId);
    setFollowBusyId(null);
    if (!ok) {
      // Roll back optimistic change
      setFollowedIds((prev) => {
        const next = new Set(prev);
        if (wasFollowing) next.add(targetId); else next.delete(targetId);
        return next;
      });
      showCuteAlert('Could not update', `Please try again in a moment.`);
      return;
    }
    if (!wasFollowing) {
      showCuteAlert('Followed', `You are now following ${targetName}.`);
    }
  };

  const handleSendMessage = () => {
    // 1. Basic Profanity Filter Mock
    const forbiddenWords = ['badword1', 'spam', 'hacking'];
    let cleanMessage = chatMessage.trim();

    // 2. Length Limit (Security Fix)
    if (cleanMessage.length > 200) {
      showCuteAlert("Error", "Message is too long (Max 200 characters)");
      return;
    }

    if (cleanMessage) {
      forbiddenWords.forEach(word => {
        const regex = new RegExp(word, 'gi');
        cleanMessage = cleanMessage.replace(regex, '***');
      });

      // Active VIP tier (checked at send-time so an expired VIP doesn't keep
      // their fancy color). Undefined = no tier or expired → default color.
      const exp = user?.vipExpiresAt && new Date(user.vipExpiresAt);
      const activeVip = (user?.vipType && exp && exp.getTime() > Date.now()) ? user.vipType : null;

      const newMessage = {
        id: Date.now().toString() + '-' + Math.random().toString(36).substring(2, 11),
        userId: user?.id,
        user: user?.name || 'User',
        type: 'user',
        message: cleanMessage,
        color: isHostView ? '#FBBF24' : '#FFFFFF',
        isHost: isHostView,
        vipType: activeVip,
      };

      if (channelRef.current) {
        channelRef.current.send({
          type: 'broadcast',
          event: 'chat',
          payload: newMessage
        });
      }

      setChatMessage('');
      // Keep the keyboard up so the user can keep chatting — it only closes
      // when they tap back / outside. Refocus covers the send-button tap.
      chatInputRef.current?.focus();
    }
  };

  // Update the seat layout locally AND broadcast it so the host + every
  // viewer stay in sync (used by kick / block / remove / leave).
  const applySeats = (next) => {
    setActiveGuests(next);
    if (channelRef.current) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'seat_update',
        payload: { activeGuests: next, audioSlotCount },
      });
    }
  };

  const resizeGuestSeats = (seats, totalSlots) => {
    const nextGuestSlots = Math.max(1, Math.min(11, Number(totalSlots) - 1));
    const next = Array.isArray(seats) ? seats.slice(0, nextGuestSlots) : [];
    while (next.length < nextGuestSlots) next.push(null);
    return next;
  };

  const applyAudioSlotCount = (nextTotalSlots) => {
    const normalized = Math.max(2, Math.min(12, Number(nextTotalSlots) || 8));
    const resizedSeats = resizeGuestSeats(activeGuestsRef.current, normalized);
    setAudioSlotCount(normalized);
    setSlotInput(String(normalized));
    setActiveGuests(resizedSeats);
    setLockedSeats(prev => prev.filter(i => i < normalized - 1));
    if (channelRef.current) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'seat_update',
        payload: { activeGuests: resizedSeats, audioSlotCount: normalized },
      });
    }
  };

  // Appoint / remove a room admin. Works from the seat menu AND the viewer
  // list, so the host can remove an admin any time — even after they leave
  // the mic seat. The admin list syncs to everyone via room_state.
  const toggleRoomAdmin = (u) => {
    if (!u?.id) return;
    const wasAdmin = roomAdmins.includes(u.id);
    setRoomAdmins(prev => wasAdmin ? prev.filter(i => i !== u.id) : [...prev, u.id]);
    if (channelRef.current) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'chat',
        payload: {
          id: `admin-${u.id}-${Date.now()}`,
          user: 'System',
          type: 'system',
          message: wasAdmin
            ? `${u.name} is no longer a room admin`
            : `${stream.broadcasterName} made ${u.name} a room admin 👑`,
          color: '#A855F7',
        },
      });
    }
  };

  // End-live workflow shared between the top-bar X confirm and any other
  // exit paths. Broadcasts the end event, marks the live row as ended,
  // then shows the host summary.
  //
  // Reward note: the OLD client-only "+300 diamonds" tier ladder
  // (mins>=30/60/120 → 100/300/1000 diamonds) lived here but never
  // actually wrote to the DB — it just bumped local state, vanished
  // on refresh, and confused hosts who thought they were paid in
  // diamonds. The REAL reward is server-side: migration 81's
  // live_stream_heartbeat grants 5,000 beans the moment a stream
  // crosses 60 minutes, atomically via live_streams.hour_reward_credited.
  // We read that flag back here so the summary shows the real
  // reward exactly when it actually landed in the wallet.
  const performEndLive = async () => {
    if (streamEndedRef.current) return;
    streamEndedRef.current = true;

    const diffSec = Math.floor((Date.now() - liveStartTime) / 1000);
    const mins = Math.floor(diffSec / 60);
    const secs = diffSec % 60;
    const durationStr = `${mins}m ${secs}s`;

    if (channelRef.current) {
      try {
        channelRef.current.send({
          type: 'broadcast',
          event: 'end_live',
          payload: { id: user?.id },
        });
      } catch (_) {}
    }

    setFinalSummaryData({
      duration: durationStr,
      gifts: totalGiftsReceived,
      diamonds: earnings,
      follows: sessionFollows,
      peakViewers,
      hourBeans: 0,
    });
    setShowSummary(true);

    if (streamRecordId) {
      try {
        const [, hourReadResult] = await Promise.all([
          endLiveStream(streamRecordId, peakViewers).catch((e) => {
            if (__DEV__) console.warn('broadcast cleanup:', e?.message);
            return null;
          }),
          supabase
            .from('live_streams')
            .select('hour_reward_credited')
            .eq('id', streamRecordId)
            .maybeSingle(),
        ]);
        if (hourReadResult?.data?.hour_reward_credited) {
          setFinalSummaryData((prev) => ({ ...prev, hourBeans: 5000 }));
        }
      } catch (_) {}
    }
  };

  const handleLeaveCall = () => {
    // Leave immediately — no confirmation, no toast. Sync the ref first so
    // the self-echo of our own seat update doesn't trip the "removed by
    // host" alert.
    callStatusRef.current = 'idle';
    setCallRequestStatus('idle');
    setIsSelfMuted(false);
    setForcedMuted(false);
    // Local-only state flip so this device sees the seat free instantly.
    setActiveGuests(prev => prev.map(g => (g && g.id === user?.id) ? null : g));
    // Broadcast a TARGETED seat_leave (just our guestId) instead of the
    // full activeGuests array. The full-array path used to race against
    // the host's promote-new-guest seat_update: if a guest left mid-promote,
    // the guest's stale view would arrive after the host's authoritative
    // one and wipe the newly seated guest from every viewer's screen.
    // The seat_leave handler already updates just the leaving slot, so
    // promotes and leaves can no longer collide.
    if (channelRef.current) {
      try {
        channelRef.current.send({
          type: 'broadcast',
          event: 'seat_leave',
          payload: { guestId: user?.id },
        });
      } catch (e) { if (__DEV__) console.warn('broadcast cleanup:', e?.message); }
    }
    // Stop publishing (back to audience)
    agora.setPublishing(false);
  };

  // ----- REAL-TIME ECONOMY LOGIC & TOAST -----
  const showFloatingToast = (gift, latestCount, recipientNames = [], senderName = null, senderAvatar = null) => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);

    const recipientLabel = recipientNames.length === 0 ? 'the Host' :
      recipientNames.length > 2 ? `${recipientNames.length} recipients` :
        recipientNames.join(' & ');

    setGiftToast({
      ...gift,
      user: senderName || user?.name || 'You',
      senderAvatar: senderAvatar || user?.avatar,
      count: latestCount,
      target: recipientLabel,
    });

    // Slide In smoothly. The toast container is now pinned to both
    // left + right (left:12, right:12 in styles), so translateX only
    // animates the slide motion — toValue 0 is the resting position.
    Animated.parallel([
      Animated.spring(toastAnimX, { toValue: 0, friction: 6, useNativeDriver: true }),
      Animated.timing(toastAnimOpacity, { toValue: 1, duration: 200, useNativeDriver: true })
    ]).start();

    toastTimeoutRef.current = setTimeout(() => {
      // Slide Out
      Animated.parallel([
        Animated.timing(toastAnimX, { toValue: -width, duration: 300, useNativeDriver: true }),
        Animated.timing(toastAnimOpacity, { toValue: 0, duration: 300, useNativeDriver: true })
      ]).start(() => setGiftToast(null));
    }, 3000);
  };

  const lastGiftTimeRef = useRef(0);
  // Throttle "please wait" toast so spam-tapping doesn't fire it on every
  // single rejected tap — once every 1.5s is enough for the user to see it.
  const lastWaitToastRef = useRef(0);
  // Diamonds already committed to in-flight gift RPCs that the profile
  // realtime UPDATE hasn't reflected yet. The pre-flight balance check
  // subtracts this so a user with 999💎 sending 500 + 500 back-to-back
  // doesn't see the second tap pass the local guard only to hit a server
  // "Insufficient diamonds" error 200ms later.
  const pendingSpendRef = useRef(0);
  const handleSendGift = async (gift, multiplier = 1) => {
    const now = Date.now();
    if (isProcessingGift || now - lastGiftTimeRef.current < 400) {
      // Surface the drop so the user knows the tap registered but was
      // rate-limited — old code silently swallowed every fast tap and
      // people thought their gift had been sent.
      if (now - lastWaitToastRef.current > 1500) {
        lastWaitToastRef.current = now;
        showCuteAlert('Please wait', 'Gifts can only be sent a few times per second.');
      }
      return;
    }
    lastGiftTimeRef.current = now;

    // Resolve recipients. When the SENDER is the host we drop the host
    // tile from "All" — they're not allowed to gift themselves through
    // a broadcast-to-all either.
    let targets = [];
    const activeOccupied = activeGuests.filter(g => g !== null);

    if (giftRecipients.includes('all')) {
      const hostTile = isHostView ? [] : [{ id: 'host', name: stream.broadcasterName }];
      targets = [...hostTile, ...activeOccupied];
    } else {
      if (giftRecipients.includes('host') && !isHostView) {
        targets.push({ id: 'host', name: stream.broadcasterName });
      }
      activeOccupied.forEach(g => {
        if (giftRecipients.includes(g.id)) targets.push(g);
      });
    }

    if (targets.length === 0) {
      showCuteAlert("No Recipient", "Please select at least one recipient to send the gift.");
      return;
    }

    const targetCount = targets.length;
    const perRecipientCost = gift.price * multiplier;
    const totalCost = perRecipientCost * targetCount;
    // The Live Goal tracks gifts sent to the HOST. Only the host's share of
    // this gift counts toward the goal (and gets broadcast so everyone's
    // goal bar stays in sync — host, sender and viewers).
    const hostIsTarget = targets.some(t => t.id === 'host');
    const hostValue = hostIsTarget ? perRecipientCost : 0;

    // Effective balance subtracts gifts that have already been sent but
    // for which the profile realtime UPDATE hasn't landed yet. Without
    // this subtraction, a user with 999💎 could pass the local check
    // twice for two 500💎 gifts (RPC takes ~150ms, throttle is 400ms),
    // then watch the second one fail with "Insufficient diamonds" on
    // the server. Now the second tap is rejected client-side with the
    // same friendly message we'd show for an actually-poor user.
    const effectiveDiamonds = myDiamonds - pendingSpendRef.current;
    if (effectiveDiamonds >= totalCost && totalCost >= 0) {
      // Resolve 'host' string -> actual broadcaster UUID
      const broadcasterId = stream.id;
      const resolvedTargets = targets.map(t => ({
        ...t,
        resolvedId: t.id === 'host' ? broadcasterId : t.id,
      })).filter((t) => {
        // Drop self-targets so a viewer who somehow ends up with themselves
        // in the recipient list (host opening their own picker, a guest
        // taking a seat and tapping their own tile) can't credit themselves.
        // The server-side migration 49 guard is the authoritative defence;
        // this is just so the UI doesn't show a fake "sent" state.
        return t.resolvedId && t.resolvedId !== user?.id;
      });

      if (resolvedTargets.length === 0) {
        showCuteAlert("Can't gift yourself", "Pick a guest on the seats or wait for the host to be someone else.");
        return;
      }

      // PROD-LEVEL: send one RPC per recipient. If any fails, stop.
      // Reserve the spend so a concurrent rapid second send doesn't
      // double-count. The release is in `finally` so an error path
      // doesn't leak the reservation forever.
      setIsProcessingGift(true);
      pendingSpendRef.current += totalCost;
      let anyFailed = false;
      try {
        for (const t of resolvedTargets) {
          if (!t.resolvedId) continue;
          const ok = await sendGiftSecurely(t.resolvedId, gift.id, perRecipientCost, {
            roomId: streamRecordId,
            giftName: gift.name,
            count: multiplier,
          });
          if (!ok) { anyFailed = true; break; }
        }
      } finally {
        // Release after a short grace window so the profile realtime
        // UPDATE has time to land — otherwise we'd briefly "double
        // refund" the user (myDiamonds dropped + pendingSpend dropped).
        setTimeout(() => { pendingSpendRef.current = Math.max(0, pendingSpendRef.current - totalCost); }, 350);
      }
      setIsProcessingGift(false);
      if (anyFailed) return;

      // Goal only counts the host's portion (matches what receivers add)
      setEarnings(prev => prev + hostValue);
      setTotalGiftsReceived(prev => prev + (multiplier * targetCount));
      // Refresh guardians since the sender may have just entered the top 3.
      // Debounced: a 100x combo only triggers one RPC after the burst.
      scheduleGuardianRefresh();

      // Optimistically bump the per-seat earnings badge for every
      // recipient. The 30s reconcile pass will overwrite this with the
      // authoritative DB total, so a transient discrepancy (e.g. a
      // failed RPC we didn't catch) self-heals.
      setSeatEarnings((prev) => {
        const next = { ...prev };
        resolvedTargets.forEach((t) => {
          if (!t.resolvedId) return;
          next[t.resolvedId] = (next[t.resolvedId] || 0) + perRecipientCost;
        });
        return next;
      });

      let newCount = multiplier;
      if (combo.active && combo.giftId === gift.id) {
        newCount = combo.count + multiplier;
        setCombo({ active: true, count: newCount, giftId: gift.id });
      } else {
        setCombo({ active: true, count: multiplier, giftId: gift.id });
      }

      comboAnim.setValue(1.5);
      Animated.spring(comboAnim, { toValue: 1, friction: 3, tension: 100, useNativeDriver: true }).start();

      const recipientNames = targets.map(t => t.name);
      showFloatingToast(gift, newCount, recipientNames);

      const animId = `anim-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
      setActiveGiftAnimation({ id: animId, source: gift.source, loop: gift.loop || false });
      // Fire the gift SFX in parallel with the Lottie overlay. Safe to call
      // even when the gift has no sound configured — the manager returns
      // silently. Done locally only here; remote viewers play their own
      // SFX when the broadcast message arrives (see the gift-message
      // handler in the channel listener).
      playGiftSound(gift);

      if (lottieTimeoutRef.current) clearTimeout(lottieTimeoutRef.current);
      if (gift.loop || gift.customDuration || multiplier > 1) {
        lottieTimeoutRef.current = setTimeout(() => {
          setActiveGiftAnimation((prev) => prev.id === animId ? { id: null, source: null, loop: false } : prev);
        }, multiplier > 1 ? 4000 : (gift.customDuration || 3000));
      }

      if (comboTimeoutRef.current) clearTimeout(comboTimeoutRef.current);
      comboTimeoutRef.current = setTimeout(() => {
        setCombo({ active: false, count: 0, giftId: null });
      }, 3000);

      const targetText = targetCount > 2 ? `${targetCount} people` : recipientNames.join(', ');
      const giftMessage = {
        id: 'gift-' + Date.now().toString() + '-' + Math.random().toString(36).substring(2, 7),
        user: user?.name || 'User',
        type: 'gift',
        giftName: gift.name,
        multiplier,
        target: targetText,
        // Plain-text fallback (kept so older listeners / logs still read sensibly)
        message: `${user?.name || 'User'} sent ${multiplier > 1 ? multiplier + 'x ' : ''}${gift.name} to ${targetText} 🎁`,
        color: '#F472B6'
      };

      if (channelRef.current) {
        channelRef.current.send({
          type: 'broadcast',
          event: 'gift',
          payload: {
            userId: user?.id,
            userName: user?.name,
            userAvatar: user?.avatar,
            giftId: gift.id,
            name: gift.name,
            count: newCount,
            target: targetText,
            hostValue, // host-bound diamonds for Live Goal sync
            // Per-recipient diamonds — receivers use this to bump
            // the per-seat earnings badge in real time without
            // waiting for the next 30s reconcile.
            receivers: resolvedTargets
              .filter((t) => !!t.resolvedId)
              .map((t) => ({ id: t.resolvedId, diamonds: perRecipientCost })),
          }
        });

        channelRef.current.send({
          type: 'broadcast',
          event: 'chat',
          payload: giftMessage
        });
        // Cross-live notification: if this is a "meaningful" gift
        // (totalCost ≥ 500 💎), fan out to the global channel so
        // every other live room's chat shows a tap-to-join row.
        if (globalEventsChannelRef.current && totalCost >= 500) {
          try {
            globalEventsChannelRef.current.send({
              type: 'broadcast',
              event: 'gift_in_live',
              payload: {
                roomId: id,
                mode,
                type,
                hostId: stream?.broadcasterId,
                hostName: stream?.broadcasterName,
                hostAvatar: stream?.coverUrl,
                senderName: user?.name,
                giftName: gift.name,
                count: newCount,
                totalCost,
              },
            });
          } catch (_) {}
        }
      }
    } else {
      setShowGiftMenu(false);
      setShowTopUpModal(true);
    }
  };

  const renderFloatingGiftToast = () => {
    if (!giftToast) return null;
    return (
      <Animated.View pointerEvents="none" style={[styles.giftToastContainer, { transform: [{ translateX: toastAnimX }], opacity: toastAnimOpacity }]}>
        <LinearGradient colors={[`${BRAND.primary}E6`, 'rgba(56,189,248,0.8)']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.giftToastGradient}>
          <View style={styles.giftToastLeft}>
            <Image
              source={{ uri: giftToast.senderAvatar || user?.avatar || 'https://picsum.photos/seed/you/50/50' }}
              style={styles.giftToastAvatar}
            />
            <View style={{ flex: 1, marginRight: 8 }}>
              <Text style={styles.giftToastUser} numberOfLines={1} ellipsizeMode="tail">
                {giftToast.user}
              </Text>
              <Text style={styles.giftToastAction} numberOfLines={1} ellipsizeMode="tail">
                Sent {giftToast.name} to {giftToast.target}
              </Text>
            </View>
          </View>
          <View style={styles.giftToastRight}>
            <LottieView source={giftToast.source} autoPlay loop style={styles.giftToastLottie} />
            <Animated.Text style={[styles.giftToastCombo, { transform: [{ scale: comboAnim }] }]}>
              X{giftToast.count}
            </Animated.Text>
          </View>
        </LinearGradient>
      </Animated.View>
    );
  };

  const renderLiveGoal = () => {
    const progress = Math.min((earnings / liveGoal) * 100, 100);
    return (
      <View style={[
        styles.liveGoalContainer,
        isAudio && styles.audioLiveGoalContainer,
        { top: insets.top + (isAudio ? 198 : (isHostView ? 105 : 60)) },
      ]}>
        <View style={styles.liveGoalHeader}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {isAudio && (
              <View style={styles.audioGoalIcon}>
                <Ionicons name="flame" size={18} color="#FFD134" />
              </View>
            )}
            <Text style={[styles.liveGoalTitle, isAudio && styles.audioGoalTitle]}>Live Goal</Text>
            {isHostView && (
              <TouchableOpacity
                onPress={() => { setTempGoal(liveGoal.toString()); setShowGoalModal(true); }}
                style={{ marginLeft: 6, padding: 2 }}
              >
                <Ionicons name="pencil" size={14} color="rgba(255,255,255,0.7)" />
              </TouchableOpacity>
            )}
          </View>
          <Text style={[styles.liveGoalStats, isAudio && styles.audioGoalStats]}>{earnings}/{liveGoal}</Text>
        </View>
        {isAudio && (
          <Text style={styles.audioGoalCompleted}>{Math.round(progress)}% Completed</Text>
        )}
        <View style={styles.liveGoalBgBar}>
          <LinearGradient
            colors={['#FFD700', '#FFA500']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={[styles.liveGoalProgressBar, { width: `${progress}%` }]}
          />
        </View>
      </View>
    );
  };

  const renderGoalSettingsModal = () => (
    <Modal visible={showGoalModal} transparent animationType="fade" onRequestClose={() => setShowGoalModal(false)}>
      <View style={styles.modalOverlay}>
        <View style={styles.goalSettingsCard}>
          <TouchableOpacity
            style={{ position: 'absolute', top: 10, right: 10, zIndex: 10, padding: 6 }}
            onPress={() => setShowGoalModal(false)}
          >
            <Ionicons name="close" size={22} color="rgba(255,255,255,0.5)" />
          </TouchableOpacity>
          <Text style={styles.goalModalTitle}>Update Live Goal</Text>
          <Text style={styles.goalModalSubtitle}>Set your diamond target for this session</Text>

          <TextInput
            style={styles.goalInput}
            value={tempGoal}
            onChangeText={setTempGoal}
            keyboardType="numeric"
            placeholder="Enter target amount"
            placeholderTextColor="rgba(255,255,255,0.3)"
          />

          <View style={styles.goalPresets}>
            {[500, 1000, 5000].map(val => (
              <TouchableOpacity key={val} style={styles.presetBtn} onPress={() => setTempGoal(val.toString())}>
                <Text style={styles.presetText}>{val}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            style={styles.saveGoalBtn}
            disabled={!showGoalModal}
            onPress={() => {
              // Double-submit guard. Without disabled+guard, a fast
              // double-tap would fire two setLiveGoal + setShowGoalModal
              // pairs and trigger the room_state broadcast twice.
              if (!showGoalModal) return;
              const newGoal = parseInt(tempGoal, 10);
              if (!Number.isFinite(newGoal) || newGoal < 100) {
                showCuteAlert("Invalid Goal", "Minimum goal target is 100 Diamonds.");
                return;
              }
              setShowGoalModal(false);   // close first so the second tap is a no-op
              setLiveGoal(newGoal);
            }}
          >
            <LinearGradient colors={[BRAND.primary, BRAND.primaryAlt]} style={styles.saveGoalGradient}>
              <Text style={styles.saveGoalText}>Save Target</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );

  const renderSFXMenu = () => (
    <View style={styles.sfxOverlay}>
      <View style={styles.sfxCard}>
        <Text style={styles.sfxTitle}>Sound Effects</Text>
        <View style={styles.sfxGrid}>
          {[
            { icon: '👏', name: 'Clap' },
            { icon: '😂', name: 'Laugh' },
            { icon: '🎉', name: 'Surprise' },
            { icon: 'Drum', name: 'Drum' }
          ].map((sfx, i) => (
            <TouchableOpacity
              key={i}
              style={styles.sfxItem}
              onPress={() => {
                triggerSFX(sfx.name);
                setShowSFXMenu(false);
              }}
            >
              <Text style={styles.sfxIcon}>{sfx.icon === 'Drum' ? '🥁' : sfx.icon}</Text>
              <Text style={styles.sfxName}>{sfx.name}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity style={styles.sfxClose} onPress={() => setShowSFXMenu(false)}>
          <Ionicons name="close" size={20} color="#FFF" />
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderGiftBottomSheet = () => {
    const filteredGifts = GIFT_ITEMS.filter(item => item.category === activeGiftTab);

    return (
      <Modal
        animationType="slide"
        transparent={true}
        visible={showGiftMenu}
        onRequestClose={() => setShowGiftMenu(false)}
      >
        <View style={styles.giftModalOverlay}>
          {/* Modal height is clamped responsively:
              - phones: ~58% of screen so the live tile underneath still peeks
              - small phones (<360w): drops to 62% so all rows can scroll
              - tablets / very tall phones: capped at 540 so it never feels
                cavernous. The grid is a FlatList — it scrolls inside.        */}
          <View style={[
            styles.giftModalContent,
            {
              paddingBottom: insets.bottom + 10,
              // Tighter bottom-sheet — small phones get a touch more
              // room so the grid + balance bar fit; everyone else gets
              // ~50% so the live tile behind still breathes.
              height: Math.min(width < 360 ? height * 0.55 : height * 0.50, 480),
            },
          ]}>
            {/* Drag handle — visual cue this sheet is dismissible */}
            <View style={styles.giftDragHandle} />

            {/* Header & Tabs — tabs scroll horizontally so >4 categories
                still fit on small phones without wrapping. */}
            <View style={styles.giftHeader}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.giftTabs}
                style={{ flex: 1 }}
              >
                {GIFT_CATEGORIES.map(cat => (
                  <TouchableOpacity
                    key={cat}
                    style={[styles.giftTabItem, activeGiftTab === cat && styles.giftTabItemActive]}
                    onPress={() => setActiveGiftTab(cat)}
                  >
                    <Text style={[styles.giftTabText, activeGiftTab === cat && styles.giftTabTextActive]}>{cat}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <TouchableOpacity onPress={() => setShowGiftMenu(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close-circle" size={22} color="rgba(255,255,255,0.5)" />
              </TouchableOpacity>
            </View>

            {/* Recipient Selector */}
            <View style={styles.recipientSelector}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recipientScroll}>
                <TouchableOpacity
                  style={[styles.recipientItem, giftRecipients.includes('all') && styles.recipientActive]}
                  onPress={() => setGiftRecipients(['all'])}
                >
                  <View style={styles.recipientIconAll}>
                    <Ionicons name="people" size={18} color="#FFF" />
                  </View>
                  <Text style={styles.recipientName}>All</Text>
                </TouchableOpacity>

                {/* "Host" tile is hidden from the host's own picker so they
                    can't pick themselves. Viewers + seated guests can still
                    select the host as a recipient. */}
                {!isHostView && (
                  <TouchableOpacity
                    style={[styles.recipientItem, giftRecipients.includes('host') && !giftRecipients.includes('all') && styles.recipientActive]}
                    onPress={() => setGiftRecipients(prev => prev.includes('all') ? ['host'] : (prev.includes('host') ? prev.filter(i => i !== 'host') : [...prev, 'host']))}
                  >
                    <Image source={{ uri: stream.coverUrl }} style={styles.recipientAvatar} />
                    <Text style={styles.recipientName} numberOfLines={1}>Host</Text>
                  </TouchableOpacity>
                )}

                {activeGuests.map((guest, idx) => {
                  if (!guest) return null;
                  const isSelected = giftRecipients.includes(guest.id) && !giftRecipients.includes('all');
                  return (
                    <TouchableOpacity
                      key={guest.id}
                      style={[styles.recipientItem, isSelected && styles.recipientActive]}
                      onPress={() => setGiftRecipients(prev => {
                        let base = prev.includes('all') ? [] : prev;
                        return base.includes(guest.id) ? base.filter(i => i !== guest.id) : [...base, guest.id];
                      })}
                    >
                      <Image source={{ uri: guest.avatar }} style={styles.recipientAvatar} />
                      <Text style={styles.recipientName} numberOfLines={1}>{guest.name}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>

            {/* Grid of Gifts — virtualised so only a couple of rows of Lottie
                animations are mounted at once. On a budget Android phone the
                old "render-all" path span up 20+ concurrent Lotties and
                thermal-throttled the GPU. */}
            <FlatList
              data={filteredGifts}
              numColumns={GIFT_NUM_COLS}
              keyExtractor={item => item.id}
              showsVerticalScrollIndicator={false}
              columnWrapperStyle={styles.giftGridRow}
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingBottom: 6 }}
              removeClippedSubviews
              initialNumToRender={8}
              maxToRenderPerBatch={8}
              windowSize={3}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.giftItemCard, combo.giftId === item.id && { backgroundColor: BRAND.primary10 }]}
                  // Tap = select only. The actual send happens when the
                  // user presses the "Send" button at the bottom. Users
                  // were complaining gifts went out the moment they
                  // touched one — that's the wrong commit gesture for a
                  // currency-spending action. We mark this item as the
                  // selected one (the bottom button reads combo.giftId).
                  // If they tap a DIFFERENT gift mid-combo, clear the
                  // chain state too — otherwise the count from the
                  // previous gift's chain would leak into the next
                  // gift's first send. Same-gift tap is a no-op.
                  onPress={() => setCombo((prev) =>
                    prev.giftId === item.id ? prev : { active: false, count: 0, giftId: item.id }
                  )}
                >
                  <View style={styles.giftIconPlaceholder}>
                    {/* Pause the grid's Lottie loops while a full-screen
                        gift overlay is playing. Both layers animating at
                        the same time was a measurable GPU spike on budget
                        Androids — pausing the grid for the ~2-3s the
                        overlay lasts cuts that spike entirely. */}
                    <LottieView
                      source={item.source}
                      autoPlay={!activeGiftAnimation?.source}
                      loop={!activeGiftAnimation?.source}
                      style={{ width: GIFT_LOTTIE, height: GIFT_LOTTIE }}
                    />
                  </View>
                  <Text style={styles.giftName} numberOfLines={1}>{item.name}</Text>
                  <View style={styles.giftPriceRow}>
                    <Ionicons name="diamond" size={10} color="#FBBF24" />
                    <Text style={styles.giftPrice}>{item.price}</Text>
                  </View>
                </TouchableOpacity>
              )}
            />

            {/* Bulk Send Selector */}
            <View style={styles.bulkSendRow}>
              <Text style={styles.bulkLabel}>Bulk Send:</Text>
              <View style={styles.bulkOptions}>
                {[1, 10, 100].map(val => (
                  <TouchableOpacity
                    key={val}
                    style={[styles.bulkBtn, giftMultiplier === val && styles.bulkBtnActive]}
                    onPress={() => setGiftMultiplier(val)}
                  >
                    <Text style={[styles.bulkBtnText, giftMultiplier === val && styles.bulkBtnTextActive]}>{val}x</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Bottom Balance & Topup Bar */}
            <View style={styles.balanceBar}>
              <View style={styles.balanceInfo}>
                <Text style={styles.balanceLabel}>My Diamonds</Text>
                <View style={styles.giftPriceRow}>
                  <Ionicons name="diamond" size={14} color="#FBBF24" />
                  <Text style={styles.balanceAmount}>{myDiamonds}</Text>
                </View>
              </View>
              <TouchableOpacity style={styles.sendGiftBtn} onPress={() => {
                // Resolve the gift to send: prefer the user's combo selection,
                // fall back to the first gift in the current category tab,
                // then any gift at all. If GIFT_ITEMS is empty entirely
                // (cold start before DB hydration) just close the menu —
                // sending `undefined` would crash handleSendGift downstream.
                const selected = GIFT_ITEMS.find(g => g.id === combo.giftId)
                  || filteredGifts[0]
                  || GIFT_ITEMS[0];
                if (!selected) {
                  setShowGiftMenu(false);
                  return;
                }
                handleSendGift(selected, giftMultiplier);
                setShowGiftMenu(false);
                setGiftMultiplier(1);
              }}>
                <LinearGradient colors={[BRAND.primary, BRAND.primaryAlt]} style={styles.sendGiftGradient}>
                  <Text style={styles.sendGiftText}>Send {giftMultiplier > 1 ? `${giftMultiplier}x` : ''}</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  const renderPremiumAdminModal = () => {
    if (!targetGuest) return null;
    const isMuted = mutedGuests.includes(targetGuest.id);
    const isAdmin = roomAdmins.includes(targetGuest.id);

    return (
      <Modal visible={showAdminMenu} transparent animationType="slide" onRequestClose={() => setShowAdminMenu(false)}>
        <View style={styles.giftModalOverlay}>
          <View style={[styles.premiumAdminCard, { paddingBottom: insets.bottom + 20 }]}>
            {/* Card Handle */}
            <View style={styles.modalHandle} />

            <View style={styles.adminHeader}>
              <View style={styles.adminAvatarWrapper}>
                <Image source={{ uri: targetGuest.avatar }} style={styles.adminAvatarLarge} />
                {isMuted && (
                  <View style={styles.adminMuteBadge}>
                    <Ionicons name="mic-off" size={16} color="#FFF" />
                  </View>
                )}
              </View>
              <Text style={styles.adminGuestName}>{targetGuest.name}</Text>
              {/* targetGuest comes from activeGuests / presence — both
                  now carry displayId after the channel.track() fix. The
                  old code rendered targetGuest.id (the UUID) directly
                  and used a hardcoded "102938" mock as fallback, which
                  obviously isn't a real user ID. */}
              <Text style={styles.adminGuestId}>ID: {targetGuest.displayId || '—'}</Text>
            </View>

            <View style={styles.adminActionGrid}>
              <TouchableOpacity
                style={styles.adminActionItem}
                onPress={() => {
                  const nextMuted = !isMuted;
                  setMutedGuests(prev => nextMuted ? [...prev, targetGuest.id] : prev.filter(id => id !== targetGuest.id));
                  // Broadcast so the guest is actually muted and everyone sees it.
                  if (channelRef.current) {
                    channelRef.current.send({
                      type: 'broadcast',
                      event: 'force_mute',
                      payload: { guestId: targetGuest.id, muted: nextMuted },
                    });
                  }
                  setShowAdminMenu(false);
                }}
              >
                <LinearGradient colors={['#FBBF24', '#D97706']} style={styles.adminActionIconBox}>
                  <Ionicons name={isMuted ? "mic-off" : "mic"} size={26} color="#FFF" />
                </LinearGradient>
                <Text style={styles.adminActionText}>{isMuted ? 'Unmute' : 'Mute'}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.adminActionItem}
                onPress={() => {
                  // Room admins (non-host) cannot remove VIP / VVIP members.
                  if (!isHostView && ['VIP', 'VVIP'].includes(targetGuest.vipType)) {
                    setShowAdminMenu(false);
                    showCuteAlert('Not allowed', 'Room admins cannot remove VIP / VVIP members.');
                    return;
                  }
                  applySeats(activeGuests.map(g => (g && g.id === targetGuest.id) ? null : g));
                  setShowAdminMenu(false);
                  showCuteAlert("User Kicked", `${targetGuest.name} has been removed from the session.`);
                }}
              >
                <LinearGradient colors={['#F97316', '#C2410C']} style={styles.adminActionIconBox}>
                  <Ionicons name="exit-outline" size={26} color="#FFF" />
                </LinearGradient>
                <Text style={styles.adminActionText}>Kick Out</Text>
              </TouchableOpacity>

              {/* Appointing admins is host-only */}
              {isHostView && targetGuest?.id !== user?.id && (
                <TouchableOpacity
                  style={styles.adminActionItem}
                  onPress={() => {
                    toggleRoomAdmin(targetGuest);
                    setShowAdminMenu(false);
                  }}
                >
                  <LinearGradient colors={isAdmin ? ['#6B7280', '#4B5563'] : ['#A855F7', '#7E22CE']} style={styles.adminActionIconBox}>
                    <Ionicons name={isAdmin ? "star-outline" : "star"} size={26} color="#FFF" />
                  </LinearGradient>
                  <Text style={styles.adminActionText}>{isAdmin ? 'Remove Admin' : 'Make Admin'}</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={[styles.adminActionGrid, { marginTop: 15 }]}>
              {/* Permanent block is host-only — persists in DB across sessions */}
              {isHostView && targetGuest?.id !== user?.id && (
                <TouchableOpacity
                  style={styles.adminActionItem}
                  onPress={async () => {
                    const { error } = await supabase.rpc('room_block_user', {
                      target: targetGuest.id,
                      reason: 'Blocked from room',
                    });
                    if (error) {
                      showCuteAlert('Block failed', error.message);
                      return;
                    }
                    setBlockedUsers(prev => prev.includes(targetGuest.id) ? prev : [...prev, targetGuest.id]);
                    applySeats(activeGuests.map(g => (g && g.id === targetGuest.id) ? null : g));
                    setShowAdminMenu(false);
                    showCuteAlert("Blocked", `${targetGuest.name} has been permanently blocked from this room.`);
                  }}
                >
                  <LinearGradient colors={['#EF4444', '#B91C1C']} style={styles.adminActionIconBox}>
                    <Ionicons name="shield-half" size={26} color="#FFF" />
                  </LinearGradient>
                  <Text style={styles.adminActionText}>Block</Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity
                style={styles.adminActionItem}
                onPress={() => {
                  const gid = targetGuest?.id;
                  setShowAdminMenu(false);
                  if (gid) router.push(`/main/user/${gid}`);
                }}
              >
                <LinearGradient colors={['#38BDF8', '#0EA5E9']} style={styles.adminActionIconBox}>
                  <Ionicons name="person" size={26} color="#FFF" />
                </LinearGradient>
                <Text style={styles.adminActionText}>Profile</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.adminActionItem} onPress={() => setShowAdminMenu(false)}>
                <LinearGradient colors={['rgba(255,255,255,0.1)', 'rgba(255,255,255,0.05)']} style={styles.adminActionIconBox}>
                  <Ionicons name="close" size={26} color="#FFF" />
                </LinearGradient>
                <Text style={styles.adminActionText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  const renderTopUpModal = () => (
    <Modal animationType="fade" transparent={true} visible={showTopUpModal} onRequestClose={() => setShowTopUpModal(false)}>
      <View style={styles.modalOverlay}>
        <View style={styles.topUpModalCard}>
          <Ionicons name="wallet" size={40} color={BRAND.primary} style={{ marginBottom: 8 }} />
          <Text style={styles.topUpTitle}>Out of Diamonds</Text>
          <Text style={styles.topUpBalance}>Balance: {myDiamonds} 💎</Text>
          <Text style={{ color: '#9CA3AF', fontSize: 13, textAlign: 'center', marginVertical: 12, paddingHorizontal: 20, lineHeight: 18 }}>
            Buy diamonds from a Reseller or Agency to keep sending gifts.
          </Text>

          <TouchableOpacity
            style={{ width: '85%', marginTop: 8 }}
            onPress={() => {
              setShowTopUpModal(false);
              router.push('/main/wallet');
            }}
          >
            <LinearGradient
              colors={[BRAND.primary, BRAND.primaryAlt]}
              style={{ paddingVertical: 14, borderRadius: 12, alignItems: 'center' }}
            >
              <Text style={{ color: '#FFF', fontWeight: 'bold', fontSize: 15 }}>Open Wallet</Text>
            </LinearGradient>
          </TouchableOpacity>

          <TouchableOpacity style={styles.modalCloseBtn} onPress={() => setShowTopUpModal(false)}>
            <Text style={styles.modalCloseText}>Maybe Later</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );

  const renderManageCallsModal = () => (
    <Modal animationType="slide" transparent={true} visible={showManageCalls} onRequestClose={() => setShowManageCalls(false)}>
      <View style={styles.giftModalOverlay}>
        <View style={[
          styles.giftModalContent,
          {
            paddingBottom: insets.bottom + 16,
            // Same compact bottom-sheet sizing as the gift menu so all
            // three host sheets feel like a single design language.
            height: Math.min(width < 360 ? height * 0.55 : height * 0.50, 480),
          },
        ]}>
          <View style={[styles.giftHeader, { borderBottomWidth: 0 }]}>
            <View style={styles.giftTabs}>
              <TouchableOpacity
                style={[styles.giftTabItem, !showViewerList && styles.giftTabItemActive]}
                onPress={() => setShowViewerList(false)}
              >
                <Text style={[styles.giftTabText, !showViewerList && styles.giftTabTextActive]}>Requests ({pendingRequests.length})</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.giftTabItem, showViewerList && styles.giftTabItemActive]}
                onPress={() => setShowViewerList(true)}
              >
                <Text style={[styles.giftTabText, showViewerList && styles.giftTabTextActive]}>Invite Friends</Text>{/* lazy-load handler below in effect */}
              </TouchableOpacity>
            </View>
          </View>

          {!showViewerList ? (
            <FlatList
              data={pendingRequests}
              keyExtractor={item => item.id}
              contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 10 }}
              ListEmptyComponent={<Text style={{ color: 'rgba(255,255,255,0.4)', textAlign: 'center', marginTop: 40 }}>No pending requests</Text>}
              renderItem={({ item }) => (
                <View style={styles.requestItem}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Image source={{ uri: item.avatar }} style={styles.requestAvatar} />
                    <Text style={styles.requestName} numberOfLines={1} ellipsizeMode="tail">{item.name}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <TouchableOpacity
                      style={[styles.requestActionBtn, { backgroundColor: '#4ADE80' }]}
                      onPress={() => {
                        // Video live caps at 3 guests (4 on-screen with host).
                        // Audio live uses the host-configured slot count.
                        const maxGuests = isAudio ? activeGuests.length : 3;
                        const occupiedCount = activeGuests.filter(g => g !== null).length;
                        if (occupiedCount >= maxGuests) {
                          showCuteAlert('Seats Full', `Max ${maxGuests} guests allowed. Remove someone first.`);
                          return;
                        }
                        const firstEmpty = activeGuests.findIndex(g => g === null);
                        if (firstEmpty !== -1) {
                          const newSeats = [...activeGuests];
                          newSeats[firstEmpty] = item;
                          setActiveGuests(newSeats);
                          setPendingRequests(prev => prev.filter(r => r.id !== item.id));

                          // Broadcast acceptance
                          if (channelRef.current) {
                            channelRef.current.send({
                              type: 'broadcast',
                              event: 'call_accepted',
                              payload: {
                                guestId: item.id,
                                seatIdx: firstEmpty,
                                activeGuests: newSeats,
                                audioSlotCount,
                              }
                            });
                          }
                        } else {
                          showCuteAlert("All Seats Filled", "Please remove someone before adding a new guest.");
                        }
                      }}
                    >
                      <Text style={styles.requestActionText}>Accept</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.requestActionBtn, { backgroundColor: 'rgba(255,255,255,0.1)' }]}
                      onPress={() => setPendingRequests(prev => prev.filter(r => r.id !== item.id))}
                    >
                      <Text style={styles.requestActionText}>Decline</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            />
          ) : (
            <FlatList
              data={inviteFriends || []}
              keyExtractor={item => item.id}
              contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 10 }}
              ListEmptyComponent={
                loadingInviteFriends ? (
                  <Text style={{ color: 'rgba(255,255,255,0.4)', textAlign: 'center', marginTop: 40 }}>Loading…</Text>
                ) : (
                  <Text style={{ color: 'rgba(255,255,255,0.4)', textAlign: 'center', marginTop: 40 }}>
                    Mutual follows show up here. Tap profiles to follow more people.
                  </Text>
                )
              }
              renderItem={({ item }) => (
                <View style={styles.requestItem}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Image source={{ uri: item.avatar }} style={styles.requestAvatar} />
                    <Text style={styles.requestName} numberOfLines={1} ellipsizeMode="tail">{item.name}</Text>
                  </View>
                  <TouchableOpacity
                    style={[styles.inviteBtn, activeGuests.find(g => g && g.id === item.id) && { opacity: 0.5 }]}
                    disabled={!!activeGuests.find(g => g && g.id === item.id)}
                    onPress={() => {
                      const isAlreadyIn = activeGuests.find(g => g && g.id === item.id);
                      if (!isAlreadyIn) {
                        showCuteAlert("Invitation Sent", `You invited ${item.name} to join your live.`);
                      }
                    }}
                  >
                    <Text style={styles.inviteBtnText}>{activeGuests.find(g => g && g.id === item.id) ? 'Active' : 'Invite'}</Text>
                  </TouchableOpacity>
                </View>
              )}
            />
          )}
        </View>
      </View>
    </Modal>
  );

  const renderViewersListModal = () => {
    const viewerList = isAudio ? getAudioVisitors() : roomViewers;
    return (
      <Modal animationType="slide" transparent={true} visible={showViewersModal} onRequestClose={() => setShowViewersModal(false)}>
        <View style={styles.giftModalOverlay}>
          <View style={[styles.giftModalContent, { height: height * 0.65, paddingBottom: insets.bottom + 10 }]}>
            <View style={styles.modalHandle} />
            <View style={[styles.giftHeader, { borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)', paddingBottom: 15 }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={[styles.giftTitle, { color: '#FFF' }]}>{isAudio ? 'Visitors' : 'Live Viewers'}</Text>
                <View style={styles.viewerCountTag}>
                  <Text style={styles.viewerCountTagText}>{viewerList.length}</Text>
                </View>
              </View>
              <TouchableOpacity onPress={() => setShowViewersModal(false)}>
                <Ionicons name="close-circle" size={26} color="rgba(255,255,255,0.4)" />
              </TouchableOpacity>
            </View>

          <FlatList
            data={viewerList}
            keyExtractor={(item, idx) => item.id ?? String(idx)}
            contentContainerStyle={{ paddingHorizontal: 15, paddingTop: 10 }}
            ListEmptyComponent={
              <Text style={{ color: '#9CA3AF', textAlign: 'center', marginTop: 40 }}>
                {isAudio ? 'No visitors watching from outside the slots yet.' : 'No viewers in the room yet.'}
              </Text>
            }
            renderItem={({ item }) => (
                  <TouchableOpacity style={styles.viewerItem} onPress={() => openProfilePopup(item)}>
                <View style={styles.viewerItemLeft}>
                  <View style={styles.viewerAvatarWrapper}>
                    {item.isVIP ? (
                      <VipAvatar
                        uri={item.avatar}
                        vipType={item.vipType || 'VIP'}
                        size={44}
                        bgColor="#1E1A34"
                      />
                    ) : (
                      <Image source={{ uri: item.avatar }} style={styles.viewerAvatarMini} />
                    )}
                    {profileFrameSourceFor(item) && (
                      <Image source={profileFrameSourceFor(item)} style={styles.viewerProfileFrameMini} resizeMode="contain" pointerEvents="none" />
                    )}
                  </View>
                  <View style={{ marginLeft: 12 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      {/* Top-3 gifter crown — was missing from this list per the audit */}
                      {guardianIds.includes(item.id) && (
                        <Text style={{ color: '#A855F7', fontSize: 13, fontWeight: 'bold', marginRight: 4 }}>♛</Text>
                      )}
                      <Text style={styles.viewerNameText} numberOfLines={1} ellipsizeMode="tail">{item.name}</Text>
                      {roomAdmins.includes(item.id) && (
                        <View style={styles.adminTagMini}>
                          <Ionicons name="star" size={9} color="#1E1B4B" />
                          <Text style={styles.adminTagMiniText}>Admin</Text>
                        </View>
                      )}
                      <View style={[styles.levelBadgeMini, { backgroundColor: (item.level || 0) > 50 ? '#FBBF24' : '#38BDF8' }]}>
                        <Text style={styles.levelBadgeText}>Lv.{item.level || 1}</Text>
                      </View>
                    </View>
                    <Text style={styles.viewerIdText}>ID: {item.displayId || item.display_id || '—'}</Text>
                    {item.coins != null && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                        <Ionicons name="diamond" size={10} color="#FBBF24" />
                        <Text style={styles.viewerCoinsText}>{item.coins}</Text>
                      </View>
                    )}
                  </View>
                </View>
                {item.id !== user?.id && (() => {
                  const isFollowed = followedIds.has(item.id);
                  const busy = followBusyId === item.id;
                  return (
                    <TouchableOpacity
                      style={[
                        styles.viewerFollowBtn,
                        isFollowed && styles.viewerFollowBtnDone,
                        busy && { opacity: 0.5 },
                      ]}
                      onPress={() => toggleFollowFromList(item.id, item.name)}
                      disabled={busy}
                    >
                      {isFollowed && (
                        <Ionicons name="checkmark" size={12} color="#4ADE80" style={{ marginRight: 4 }} />
                      )}
                      <Text style={[
                        styles.viewerFollowText,
                        isFollowed && { color: '#4ADE80' },
                      ]}>
                        {isFollowed ? 'Following' : 'Follow'}
                      </Text>
                    </TouchableOpacity>
                  );
                })()}
              </TouchableOpacity>
            )}
          />
        </View>
      </View>
    </Modal>
    );
  };

  const renderViewerProfileModal = () => {
    if (!selectedViewer) return null;
    const countryFlag = flagFor(selectedViewer.country);
    const isSelfProfile = selectedViewer.id === user?.id;
    const isFollowingProfile = !!selectedViewer.following || followedIds.has(selectedViewer.id);
    return (
      <Modal animationType="fade" transparent={true} visible={!!selectedViewer} onRequestClose={() => setSelectedViewer(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.viewerProfileCard}>
            <View style={styles.cardGlowOverlay} />
            <Text pointerEvents="none" style={[styles.profileDecorStar, styles.profileDecorStarLeft]}>★</Text>
            <Text pointerEvents="none" style={[styles.profileDecorStar, styles.profileDecorStarRight]}>✦</Text>
            <Text pointerEvents="none" style={[styles.profileDecorHeart]}>♥</Text>
            <TouchableOpacity style={styles.cardCloseBtn} onPress={() => setSelectedViewer(null)}>
              <LinearGradient colors={['#FF4FE1', '#6C35FF']} style={styles.cardCloseGradient}>
                <Ionicons name="close" size={27} color="#FFF" />
              </LinearGradient>
            </TouchableOpacity>

            <View style={styles.profileHeader}>
              <View style={styles.profileAvatarBox}>
                <Image source={{ uri: selectedViewer.avatar }} style={styles.profileAvatarLarge} />
                {profileFrameSourceFor(selectedViewer) && (
                  <Image source={profileFrameSourceFor(selectedViewer)} style={styles.viewerProfileFrameLarge} resizeMode="contain" pointerEvents="none" />
                )}
                <View style={styles.levelRingGlow} />
                <View style={styles.profileLevelBadge}>
                  <Text style={styles.profileLevelText}>Lv.{selectedViewer.level || 1}</Text>
                </View>
              </View>
              <Text style={styles.profileNameLarge} numberOfLines={1}>{selectedViewer.name}</Text>
              {/* Display ID — sequential 202xxx number set by the signup
                  trigger and now shipped on every presence payload
                  (channel.track) so viewers see it without a profile
                  fetch. We deliberately DON'T fall back to a UUID
                  slice — that produced "2d1814ff"-style strings users
                  confused for their actual ID. A clean em-dash is the
                  right answer when the field is genuinely unset. */}
              <Text style={styles.profileUserId}>
                ID: {selectedViewer.displayId || selectedViewer.display_id || '—'}
              </Text>
              <View style={styles.profileMetaPill}>
                <Ionicons name="location-outline" size={14} color="#8BD8FF" />
                <Text style={styles.profileMetaText}>{countryFlag ? `${countryFlag}  ` : ''}{selectedViewer.country || 'Global'}</Text>
              </View>
            </View>

            {profileModalLoading || selectedViewer.loading ? (
              <View style={styles.profileLoadingBox}>
                <LogoLoader size="small" />
              </View>
            ) : null}

            <View style={styles.profileStatsRow}>
              <View style={styles.pStatItem}>
                <Ionicons name="people" size={27} color="#20D8FF" />
                <Text style={styles.pStatValue}>{formatProfileCount(selectedViewer.followers)}</Text>
                <Text style={styles.pStatLabel}>Followers</Text>
              </View>
              <View style={styles.pStatDivider} />
              <View style={styles.pStatItem}>
                <Ionicons name="person" size={27} color="#FF4FD8" />
                <Text style={styles.pStatValue}>{formatProfileCount(selectedViewer.followingCount)}</Text>
                <Text style={styles.pStatLabel}>Following</Text>
              </View>
              <View style={styles.pStatDivider} />
              <View style={styles.pStatItem}>
                <Ionicons name="eye" size={27} color="#FFD43A" />
                <Text style={styles.pStatValue}>{formatProfileCount(selectedViewer.visitors)}</Text>
                <Text style={styles.pStatLabel}>Visitors</Text>
              </View>
            </View>

            <View style={styles.profileBioBox}>
              <Text style={styles.profileBioLabel}>Bio</Text>
              <Text style={styles.profileBioText}>{selectedViewer.bio || 'No bio yet.'}</Text>
            </View>

            <View style={styles.profileActionsContainer}>
              {!isSelfProfile && (
                <TouchableOpacity
                  style={styles.pActionMain}
                  onPress={async () => {
                    const ok = isFollowingProfile ? await unfollowUser(selectedViewer.id) : await followUser(selectedViewer.id);
                    if (!ok) return;
                    setFollowedIds((prev) => {
                      const next = new Set(prev);
                      if (isFollowingProfile) next.delete(selectedViewer.id); else next.add(selectedViewer.id);
                      return next;
                    });
                    setSelectedViewer((current) => current ? {
                      ...current,
                      following: !isFollowingProfile,
                      followers: Math.max(0, Number(current.followers || 0) + (isFollowingProfile ? -1 : 1)),
                    } : current);
                  }}
                >
                  <LinearGradient colors={isFollowingProfile ? ['#594376', '#382b62'] : [BRAND.primary, BRAND.primaryAlt]} style={styles.pActionGradient}>
                    <Ionicons name={isFollowingProfile ? 'checkmark' : 'person-add'} size={26} color="#FFF" />
                    <Text style={styles.pActionText}>{isFollowingProfile ? 'Following' : 'Follow'}</Text>
                  </LinearGradient>
                </TouchableOpacity>
              )}

              <View style={styles.pActionMiniRow}>
                {!isSelfProfile && <TouchableOpacity style={styles.pActionMini} onPress={() => { setSelectedViewer(null); setShowGiftMenu(true); }}>
                  <Text style={styles.pActionEmoji}>🎁</Text>
                  <Text style={styles.pActionMiniText}>Gift</Text>
                </TouchableOpacity>}
                {!isSelfProfile && <TouchableOpacity style={styles.pActionMini} onPress={() => { const targetId = selectedViewer.id; const targetName = encodeURIComponent(selectedViewer.name || 'User'); setSelectedViewer(null); router.push(`/main/chat/${targetId}?name=${targetName}`); }}>
                  <Text style={styles.pActionEmoji}>💬</Text>
                  <Text style={styles.pActionMiniText}>Message</Text>
                </TouchableOpacity>}
                {!isSelfProfile && (
                  <TouchableOpacity
                    style={styles.pActionMini}
                    onPress={() => { setReportTarget({ id: selectedViewer.id, name: selectedViewer.name }); setSelectedViewer(null); }}
                  >
                    <Text style={styles.pActionEmoji}>🚩</Text>
                    <Text style={styles.pActionMiniText}>Report</Text>
                  </TouchableOpacity>
                )}
              </View>

              {isHostView && (
                <View style={styles.hostModRow}>
                  <TouchableOpacity
                    style={[styles.hostModBtn, { borderColor: '#EF4444' }]}
                    onPress={() => {
                      showCuteAlert("Kick User", `Are you sure you want to kick ${selectedViewer.name}?`, [
                        { text: 'Cancel' },
                        { text: 'Kick', onPress: () => { showCuteAlert("Kicked", `${selectedViewer.name} removed.`); setSelectedViewer(null); } }
                      ]);
                    }}
                  >
                    <Ionicons name="exit" size={18} color="#EF4444" />
                    <Text style={[styles.hostModText, { color: '#EF4444' }]}>Kick</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.hostModBtn, { borderColor: '#A855F7' }]}
                    onPress={() => { toggleRoomAdmin(selectedViewer); setSelectedViewer(null); }}
                  >
                    <Ionicons name={roomAdmins.includes(selectedViewer.id) ? "star-outline" : "star"} size={18} color="#A855F7" />
                    <Text style={[styles.hostModText, { color: '#A855F7' }]}>
                      {roomAdmins.includes(selectedViewer.id) ? 'Remove Admin' : 'Make Admin'}
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.hostModBtn, { borderColor: '#B91C1C', backgroundColor: 'rgba(185,28,28,0.1)' }]}
                    onPress={() => {
                      showCuteAlert("Block User", `This will permanently block ${selectedViewer.name} from your rooms.`, [
                        { text: 'Cancel' },
                        {
                          text: 'Block', onPress: async () => {
                            const { error } = await supabase.rpc('room_block_user', {
                              target: selectedViewer.id,
                              reason: 'Blocked from viewer list',
                            });
                            if (error) { showCuteAlert('Block failed', error.message); return; }
                            setBlockedUsers(prev => prev.includes(selectedViewer.id) ? prev : [...prev, selectedViewer.id]);
                            showCuteAlert("Blocked", `${selectedViewer.name} has been blocked.`);
                            setSelectedViewer(null);
                          }
                        }
                      ]);
                    }}
                  >
                    <Ionicons name="shield-half" size={18} color="#B91C1C" />
                    <Text style={[styles.hostModText, { color: '#B91C1C' }]}>Block</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </View>
        </View>
      </Modal>
    );
  };


  const renderGamesBottomSheet = () => {
    // Compact 2-column tile grid for the picker; the game body itself
    // takes 'auto' height so it sizes to its own content.
    const menuHeight = Math.min(620, Math.round(height * 0.72));
    const royalFeastHeight = Math.min(760, height - insets.top - 12);
    const gameSheetHeight = gameMenuState === 'menu'
      ? menuHeight
      : gameMenuState === 'royalfeast'
        ? royalFeastHeight
        : 'auto';
    return (
      <Modal animationType="slide" transparent={true} visible={gameMenuState !== null} onRequestClose={() => setGameMenuState(null)}>
        <View style={styles.giftModalOverlay}>
          <View style={[styles.giftModalContent, { paddingBottom: insets.bottom + 20, height: gameSheetHeight }]}>

            {gameMenuState === 'menu' && (
              <View style={{ flex: 1 }}>
                <View style={styles.gamePickerHeader}>
                  <View>
                    <Text style={styles.gamePickerTitle}>Mini Games</Text>
                    <Text style={styles.gamePickerSubtitle}>Bet together — one shared round per game</Text>
                  </View>
                  <TouchableOpacity onPress={() => setGameMenuState(null)} style={styles.gamePickerClose}>
                    <Ionicons name="close" size={18} color="rgba(255,255,255,0.7)" />
                  </TouchableOpacity>
                </View>

                <ScrollView
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={styles.gameTileGrid}
                >
                  {fruitActive && (
                    <TouchableOpacity
                      style={styles.gameTile}
                      activeOpacity={0.85}
                      onPress={() => setGameMenuState('fruit')}
                    >
                      <LinearGradient
                        colors={['rgba(251,191,36,0.18)', 'rgba(244,114,182,0.10)']}
                        style={styles.gameTileGrad}
                      >
                        <View style={styles.gameTileIconWrap}>
                          <Text style={styles.gameTileEmoji}>🎰</Text>
                        </View>
                        <Text style={styles.gameTileName} numberOfLines={1}>Fruit Roulette</Text>
                        <Text style={styles.gameTileDesc} numberOfLines={2}>Pick a fruit. Win up to 8×.</Text>
                        <View style={styles.gameTileChip}>
                          <Ionicons name="people-outline" size={10} color="#FBBF24" />
                          <Text style={styles.gameTileChipText}>Multiplayer</Text>
                        </View>
                      </LinearGradient>
                    </TouchableOpacity>
                  )}

                  {teenPattiActive && (
                    <TouchableOpacity
                      style={styles.gameTile}
                      activeOpacity={0.85}
                      onPress={() => setGameMenuState('teenpatti')}
                    >
                      <LinearGradient
                        colors={['rgba(6,182,212,0.18)', 'rgba(217,70,239,0.10)']}
                        style={styles.gameTileGrad}
                      >
                        <View style={styles.gameTileIconWrap}>
                          <Text style={styles.gameTileEmoji}>🃏</Text>
                        </View>
                        <Text style={styles.gameTileName} numberOfLines={1}>Teen Patti</Text>
                        <Text style={styles.gameTileDesc} numberOfLines={2}>Bet on A, B or C. Winner pays 2×.</Text>
                        <View style={styles.gameTileChip}>
                          <Ionicons name="people-outline" size={10} color="#06B6D4" />
                          <Text style={[styles.gameTileChipText, { color: '#06B6D4' }]}>Multiplayer</Text>
                        </View>
                      </LinearGradient>
                    </TouchableOpacity>
                  )}

                  {royalFeastActive && (
                    <TouchableOpacity
                      style={styles.gameTile}
                      activeOpacity={0.85}
                      onPress={() => setGameMenuState('royalfeast')}
                    >
                      <LinearGradient
                        colors={['rgba(245,199,106,0.20)', 'rgba(126,52,174,0.18)']}
                        style={styles.gameTileGrad}
                      >
                        <View style={styles.gameTileIconWrap}>
                          <Text style={styles.gameTileEmoji}>👑</Text>
                        </View>
                        <Text style={styles.gameTileName} numberOfLines={1}>Royal Feast</Text>
                        <Text style={styles.gameTileDesc} numberOfLines={2}>Choose a feast. Win up to 45×.</Text>
                        <View style={styles.gameTileChip}>
                          <Ionicons name="globe-outline" size={10} color="#F5C76A" />
                          <Text style={[styles.gameTileChipText, { color: '#F5C76A' }]}>HTML5</Text>
                        </View>
                      </LinearGradient>
                    </TouchableOpacity>
                  )}

                  {!fruitActive && !teenPattiActive && !royalFeastActive && (
                    <View style={styles.gameTileEmpty}>
                      <Ionicons name="game-controller-outline" size={44} color="rgba(255,255,255,0.2)" />
                      <Text style={styles.gameTileEmptyText}>
                        Games are temporarily disabled.
                      </Text>
                    </View>
                  )}
                </ScrollView>
              </View>
            )}

            {gameMenuState === 'fruit' && (
              <FruitRoulette
                roomId={id}
                myDiamonds={myDiamonds}
                setMyDiamonds={setMyDiamonds}
                onBack={() => setGameMenuState('menu')}
                onClose={() => setGameMenuState(null)}
              />
            )}

            {gameMenuState === 'teenpatti' && (
              <TeenPatti
                roomId={id}
                myDiamonds={myDiamonds}
                setMyDiamonds={setMyDiamonds}
                onBack={() => setGameMenuState('menu')}
                onClose={() => setGameMenuState(null)}
              />
            )}

            {gameMenuState === 'royalfeast' && (
              <Html5RoyalFeast
                roomId={id}
                myDiamonds={myDiamonds}
                setMyDiamonds={setMyDiamonds}
                onBack={() => setGameMenuState('menu')}
                onClose={() => setGameMenuState(null)}
              />
            )}

          </View>
        </View>
      </Modal>
    );
  };

  const renderHostProfileModal = () => (
    <Modal animationType="fade" transparent={true} visible={showHostModal} onRequestClose={() => setShowHostModal(false)}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <Image source={{ uri: stream.coverUrl }} style={styles.modalAvatar} />
          <Text style={styles.modalHostName} numberOfLines={1} ellipsizeMode="tail">{stream.broadcasterName}</Text>
          <Text style={styles.modalBio}>"Welcome to my live stream! Let's have fun!"</Text>

          <View style={styles.modalStats}>
            <View style={styles.statBox}>
              <Text style={styles.statValue}>12.5k</Text>
              <Text style={styles.statLabel}>Followers</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statValue}>890</Text>
              <Text style={styles.statLabel}>Following</Text>
            </View>
          </View>

          <TouchableOpacity style={styles.modalCloseBtn} onPress={() => setShowHostModal(false)}>
            <Text style={styles.modalCloseText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );

  const renderTopActions = () => {
    if (isAudio) {
      const goalProgress = Math.min((earnings / liveGoal) * 100, 100);
      const audioVisitors = getAudioVisitors();
      const recentAudioVisitors = audioVisitors.slice(-5).reverse();
      const leaveAudioRoom = async () => {
        if (isHostView) {
          const ok = await confirmCuteAlert(
            'End live?',
            'This will end your stream now.',
            { confirmText: 'End', cancelText: 'Cancel', destructive: true }
          );
          if (ok) await performEndLive();
        } else {
          router.back();
        }
      };

      return (
        <View style={[styles.audioTopShell, { top: insets.top + 8 }]}>
          <View style={styles.audioTopNav}>
            <TouchableOpacity style={styles.audioAssetButton} onPress={leaveAudioRoom}>
              <Image source={AUDIO_BACK_BUTTON} style={styles.audioAssetIcon} resizeMode="contain" />
            </TouchableOpacity>
            <View style={styles.audioTopNavRight}>
              {isHostView && audioVisitors.length > 0 && (
                <View style={styles.audioVisitorStrip}>
                  <TouchableOpacity style={styles.audioVisitorAvatars} onPress={handleViewersClick} activeOpacity={0.82}>
                    {recentAudioVisitors.map((viewer, idx) => (
                      <View
                        key={viewer.id || `${idx}`}
                        style={[
                          styles.audioVisitorAvatarWrap,
                          idx > 0 && { marginLeft: -10 },
                        ]}
                      >
                        <Image source={{ uri: viewer.avatar }} style={styles.audioVisitorAvatar} />
                      </View>
                    ))}
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.audioVisitorCountBtn} onPress={handleViewersClick} activeOpacity={0.8}>
                    <Text style={styles.audioVisitorCountText}>{audioVisitors.length}</Text>
                  </TouchableOpacity>
                </View>
              )}
              <TouchableOpacity style={styles.audioTrophyButton} onPress={() => setShowRankingSheet(true)}>
                <Ionicons name="trophy" size={22} color="#FFD73A" />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.audioAssetButton}
                onPress={() => isHostView ? setShowHostMoreMenu(true) : handleViewersClick()}
              >
                <Image source={AUDIO_MORE_BUTTON} style={styles.audioAssetIcon} resizeMode="contain" />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.audioHostHero}>
            <Image source={AUDIO_HOST_BANNER_BG} style={styles.audioHostHeroBg} resizeMode="cover" pointerEvents="none" />
            <View style={styles.audioHeroTopLine}>
              <Text style={styles.audioHeroName} numberOfLines={1}>{stream.broadcasterName || 'Host'}</Text>
              <View style={styles.audioHeroViewer}>
                <Ionicons name="eye" size={15} color="#FFF" />
                <Text style={styles.audioHeroViewerText}>{liveViewerCount}</Text>
              </View>
              <View style={styles.audioHeroMeta}>
                <Ionicons name="diamond" size={13} color="#F4C84A" />
                <Text style={styles.audioHeroMetaText}>{urlTitle || 'Audio Live'}  •  {formatDuration(liveDuration)}</Text>
              </View>
            </View>

            <View style={styles.audioHeroGoalRow}>
              <View style={styles.audioHeroGoalTitleWrap}>
                <View style={styles.audioHeroGoalIcon}>
                  <Ionicons name="flame" size={15} color="#FFD134" />
                </View>
                <Text style={styles.audioHeroGoalTitle}>Live Goal</Text>
                {isHostView && (
                  <TouchableOpacity
                    onPress={() => { setTempGoal(liveGoal.toString()); setShowGoalModal(true); }}
                    style={styles.audioHeroGoalEdit}
                  >
                    <Ionicons name="pencil" size={13} color="rgba(255,255,255,0.72)" />
                  </TouchableOpacity>
                )}
              </View>
              <View style={styles.audioHeroGoalStatsWrap}>
                <Text style={styles.audioHeroGoalStats}>{earnings}/{liveGoal}</Text>
                <Text style={styles.audioHeroGoalCompleted}>{Math.round(goalProgress)}% Completed</Text>
              </View>
            </View>

            <View style={styles.audioHeroGoalBarBg}>
              <LinearGradient
                colors={['#FFD700', '#FFA500']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={[styles.audioHeroGoalBarFill, { width: `${goalProgress}%` }]}
              />
            </View>
          </View>
        </View>
      );
    }

    // ── Responsive sizing for the top bar ─────────────────────────────
    // The old layout used a hard-coded marquee width and a fixed list of
    // 4 viewer avatars with 10px gaps. On small Androids the right-side
    // cluster pushed onto the host name bar (visual overlap) because the
    // marquee refused to shrink. We compute everything from the actual
    // screen width here so the bar adapts cleanly across 320 → 768+ px.
    //
    //   shownAvatars      — fewer slots on phones < 380, more on iPads.
    //                       Tap the count badge to see the full list.
    //   avatarClusterW    — first avatar full-size, rest stacked with
    //                       -12px margin (Instagram-style overlap).
    //   rightSideW        — avatars + trophy + close + small gaps.
    //   marqueeWidth      — whatever's left over, clamped [80, 200].
    //                       Always >= 80 so the name is at least readable.
    const shownAvatars = Math.min(
      roomViewers.length,
      width < 360 ? 1 : width < 400 ? 2 : width < 440 ? 3 : 4
    );
    const avatarClusterW = shownAvatars > 0 ? 36 + (shownAvatars - 1) * 24 : 0;
    const rightSideW = avatarClusterW + 80; // trophy 32 + close 32 + gaps ~16
    const leftFixed = 110; // avatar 40 + hostInfo margins 20 + follow 28 + padding/border ~22
    const marqueeWidth = Math.max(80, Math.min(width - 32 - leftFixed - rightSideW - 8, 200));

    return (
    <View style={[styles.topActions, { top: insets.top + 10 }]}>
      <View style={styles.topLeftContainer}>
        <View style={styles.broadcasterPanelWrapper}>
          <TouchableOpacity
            style={styles.broadcasterPanel}
            onPress={() => !isHostView && openProfilePopup({
              id: stream.id,
              name: stream.broadcasterName,
              avatar: stream.coverUrl,
              country: stream.country,
              level: stream.level,
            })}
            activeOpacity={0.8}
          >
            <View style={styles.hostAvatarWrapper}>
              <Image source={{ uri: stream.coverUrl }} style={styles.hostAvatarSmall} />
            </View>
            <View style={styles.hostInfo}>
              <MarqueeText
                text={stream.broadcasterName || urlTitle || 'Broadcaster'}
                style={styles.hostName}
                containerWidth={marqueeWidth}
              />
              <View style={styles.viewerCountBubble}>
                <Ionicons name="eye" size={10} color="#FFF" />
                <Text style={styles.viewerCountText}>{liveViewerCount}</Text>
              </View>
            </View>
          </TouchableOpacity>

          {!isHostView && !isFollowing && (
            <TouchableOpacity
              style={[styles.hostFollowBtn, hostFollowBusy && { opacity: 0.5 }]}
              onPress={handleFollow}
              disabled={hostFollowBusy}
            >
              <LinearGradient colors={[BRAND.primary, BRAND.primaryAlt]} style={styles.hostFollowGradient}>
                <Ionicons name="add" size={18} color="#FFF" />
              </LinearGradient>
            </TouchableOpacity>
          )}

          {/* Just-followed checkmark — a quick acknowledgement that
              fades in/out. Shown ONLY in the ~1.4s window right after
              the viewer taps Follow. On subsequent visits to the same
              live (already-following state, justFollowedHost = false),
              nothing is rendered here — the missing Follow + button is
              the only signal needed. Mirrors Bigo / Likee. */}
          {!isHostView && isFollowing && justFollowedHost && (
            <Animated.View style={[styles.justFollowedBadge, { opacity: justFollowedFadeRef.current }]} pointerEvents="none">
              <Ionicons name="checkmark" size={14} color="#4ADE80" />
            </Animated.View>
          )}
        </View>

        {isHostView && (
          <View style={styles.hostStatsRow}>
            <View style={styles.earningsBadge}>
              <Ionicons name="diamond" size={12} color="#FBBF24" />
              <Text style={styles.earningsText}>{earnings}</Text>
            </View>
            <View style={[styles.earningsBadge, { borderColor: 'rgba(255,255,255,0.2)' }]}>
              <Ionicons name="time-outline" size={12} color="#FFF" />
              <Text style={[styles.earningsText, { color: '#FFF' }]}>{formatDuration(liveDuration)}</Text>
            </View>
          </View>
        )}
      </View>

      <View style={styles.topRightActions}>
        <View style={styles.topViewers}>
          <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center' }} onPress={handleViewersClick}>
            {roomViewers.slice(0, shownAvatars).map((viewer, idx) => (
              <View
                key={viewer.id}
                style={[
                  styles.topViewerAvatarWrapper,
                  // First avatar sits flush; later ones overlap leftward
                  // by 12px (Instagram-style stacking). Saves ~50% of the
                  // horizontal footprint vs. the old 10px-gap layout
                  // without dropping any avatars on small phones.
                  idx === 0 ? { marginLeft: 4 } : { marginLeft: -12 },
                ]}
              >
                <Image
                  source={{ uri: viewer.avatar }}
                  style={styles.topViewerAvatar}
                />
              </View>
            ))}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.rankingChip}
            onPress={() => setShowRankingSheet(true)}
            activeOpacity={0.7}
          >
            <Ionicons name="trophy" size={14} color="#FBBF24" />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.topViewerCount}
            onPress={async () => {
              if (isHostView) {
                // Compact cute confirm — small footprint, short copy.
                const ok = await confirmCuteAlert(
                  'End live?',
                  'This will end your stream now.',
                  { confirmText: 'End', cancelText: 'Cancel', destructive: true }
                );
                if (ok) await performEndLive();
              } else {
                // Viewer just leaves — no confirmation needed.
                router.back();
              }
            }}
            activeOpacity={0.7}
          >
            <Ionicons name="close" size={16} color="#FFF" />
          </TouchableOpacity>
        </View>
      </View>
    </View>
    );
  };

  const renderMusicPickerModal = () => (
    <Modal visible={showMusicModal} transparent animationType="slide" onRequestClose={() => setShowMusicModal(false)}>
      <View style={[styles.summaryOverlay, { justifyContent: 'flex-end' }]}>
        <View style={[
          styles.giftModalContent,
          {
            width: '100%',
            paddingBottom: insets.bottom + 16,
            // Matches the gift + call-requests sheets — single sizing
            // formula across all three host bottom-sheets for cohesion.
            height: Math.min(width < 360 ? height * 0.55 : height * 0.50, 480),
          },
        ]}>
          <View style={[styles.giftHeader, { paddingVertical: 12 }]}>
            <Text style={[styles.giftTabTextActive, { fontSize: 18 }]}>Your Music</Text>
            <TouchableOpacity onPress={() => setShowMusicModal(false)}>
              <Ionicons name="close-circle" size={28} color="rgba(255,255,255,0.5)" />
            </TouchableOpacity>
          </View>

          {/* Now playing strip */}
          {currentMusic && (
            <View style={{ flexDirection: 'row', alignItems: 'center', padding: 12, marginHorizontal: 16, borderRadius: 12, backgroundColor: `${BRAND.primary}1F`, borderWidth: 1, borderColor: BRAND.primary30 }}>
              <Ionicons name="musical-notes" size={20} color={BRAND.primary} />
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={{ color: '#FFF', fontWeight: 'bold' }} numberOfLines={1}>{currentMusic.title}</Text>
                {currentMusic.artist && (
                  <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11 }} numberOfLines={1}>{currentMusic.artist}</Text>
                )}
              </View>
              <TouchableOpacity onPress={togglePlayPause} style={{ padding: 6 }}>
                <Ionicons name={isMusicPlaying ? 'pause-circle' : 'play-circle'} size={32} color={BRAND.primary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => stopMusic(true)} style={{ padding: 6, marginLeft: 4 }}>
                <Ionicons name="stop-circle" size={28} color="rgba(255,255,255,0.6)" />
              </TouchableOpacity>
            </View>
          )}

          <ScrollView style={{ paddingHorizontal: 20, paddingTop: 15 }}>
            {musicLoading ? (
              <Text style={{ color: '#9CA3AF', textAlign: 'center', marginTop: 30 }}>Loading…</Text>
            ) : musicPermStatus === 'denied' ? (
              // Permission CTA — the host can re-trigger the prompt from
              // here without leaving the room. If the user previously
              // chose "Don't ask again", expo-media-library will surface
              // an OS-level deep link to settings on the next call.
              <View style={{ alignItems: 'center', marginTop: 30 }}>
                <Ionicons name="lock-closed-outline" size={48} color="rgba(255,255,255,0.25)" />
                <Text style={{ color: '#FFF', marginTop: 12, textAlign: 'center', fontWeight: '700' }}>
                  Music access needed
                </Text>
                <Text style={{ color: '#9CA3AF', fontSize: 12, marginTop: 6, textAlign: 'center', paddingHorizontal: 24 }}>
                  Allow access to your device music so you can play tracks while you're live.
                </Text>
                <TouchableOpacity
                  onPress={loadDeviceMusic}
                  style={{ marginTop: 18, backgroundColor: BRAND.primary, paddingHorizontal: 22, paddingVertical: 10, borderRadius: 22 }}
                >
                  <Text style={{ color: '#FFF', fontWeight: '800' }}>Grant access</Text>
                </TouchableOpacity>
              </View>
            ) : musicTracks.length === 0 ? (
              <View style={{ alignItems: 'center', marginTop: 30 }}>
                <Ionicons name="musical-notes-outline" size={48} color="rgba(255,255,255,0.2)" />
                <Text style={{ color: '#9CA3AF', marginTop: 12, textAlign: 'center' }}>
                  No music found on this device.
                </Text>
                <Text style={{ color: '#6B7280', fontSize: 11, marginTop: 6, textAlign: 'center', paddingHorizontal: 24 }}>
                  Add MP3 / M4A files to your device library, then reopen this menu.
                </Text>
              </View>
            ) : musicTracks.map((track) => {
              const isCurrent = currentMusic?.id === track.id;
              return (
                <TouchableOpacity
                  key={track.id}
                  style={[styles.gameListItem, { marginBottom: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)', opacity: isCurrent ? 0.7 : 1 }]}
                  onPress={() => playTrack(track)}
                >
                  <View style={[styles.chatToggleBtn, { backgroundColor: BRAND.primary10 }]}>
                    {track.cover_url
                      ? <Image source={{ uri: track.cover_url }} style={{ width: 40, height: 40, borderRadius: 8 }} />
                      : <Ionicons name="musical-note" size={20} color={BRAND.primary} />
                    }
                  </View>
                  <View style={{ marginLeft: 15, flex: 1 }}>
                    <Text style={{ color: '#FFF', fontSize: 16, fontWeight: 'bold' }} numberOfLines={1}>{track.title}</Text>
                    {track.artist && (
                      <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 4 }} numberOfLines={1}>{track.artist}</Text>
                    )}
                  </View>
                  <Ionicons
                    name={isCurrent && isMusicPlaying ? 'volume-high' : 'play-circle'}
                    size={28}
                    color={isCurrent ? BRAND.primary : '#4ADE80'}
                  />
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );

  const renderVideoLayout = () => {
    if (isAudio) return null;

    // Host camera is the fullscreen background (mounted at root level).
    // Guests appear as floating thumbnails on the side — speaking ring,
    // guardian crown, and the viewer/host tap menus all mirror the audio
    // seat behaviour so the two modes feel consistent.
    const occupiedGuests = activeGuests.filter(g => g !== null);

    return (
      <View style={StyleSheet.absoluteFillObject}>
        <LinearGradient colors={['transparent', 'rgba(0,0,0,0.6)', 'rgba(0,0,0,0.9)']} style={styles.videoOverlayGradient} />

        {/* Floating Guest Thumbnails */}
        <View style={styles.videoGuestGrid}>
          {occupiedGuests.map((guest) => {
            const isMe = guest.id === user?.id || guest.id === 'You';
            const guestMuted = mutedGuests.includes(guest.id) || (isMe && isSelfMuted);
            const isSpeaking = !guestMuted && (isMe
              ? agora.localSpeaking
              : agora.speakingUids.includes(agoraUidFromId(String(guest.id))));
            const vipTheme = activeVipTheme(guest);
            const tileBorderColor = isSpeaking ? '#38BDF8' : (vipTheme ? vipTheme.ring : '#2D1B4E');

            const openMenu = () => {
              if (isHostView || roomAdmins.includes(user?.id)) {
                setTargetGuest(guest);
                setShowAdminMenu(true);
              } else if (isMe) {
                // Viewer tapped their own tile — quick leave shortcut.
                showCuteAlert(`Your Seat`, `You're on the call. Tap Leave to step down.`, [
                  { text: 'Stay', style: 'cancel' },
                  { text: 'Leave', style: 'destructive', onPress: handleLeaveCall },
                ]);
              } else {
                // Non-host tap on someone else — same options as audio.
                showCuteAlert(`Guest`, `${guest.name}`, [
                  { text: 'View Profile', onPress: () => guest.id && router.push(`/main/user/${guest.id}`) },
                  { text: 'Report', style: 'destructive', onPress: () => setReportTarget({ id: guest.id, name: guest.name }) },
                  { text: 'Close', style: 'cancel' },
                ]);
              }
            };

            return (
              <TouchableOpacity
                key={guest.id}
                style={[
                  styles.guestVideoBox,
                  { borderColor: tileBorderColor },
                  isSpeaking && styles.guestTileSpeaking,
                  guest.videoEnabled === false && styles.audioOnlyGuestBox,
                ]}
                activeOpacity={0.9}
                onPress={openMenu}
              >
                {guest.videoEnabled !== false ? (
                  <View style={{ flex: 1 }}>
                    {(isMe && isAgoraPublisher && isCamOn && agora.joined) ? (
                      <View style={{ flex: 1 }}>
                        <RtcSurfaceView
                          key={`local-${isAgoraPublisher ? 'pub' : 'sub'}-${agora.joined}`}
                          style={styles.guestVideoFeed}
                          canvas={{ uid: 0 }}
                        />
                        {renderFilterOverlay()}
                      </View>
                    ) : (agora.joined && agora.remoteUids.includes(agoraUidFromId(String(guest.id))) && !agora.videoOffUids.includes(agoraUidFromId(String(guest.id)))) ? (
                      <RtcSurfaceView
                        key={`remote-${agoraUidFromId(String(guest.id))}`}
                        style={styles.guestVideoFeed}
                        canvas={{ uid: agoraUidFromId(String(guest.id)) }}
                      />
                    ) : (
                      <Image source={{ uri: guest.avatar }} style={styles.guestVideoFeed} />
                    )}
                  </View>
                ) : (
                  <View style={styles.audioGuestPlaceholder}>
                    <LinearGradient
                      colors={['rgba(168,85,247,0.15)', BRAND.primary10]}
                      style={StyleSheet.absoluteFillObject}
                    />
                    <View style={[styles.pulseCircle, { width: 64, height: 64, borderRadius: 32, opacity: 0.4 }]} />
                    <Image source={{ uri: guest.avatar }} style={styles.audioGuestAvatarSmall} />
                    <View style={styles.audioModeChip}>
                      <Ionicons name="videocam-off" size={9} color="#FFF" />
                      <Text style={styles.audioModeChipText}>Audio</Text>
                    </View>
                  </View>
                )}

                {/* The top-of-tile badge (VIP icon or guardian crown ♛)
                    used to live here. Product decision: simpler video
                    tile reads cleaner — the chat row + viewer profile
                    popup already surface VIP / guardian status, so the
                    seat tile doesn't need the extra ornament. */}

                {/* SpeakingPulse — audio seats had this animated halo on
                    line 2908; video tiles only signalled talking with a
                    static border colour, which budget-phone users said
                    looked dead. Same component, ported across. */}
                {!guestMuted && isSpeaking && (
                  <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
                    <SpeakingPulse active={isSpeaking} dynamicLevel={0} />
                  </View>
                )}

                <View style={styles.guestNameTag}>
                  {/* Name marquee uses the actual tile width (112px from
                      guestVideoBox) minus the tag's internal horizontal
                      padding so the text fills the visible strip without
                      overflowing right. Previously hard-coded 130px,
                      which exceeded the tile and clipped the right edge. */}
                  <MarqueeText
                    text={guest.name}
                    style={styles.guestNameMini}
                    containerWidth={104}
                  />
                </View>

                {/* Seat number tag — matches the audio-seat numbering so
                    hosts can address guests as "seat 3" regardless of
                    mode. */}
                <View style={styles.videoSeatNumTag}>
                  <Text style={styles.seatNumTagText}>{activeGuests.indexOf(guest) + 1}</Text>
                </View>

                <View style={styles.guestVideoOverlay}>
                  {guestMuted && (
                    <Ionicons name="mic-off" size={12} color="#EF4444" />
                  )}
                </View>

                {/* Host-side quick remove. Audio seats had this dedicated
                    X button (line 2939) — video relied on the long press
                    menu, which is two extra taps. */}
                {isHostView && (
                  <TouchableOpacity
                    style={styles.videoRemoveSeatBtn}
                    onPress={(e) => {
                      e.stopPropagation?.();
                      const idx = activeGuests.indexOf(guest);
                      if (idx < 0) return;
                      const newSeats = [...activeGuests];
                      newSeats[idx] = null;
                      applySeats(newSeats);
                    }}
                  >
                    <Ionicons name="close-circle" size={16} color="#EF4444" />
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    );
  };

  const renderEntranceBanner = () => {
    if (!entranceBanner) return null;

    // Tier Configuration
    const configs = {
      'VIP': {
        colors: ['#94A3B8', '#475569', '#1E293B'], // Silver/Steel
        icon: 'star',
        title: 'VIP ENTRANCE',
        label: 'Elite Member',
        glow: 'rgba(148, 163, 184, 0.3)'
      },
      'SVIP': {
        colors: ['#F59E0B', '#B45309', '#78350F'], // Gold/Amber
        icon: 'shield-checkmark',
        title: 'SUPER VIP',
        label: 'Royal Member',
        glow: 'rgba(245, 158, 11, 0.4)'
      },
      'VVIP': {
        colors: ['#7E22CE', '#D946EF', '#4F46E5'], // Royal Purple/Neon
        icon: 'diamond',
        title: 'SUPREME VVIP',
        label: 'Legendary King',
        glow: 'rgba(217, 70, 239, 0.5)'
      }
    };

    const config = configs[entranceBanner.type] || configs['VIP'];

    return (
      <Animated.View style={[
        styles.entranceBannerContainer,
        { transform: [{ translateX: entranceAnimX }], opacity: entranceAnimOpacity }
      ]}>
        <View style={[styles.entranceGlowLarge, { backgroundColor: config.glow }]} />
        <LinearGradient
          colors={config.colors}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          style={styles.entranceBannerGradient}
        >
          <View style={styles.entranceBannerLeft}>
            <View style={styles.entranceAvatarBox}>
              <VipAvatar
                uri={entranceBanner.avatar}
                vipType={entranceBanner.type || 'VIP'}
                size={56}
                intense
                bgColor="rgba(0,0,0,0.45)"
              />
            </View>
          </View>

          <View style={styles.entranceBannerMiddle}>
            <Text style={styles.entranceBannerActionText}>{config.title}</Text>
            <Text style={styles.entranceBannerText} numberOfLines={1}>
              <Text style={styles.entranceBannerName}>{entranceBanner.name}</Text>
              <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13 }}> {config.label}</Text>
            </Text>
          </View>

          <View style={styles.entranceBannerRight}>
            <View style={styles.levelBadgeEntrance}>
              <Text style={styles.levelBadgeTextEntrance}>Lv.{entranceBanner.level}</Text>
            </View>
          </View>
        </LinearGradient>
      </Animated.View>
    );
  };

  const renderRoomTitle = () => {
    const title = (roomTitle || urlTitle || '').trim();
    // No title set â†’ don't show anything (and never block seat taps below).
    if (!title) return null;
    return (
      <View pointerEvents="none" style={[styles.roomTitleBadge, { top: insets.top + (isAudio ? 62 : 155) }]}>
        <LinearGradient
          colors={[BRAND.primary20, 'rgba(107, 78, 255, 0.2)']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.roomTitleGradient}
        >
          <Ionicons name="sparkles" size={12} color={BRAND.primary} style={{ marginRight: 6 }} />
          <MarqueeText
            text={title}
            style={styles.roomTitleText}
            containerWidth={width * 0.6}
          />
        </LinearGradient>
      </View>
    );
  };

  const SpeakingPulse = ({ active, dynamicLevel = 0 }) => {
    const anim = useRef(new Animated.Value(0)).current;

    useEffect(() => {
      if (active) {
        Animated.loop(
          Animated.timing(anim, {
            toValue: 1,
            duration: 1500,
            useNativeDriver: true,
          })
        ).start();
      } else {
        anim.setValue(0);
      }
    }, [active]);

    if (!active && dynamicLevel <= 0.1) return null;

    // Use dynamicLevel for extra scale if provided
    const scaleFactor = active ? (1.2 + dynamicLevel * 1.5) : (1 + dynamicLevel * 2);

    // One pulse circle instead of three. In an 8-seat audio room the old
    // implementation rendered 24 concurrently animated Views (8 seats ×
    // 3 circles) and that GPU compositing was a major thermal source on
    // budget Androids. The single ring still reads as "talking" clearly.
    return (
      <View style={styles.pulseContainer}>
        <Animated.View
          style={[
            styles.pulseCircle,
            {
              transform: [{
                scale: anim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [1, scaleFactor],
                }),
              }],
              opacity: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [0.6, 0],
              }),
            },
          ]}
        />
      </View>
    );
  };

  // VIP/VVIP active tier theme — drives the small crown badge + ring color
  // above the seat avatar. Returns null when the user has no tier or it has
  // expired (so non-VIP guests don't show a crown).
  const VIP_SEAT_THEME = {
    VIP:  { ring: '#CBD5E1', badge: '#94A3B8', icon: 'star' },
    SVIP: { ring: '#FCD34D', badge: '#F59E0B', icon: 'shield-checkmark' },
    VVIP: { ring: '#F472B6', badge: '#A855F7', icon: 'diamond' },
  };
  const activeVipTheme = (g) => {
    if (!g?.vipType || g.vipType === 'none' || !g.vipExpiresAt) return null;
    const exp = new Date(g.vipExpiresAt);
    if (Number.isNaN(exp.getTime()) || exp.getTime() <= Date.now()) return null;
    return VIP_SEAT_THEME[g.vipType] || null;
  };

  const profileFrameSourceFor = (person) => {
    const frameUrl = person?.selectedProfileFrameUrl || person?.profileFrameUrl || person?.frameUrl || null;
    const frameId = person?.selectedProfileFrame || person?.profileFrame || null;
    if (frameUrl) {
      if (typeof frameUrl === 'string' && frameUrl.startsWith('bundled://')) {
        return PROFILE_FRAME_ASSETS[frameUrl.replace('bundled://', '')] || null;
      }
      return { uri: frameUrl };
    }
    return frameId ? (PROFILE_FRAME_ASSETS[frameId] || null) : null;
  };

  const renderSeatProfileFrame = (person) => {
    const source = profileFrameSourceFor(person);
    if (!source) return null;
    return <Image source={source} style={styles.seatProfileFrame} resizeMode="contain" pointerEvents="none" />;
  };

  const renderAudioRoomSeats = () => {
    const hostMutedNow = isHostView ? isSelfMuted : hostMuted;
    const hostSpeaking = !hostMutedNow &&
      (isHostView ? agora.localSpeaking : agora.speakingUids.includes(hostUid));

    // Compact number formatter for the per-seat earnings badge. Keeps
    // the badge width predictable across the 4-column grid: 850, 1.2k,
    // 12k, 1.5M all render in the same ~5-char footprint.
    const fmtCompact = (n) => {
      const v = Number(n) || 0;
      if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1).replace(/\.0$/, '') + 'M';
      if (v >= 1_000)     return (v / 1_000).toFixed(v >= 10_000 ? 0 : 1).replace(/\.0$/, '') + 'k';
      return String(v);
    };

    // Small "💎 1.2k" pill under a seat-holder's name. Only renders
    // when the receiver has accumulated > 0 diamonds this session —
    // empty seats stay clean and uncluttered.
    const renderEarningsBadge = (receiverId) => {
      const amount = receiverId ? seatEarnings[receiverId] : 0;
      if (!amount || amount <= 0) return null;
      return (
        <View style={styles.seatGiftBadge}>
          <Ionicons name="diamond" size={9} color="#FBBF24" />
          <Text style={styles.seatGiftBadgeText} numberOfLines={1}>{fmtCompact(amount)}</Text>
        </View>
      );
    };

  const renderHostCell = () => (
    <View style={styles.seatSlot}>
        <TouchableOpacity
          activeOpacity={0.86}
          style={styles.avatarWrapper}
          onPress={() => openProfilePopup({
            id: stream.id,
            name: stream.broadcasterName,
            avatar: stream.coverUrl,
            country: stream.country,
            level: stream.level,
          })}
        >
          <SpeakingPulse active={hostSpeaking} dynamicLevel={0} />
          <View style={[styles.seatAvatarRing, styles.seatAvatarRingHost, hostSpeaking && styles.speakingRing]}>
            <Image
              source={{ uri: stream.coverUrl || `https://picsum.photos/seed/${stream.id}/100/100` }}
              style={styles.seatAvatar}
              resizeMode="cover"
            />
          </View>
          {renderSeatProfileFrame(stream)}
          {hostMutedNow && (
            <View style={styles.muteIndicatorMini}>
              <Ionicons name="mic-off" size={10} color="#EF4444" />
            </View>
          )}
        </TouchableOpacity>
        <Text style={styles.seatName} numberOfLines={1}>{stream.broadcasterName}</Text>
        {renderEarningsBadge(stream.id)}
      </View>
    );

    const renderGuestCell = (seatIdx) => {
      const guest = activeGuests[seatIdx];
      const displayNumber = seatIdx + 2; // seat 2..8
      const isMe = guest && guest.id === user?.id;
      const guestMuted = guest && (mutedGuests.includes(guest.id) || (isMe && isSelfMuted));
      const isSpeaking = guest && !guestMuted &&
        (isMe ? agora.localSpeaking : agora.speakingUids.includes(agoraUidFromId(guest.id)));
      return (
        <View key={seatIdx} style={styles.seatSlot}>
          {guest ? (
            <TouchableOpacity
              style={styles.occupiedSeat}
              onPress={() => {
                if (isHostView || roomAdmins.includes(user?.id)) {
                  setTargetGuest(guest);
                  setShowAdminMenu(true);
                } else {
                  openProfilePopup(guest);
                }
              }}
            >
              <View style={styles.avatarWrapper}>
                <SpeakingPulse active={isSpeaking} dynamicLevel={0} />
                {(() => {
                  const vipTheme = activeVipTheme(guest);
                  return (
                    <>
                      <View style={[
                        styles.seatAvatarRing,
                        isSpeaking && styles.speakingRing,
                        vipTheme && { borderColor: vipTheme.ring, borderWidth: 2 },
                      ]}>
                        <Image source={{ uri: guest.avatar }} style={styles.seatAvatar} />
                      </View>
                      {renderSeatProfileFrame(guest)}
                      {guestMuted && (
                        <View style={styles.muteIndicatorMini}>
                          <Ionicons name="mic-off" size={10} color="#EF4444" />
                        </View>
                      )}
                      {vipTheme && (
                        <View style={[styles.guardianCrown, { backgroundColor: vipTheme.badge }]}>
                          <Ionicons name={vipTheme.icon} size={11} color="#FFF" />
                        </View>
                      )}
                      {/* Non-VIP guardian crown — the chat already showed
                          this but audio seats were missing it. Mirrors
                          the video tile fix from Sprint 5. */}
                      {!vipTheme && guest.id && guardianIds.includes(guest.id) && (
                        <View style={[styles.guardianCrown, { backgroundColor: '#A855F7' }]}>
                          <Text style={{ color: '#FFF', fontSize: 11, fontWeight: 'bold', lineHeight: 13 }}>♛</Text>
                        </View>
                      )}
                    </>
                  );
                })()}
              </View>
              <Text style={styles.seatName} numberOfLines={1}>{guest.name}</Text>
              {renderEarningsBadge(guest.id)}
              {isHostView && (
                <TouchableOpacity
                  style={styles.removeSeatBtn}
                  onPress={() => {
                    const newSeats = [...activeGuests];
                    newSeats[seatIdx] = null;
                    applySeats(newSeats);
                  }}
                >
                  <Ionicons name="close-circle" size={14} color="#EF4444" />
                </TouchableOpacity>
              )}
            </TouchableOpacity>
          ) : (
            (() => {
              const thisSeatLocked = isSeatsLocked || lockedSeats.includes(seatIdx);
              return (
                <TouchableOpacity
                  style={styles.emptySeat}
                  onLongPress={() => {
                    // Host-only: toggle per-seat lock for THIS seat
                    if (!isHostView) return;
                    const perSeatLocked = lockedSeats.includes(seatIdx);
                    showCuteAlert(
                      `Seat ${displayNumber}`,
                      perSeatLocked ? 'Unlock this seat?' : 'Lock this seat? Only invited guests will be able to join.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: perSeatLocked ? 'Unlock' : 'Lock',
                          onPress: () => {
                            setLockedSeats(prev =>
                              perSeatLocked ? prev.filter(i => i !== seatIdx) : [...prev, seatIdx]
                            );
                          }
                        }
                      ]
                    );
                  }}
                  onPress={() => {
                    if (!isHostView) {
                      if (callRequestStatus !== 'idle') {
                        showCuteAlert('Already on a seat', "You can only join one seat at a time. Leave your current seat first.");
                        return;
                      }
                      if (thisSeatLocked) {
                        setCallRequestStatus('pending');
                        if (channelRef.current) {
                          channelRef.current.send({
                            type: 'broadcast',
                            event: 'call_request',
                            payload: {
                              id: user?.id,
                              name: user?.name || 'Visitor',
                              avatar: user?.avatar || 'https://picsum.photos/seed/visitor/100/100',
                              vipType: user?.vipType || 'none',
                              vipExpiresAt: user?.vipExpiresAt || null,
                              selectedProfileFrame: user?.selectedProfileFrame || null,
                              selectedProfileFrameUrl: user?.selectedProfileFrameUrl || null,
                              selectedMallIntro: user?.selectedMallIntro || null,
                              selectedMallIntroVideoUrl: user?.selectedMallIntroVideoUrl || null,
                              selectedMallIntroThumbnailUrl: user?.selectedMallIntroThumbnailUrl || null,
                            }
                          });
                        }
                        showCuteAlert("Request Sent", "Waiting for host to accept your call request.");
                      } else {
                        const myUser = {
                          id: user?.id,
                          name: user?.name || 'Visitor',
                          avatar: user?.avatar || 'https://picsum.photos/seed/visitor/100/100',
                          isVIP: !!user?.vipType,
                          vipType: user?.vipType || 'none',
                          vipExpiresAt: user?.vipExpiresAt || null,
                          selectedProfileFrame: user?.selectedProfileFrame || null,
                          selectedProfileFrameUrl: user?.selectedProfileFrameUrl || null,
                          selectedMallIntro: user?.selectedMallIntro || null,
                          selectedMallIntroVideoUrl: user?.selectedMallIntroVideoUrl || null,
                          selectedMallIntroThumbnailUrl: user?.selectedMallIntroThumbnailUrl || null,
                        };
                        const newSeats = activeGuests.map(g => (g && g.id === user?.id) ? null : g);
                        newSeats[seatIdx] = myUser;
                        setActiveGuests(newSeats);
                        setCallRequestStatus('accepted');

                        if (channelRef.current) {
                          channelRef.current.send({
                            type: 'broadcast',
                            event: 'seat_update',
                            payload: { activeGuests: newSeats, audioSlotCount }
                          });
                        }
                      }
                    } else {
                      setShowManageCalls(true);
                    }
                  }}
                >
                  <Image source={AUDIO_SEAT_FRAME} style={styles.neonSeatFrame} resizeMode="contain" pointerEvents="none" />
                  <Ionicons name={thisSeatLocked ? "lock-closed" : "person"} size={18} color={thisSeatLocked ? `${BRAND.primary}80` : "rgba(255,255,255,0.35)"} />
                  <Text style={styles.emptySeatNum}>{displayNumber}</Text>
                  {thisSeatLocked && !isHostView && (
                    <View style={styles.seatLockBadge}>
                      <Text style={styles.seatLockText}>LOCKED</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })()
          )}
        </View>
      );
    };

    return (
      <View style={styles.audioSeatsContainer}>
        <View style={styles.seatGrid}>
          {renderHostCell()}
          {activeGuests.map((_, idx) => renderGuestCell(idx))}
        </View>
      </View>
    );
  };

  const renderHostControlBar = () => (
    <View style={[styles.hostControlBar, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      <View style={styles.hostControlLeft}>
        <TouchableOpacity style={styles.chatToggleBtn} onPress={() => setKeyboardVisible(true)}>
          <Ionicons name="chatbubble-outline" size={24} color="#FFF" />
        </TouchableOpacity>

        {/* Request Manager relocated here */}
        <TouchableOpacity style={styles.hostActionBtn} onPress={() => setShowManageCalls(true)}>
          <View>
            <Ionicons name="people-outline" size={24} color="#FFF" />
            {pendingRequests.length > 0 && (
              <View style={styles.requestBadgeSmall}>
                <Text style={styles.requestBadgeTextSmall}>{pendingRequests.length}</Text>
              </View>
            )}
          </View>
          <Text style={styles.hostActionText}>Requests</Text>
        </TouchableOpacity>

        {/* Frequent controls stay in the bar; Music / Background / SFX
            / Lock collapsed into the More (•••) menu below to avoid
            overflow on narrow phones. */}
        <TouchableOpacity style={styles.hostActionBtn} onPress={() => setIsSelfMuted(!isSelfMuted)}>
          <Ionicons
            name={isSelfMuted ? "mic-off" : "mic-outline"}
            size={22}
            color={isSelfMuted ? "#EF4444" : "#FFF"}
          />
          <Text style={[styles.hostActionText, isSelfMuted && { color: '#EF4444' }]}>
            {isSelfMuted ? 'Muted' : 'Mic'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.hostActionBtn} onPress={() => setGameMenuState('menu')}>
          <Ionicons name="game-controller-outline" size={22} color="#FFF" />
          <Text style={styles.hostActionText}>Game</Text>
        </TouchableOpacity>
        {/* More — overflow menu for Music / Background / Lock / SFX.
            Purple dot on top-right when a background template is
            applied OR seats are locked, so the host knows there's
            non-default state behind the menu without having to open
            it. */}
        <TouchableOpacity style={styles.hostActionBtn} onPress={() => setShowHostMoreMenu(true)}>
          <View>
            <Ionicons name="ellipsis-horizontal" size={22} color="#FFF" />
            {(activeTemplateId || (isAudio && isSeatsLocked)) && (
              <View style={styles.hostActionDot} />
            )}
          </View>
          <Text style={styles.hostActionText}>More</Text>
        </TouchableOpacity>
        {/* Host can gift their guests on the seats; the "Host" tile is
            hidden from the recipient picker when isHostView so they
            cannot self-credit. */}
        <TouchableOpacity style={styles.hostActionBtn} onPress={() => setShowGiftMenu(true)}>
          <Ionicons name="gift-outline" size={22} color={BRAND.primary} />
          <Text style={[styles.hostActionText, { color: BRAND.primary }]}>Gift</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderVideoSideBar = () => {
    if (!isHostView || isAudio || isKeyboardVisible) return null;
    // A single circular "tools" trigger. The previous design stacked
    // four buttons here and they consistently overlapped the floating
    // guest tiles (both pinned to right:12). One small button leaves
    // the guest column unobstructed; the bottom sheet handles the
    // actual controls. The tiny coloured dot on the corner surfaces
    // any active "off-default" state so the host knows at a glance
    // whether the cam is off or beauty is on without opening the
    // sheet.
    const beautyOn = (beautyLevels.smooth + beautyLevels.whiten + beautyLevels.redness + beautyLevels.sharp) > 0;
    const indicatorColor = !isCamOn ? '#EF4444' : (beautyOn ? '#FBBF24' : null);
    return (
      <View style={styles.videoSideBar}>
        <TouchableOpacity style={styles.hostToolsBtn} onPress={() => setShowHostTools(true)}>
          <LinearGradient colors={['rgba(0,0,0,0.65)', 'rgba(0,0,0,0.45)']} style={styles.hostToolsBtnBg}>
            <Ionicons name="ellipsis-horizontal" size={24} color="#FFF" />
            {indicatorColor && (
              <View style={[styles.hostToolsBtnDot, { backgroundColor: indicatorColor }]} />
            )}
          </LinearGradient>
          <Text style={styles.sideBarText}>Tools</Text>
        </TouchableOpacity>
      </View>
    );
  };

  // ── Host overflow ("More") menu — surfaces the less-frequent audio
  //    host actions that don't fit in the bottom action bar. Backed by a
  //    bottom sheet so we can grow the grid later without crowding the
  //    main UI again. Each tile mirrors the action's existing handler so
  //    there's a single source of truth for behaviour.
  const renderHostMoreMenu = () => {
    if (!isHostView) return null;
    const beautyOn = (beautyLevels.smooth + beautyLevels.whiten + beautyLevels.redness + beautyLevels.sharp) > 0;
    const items = [
      {
        key:    'music',
        label:  'Music',
        icon:   'musical-notes-outline',
        color:  '#FFF',
        onPress: () => { setShowHostMoreMenu(false); setShowMusicModal(true); },
        active: false,
        show:   true,
      },
      {
        key:    'background',
        label:  'Background',
        icon:   'image-outline',
        color:  activeTemplateId ? '#A855F7' : '#FFF',
        onPress: () => { setShowHostMoreMenu(false); setShowAudioTemplates(true); },
        active: !!activeTemplateId,
        show:   isAudio,
      },
      {
        key:    'sfx',
        label:  'SFX',
        icon:   'musical-note-outline',
        color:  '#FFF',
        onPress: () => { setShowHostMoreMenu(false); setShowSFXMenu(true); },
        active: false,
        show:   true,
      },
      {
        // Host drops a bag of diamonds; first N viewers to tap split
        // the pot. The drop UI used to live behind the viewer-side
        // ellipsis menu — a path the host never reached — so the
        // feature was effectively dead. Surfaces in both audio and
        // video host modes.
        key:    'luckybag',
        label:  'Lucky Bag',
        icon:   'gift-outline',
        color:  '#FBBF24',
        onPress: () => { setShowHostMoreMenu(false); setShowLuckyBagDrop(true); },
        active: !!activeLuckyBag,
        show:   true,
      },
      {
        key:    'chair',
        label:  'Add Chair',
        icon:   'grid-outline',
        iconText: '🪑',
        color:  '#38BDF8',
        onPress: () => {
          setSlotInput(String(audioSlotCount));
          setShowHostMoreMenu(false);
          setShowSlotModal(true);
        },
        active: audioSlotCount !== 8,
        show:   isAudio,
      },
      {
        key:    'lock',
        label:  isSeatsLocked ? 'Locked' : 'Unlock',
        icon:   isSeatsLocked ? 'lock-closed' : 'lock-open-outline',
        color:  isSeatsLocked ? BRAND.primary : '#FFF',
        onPress: () => setIsSeatsLocked(!isSeatsLocked), // no auto-close; toggle in place
        active: isSeatsLocked,
        show:   isAudio,
      },
      // Video mode picks up Beauty/Flip/Cam through the existing
      // host-tools sheet; we keep them out of the audio More menu.
      {
        key:    'beauty',
        label:  'Beauty',
        icon:   'sparkles',
        color:  beautyOn ? '#FBBF24' : '#FFF',
        onPress: () => { setShowHostMoreMenu(false); setShowBeautySheet(true); },
        active: beautyOn,
        show:   !isAudio,
      },
    ].filter((t) => t.show);

    return (
      <Modal visible={showHostMoreMenu} transparent animationType="slide" onRequestClose={() => setShowHostMoreMenu(false)}>
        <TouchableOpacity style={styles.moreOverlay} activeOpacity={1} onPress={() => setShowHostMoreMenu(false)}>
          <View style={[styles.hostToolsSheet, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
            <View style={styles.modalHandle} />
            <Text style={styles.hostToolsTitle}>More Options</Text>
            <View style={styles.hostToolsGrid}>
              {items.map((t) => (
                <TouchableOpacity
                  key={t.key}
                  style={styles.hostToolsTile}
                  onPress={t.onPress}
                  activeOpacity={0.85}
                >
                  <View style={[styles.hostToolsTileIcon, t.active && styles.hostToolsTileIconActive]}>
                    {t.iconText ? (
                      <Text style={styles.hostToolsTileEmoji}>{t.iconText}</Text>
                    ) : (
                      <Ionicons name={t.icon} size={26} color={t.color} />
                    )}
                  </View>
                  <Text style={styles.hostToolsTileLabel}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    );
  };

  const renderSlotSettingsModal = () => {
    if (!isHostView || !isAudio) return null;
    const currentSlots = Math.max(2, Math.min(12, Number(slotInput) || audioSlotCount));
    return (
      <Modal visible={showSlotModal} transparent animationType="fade" onRequestClose={() => setShowSlotModal(false)}>
        <TouchableOpacity style={styles.slotModalOverlay} activeOpacity={1} onPress={() => setShowSlotModal(false)}>
          <TouchableOpacity activeOpacity={1} style={styles.slotModalCard} onPress={() => {}}>
            <View style={styles.modalHandle} />
            <Text style={styles.slotModalTitle}>Chairs</Text>
            <Text style={styles.slotModalSubtitle}>How many chairs do you want in this live room? This includes the host chair.</Text>

            <View style={styles.slotInputRow}>
              <TouchableOpacity
                style={styles.slotStepperBtn}
                onPress={() => setSlotInput(String(Math.max(2, currentSlots - 1)))}
              >
                <Ionicons name="remove" size={20} color="#FFF" />
              </TouchableOpacity>
              <TextInput
                value={slotInput}
                onChangeText={(text) => setSlotInput(text.replace(/[^0-9]/g, '').slice(0, 2))}
                keyboardType="number-pad"
                style={styles.slotInput}
                placeholder="8"
                placeholderTextColor="rgba(255,255,255,0.35)"
                selectTextOnFocus
              />
              <TouchableOpacity
                style={styles.slotStepperBtn}
                onPress={() => setSlotInput(String(Math.min(12, currentSlots + 1)))}
              >
                <Ionicons name="add" size={20} color="#FFF" />
              </TouchableOpacity>
            </View>

            <Text style={styles.slotRangeHint}>Allowed: 2-12 chairs</Text>

            <View style={styles.slotModalActions}>
              <TouchableOpacity style={styles.slotCancelBtn} onPress={() => setShowSlotModal(false)}>
                <Text style={styles.slotCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.slotSaveBtn}
                onPress={() => {
                  applyAudioSlotCount(currentSlots);
                  setShowSlotModal(false);
                }}
              >
                <LinearGradient colors={['#00C2FF', '#D92BFF']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.slotSaveGradient}>
                  <Text style={styles.slotSaveText}>Save</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    );
  };

  const renderHostToolsSheet = () => {
    if (!isHostView || isAudio) return null;
    // 4-up grid of the host's live controls. Reuses the same handlers
    // the old sidebar had so behaviour is unchanged — only the
    // surface has moved. Each tile shows an "active" tint when its
    // feature is in a non-default state (cam off, beauty on).
    const beautyOn = (beautyLevels.smooth + beautyLevels.whiten + beautyLevels.redness + beautyLevels.sharp) > 0;
    const tools = [
      {
        key:     'flip',
        label:   'Flip',
        icon:    'camera-reverse',
        color:   '#FFF',
        onPress: () => { setIsFrontCam(!isFrontCam); agora.switchCamera(); },
        active:  false,
      },
      {
        key:     'cam',
        label:   isCamOn ? 'Cam On' : 'Cam Off',
        icon:    isCamOn ? 'videocam' : 'videocam-off',
        color:   isCamOn ? '#4ADE80' : '#EF4444',
        onPress: () => setIsCamOn(!isCamOn),
        active:  !isCamOn,
      },
      {
        key:     'beauty',
        label:   'Beauty',
        icon:    'sparkles',
        color:   beautyOn ? '#FBBF24' : '#FFF',
        onPress: () => { setShowHostTools(false); setShowBeautySheet(true); },
        active:  beautyOn,
      },
      {
        key:     'sfx',
        label:   'SFX',
        icon:    'musical-note',
        color:   '#FFF',
        onPress: () => { setShowHostTools(false); setShowSFXMenu(true); },
        active:  false,
      },
    ];
    return (
      <Modal visible={showHostTools} transparent animationType="slide" onRequestClose={() => setShowHostTools(false)}>
        <TouchableOpacity style={styles.moreOverlay} activeOpacity={1} onPress={() => setShowHostTools(false)}>
          <View style={[styles.hostToolsSheet, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
            <View style={styles.modalHandle} />
            <Text style={styles.hostToolsTitle}>Host Tools</Text>
            <View style={styles.hostToolsGrid}>
              {tools.map((t) => (
                <TouchableOpacity
                  key={t.key}
                  style={styles.hostToolsTile}
                  onPress={t.onPress}
                  activeOpacity={0.85}
                >
                  <View style={[styles.hostToolsTileIcon, t.active && styles.hostToolsTileIconActive]}>
                    <Ionicons name={t.icon} size={26} color={t.color} />
                  </View>
                  <Text style={styles.hostToolsTileLabel}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    );
  };

  const renderBroadcastSummaryModal = () => {
    if (!finalSummaryData) return null;
    return (
      <Modal visible={showSummary} transparent animationType="slide">
        <View style={styles.summaryOverlay}>
          <LinearGradient colors={[BRAND.splashBg, '#251B45']} style={styles.summaryCard}>
            <View style={styles.summaryAvatarWrapper}>
              <Image source={{ uri: stream.coverUrl }} style={styles.summaryAvatar} />
              <View style={styles.summaryBadge}>
                <Ionicons name="trophy" size={14} color="#FFF" />
              </View>
            </View>
            <Text style={styles.summaryTitle}>Live Stream Ended</Text>
            <Text style={styles.summarySubtitle}>Great work, Broadcaster!</Text>

            <View style={styles.summaryStatsRow}>
              <View style={styles.sumStatItem}>
                <Ionicons name="time" size={16} color="#38BDF8" />
                <Text style={styles.sumStatValue}>{finalSummaryData.duration}</Text>
                <Text style={styles.sumStatLabel}>Duration</Text>
              </View>
              <View style={styles.sumStatBar} />
              <View style={styles.sumStatItem}>
                <Ionicons name="people" size={16} color="#FBBF24" />
                <Text style={styles.sumStatValue}>{finalSummaryData.follows}</Text>
                <Text style={styles.sumStatLabel}>Follows</Text>
              </View>
              <View style={styles.sumStatBar} />
              <View style={styles.sumStatItem}>
                <Ionicons name="gift" size={16} color={BRAND.primary} />
                <Text style={styles.sumStatValue}>{finalSummaryData.gifts}</Text>
                <Text style={styles.sumStatLabel}>Gifts</Text>
              </View>
              <View style={styles.sumStatBar} />
              <View style={styles.sumStatItem}>
                <Ionicons name="diamond" size={16} color="#FBBF24" />
                <Text style={styles.sumStatValue}>{finalSummaryData.diamonds}</Text>
                <Text style={styles.sumStatLabel}>Earnings</Text>
              </View>
            </View>

            {finalSummaryData.hourBeans > 0 && (
              <View style={styles.rewardBanner}>
                <LinearGradient colors={['rgba(251, 191, 36, 0.2)', 'transparent']} style={styles.rewardBannerInner}>
                  <Ionicons name="trophy" size={20} color="#FBBF24" />
                  <View style={{ marginLeft: 12 }}>
                    <Text style={styles.rewardBannerTitle}>1 Hour Live Reward!</Text>
                    <Text style={styles.rewardBannerVal}>+{finalSummaryData.hourBeans.toLocaleString()} Beans added to wallet</Text>
                  </View>
                </LinearGradient>
              </View>
            )}

            <TouchableOpacity
              style={styles.summaryDoneBtn}
              onPress={() => {
                setShowSummary(false);
                // replace instead of push so the broadcast screen unmounts —
                // otherwise its BackHandler stays active and intercepts back
                // presses on later screens.
                router.replace('/main/(tabs)/');
              }}
            >
              <LinearGradient colors={[BRAND.primary, BRAND.primaryAlt]} style={styles.summaryDoneGradient}>
                <Text style={styles.summaryDoneText}>Back to Home</Text>
              </LinearGradient>
            </TouchableOpacity>
          </LinearGradient>
        </View>
      </Modal>
    );
  };

  const renderLiveEndedForViewer = () => (
    <Modal visible={isLiveEndedForViewer} transparent animationType="fade">
      <View style={styles.summaryOverlay}>
        <LinearGradient colors={[BRAND.splashBg, '#251B45']} style={styles.summaryCard}>
          <View style={styles.summaryAvatarWrapper}>
            <Image source={{ uri: stream.coverUrl }} style={styles.summaryAvatar} />
          </View>
          <Text style={styles.summaryTitle}>Live Ended</Text>
          <Text style={styles.summarySubtitle}>{stream.broadcasterName} has ended the stream.</Text>

          <View style={styles.summaryStatsRow}>
            <View style={styles.sumStatItem}>
              <Ionicons name="diamond" size={16} color="#FBBF24" />
              <Text style={styles.sumStatValue}>{earnings}</Text>
              <Text style={styles.sumStatLabel}>Sent</Text>
            </View>
            <View style={styles.sumStatBar} />
            <View style={styles.sumStatItem}>
              <Ionicons name="time" size={16} color="#38BDF8" />
              <Text style={styles.sumStatValue}>12m</Text>
              <Text style={styles.sumStatLabel}>Watched</Text>
            </View>
          </View>

          <View style={{ width: '100%', gap: 12 }}>
            <TouchableOpacity
              style={[styles.summaryDoneBtn, { marginTop: 0 }]}
              onPress={async () => {
                const ok = await followUser(stream.id);
                if (ok) {
                  setIsFollowing(true);
                  showCuteAlert("Followed", "You are now following this broadcaster!");
                }
              }}
            >
              <LinearGradient colors={[BRAND.primary, BRAND.primaryAlt]} style={styles.summaryDoneGradient}>
                <Text style={styles.summaryDoneText}>Follow Broadcaster</Text>
              </LinearGradient>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.summaryDoneBtn, { marginTop: 0, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' }]}
              onPress={() => {
                setIsLiveEndedForViewer(false);
                router.replace('/main/(tabs)/');
              }}
            >
              <View style={styles.summaryDoneGradient}>
                <Text style={styles.summaryDoneText}>Back to Home</Text>
              </View>
            </TouchableOpacity>
          </View>
        </LinearGradient>
      </View>
    </Modal>
  );

  const addReaction = (type, broadcast = false) => {
    const id = Date.now() + Math.random().toString();
    setReactions(prev => [...prev, { id, type, x: Math.random() * 40 - 20 }]);
    setTimeout(() => {
      setReactions(prev => prev.filter(r => r.id !== id));
    }, 4000);
    // Broadcast so the host + every viewer sees the floating reaction too.
    if (broadcast && channelRef.current) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'reaction',
        payload: { type, by: user?.id },
      });
    }
  };

  const renderChatList = () => (
    <View
      style={[
        styles.chatListContainer,
        // Responsive cap: video rooms get 30% of screen height so the
        // host's camera feed isn't visually competing with a wall of
        // chat; audio rooms get 40% since the seat grid already pushes
        // chat lower. With these caps the chat always sits in the
        // bottom slice of the screen instead of climbing toward the
        // top.
        { maxHeight: Math.round(height * (isAudio ? 0.40 : 0.30)) },
      ]}
    >
      <FlatList
        data={chats}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        inverted={true}
        style={{ flex: 1 }}
        contentContainerStyle={[styles.chatList, { justifyContent: 'flex-end' }]}
        renderItem={({ item }) => {
          if (item.type === 'system') {
            return (
              <View style={styles.systemAlertBlock}>
                <Text style={styles.systemAlertText}>{item.message}</Text>
              </View>
            );
          }
          if (item.type === 'gift') {
            return (
              <View style={styles.chatMessageRow}>
                <View style={[styles.chatBubble, styles.giftChatBubble]}>
                  <Text style={styles.chatUserText}>
                    <Text style={{ color: '#FBBF24', fontWeight: 'bold' }}>{item.user} </Text>
                    <Text style={{ color: '#E5E7EB' }}>sent </Text>
                    <Text style={{ color: '#F472B6', fontWeight: 'bold' }}>
                      {item.multiplier > 1 ? item.multiplier + 'x ' : ''}{item.giftName}
                    </Text>
                    <Text style={{ color: '#E5E7EB' }}> to {item.target} 🎁</Text>
                  </Text>
                </View>
              </View>
            );
          }
          if (item.type === 'entrance') {
            return (
              <View style={styles.entranceBlock}>
                <LinearGradient colors={['rgba(244,114,182,0.2)', 'transparent']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.entranceGradient}>
                  <Text style={styles.entranceText}>{item.message}</Text>
                </LinearGradient>
              </View>
            );
          }
          if (item.type === 'live_notification') {
            const p = item.payload || {};
            const isGift = item.subType === 'gift';
            const tint = isGift ? 'rgba(251,191,36,0.18)' : 'rgba(244,63,94,0.18)';
            const border = isGift ? '#FBBF24' : '#F43F5E';
            const accent = isGift ? '#FBBF24' : '#F87171';
            const icon = isGift ? '🎁' : '💰';
            const body = isGift
              ? `${p.senderName || 'Someone'} sent ${p.count > 1 ? p.count + 'x ' : ''}${p.giftName || 'a gift'} to ${p.hostName || 'a host'}`
              : `${p.dropperName || 'Someone'} dropped ${(Number(p.perWinner) * Number(p.winnerCount || 0)).toLocaleString()} 💎 Lucky Bag — ${p.winnerCount || 0} winners`;
            return (
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => {
                  if (!p.roomId) return;
                  const m = p.mode || 'audio';
                  const t = p.type || '';
                  router.replace(`/broadcast/${p.roomId}?mode=${m}${t ? `&type=${t}` : ''}`);
                }}
                style={[styles.liveNotifBlock, { backgroundColor: tint, borderColor: border }]}
              >
                <Text style={styles.liveNotifIcon}>{icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.liveNotifBody} numberOfLines={2}>{body}</Text>
                  <Text style={[styles.liveNotifCta, { color: accent }]}>▶ Tap to join {p.hostName || ''}</Text>
                </View>
              </TouchableOpacity>
            );
          }
          const isGuardian = item.userId && guardianIds.includes(item.userId);
          const VIP_NAME_COLOR = { VIP: '#CBD5E1', SVIP: '#FCD34D', VVIP: '#F472B6' };
          const VIP_BORDER     = { VIP: 'rgba(203,213,225,0.5)', SVIP: 'rgba(252,211,77,0.5)', VVIP: 'rgba(244,114,182,0.6)' };
          const VIP_BADGE      = { VIP: 'VIP', SVIP: 'SVIP', VVIP: 'VVIP' };
          const tierColor      = item.vipType ? VIP_NAME_COLOR[item.vipType] : null;
          const tierBorder     = item.vipType ? VIP_BORDER[item.vipType]     : null;
          return (
            <View style={styles.chatMessageRow}>
              <View style={[
                styles.chatBubble,
                item.isHost && { borderColor: 'rgba(251,191,36,0.5)', borderWidth: 1 },
                !item.isHost && tierBorder && { borderColor: tierBorder, borderWidth: 1 },
                !item.isHost && !tierBorder && isGuardian && { borderColor: 'rgba(168,85,247,0.5)', borderWidth: 1 },
              ]}>
                <Text style={styles.chatUserText}>
                  {item.isHost && (
                    <Text style={{ color: '#FBBF24', fontSize: 10, fontWeight: 'bold' }}> [Host] </Text>
                  )}
                  {!item.isHost && item.vipType && (
                    <Text style={{ color: tierColor, fontSize: 9, fontWeight: 'bold' }}>{VIP_BADGE[item.vipType]} </Text>
                  )}
                  {isGuardian && !item.isHost && (
                    <Text style={{ color: '#A855F7', fontSize: 11, fontWeight: 'bold' }}>♛ </Text>
                  )}
                  <Text style={{ color: tierColor || item.color, fontWeight: 'bold' }}>{item.user}: </Text>
                  {item.message}
                </Text>
              </View>
            </View>
          );
        }}
      />
      {/* Top fade gradient was removed — it read as a visible black
          band on the dark canvas behind both audio AND video rooms
          (the dark colour stacked on top of an equally dark
          background). The maxHeight cap on chatListContainer is the
          real fix; a hard top edge is the standard Bigo/Tango/Likee
          look anyway. */}
    </View>
  );

  const handleShareRoom = async () => {
    // Brand-aware share link — host swaps when tenant.config changes,
    // so each white-labelled deploy shares its own URL + app name.
    const url = `${TENANT_CONFIG.shareDomain}/live/${id}`;
    const message = `🔴 ${stream.broadcasterName} is live on ${TENANT_CONFIG.appName}! Join now: ${url}`;
    let shared = false;
    try {
      const { Share } = require('react-native');
      const result = await Share.share({ message, url });
      shared = result?.action !== 'dismissedAction';
    } catch (e) {
      showCuteAlert('Share', message);
    }
    // Credit the daily "share a stream" mission. Fire-and-forget so a
    // network blip doesn't disrupt the share toast the OS just showed.
    if (shared && !isHostView) {
      claimShareTask?.();
    }
  };

  // Bottom-bar "More" sheet — home for secondary actions so the comment row
  // stays clean. New features (lucky bag, report, etc.) get added here.
  const refreshGifterRanking = async () => {
    if (!id) return;
    const { data } = await supabase.rpc('room_gifter_ranking', { room_host: id, max_n: 10 });
    if (Array.isArray(data)) setGifterRanking(data);
  };
  useEffect(() => { if (showRankingSheet) refreshGifterRanking(); }, [showRankingSheet]);

  // Guardians = top 3 gifters to this host in the last 7 days. Crown badge
  // shown next to their name in chat + viewer list.
  //
  // refreshGuardians used to fire after EVERY gift send (line 1734) which
  // meant 100x bulk sends in a 10x combo = 100 RPC calls. We now expose a
  // debounced trigger (`scheduleGuardianRefresh`) that the gift handler
  // calls; the actual RPC runs at most once per second after a flurry of
  // sends.
  const guardianRefreshTimerRef = useRef(null);
  const refreshGuardians = async () => {
    if (!id) return;
    const { data } = await supabase.rpc('room_get_guardians', { host_id: id });
    if (Array.isArray(data)) setGuardianIds(data.map(r => r.guardian_id));
  };
  const scheduleGuardianRefresh = () => {
    if (!id) return;
    if (guardianRefreshTimerRef.current) clearTimeout(guardianRefreshTimerRef.current);
    guardianRefreshTimerRef.current = setTimeout(refreshGuardians, 1000);
  };
  useEffect(() => {
    refreshGuardians();
    return () => {
      if (guardianRefreshTimerRef.current) clearTimeout(guardianRefreshTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ──────────────────────────────────────────────────────────────────
  // Per-seat earnings — diamonds received this session, per receiver.
  //
  // Strategy is hybrid: one RPC for the authoritative aggregate, then
  // optimistic increments on each realtime gift broadcast for instant
  // visual feedback. A 30s reconcile loop catches any drift (dropped
  // broadcasts, double-counts, etc) so the numbers can't run away.
  //
  // The map is keyed by receiver profile id, so it's stable across
  // seat shuffles — if a guest moves from seat 3 to seat 5 their
  // accumulated count moves with them.
  // ──────────────────────────────────────────────────────────────────
  const refreshSeatEarnings = async () => {
    if (!id) return;
    const { data, error } = await supabase.rpc('get_room_seat_earnings', { p_host_id: id });
    if (error || !Array.isArray(data)) return;
    // Replace, don't merge — RPC is authoritative for what's currently
    // in the DB. A local optimistic increment that lost the race with
    // a server-side rollback would be corrected here, which is the
    // entire point of the reconcile pass.
    const next = {};
    data.forEach((r) => {
      if (r?.receiver_id) {
        next[r.receiver_id] = Number(r.diamonds_received) || 0;
      }
    });
    setSeatEarnings(next);
  };
  useEffect(() => {
    if (!id) return undefined;
    refreshSeatEarnings();
    // Reconcile every 30s. Cheap RPC + small payload + no realtime
    // overhead — fine to fire on a steady cadence.
    const t = setInterval(refreshSeatEarnings, 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // === Lucky Bag ===
  // Anyone in the room (host, co-host on call, or viewer) can throw a
  // bag — the SQL deducts from the caller and the dropper is recorded
  // as host_id so they cannot claim their own bag. The room owner (id)
  // is passed as p_room_host_id so per-room history attribution stays
  // correct even when a viewer drops the bag.
  const handleDropLuckyBag = async () => {
    if (!id) return;
    const { data, error } = await supabase.rpc('create_lucky_bag', {
      prize_diamonds: luckyBagPrize,
      winner_count:   luckyBagWinners,
      p_room_host_id: id,
    });
    if (error) { showCuteAlert('Drop failed', error.message); return; }
    setShowLuckyBagDrop(false);
    const perWinner = Math.floor(luckyBagPrize / luckyBagWinners);
    const dropperName = (user?.user_metadata?.full_name) || user?.email?.split('@')[0] || 'Someone';
    // Random landing spot. Range tuned to avoid the top header (avatar
    // + viewers count), the bottom chat input bar, and the audio seat
    // grid in the centre. posX 0.18–0.78 keeps the bag clear of the
    // right-side action cluster; posY 0.55–0.72 keeps it below the
    // seat grid and above the chat. Same range for video mode — only
    // the host's face overlaps slightly, and that's fine.
    const posX = 0.18 + Math.random() * 0.60;
    const posY = 0.55 + Math.random() * 0.17;
    const dropAt = new Date().toISOString();
    // Broadcast to all viewers so the bag appears for everyone instantly.
    if (channelRef.current) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'lucky_bag_dropped',
        payload: {
          bagId: data,
          perWinner,
          winners: luckyBagWinners,
          droppedBy: user?.id,
          dropperName,
          dropAt,
          posX,
          posY,
        },
      });
    }
    // Cross-live notification — fan out to every other room's chat
    // so viewers can hop in and grab a piece of the bag.
    if (globalEventsChannelRef.current) {
      try {
        globalEventsChannelRef.current.send({
          type: 'broadcast',
          event: 'lucky_bag_in_live',
          payload: {
            roomId: id,
            mode,
            type,
            hostId: stream?.broadcasterId,
            hostName: stream?.broadcasterName,
            hostAvatar: stream?.coverUrl,
            dropperName,
            perWinner,
            winnerCount: luckyBagWinners,
          },
        });
      } catch (_) {}
    }
    // Dropper also sees the countdown + bag — the SQL blocks them from
    // claiming, and renderActiveLuckyBag's tap handler disables for the
    // dropper, so they can't accidentally claim from their own bag.
    setActiveLuckyBag({
      id: data,
      perWinner,
      winners: luckyBagWinners,
      droppedBy: user?.id,
      dropperName,
      dropAt,
      posX,
      posY,
    });
    setTimeout(() => setActiveLuckyBag(null), 75000); // 15s reveal + 60s claim
  };

  // Phase / countdown driver. Re-runs whenever a new bag lands. Reads
  // off dropAt + a 15-second reveal window; ticks every 250ms so the
  // displayed countdown number is snappy but not over-rendered.
  useEffect(() => {
    if (!activeLuckyBag?.dropAt) {
      setLuckyBagPhase('idle');
      setLuckyBagCountdown(0);
      return undefined;
    }
    const dropMs = new Date(activeLuckyBag.dropAt).getTime();
    const revealAt = dropMs + 15000; // 15-second reveal delay
    const tick = () => {
      const remaining = Math.ceil((revealAt - Date.now()) / 1000);
      if (remaining > 0) {
        setLuckyBagPhase('pending');
        setLuckyBagCountdown(remaining);
      } else {
        setLuckyBagPhase('open');
        setLuckyBagCountdown(0);
      }
    };
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLuckyBag?.dropAt, activeLuckyBag?.id]);

  // Run the entrance + pulse animations whenever a new bag opens up.
  // The drop spring is one-shot (settles in ~600 ms with a small
  // bounce); the pulse halo loops until the bag closes or this user
  // taps. We reset both values when the bag id changes so a fresh
  // drop always re-plays the entrance instead of inheriting the
  // settled state of the previous one.
  useEffect(() => {
    if (luckyBagPhase !== 'open') return undefined;
    luckyDropAnim.setValue(0);
    Animated.spring(luckyDropAnim, {
      toValue: 1,
      friction: 5.5,
      tension: 55,
      useNativeDriver: true,
    }).start();

    luckyPulseAnim.setValue(0);
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(luckyPulseAnim, {
          toValue: 1,
          duration: 750,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(luckyPulseAnim, {
          toValue: 0,
          duration: 750,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );
    pulseLoop.start();
    return () => { try { pulseLoop.stop(); } catch (_) {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [luckyBagPhase, activeLuckyBag?.id]);

  // Fetch winners list for a settled / opened bag. Uses the SECURITY
  // DEFINER RPC added in migration 91 so we can pull profile names +
  // avatars in one round-trip without fighting profiles' SELECT RLS.
  const fetchLuckyBagWinners = async (bagId) => {
    setLuckyBagLoadingWinners(true);
    const { data, error } = await supabase.rpc('get_lucky_bag_winners', { p_bag_id: bagId });
    setLuckyBagLoadingWinners(false);
    if (error) return [];
    return Array.isArray(data) ? data : [];
  };

  const handleClaimLuckyBag = async () => {
    if (!activeLuckyBag || luckyBagClaiming) return;
    // Gate: the bag is visually hidden during the 15s reveal, but a
    // stale tap on the countdown banner could still trip this. Bail
    // until the open phase to be safe.
    if (luckyBagPhase !== 'open') return;
    setLuckyBagClaiming(true);
    const { data, error } = await supabase.rpc('claim_lucky_bag', { bag: activeLuckyBag.id });
    setLuckyBagClaiming(false);
    if (error) { showCuteAlert('Claim failed', error.message); return; }

    // After the claim attempt — whether it landed a prize or not —
    // show the winners list so the user sees where they ranked
    // (or that they missed). This is the Streamkar-style "tap → see
    // who won" UX.
    const wonAmount = Number(data) || 0;
    const winners = await fetchLuckyBagWinners(activeLuckyBag.id);
    setLuckyBagWinnersList(winners);

    // Find this user's rank in the winners list. If the claim worked
    // their row will be there; if they were too late, it won't.
    const myRow = winners.find((w) => w.user_id === user?.id);
    if (myRow) {
      setLuckyBagMyResult({
        kind:   'won',
        amount: Number(myRow.amount) || wonAmount,
        rank:   Number(myRow.rank),
      });
    } else if (activeLuckyBag.droppedBy === user?.id) {
      // The dropper can never appear in the winners list (SQL blocks
      // self-claim), so show a distinct "your bag" header instead of
      // the regretful sorry one.
      setLuckyBagMyResult({ kind: 'owner' });
    } else {
      setLuckyBagMyResult({ kind: 'missed' });
    }

    setShowLuckyBagWinners(true);
    // Hide the bag for THIS user once they've tapped — they've seen
    // their result, so a second tap would be wasted. Other users in
    // the room still see the bag until either they claim or the 75s
    // timer trims it.
    setLuckyBagPhase('done');
  };

  const renderBeautySheet = () => {
    const EFFECTS = [
      { key: 'smooth',  label: 'Smooth',    color: BRAND.primary, desc: 'Soften skin' },
      { key: 'whiten',  label: 'Whiten',    color: '#FBBF24', desc: 'Brighten complexion' },
      { key: 'redness', label: 'Rosy',      color: '#EC4899', desc: 'Rosy cheeks' },
      { key: 'sharp',   label: 'Sharpness', color: '#38BDF8', desc: 'Detail enhance' },
    ];
    const PRESETS = [
      { name: 'Off',     preset: { smooth: 0, whiten: 0, redness: 0, sharp: 0 } },
      { name: 'Natural', preset: { smooth: 1, whiten: 1, redness: 1, sharp: 0 } },
      { name: 'Glow',    preset: { smooth: 2, whiten: 2, redness: 2, sharp: 1 } },
      { name: 'Strong',  preset: { smooth: 4, whiten: 3, redness: 3, sharp: 2 } },
    ];
    const isActive = (p) => Object.keys(p).every(k => p[k] === beautyLevels[k]);
    return (
      <Modal visible={showBeautySheet} transparent animationType="slide" onRequestClose={() => setShowBeautySheet(false)}>
        <TouchableOpacity style={styles.moreOverlay} activeOpacity={1} onPress={() => setShowBeautySheet(false)}>
          <View style={[styles.moreSheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.modalHandle} />
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 6 }}>
              <Ionicons name="sparkles" size={20} color="#FBBF24" />
              <Text style={[styles.moreTitle, { marginLeft: 8 }]}>Beauty</Text>
            </View>
            <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, textAlign: 'center', marginBottom: 14 }}>
              Powered by your Agora SDK — no extra cost.
            </Text>

            {/* Preset row */}
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
              {PRESETS.map(p => {
                const active = isActive(p.preset);
                return (
                  <TouchableOpacity
                    key={p.name}
                    style={{
                      flex: 1, paddingVertical: 9, borderRadius: 18, alignItems: 'center', borderWidth: 1,
                      backgroundColor: active ? `${BRAND.primary}2E` : 'transparent',
                      borderColor: active ? BRAND.primary : 'rgba(255,255,255,0.18)',
                    }}
                    onPress={() => setBeautyLevels(p.preset)}
                  >
                    <Text style={{ color: active ? BRAND.primary : '#FFF', fontWeight: '700', fontSize: 12 }}>{p.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Effect rows — bar-style picker (0..4) */}
            {EFFECTS.map(eff => (
              <View key={eff.key} style={{ marginBottom: 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: eff.color, marginRight: 8 }} />
                    <Text style={{ color: '#FFF', fontSize: 13, fontWeight: '600' }}>{eff.label}</Text>
                    <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, marginLeft: 8 }}>{eff.desc}</Text>
                  </View>
                  <Text style={{ color: eff.color, fontSize: 11, fontWeight: '700' }}>{beautyLevels[eff.key]} / 4</Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  {[0, 1, 2, 3, 4].map(lvl => {
                    const filled = beautyLevels[eff.key] >= lvl && lvl > 0;
                    const isZero = lvl === 0;
                    return (
                      <TouchableOpacity
                        key={lvl}
                        activeOpacity={0.7}
                        style={{
                          flex: 1, height: 14, borderRadius: 7,
                          backgroundColor: filled ? eff.color : (isZero && beautyLevels[eff.key] === 0 ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.08)'),
                          borderWidth: isZero ? 1 : 0,
                          borderColor: 'rgba(255,255,255,0.2)',
                        }}
                        onPress={() => setBeautyLevels(prev => ({ ...prev, [eff.key]: lvl }))}
                      />
                    );
                  })}
                </View>
              </View>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    );
  };

  const renderLuckyBagDropModal = () => {
    const PRIZE_OPTIONS  = [100, 500, 1000, 5000, 10000];
    const WINNER_OPTIONS = [1, 5, 10, 20];
    return (
      <Modal visible={showLuckyBagDrop} transparent animationType="slide" onRequestClose={() => setShowLuckyBagDrop(false)}>
        <View style={styles.moreOverlay}>
          <View style={[styles.moreSheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.modalHandle} />
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 6 }}>
              <Ionicons name="gift" size={20} color="#FBBF24" />
              <Text style={[styles.moreTitle, { marginLeft: 8 }]}>Drop Lucky Bag</Text>
            </View>
            <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11, textAlign: 'center', marginBottom: 12 }}>
              Pay {luckyBagPrize.toLocaleString()} 💎 — split equally among first {luckyBagWinners} viewers to claim. Bag expires in 60 seconds.
            </Text>

            <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, marginBottom: 6 }}>Prize pool</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
              {PRIZE_OPTIONS.map(p => (
                <TouchableOpacity
                  key={p}
                  style={{
                    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1,
                    backgroundColor: luckyBagPrize === p ? 'rgba(251,191,36,0.2)' : 'transparent',
                    borderColor: luckyBagPrize === p ? '#FBBF24' : 'rgba(255,255,255,0.2)',
                  }}
                  onPress={() => setLuckyBagPrize(p)}
                >
                  <Text style={{ color: luckyBagPrize === p ? '#FBBF24' : '#FFF', fontWeight: '600' }}>
                    {p.toLocaleString()} 💎
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, marginBottom: 6 }}>Winners</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
              {WINNER_OPTIONS.map(w => (
                <TouchableOpacity
                  key={w}
                  style={{
                    flex: 1, paddingVertical: 10, borderRadius: 20, borderWidth: 1, alignItems: 'center',
                    backgroundColor: luckyBagWinners === w ? 'rgba(56,189,248,0.2)' : 'transparent',
                    borderColor: luckyBagWinners === w ? '#38BDF8' : 'rgba(255,255,255,0.2)',
                  }}
                  onPress={() => setLuckyBagWinners(w)}
                >
                  <Text style={{ color: luckyBagWinners === w ? '#38BDF8' : '#FFF', fontWeight: '600' }}>{w}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                style={{ flex: 1, paddingVertical: 12, borderRadius: 24, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' }}
                onPress={() => setShowLuckyBagDrop(false)}
              >
                <Text style={{ color: '#FFF', fontWeight: '600' }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{ flex: 1.5, paddingVertical: 12, borderRadius: 24, alignItems: 'center', backgroundColor: '#FBBF24' }}
                onPress={handleDropLuckyBag}
              >
                <Text style={{ color: BRAND.splashBg, fontWeight: '700' }}>Drop Bag</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  const renderActiveLuckyBag = () => {
    if (!activeLuckyBag) return null;
    // Once this user has claimed (or seen the result), the bag is
    // hidden for them. Other users still see it until they claim or
    // the 75-second outer timeout trims activeLuckyBag.
    if (luckyBagPhase === 'done') return null;

    // Pending phase: top banner with countdown. No tappable bag yet.
    // This is the Streamkar-style "drop announcement" — gives everyone
    // a chance to glance at the screen and ready their thumb without
    // letting the first viewer to load instantly snipe the bag.
    if (luckyBagPhase === 'pending') {
      return (
        <View pointerEvents="none" style={[styles.luckyBagPendingBanner, { top: insets.top + 60 }]}>
          <View style={styles.luckyBagPendingInner}>
            <Text style={styles.luckyBagPendingIcon}>🎉</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.luckyBagPendingTitle}>
                Lucky Bag dropping{activeLuckyBag.dropperName ? ` from ${activeLuckyBag.dropperName}` : ''}
              </Text>
              <Text style={styles.luckyBagPendingSub}>
                Get ready — appears in {luckyBagCountdown}s
              </Text>
            </View>
            <View style={styles.luckyBagPendingTimer}>
              <Text style={styles.luckyBagPendingTimerText}>{luckyBagCountdown}</Text>
            </View>
          </View>
        </View>
      );
    }

    // Open phase: bag visible at the randomised landing spot.
    // Disabled only for the dropper (SQL also blocks them). Anyone
    // else can tap to claim — first N win, the rest see the
    // winners list with a sorry header.
    const droppedByMe = activeLuckyBag.droppedBy && user?.id && activeLuckyBag.droppedBy === user.id;
    // Place the bag at the broadcast-supplied percent-of-screen
    // coordinates, clamped slightly inside the edges so it never
    // gets sliced off on narrow phones.
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const left = `${(clamp(activeLuckyBag.posX, 0.05, 0.78) * 100).toFixed(1)}%`;
    const top  = `${(clamp(activeLuckyBag.posY, 0.30, 0.78) * 100).toFixed(1)}%`;

    // Drop entrance: slide in from 240 px above the resting position
    // with a small bounce. The interpolation also fades opacity in so
    // the bag doesn't pop in mid-air during the spring overshoot.
    const dropTranslateY = luckyDropAnim.interpolate({
      inputRange:  [0, 1],
      outputRange: [-240, 0],
    });
    const dropOpacity = luckyDropAnim.interpolate({
      inputRange:  [0, 0.25, 1],
      outputRange: [0, 1, 1],
    });

    // Pulse halo: a second circle behind the sack that expands and
    // fades on a 1.5 s loop. Scale stops at 1.35 so it doesn't grow
    // larger than the implicit tap area.
    const pulseScale = luckyPulseAnim.interpolate({
      inputRange:  [0, 1],
      outputRange: [1, 1.35],
    });
    const pulseOpacity = luckyPulseAnim.interpolate({
      inputRange:  [0, 1],
      outputRange: [0.55, 0],
    });

    return (
      <View pointerEvents="box-none" style={StyleSheet.absoluteFillObject}>
        <Animated.View
          style={[
            styles.luckyBagTile,
            { left, top, transform: [{ translateY: dropTranslateY }], opacity: dropOpacity },
          ]}
        >
          <TouchableOpacity
            activeOpacity={0.85}
            disabled={droppedByMe || luckyBagClaiming}
            onPress={handleClaimLuckyBag}
            style={{ alignItems: 'center' }}
          >
            <View style={styles.luckyBagSackWrap}>
              {/* Pulsing golden halo behind the sack — pure
                  attention-grabber; no input role. */}
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.luckyBagPulseHalo,
                  { opacity: pulseOpacity, transform: [{ scale: pulseScale }] },
                ]}
              />
              {/* The sack itself. LUCKY_BAG_IMAGE (top of file) wins
                  the moment it's defined; until then we render a
                  bag-shaped emoji + drawstring detail so the visual
                  isn't just a flat circle. */}
              <View style={styles.luckyBagSack}>
                {LUCKY_BAG_IMAGE ? (
                  <Image source={LUCKY_BAG_IMAGE} style={styles.luckyBagSackImage} resizeMode="contain" />
                ) : (
                  <>
                    <View style={styles.luckyBagDrawstring} />
                    <Text style={styles.luckyBagSackIcon}>💰</Text>
                  </>
                )}
              </View>
            </View>
            <View style={styles.luckyBagTileBadge}>
              <Text style={styles.luckyBagTileBadgeText}>
                {droppedByMe ? 'Your bag' : (luckyBagClaiming ? '…' : 'Tap!')}
              </Text>
            </View>
          </TouchableOpacity>
        </Animated.View>
      </View>
    );
  };

  // ── Winners list modal (shown after this user taps a bag) ─────────
  // Header tells them what just happened (won / sorry / your-bag);
  // body is the full ranked list with avatars + amounts. Tapping the
  // backdrop or close button dismisses.
  const renderLuckyBagWinnersModal = () => {
    if (!showLuckyBagWinners) return null;
    const result = luckyBagMyResult;
    const headerCfg = (() => {
      if (result?.kind === 'won') {
        return {
          icon:  '🎉',
          title: 'You Won!',
          sub:   `+${Number(result.amount).toLocaleString()} 💎 · You ranked #${result.rank}`,
          tint:  '#FBBF24',
        };
      }
      if (result?.kind === 'owner') {
        return {
          icon:  '🎁',
          title: 'Your Lucky Bag',
          sub:   `${luckyBagWinnersList.length} viewer${luckyBagWinnersList.length === 1 ? '' : 's'} grabbed your beans`,
          tint:  '#A855F7',
        };
      }
      return {
        icon:  '😅',
        title: 'Sorry!',
        sub:   'Better luck next time — see who grabbed it below',
        tint:  '#F87171',
      };
    })();

    return (
      <Modal
        visible={showLuckyBagWinners}
        transparent
        animationType="fade"
        onRequestClose={() => setShowLuckyBagWinners(false)}
      >
        <TouchableOpacity
          style={styles.luckyBagWinnersOverlay}
          activeOpacity={1}
          onPress={() => setShowLuckyBagWinners(false)}
        >
          <View style={styles.luckyBagWinnersCard}>
            <View style={[styles.luckyBagWinnersHeader, { backgroundColor: `${headerCfg.tint}22` }]}>
              <Text style={styles.luckyBagWinnersIcon}>{headerCfg.icon}</Text>
              <Text style={[styles.luckyBagWinnersTitle, { color: headerCfg.tint }]}>{headerCfg.title}</Text>
              <Text style={styles.luckyBagWinnersSub}>{headerCfg.sub}</Text>
            </View>

            {luckyBagLoadingWinners ? (
              <View style={{ padding: 32, alignItems: 'center' }}>
                <Text style={{ color: 'rgba(255,255,255,0.6)' }}>Loading...</Text>
              </View>
            ) : luckyBagWinnersList.length === 0 ? (
              <View style={{ padding: 32, alignItems: 'center' }}>
                <Text style={{ color: 'rgba(255,255,255,0.6)' }}>No grabbers yet.</Text>
              </View>
            ) : (
              <FlatList
                data={luckyBagWinnersList}
                keyExtractor={(item) => `${item.user_id}-${item.rank}`}
                style={{ maxHeight: 360 }}
                renderItem={({ item }) => {
                  const isMe = item.user_id === user?.id;
                  return (
                    <View style={[styles.luckyBagWinnerRow, isMe && styles.luckyBagWinnerRowMe]}>
                      <View style={styles.luckyBagWinnerRank}>
                        <Text style={styles.luckyBagWinnerRankText}>#{item.rank}</Text>
                      </View>
                      <Image
                        source={{ uri: item.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${item.user_id}` }}
                        style={styles.luckyBagWinnerAvatar}
                      />
                      <View style={{ flex: 1, marginLeft: 10 }}>
                        <Text style={styles.luckyBagWinnerName} numberOfLines={1}>
                          {item.full_name}{isMe ? ' (You)' : ''}
                        </Text>
                      </View>
                      <Text style={styles.luckyBagWinnerAmount}>
                        +{Number(item.amount).toLocaleString()} 💎
                      </Text>
                    </View>
                  );
                }}
              />
            )}

            <TouchableOpacity
              style={styles.luckyBagWinnersClose}
              onPress={() => setShowLuckyBagWinners(false)}
            >
              <Text style={styles.luckyBagWinnersCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    );
  };

  const renderRankingSheet = () => (
    <Modal visible={showRankingSheet} transparent animationType="slide" onRequestClose={() => setShowRankingSheet(false)}>
      <TouchableOpacity style={styles.moreOverlay} activeOpacity={1} onPress={() => setShowRankingSheet(false)}>
        <View style={[styles.moreSheet, { paddingBottom: insets.bottom + 16, maxHeight: '75%' }]}>
          <View style={styles.modalHandle} />
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}>
            <Ionicons name="trophy" size={20} color="#FBBF24" />
            <Text style={[styles.moreTitle, { marginLeft: 8 }]}>Top Gifters</Text>
          </View>
          <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, textAlign: 'center', marginBottom: 12 }}>
            Top contributors in this live session
          </Text>
          {gifterRanking.length === 0 ? (
            <Text style={{ color: 'rgba(255,255,255,0.5)', textAlign: 'center', paddingVertical: 30 }}>
              No gifts yet. Be the first contributor!
            </Text>
          ) : (
            <FlatList
              data={gifterRanking}
              keyExtractor={(item) => item.sender_id}
              renderItem={({ item, index }) => {
                const rank = index + 1;
                const medal = rank === 1 ? '#FBBF24' : rank === 2 ? '#D1D5DB' : rank === 3 ? '#CD7F32' : 'rgba(255,255,255,0.3)';
                return (
                  <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' }}>
                    <View style={{ width: 30, alignItems: 'center' }}>
                      <Text style={{ color: medal, fontSize: 14, fontWeight: 'bold' }}>{rank}</Text>
                    </View>
                    <Image
                      source={{ uri: item.sender_avatar || `https://picsum.photos/seed/${item.sender_id}/60` }}
                      style={{ width: 40, height: 40, borderRadius: 20 }}
                    />
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={{ color: '#FFF', fontSize: 13, fontWeight: '600' }} numberOfLines={1}>{item.sender_name || 'Anonymous'}</Text>
                      <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>{item.gift_count} gift{Number(item.gift_count) !== 1 ? 's' : ''}</Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Ionicons name="diamond" size={13} color="#38BDF8" />
                      <Text style={{ color: '#38BDF8', fontWeight: 'bold', marginLeft: 4, fontSize: 13 }}>
                        {Number(item.total_diamonds).toLocaleString()}
                      </Text>
                    </View>
                  </View>
                );
              }}
            />
          )}
        </View>
      </TouchableOpacity>
    </Modal>
  );

  const submitReport = async () => {
    if (!reportTarget?.id || !reportReason) {
      showCuteAlert('Pick a reason', 'Please select a reason for the report.');
      return;
    }
    const { error } = await supabase.rpc('submit_user_report', {
      target: reportTarget.id,
      reason: reportReason,
      note: reportNote || null,
      room_host: id || null,
    });
    if (error) {
      showCuteAlert('Report failed', error.message);
      return;
    }
    setReportTarget(null);
    setReportReason(null);
    setReportNote('');
    showCuteAlert('Reported', 'Thanks — our moderators will review it.');
  };

  const renderReportModal = () => (
    <Modal visible={!!reportTarget} transparent animationType="slide" onRequestClose={() => setReportTarget(null)}>
      <View style={styles.moreOverlay}>
        <View style={[styles.moreSheet, { paddingBottom: insets.bottom + 16, maxHeight: '80%' }]}>
          <View style={styles.modalHandle} />
          <Text style={styles.moreTitle}>Report {reportTarget?.name || 'user'}</Text>
          <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, paddingHorizontal: 4, marginBottom: 10 }}>
            Pick the reason that best describes what happened.
          </Text>
          <ScrollView style={{ maxHeight: 280 }}>
            {REPORT_REASONS.map((r) => {
              const selected = reportReason === r.code;
              return (
                <TouchableOpacity
                  key={r.code}
                  style={{
                    flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 8,
                    borderRadius: 10, marginVertical: 2,
                    backgroundColor: selected ? `${BRAND.primary}1F` : 'transparent',
                    borderWidth: 1, borderColor: selected ? BRAND.primary : 'rgba(255,255,255,0.08)',
                  }}
                  onPress={() => setReportReason(r.code)}
                >
                  <Ionicons
                    name={selected ? 'radio-button-on' : 'radio-button-off'}
                    size={18}
                    color={selected ? BRAND.primary : 'rgba(255,255,255,0.4)'}
                  />
                  <Text style={{ color: '#FFF', marginLeft: 10, fontSize: 13 }}>{r.label}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          <TextInput
            style={{
              color: '#FFF', backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 10,
              paddingHorizontal: 12, paddingVertical: 10, marginTop: 12, fontSize: 13, minHeight: 60,
              textAlignVertical: 'top',
            }}
            placeholder="Add a note (optional)"
            placeholderTextColor="rgba(255,255,255,0.4)"
            value={reportNote}
            onChangeText={setReportNote}
            multiline
            maxLength={300}
          />
          <View style={{ flexDirection: 'row', marginTop: 14, gap: 10 }}>
            <TouchableOpacity
              style={{ flex: 1, paddingVertical: 12, borderRadius: 24, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' }}
              onPress={() => { setReportTarget(null); setReportReason(null); setReportNote(''); }}
            >
              <Text style={{ color: '#FFF', fontWeight: '600' }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{ flex: 1, paddingVertical: 12, borderRadius: 24, alignItems: 'center', backgroundColor: BRAND.primary }}
              onPress={submitReport}
            >
              <Text style={{ color: '#FFF', fontWeight: '700' }}>Submit Report</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );

  const renderBlockedSheet = () => (
    <Modal visible={showBlockedSheet} transparent animationType="slide" onRequestClose={() => setShowBlockedSheet(false)}>
      <TouchableOpacity style={styles.moreOverlay} activeOpacity={1} onPress={() => setShowBlockedSheet(false)}>
        <View style={[styles.moreSheet, { paddingBottom: insets.bottom + 16, maxHeight: '70%' }]}>
          <View style={styles.modalHandle} />
          <Text style={styles.moreTitle}>Blocked Users</Text>
          {blockedList.length === 0 ? (
            <Text style={{ color: 'rgba(255,255,255,0.5)', textAlign: 'center', paddingVertical: 30 }}>
              No blocked users.
            </Text>
          ) : (
            <FlatList
              data={blockedList}
              keyExtractor={(item) => item.blocked_id}
              renderItem={({ item }) => (
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' }}>
                  <Image
                    source={{ uri: item.avatar || `https://picsum.photos/seed/${item.blocked_id}/60` }}
                    style={{ width: 44, height: 44, borderRadius: 22 }}
                  />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={{ color: '#FFF', fontSize: 14, fontWeight: '600' }}>{item.name || 'User'}</Text>
                    {item.reason && <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }} numberOfLines={1}>{item.reason}</Text>}
                  </View>
                  <TouchableOpacity
                    style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18, borderWidth: 1, borderColor: '#38BDF8' }}
                    onPress={async () => {
                      const { error } = await supabase.rpc('room_unblock_user', { target: item.blocked_id });
                      if (error) { showCuteAlert('Unblock failed', error.message); return; }
                      await refreshBlockedList();
                    }}
                  >
                    <Text style={{ color: '#38BDF8', fontSize: 12, fontWeight: '600' }}>Unblock</Text>
                  </TouchableOpacity>
                </View>
              )}
            />
          )}
        </View>
      </TouchableOpacity>
    </Modal>
  );

  const renderMoreMenu = () => (
    <Modal visible={showMoreMenu} transparent animationType="fade" onRequestClose={() => setShowMoreMenu(false)}>
      <TouchableOpacity style={styles.moreOverlay} activeOpacity={1} onPress={() => setShowMoreMenu(false)}>
        <View style={[styles.moreSheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.modalHandle} />
          <Text style={styles.moreTitle}>More</Text>
          <View style={styles.moreGrid}>
            <TouchableOpacity style={styles.moreItem} onPress={() => { setShowMoreMenu(false); handleShareRoom(); }}>
              <View style={[styles.moreIconBox, { backgroundColor: 'rgba(56,189,248,0.15)' }]}>
                <Ionicons name="share-social" size={24} color="#38BDF8" />
              </View>
              <Text style={styles.moreItemText}>Share</Text>
            </TouchableOpacity>

            {isHostView && (
              <TouchableOpacity style={styles.moreItem} onPress={() => { setShowMoreMenu(false); setShowBlockedSheet(true); }}>
                <View style={[styles.moreIconBox, { backgroundColor: 'rgba(239,68,68,0.15)' }]}>
                  <Ionicons name="shield-half" size={24} color="#EF4444" />
                </View>
                <Text style={styles.moreItemText}>Blocked</Text>
              </TouchableOpacity>
            )}

            {/* Anyone with diamonds can throw a Lucky Bag in any room;
                the SQL deducts from the dropper and blocks them from
                claiming their own bag. */}
            <TouchableOpacity style={styles.moreItem} onPress={() => { setShowMoreMenu(false); setShowLuckyBagDrop(true); }}>
              <View style={[styles.moreIconBox, { backgroundColor: 'rgba(251,191,36,0.15)' }]}>
                <Ionicons name="gift" size={24} color="#FBBF24" />
              </View>
              <Text style={styles.moreItemText}>Lucky Bag</Text>
            </TouchableOpacity>

            {/* Direct-message the host without leaving the room. We close
                the live screen on navigation — keeping the broadcast room
                mounted underneath the chat screen costs CPU and battery
                for a feature the user is actively walking away from. */}
            {!isHostView && id && (
              <TouchableOpacity
                style={styles.moreItem}
                onPress={() => {
                  setShowMoreMenu(false);
                  const hostName = encodeURIComponent(stream?.broadcasterName || 'Host');
                  router.push(`/main/chat/${id}?name=${hostName}`);
                }}
              >
                <View style={[styles.moreIconBox, { backgroundColor: 'rgba(168,85,247,0.18)' }]}>
                  <Ionicons name="chatbubble-ellipses" size={24} color="#A855F7" />
                </View>
                <Text style={styles.moreItemText}>Message Host</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </TouchableOpacity>
    </Modal>
  );

  const renderInteractiveBar = () => {
    if (isHostView && !isKeyboardVisible) return renderHostControlBar();

    const onCall = callRequestStatus === 'accepted';

    return (
      <View style={[styles.inputAreaWrap, {
        // Edge-to-edge (app.config.js edgeToEdgeEnabled:true) means the
        // input draws under the system gesture indicator unless we add
        // bottom padding. Users on Vivo/Xiaomi/etc. reported the input
        // box being half-covered by the gesture bar and unclickable.
        // insets.bottom is the authoritative value from
        // react-native-safe-area-context, but on a few OEMs the inset
        // gets reported as 0 or as a stale value before the first
        // layout. Floor at 24dp on Android (gesture indicator height +
        // a 4dp tap buffer) and 16dp on iOS (small home indicator)
        // so the input is always tappable regardless of how the OEM
        // reports its safe area.
        paddingBottom: isKeyboardVisible
          ? 8
          : Math.max(insets.bottom, Platform.OS === 'android' ? 24 : 16),
      }]}>
        {/* Co-host broadcasting controls — only while on the mic, on their own
            row so they never crowd the comment input. */}
        {!isHostView && onCall && !isKeyboardVisible && (
          <View style={styles.coHostStrip}>
            <TouchableOpacity
              style={[styles.coHostBtn, isSelfMuted && styles.coHostBtnDanger]}
              onPress={() => {
                if (forcedMuted) {
                  showCuteAlert('Muted by host', 'The host has muted you. You can’t unmute yourself until they unmute you.');
                  return;
                }
                setIsSelfMuted(!isSelfMuted);
              }}
            >
              <Ionicons name={isSelfMuted ? 'mic-off' : 'mic'} size={20} color={isSelfMuted ? '#EF4444' : '#38BDF8'} />
              <Text style={styles.coHostBtnLabel}>{isSelfMuted ? 'Unmute' : 'Mute'}</Text>
            </TouchableOpacity>

            {!isAudio && (
              <>
                <TouchableOpacity style={styles.coHostBtn} onPress={() => { setIsFrontCam(!isFrontCam); agora.switchCamera(); }}>
                  <Ionicons name="camera-reverse" size={20} color="#38BDF8" />
                  <Text style={styles.coHostBtnLabel}>Flip</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.coHostBtn, !isCamOn && styles.coHostBtnDanger]} onPress={() => setIsCamOn(!isCamOn)}>
                  <Ionicons name={isCamOn ? 'videocam' : 'videocam-off'} size={20} color={isCamOn ? '#38BDF8' : '#EF4444'} />
                  <Text style={styles.coHostBtnLabel}>{isCamOn ? 'Cam' : 'Off'}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.coHostBtn} onPress={() => setShowBeautySheet(true)}>
                  <Ionicons name="sparkles" size={20} color={(beautyLevels.smooth + beautyLevels.whiten + beautyLevels.redness + beautyLevels.sharp) > 0 ? '#FBBF24' : '#38BDF8'} />
                  <Text style={styles.coHostBtnLabel}>Beauty</Text>
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity style={styles.coHostBtn} onPress={() => setShowSFXMenu(!showSFXMenu)}>
              <Ionicons name="musical-note" size={20} color="#FBBF24" />
              <Text style={styles.coHostBtnLabel}>SFX</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.coHostBtn, styles.coHostBtnDanger]} onPress={handleLeaveCall}>
              <Ionicons name="exit" size={20} color="#EF4444" />
              <Text style={[styles.coHostBtnLabel, { color: '#EF4444' }]}>Leave</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Comment row: input always keeps room; only 3 fixed actions. */}
        <View style={styles.inputArea}>
          <View style={styles.chatInputWrapper}>
            <TextInput
              ref={chatInputRef}
              style={styles.chatInput}
              placeholder="Say something..."
              placeholderTextColor="rgba(255,255,255,0.6)"
              value={chatMessage}
              onChangeText={setChatMessage}
              onSubmitEditing={handleSendMessage}
              returnKeyType="send"
              submitBehavior="submit"
              autoFocus={isKeyboardVisible}
            />
            {chatMessage.trim().length > 0 && (
              <TouchableOpacity style={styles.sendIconInside} onPress={handleSendMessage}>
                <Ionicons name="send" size={20} color={BRAND.primary} />
              </TouchableOpacity>
            )}
          </View>

          {!isKeyboardVisible && (
            <>
              <TouchableOpacity style={styles.actionCircleBtn} onPress={() => setGameMenuState('menu')}>
                <Ionicons name="game-controller" size={22} color="#FBBF24" />
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actionCircleBtn, styles.giftCircleBtn]} onPress={() => setShowGiftMenu(true)}>
                <Ionicons name="gift" size={22} color="#FFF" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionCircleBtn} onPress={() => setShowMoreMenu(true)}>
                <Ionicons name="ellipsis-horizontal" size={22} color="#FFF" />
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    );
  };

  // Permission gate — block live for host until camera/mic are granted
  if (isHost && (camMissing || micMissing)) {
    const needsCam = camMissing;
    const needsMic = micMissing;
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#0E111E', justifyContent: 'center', padding: 24 }}>
        <StatusBar barStyle="light-content" />
        <View style={{ alignItems: 'center' }}>
          <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: `${BRAND.primary}26`, justifyContent: 'center', alignItems: 'center', marginBottom: 20 }}>
            <Ionicons name={needsCam ? 'videocam' : 'mic'} size={36} color={BRAND.primary} />
          </View>
          <Text style={{ color: '#FFF', fontSize: 22, fontWeight: 'bold', marginBottom: 8, textAlign: 'center' }}>
            {needsCam && needsMic ? 'Camera & Mic Access Needed' : needsCam ? 'Camera Access Needed' : 'Microphone Access Needed'}
          </Text>
          <Text style={{ color: '#9CA3AF', fontSize: 14, textAlign: 'center', marginBottom: 24, lineHeight: 20 }}>
            {isVideoMode
              ? 'To go live we need access to your camera and microphone so viewers can see and hear you.'
              : 'To start an audio live we need access to your microphone.'}
          </Text>
          <TouchableOpacity
            style={{ backgroundColor: BRAND.primary, paddingVertical: 14, paddingHorizontal: 40, borderRadius: 12, marginBottom: 12 }}
            onPress={async () => {
              if (needsCam) {
                const res = await requestCameraPerm();
                if (!res.granted && !res.canAskAgain) Linking.openSettings();
              }
              if (needsMic) {
                const res = await requestMicPerm();
                if (!res.granted && !res.canAskAgain) Linking.openSettings();
              }
            }}
          >
            <Text style={{ color: '#FFF', fontWeight: 'bold', fontSize: 15 }}>
              {(cameraPerm?.canAskAgain === false || micPerm?.canAskAgain === false) ? 'Open Settings' : 'Grant Access'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.back()}>
            <Text style={{ color: '#9CA3AF', fontSize: 13 }}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <>
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />

      {/* Layer 0: Global Background — fullscreen HOST video via Agora.
          Host sees their own local feed; viewers/guests see the host's
          remote feed. Falls back to the cover image when video isn't live. */}
      {!isAudio && (
        <View style={[StyleSheet.absoluteFillObject, { overflow: 'hidden', backgroundColor: '#000' }]}>
          {(isHostView && isCamOn && agora.joined) ? (
            <View style={StyleSheet.absoluteFillObject}>
              <RtcSurfaceView style={StyleSheet.absoluteFillObject} canvas={{ uid: 0 }} />
              {renderFilterOverlay()}
            </View>
          ) : (!isHostView && agora.joined && agora.remoteUids.includes(hostUid) && !agora.videoOffUids.includes(hostUid)) ? (
            <View style={StyleSheet.absoluteFillObject}>
              <RtcSurfaceView style={StyleSheet.absoluteFillObject} canvas={{ uid: hostUid }} />
            </View>
          ) : (
            <View style={[StyleSheet.absoluteFillObject, { backgroundColor: BRAND.splashBg, justifyContent: 'center', alignItems: 'center' }]}>
              <LinearGradient
                colors={[`${BRAND.primary}2E`, 'rgba(107,78,255,0.10)', 'transparent']}
                style={[StyleSheet.absoluteFillObject, { opacity: 0.7 }]}
              />
              <View style={{ width: 130, height: 130, borderRadius: 65, borderWidth: 2, borderColor: `${BRAND.primary}66`, justifyContent: 'center', alignItems: 'center', shadowColor: BRAND.primary, shadowOpacity: 0.5, shadowRadius: 16, shadowOffset: { width: 0, height: 0 }, elevation: 12 }}>
                <Image source={{ uri: stream.coverUrl }} style={{ width: 118, height: 118, borderRadius: 59 }} />
              </View>
              {(!isHostView || isCamOn) ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 18, gap: 8 }}>
                  <LogoLoader size="small" />
                  <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: '500', letterSpacing: 0.3 }}>
                    {isHostView ? 'Going live' : 'Joining'}
                  </Text>
                </View>
              ) : (
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 18, gap: 6, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.4)' }}>
                  <Ionicons name="videocam-off" size={12} color="rgba(255,255,255,0.7)" />
                  <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '600' }}>Camera Off</Text>
                </View>
              )}
            </View>
          )}
        </View>
      )}

      {/* Layer 1: Core Interface & Specialized Backgrounds (Duo/Audio) */}
      <View style={styles.container} {...(!isHostView ? panResponder.panHandlers : {})}>
        {isAudio ? (
          <View style={StyleSheet.absoluteFillObject}>
            <Image source={AUDIO_ROOM_BACKGROUND} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
            <LinearGradient
              colors={['rgba(0,2,48,.10)', 'rgba(3,0,50,.05)', 'rgba(4,0,35,.28)']}
              style={StyleSheet.absoluteFillObject}
            />
            {/* Admin-curated room template (mig 88). Layered ABOVE the
                blurred cover so it actually shows, but with the seat
                grid + chat foreground sitting on top of it. resizeMode
                "cover" so portrait + landscape templates both fill the
                canvas without stretching. */}
            {activeTemplateId && (() => {
              const t = (audioTemplates || []).find((x) => x.id === activeTemplateId);
              if (!t || !t.background_url) return null;
              return (
                <Image
                  source={{ uri: t.background_url }}
                  style={StyleSheet.absoluteFillObject}
                  resizeMode="cover"
                  pointerEvents="none"
                />
              );
            })()}
          </View>
        ) : (
          renderVideoLayout()
        )}

        {/* Layered Foreground. react-native-keyboard-controller reports the
            true keyboard inset on edge-to-edge Android, so we raise the
            foreground's bottom edge by keyboardHeight when the keyboard is up.
            The flex:1 chat then shrinks naturally, and the input lands just
            above the keyboard on any device size. */}
        <View style={[styles.overlayForeground, isKeyboardVisible && { bottom: keyboardHeight }]}>
          {currentMusic && (
            <TouchableOpacity
              style={styles.musicMarquee}
              onPress={() => isHostView && setShowMusicModal(true)}
              activeOpacity={isHostView ? 0.7 : 1}
            >
              <Text style={styles.musicMarqueeText}>
                🎵 {isMusicPlaying ? 'Playing' : 'Paused'}: {currentMusic.title}
                {currentMusic.artist ? ` — ${currentMusic.artist}` : ''}
                {isHostView ? ' • Tap to control' : ''} •
              </Text>
            </TouchableOpacity>
          )}
          {renderEntranceBanner()}
          {renderTopActions()}
          {/* Tiny swipe hint pill — only when viewer entered from home with a
              non-trivial feed. Disappears on the first swipe. */}
          {!isHostView && siblingIds.length > 1 && (
            <View pointerEvents="none" style={[styles.swipeHint, { top: insets.top + 6 }]}>
              {currentIdx > 0 && (
                <Ionicons name="chevron-up" size={11} color="rgba(255,255,255,0.7)" />
              )}
              <Text style={styles.swipeHintText}>
                {Math.max(1, currentIdx + 1)} / {siblingIds.length}
              </Text>
              {currentIdx < siblingIds.length - 1 && (
                <Ionicons name="chevron-down" size={11} color="rgba(255,255,255,0.7)" />
              )}
            </View>
          )}
          {renderRoomTitle()}
          {renderVideoSideBar()}
          {!isAudio && renderLiveGoal()}
          {isAudio ? (
            <View style={[styles.middleSectionAudio, { paddingTop: insets.top + 190 }]}>
              {renderAudioRoomSeats()}
            </View>
          ) : (
            <View style={styles.middleSectionVideo}>
              {/* Title now part of host panel */}
            </View>
          )}
          {/* Chat + input dock — sits at the bottom of the column. Keyboard
              avoidance is handled by Android's softwareKeyboardLayoutMode:"resize"
              (in app.json) + flex-based layout above, so the OS automatically
              shrinks the available height when keyboard opens and the input
              naturally lands above it on every device size. */}
          {renderChatList()}
          {renderInteractiveBar()}

          {/* Floating Actions Cluster (Join Call & Heart) */}
          {!isHostView && !isKeyboardVisible && (
            <View style={styles.floatingActionCluster}>
              {callRequestStatus !== 'accepted' && (
                <TouchableOpacity
                  style={styles.floatingJoinBtnMain}
                  onPress={() => {
                    if (callRequestStatus === 'idle') {
                      if (channelRef.current) {
                        channelRef.current.send({
                          type: 'broadcast',
                          event: 'call_request',
                          payload: {
                            id: user?.id,
                            name: user?.name || 'Visitor',
                            avatar: user?.avatar || 'https://picsum.photos/seed/visitor/100/100',
                            vipType: user?.vipType || 'none',
                            vipExpiresAt: user?.vipExpiresAt || null,
                            selectedProfileFrame: user?.selectedProfileFrame || null,
                            selectedProfileFrameUrl: user?.selectedProfileFrameUrl || null,
                            videoEnabled: isVideoMode,
                          },
                        });
                      }
                      setCallRequestStatus('pending');
                    } else {
                      // Cancelling a pending request — tell the host to drop it
                      if (channelRef.current) {
                        channelRef.current.send({
                          type: 'broadcast',
                          event: 'call_cancel',
                          payload: { id: user?.id },
                        });
                      }
                      setCallRequestStatus('idle');
                    }
                  }}
                >
                  <LinearGradient
                    colors={callRequestStatus === 'pending' ? ['#F59E0B', '#D97706'] : ['#38BDF8', '#0EA5E9']}
                    style={styles.floatingJoinGradient}
                  >
                    {callRequestStatus === 'pending' ? (
                      <View style={{ alignItems: 'center' }}>
                        <Ionicons name="timer" size={18} color="#FFF" />
                        <View style={styles.pendingDot} />
                      </View>
                    ) : (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={{ fontSize: 18 }}>✋</Text>
                        <Text style={{ color: '#FFF', fontSize: 14, fontWeight: 'bold' }}>Join</Text>
                      </View>
                    )}
                  </LinearGradient>
                  {callRequestStatus === 'pending' && (
                    <View style={styles.pendingTag}>
                      <Text style={styles.pendingTagText}>Pending...</Text>
                    </View>
                  )}
                </TouchableOpacity>
              )}

              <TouchableOpacity
                style={styles.floatingHeartBtn}
                onPress={() => addReaction('heart', true)}
              >
                <LinearGradient
                  colors={[BRAND.primary, BRAND.primaryAlt]}
                  style={styles.floatingJoinGradient}
                >
                  <Ionicons name="heart" size={22} color="#FFF" />
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}


        </View>

        {/* Full Screen Lottie Magic Animation overlay */}
        {activeGiftAnimation.source && (
          <View style={styles.lottieFullScreenContainer} pointerEvents="none">
            <LottieView
              key={activeGiftAnimation.id}
              source={activeGiftAnimation.source}
              autoPlay
              speed={0.8}
              loop={activeGiftAnimation.loop}
              onAnimationFinish={() => {
                if (!activeGiftAnimation.loop) {
                  setActiveGiftAnimation((prev) => prev.id === activeGiftAnimation.id ? { id: null, source: null, loop: false } : prev);
                }
              }}
              style={styles.lottiePlayer}
              resizeMode="contain"
            />
          </View>
        )}
        {activeMallIntro && activeMallIntroSource ? (
          <MallIntroOverlay
            key={activeMallIntro.id}
            intro={activeMallIntro}
            source={activeMallIntroSource}
            onDone={finishActiveMallIntro}
          />
        ) : null}

        {/* Gift sender banner — rendered AFTER the gift animation so the
            sender's name sits ON TOP of the gift, not hidden behind it. */}
        {renderFloatingGiftToast()}

        {/* Modals placed last to overlay correctly naturally */}
        {renderLiveEndedForViewer()}
        {renderBroadcastSummaryModal()}
        {renderMusicPickerModal()}
        {renderManageCallsModal()}
        {renderGamesBottomSheet()}
        {renderGiftBottomSheet()}
        {renderTopUpModal()}
        {renderHostProfileModal()}
        {renderPremiumAdminModal()}
        {renderGoalSettingsModal()}
        {renderViewersListModal()}
        {renderViewerProfileModal()}
        {renderMoreMenu()}
        {renderBlockedSheet()}
        {renderReportModal()}
        {renderRankingSheet()}
        {renderLuckyBagDropModal()}
        {renderActiveLuckyBag()}
        {renderLuckyBagWinnersModal()}
        {renderBeautySheet()}
        {renderHostToolsSheet()}
        {renderHostMoreMenu()}
        {renderSlotSettingsModal()}
        {/* Audio room background picker — host-only, audio-only. The
            sheet itself enforces the same gates, but rendering only
            when relevant keeps the modal tree tidy. */}
        {isHostView && isAudio && (
          <AudioTemplateSheet
            visible={showAudioTemplates}
            onClose={() => setShowAudioTemplates(false)}
            streamId={streamRecordId}
            activeTemplateId={activeTemplateId}
            onApplied={(id) => setActiveTemplateId(id)}
          />
        )}
        {showSFXMenu && renderSFXMenu()}

        {/* Floating Reactions Layer */}
        <View style={styles.reactionsOverlay} pointerEvents="none">
          {reactions.map(reaction => (
            <FloatingEmoji key={reaction.id} type={reaction.type} offset={reaction.x} />
          ))}
        </View>
      </View>
    </>
  );
}

// Marquee Text Component for auto-scrolling long names/titles
const MarqueeText = ({ text, style, containerWidth }) => {
  const scrollAnim = useRef(new Animated.Value(0)).current;
  const [contentWidth, setContentWidth] = useState(0);
  const [containerMeasuredWidth, setContainerMeasuredWidth] = useState(containerWidth || 0);

  useEffect(() => {
    if (contentWidth > containerMeasuredWidth && containerMeasuredWidth > 0) {
      scrollAnim.setValue(0);
      const duration = (contentWidth / 40) * 1000; // Adjust speed here

      Animated.loop(
        Animated.timing(scrollAnim, {
          toValue: -contentWidth - 20, // Move past the content + gap
          duration: duration,
          easing: Easing.linear,
          useNativeDriver: true,
        })
      ).start();
    } else {
      scrollAnim.stopAnimation();
      scrollAnim.setValue(0);
    }
  }, [contentWidth, containerMeasuredWidth, text]);

  return (
    <View
      style={[{ overflow: 'hidden', width: containerMeasuredWidth || 'auto' }, style]}
      onLayout={(e) => !containerWidth && setContainerMeasuredWidth(e.nativeEvent.layout.width)}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        scrollEnabled={false}
        contentContainerStyle={{ flexDirection: 'row' }}
      >
        <Animated.View
          style={{ flexDirection: 'row', transform: [{ translateX: scrollAnim }] }}
          onLayout={(e) => setContentWidth(e.nativeEvent.layout.width)}
        >
          <Text style={style}>{text}</Text>
          {contentWidth > containerMeasuredWidth && (
            <Text style={[style, { marginLeft: 20 }]}>{text}</Text>
          )}
        </Animated.View>
      </ScrollView>
    </View>
  );
};

// Floating Emoji Sub-component
const FloatingEmoji = ({ type, offset }) => {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 3500,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true
    }).start();
  }, []);

  const translateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -height * 0.5]
  });
  const opacity = anim.interpolate({
    inputRange: [0, 0.2, 0.8, 1],
    outputRange: [0, 1, 0.8, 0]
  });
  const translateX = anim.interpolate({
    inputRange: [0, 0.25, 0.5, 0.75, 1],
    outputRange: [0, offset, -offset, offset, 0]
  });

  return (
    <Animated.View style={[styles.floatingEmoji, { transform: [{ translateY }, { translateX }], opacity }]}>
      <Text style={{ fontSize: 24 }}>{type === 'heart' ? '❤️' : '👏'}</Text>
    </Animated.View>
  );
};

// STYLES
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  videoBackgroundMap: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  videoOverlayGradient: { position: 'absolute', bottom: 0, width: '100%', height: height * 0.4 },
  audioBackgroundBlur: { ...StyleSheet.absoluteFillObject, resizeMode: 'cover' },
  overlayForeground: { ...StyleSheet.absoluteFillObject, flexDirection: 'column', justifyContent: 'space-between' },

  lottieFullScreenContainer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 99,
    elevation: 99,
    justifyContent: 'center',
    alignItems: 'center',
    pointerEvents: 'none',
  },
  lottiePlayer: { width: width * 0.95, height: height * 0.85 },
  mallIntroOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 210,
    elevation: 210,
    backgroundColor: 'rgba(0,0,0,0.62)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mallIntroVideo: {
    width: MALL_INTRO_WIDTH,
    height: MALL_INTRO_MAX_HEIGHT,
    maxHeight: height * 0.92,
    backgroundColor: 'transparent',
  },
  mallIntroVideoHidden: {
    opacity: 0,
  },
  mallIntroNamePill: {
    position: 'absolute',
    bottom: Math.max(44, height * 0.1),
    maxWidth: width * 0.82,
    paddingHorizontal: 15,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: 'rgba(9, 8, 34, 0.58)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  mallIntroNameText: { color: '#FFF', fontSize: 13, fontWeight: '800' },

  topActions: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, zIndex: 110, alignItems: 'flex-start' },
  // Left wrapper for the host bar. Uses flex so the bar can shrink
  // when the right-side viewer cluster grows, and minWidth: 0 so
  // children with intrinsic widths (the marquee) don't push the
  // whole container past the available row width.
  topLeftContainer: { flex: 1, minWidth: 0, marginRight: 8 },
  swipeHint: { position: 'absolute', alignSelf: 'center', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 3, zIndex: 111 },
  swipeHintText: { color: 'rgba(255,255,255,0.85)', fontSize: 10, fontWeight: '700', letterSpacing: 0.4, backgroundColor: 'rgba(0,0,0,0.45)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  broadcasterPanelWrapper: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 25, paddingRight: 4, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  broadcasterPanel: { flexDirection: 'row', alignItems: 'center', padding: 4, paddingRight: 8 },
  hostAvatarSmall: { width: 40, height: 40, borderRadius: 20 },
  hostInfo: { marginHorizontal: 10, justifyContent: 'center' },
  hostName: { color: '#FFF', fontSize: 13, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 1, height: 1 }, textShadowRadius: 3 },
  viewerCountBubble: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  viewerCountText: { color: 'rgba(255,255,255,0.8)', fontSize: 10, marginLeft: 4, fontWeight: 'bold' },
  followBtn: { backgroundColor: BRAND.primary, width: 28, height: 28, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  // Follow button sits flush with the bar's right edge so it reads as
  // PART of the bar, not a separate floating chip. No outer margin;
  // the wrapper's `paddingRight: 4` handles the edge spacing. Reduced
  // size + thinner border = visually integrated.
  hostFollowBtn: {},
  hostFollowGradient: { width: 28, height: 28, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  // Compact ack badge that briefly shows next to the host name right
  // after a Follow. No text, just a checkmark — animation handles the
  // "registered your tap" feedback.
  justFollowedBadge: { width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(74,222,128,0.18)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.55)', alignItems: 'center', justifyContent: 'center', marginRight: 4 },

  topRightActions: { flexDirection: 'row', alignItems: 'center' },
  topViewers: { flexDirection: 'row', alignItems: 'center' },
  topViewerAvatar: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' },
  topViewerCount: { width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', marginLeft: 4, zIndex: 150, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  rankingChip: { width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(251,191,36,0.15)', justifyContent: 'center', alignItems: 'center', marginLeft: 4, zIndex: 150, borderWidth: 1, borderColor: 'rgba(251,191,36,0.5)' },
  audioTopShell: {
    position: 'absolute',
    left: 20,
    right: 20,
    zIndex: 120,
  },
  audioTopNav: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  audioTopNavRight: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  audioVisitorStrip: { flexDirection: 'row', alignItems: 'center', marginRight: 1 },
  audioVisitorAvatars: { flexDirection: 'row', alignItems: 'center' },
  audioVisitorAvatarWrap: {
    width: 28,
    height: 28,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.75)',
    backgroundColor: '#180B67',
  },
  audioVisitorAvatar: { width: '100%', height: '100%', borderRadius: 14 },
  audioVisitorCountBtn: {
    minWidth: 28,
    height: 28,
    borderRadius: 14,
    marginLeft: -5,
    paddingHorizontal: 7,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(217,222,230,0.86)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.95)',
  },
  audioVisitorCountText: { color: '#3A4050', fontSize: 11, fontWeight: '900' },
  audioAssetButton: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center' },
  audioAssetIcon: { width: 46, height: 46 },
  audioTrophyButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(65, 23, 111, 0.82)',
    borderWidth: 1.2,
    borderColor: '#FFAE37',
    shadowColor: '#FFAE37',
    shadowOpacity: 0.65,
    shadowRadius: 9,
    elevation: 9,
  },
  audioHostHero: {
    width: '100%',
    minHeight: 76,
    marginTop: 16,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingTop: 9,
    paddingBottom: 9,
    backgroundColor: 'rgba(12, 8, 77, 0.2)',
    borderWidth: 1.2,
    borderColor: 'rgba(120, 206, 255, 0.85)',
    shadowColor: '#B832FF',
    shadowOpacity: 0.55,
    shadowRadius: 14,
    elevation: 10,
    overflow: 'hidden',
  },
  audioHostHeroBg: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
    borderRadius: 14,
    opacity: 0.98,
  },
  audioHeroAvatarWrap: {
    width: 82,
    height: 82,
    alignItems: 'center',
    justifyContent: 'center',
  },
  audioHeroFrame: { position: 'absolute', width: 92, height: 92 },
  audioHeroAvatar: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#180B67' },
  audioHeroBadge: { position: 'absolute', width: 30, height: 30, left: -2, bottom: 0 },
  audioOnlineDot: {
    position: 'absolute', right: 2, bottom: 6,
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: '#22E681', borderWidth: 2, borderColor: '#21105B',
  },
  audioHeroCopy: { flex: 1, marginLeft: 13, minWidth: 0 },
  audioHeroTopLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 7,
  },
  audioHeroName: { flex: 1, minWidth: 0, color: '#FFF', fontSize: 15, fontWeight: '900' },
  audioHeroViewer: {
    paddingHorizontal: 7,
    height: 19,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(4, 4, 49, 0.72)',
  },
  audioHeroViewerText: { color: '#FFF', fontSize: 11, fontWeight: '700' },
  audioHeroMeta: {
    flexShrink: 1,
    paddingHorizontal: 7,
    height: 21,
    borderRadius: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(24, 13, 95, 0.86)',
    borderWidth: 1,
    borderColor: '#318DFF',
  },
  audioHeroMetaText: { color: '#FFF', fontSize: 9, fontWeight: '700' },
  audioHeroGoalRow: {
    marginTop: 7,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  audioHeroGoalTitleWrap: { flexDirection: 'row', alignItems: 'center', minWidth: 0 },
  audioHeroGoalIcon: {
    width: 18,
    height: 18,
    borderRadius: 9,
    marginRight: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,105,27,.18)',
    borderWidth: 1,
    borderColor: '#FF7838',
  },
  audioHeroGoalTitle: { color: '#FFF', fontSize: 12, fontWeight: '900' },
  audioHeroGoalEdit: { marginLeft: 6, padding: 2 },
  audioHeroGoalStatsWrap: { alignItems: 'flex-end' },
  audioHeroGoalStats: { color: '#FBBF24', fontSize: 13, fontWeight: '900' },
  audioHeroGoalCompleted: { color: '#D8D2FF', fontSize: 8, fontWeight: '700', marginTop: -2 },
  audioHeroGoalBarBg: {
    height: 6,
    marginTop: 5,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  audioHeroGoalBarFill: { height: '100%', borderRadius: 5 },
  // Legacy lucky bag styles — still referenced by older render paths.
  // The new countdown-banner + random-position bag tile use the
  // *Pending/Tile/Sack/Winners* groups below.
  luckyBagOverlay: { position: 'absolute', top: '38%', left: 0, right: 0, alignItems: 'center', zIndex: 130, elevation: 130 },
  luckyBagBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(26,18,48,0.95)', borderWidth: 2, borderColor: '#FBBF24', borderRadius: 22, paddingVertical: 10, paddingHorizontal: 14, shadowColor: '#FBBF24', shadowOpacity: 0.6, shadowRadius: 14, shadowOffset: { width: 0, height: 0 }, elevation: 12 },
  luckyBagInfo: { marginLeft: 10, marginRight: 14 },
  luckyBagPrize: { color: '#FBBF24', fontSize: 16, fontWeight: 'bold' },
  luckyBagSub: { color: 'rgba(255,255,255,0.7)', fontSize: 10 },
  luckyBagAction: { color: '#FFF', fontWeight: 'bold', fontSize: 12, backgroundColor: BRAND.primary, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12 },

  // Pending banner — top-of-screen drop-announce strip during the
  // 15-second reveal countdown. Non-tappable; the bag itself becomes
  // tappable once countdown hits zero.
  luckyBagPendingBanner: { position: 'absolute', left: 16, right: 16, zIndex: 140, elevation: 140 },
  luckyBagPendingInner: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(26,18,48,0.95)', borderWidth: 1.5, borderColor: '#FBBF24', borderRadius: 16, paddingVertical: 10, paddingHorizontal: 14, shadowColor: '#FBBF24', shadowOpacity: 0.5, shadowRadius: 12, elevation: 10 },
  luckyBagPendingIcon: { fontSize: 24, marginRight: 10 },
  luckyBagPendingTitle: { color: '#FFF', fontSize: 13, fontWeight: '700' },
  luckyBagPendingSub:   { color: 'rgba(255,255,255,0.7)', fontSize: 11, marginTop: 1 },
  luckyBagPendingTimer: { marginLeft: 10, width: 40, height: 40, borderRadius: 20, backgroundColor: '#FBBF24', justifyContent: 'center', alignItems: 'center' },
  luckyBagPendingTimerText: { color: BRAND.splashBg, fontSize: 16, fontWeight: '800' },

  // Open phase bag tile — small floating burlap-sack-style button at a
  // randomised (posX, posY) percent of screen. The badge underneath
  // signals tappability and shows "Your bag" for the dropper.
  luckyBagTile: { position: 'absolute', width: 96, alignItems: 'center', zIndex: 145, elevation: 145 },
  // Wrap exists only so the pulsing halo can sit absolutely behind
  // the sack without breaking the tile's vertical layout.
  luckyBagSackWrap: { width: 88, height: 88, justifyContent: 'center', alignItems: 'center' },
  // Halo — same dimensions as the sack, scaled + faded by the pulse
  // animation. Slightly larger border-radius so the soft edge looks
  // like a glow rather than a hard ring.
  luckyBagPulseHalo: { position: 'absolute', width: 88, height: 88, borderRadius: 50, backgroundColor: '#FBBF24', shadowColor: '#FBBF24', shadowOpacity: 0.9, shadowRadius: 20, shadowOffset: { width: 0, height: 0 } },
  luckyBagSack: { width: 84, height: 84, borderRadius: 42, backgroundColor: 'rgba(184,115,51,0.95)', justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: '#FBBF24', shadowColor: '#FBBF24', shadowOpacity: 0.7, shadowRadius: 16, shadowOffset: { width: 0, height: 0 }, elevation: 14, overflow: 'hidden' },
  // Drawstring detail — thin tan band across the top of the sack to
  // hint at a real burlap bag silhouette without needing the asset.
  luckyBagDrawstring: { position: 'absolute', top: 10, left: 14, right: 14, height: 4, borderRadius: 2, backgroundColor: '#E8D2A6', opacity: 0.85 },
  luckyBagSackIcon: { fontSize: 44, marginTop: 6 },
  // Used when LUCKY_BAG_IMAGE is wired up — fills the sack circle so
  // the user's burlap art is the entire visual.
  luckyBagSackImage: { width: 76, height: 76 },
  luckyBagTileBadge: { marginTop: 6, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 14, backgroundColor: BRAND.primary },
  luckyBagTileBadgeText: { color: '#FFF', fontWeight: '800', fontSize: 12 },

  // Winners-list modal — appears once a viewer taps the bag.
  luckyBagWinnersOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20 },
  luckyBagWinnersCard: { width: '100%', maxWidth: 380, backgroundColor: BRAND.splashBg, borderRadius: 24, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  luckyBagWinnersHeader: { paddingVertical: 22, paddingHorizontal: 18, alignItems: 'center' },
  luckyBagWinnersIcon:   { fontSize: 36, marginBottom: 6 },
  luckyBagWinnersTitle:  { fontSize: 22, fontWeight: '800', marginBottom: 4 },
  luckyBagWinnersSub:    { color: 'rgba(255,255,255,0.7)', fontSize: 12, textAlign: 'center' },
  luckyBagWinnerRow:     { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  luckyBagWinnerRowMe:   { backgroundColor: 'rgba(251,191,36,0.08)' },
  luckyBagWinnerRank:    { width: 36, height: 28, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.08)', justifyContent: 'center', alignItems: 'center', marginRight: 10 },
  luckyBagWinnerRankText:{ color: '#FBBF24', fontWeight: '700', fontSize: 11 },
  luckyBagWinnerAvatar:  { width: 34, height: 34, borderRadius: 17 },
  luckyBagWinnerName:    { color: '#FFF', fontSize: 13, fontWeight: '600' },
  luckyBagWinnerAmount:  { color: '#FBBF24', fontWeight: '700', fontSize: 13 },
  luckyBagWinnersClose:  { paddingVertical: 14, alignItems: 'center', backgroundColor: `${BRAND.primary}26` },
  luckyBagWinnersCloseText: { color: BRAND.primary, fontWeight: '700', fontSize: 14 },
  closeBtnCircle: { width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.3)' },

  middleSectionAudio: { justifyContent: 'flex-start' },
  middleSectionVideo: { flex: 1 },

  audioSeatsContainer: { alignItems: 'center', paddingHorizontal: 8 },
  seatGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', width: '100%', paddingTop: 8 },
  seatSlot: { width: (width - 16) / 4, alignItems: 'center', marginBottom: isSmallScreen ? 12 : 16 },
  occupiedSeat: { alignItems: 'center' },
  seatAvatar: { width: AUDIO_SEAT_AVATAR_SIZE, height: AUDIO_SEAT_AVATAR_SIZE, borderRadius: AUDIO_SEAT_AVATAR_SIZE / 2, backgroundColor: '#17095F' },
  seatAvatarRing: {
    width: AUDIO_SEAT_EMPTY_SIZE, height: AUDIO_SEAT_EMPTY_SIZE, borderRadius: AUDIO_SEAT_EMPTY_SIZE / 2,
    borderWidth: 1.5, borderColor: 'rgba(117,202,255,.8)',
    justifyContent: 'center', alignItems: 'center',
    backgroundColor: 'rgba(45,17,135,.34)',
  },
  seatAvatarRingHost: { borderColor: '#41D9FF', borderWidth: 2 },
  neonSeatFrame: {
    position: 'absolute',
    width: AUDIO_SEAT_FRAME_SIZE,
    height: AUDIO_SEAT_FRAME_SIZE,
    top: 0,
    left: 0,
    zIndex: 0,
  },
  seatProfileFrame: {
    position: 'absolute',
    width: AUDIO_SEAT_PROFILE_FRAME_SIZE,
    height: AUDIO_SEAT_PROFILE_FRAME_SIZE,
    top: (AUDIO_SEAT_FRAME_SIZE - AUDIO_SEAT_PROFILE_FRAME_SIZE) / 2,
    left: (AUDIO_SEAT_FRAME_SIZE - AUDIO_SEAT_PROFILE_FRAME_SIZE) / 2,
    zIndex: 8,
  },
  seatName: {
    color: '#FFF',
    fontSize: 10,
    fontWeight: '800',
    marginTop: 6,
    minWidth: 64,
    maxWidth: (width - 16) / 4 - 6,
    textAlign: 'center',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: 'rgba(21,8,91,.88)',
  },
  // Per-seat "💎 1.2k" earnings pill. Width is tracked to the seat
  // column so a 1.5M reading from a top gifter doesn't overflow into
  // the adjacent seat. Subtle gold tint to read as "value" without
  // competing with the speaking ring or VIP badge for attention.
  seatGiftBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(251, 191, 36, 0.12)',
    borderColor: 'rgba(251, 191, 36, 0.35)',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 1,
    marginTop: 3,
    maxWidth: (width - 32) / 4 - 4,
    gap: 3,
  },
  seatGiftBadgeText: {
    color: '#FCD34D',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  emptySeat: {
    width: AUDIO_SEAT_FRAME_SIZE, height: AUDIO_SEAT_FRAME_SIZE, borderRadius: AUDIO_SEAT_FRAME_SIZE / 2,
    backgroundColor: 'rgba(66,35,157,.34)',
    justifyContent: 'center', alignItems: 'center',
  },
  emptySeatNum: { color: '#E9E5FF', fontSize: 9, marginTop: 0, fontWeight: '800' },
  seatNumTag: {
    position: 'absolute', top: -2, left: -2,
    backgroundColor: '#38BDF8',
    minWidth: 18, height: 18, borderRadius: 9,
    paddingHorizontal: 4,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 1.5, borderColor: '#0E111E',
    zIndex: 10,
  },
  seatNumTagText: { color: '#FFF', fontSize: 9, fontWeight: 'bold' },
  guardianCrown: { position: 'absolute', top: -10, alignSelf: 'center', backgroundColor: '#A855F7', minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, justifyContent: 'center', alignItems: 'center', borderWidth: 1.5, borderColor: '#0E111E', zIndex: 11 },
  guardianCrownText: { color: '#FFF', fontSize: 10, fontWeight: 'bold', lineHeight: 12 },
  hostMuteBadge: { position: 'absolute', bottom: 0, right: 0, backgroundColor: '#EF4444', width: 22, height: 22, borderRadius: 11, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: '#0E111E' },
  seatLockBadge: { position: 'absolute', bottom: -10, backgroundColor: BRAND.primary30, paddingHorizontal: 4, borderRadius: 4 },
  seatLockText: { color: BRAND.primary, fontSize: 7, fontWeight: 'bold' },

  /* Pulse & Speaker Styles */
  pulseContainer: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', zIndex: -1 },
  pulseCircle: { position: 'absolute', width: AUDIO_SEAT_PULSE_SIZE, height: AUDIO_SEAT_PULSE_SIZE, borderRadius: AUDIO_SEAT_PULSE_SIZE / 2, backgroundColor: 'rgba(40,207,255,.3)', borderWidth: 1, borderColor: '#38D9FF' },
  avatarWrapper: { width: AUDIO_SEAT_FRAME_SIZE, height: AUDIO_SEAT_FRAME_SIZE, justifyContent: 'center', alignItems: 'center' },
  avatarRingSmall: { padding: 2, borderRadius: (AUDIO_SEAT_EMPTY_SIZE + 4) / 2, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  speakingRing: { borderColor: '#38BDF8', borderWidth: 2, shadowColor: '#38BDF8', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.8, shadowRadius: 5 },

  /* Gifting Recipient Selector */
  recipientSelector: { height: 60, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)', backgroundColor: 'rgba(255,255,255,0.02)' },
  recipientScroll: { paddingHorizontal: 12, alignItems: 'center' },
  recipientItem: { alignItems: 'center', marginRight: 12, padding: 3, borderRadius: 10, width: 50 },
  recipientActive: { backgroundColor: `${BRAND.primary}26`, borderWidth: 1, borderColor: BRAND.primary },
  recipientAvatar: { width: 28, height: 28, borderRadius: 14, marginBottom: 3, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  recipientIconAll: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#6B4EFF', justifyContent: 'center', alignItems: 'center', marginBottom: 3 },
  recipientName: { color: '#FFF', fontSize: 9, fontWeight: '500' },

  // flex:1 lets the container fill available space; the inline
  // maxHeight in renderChatList (30% of screen for video, 40% for
  // audio) then caps it so it doesn't climb past the middle of the
  // screen the way the old layout did (which gave both this and
  // middleSectionVideo flex:1 and let them split 50/50). minHeight
  // keeps a tiny dock visible when the room is silent.
  chatListContainer: { flex: 1, paddingHorizontal: 16, justifyContent: 'flex-end', marginBottom: 5, minHeight: 80 },
  hostControlBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 10, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)' },

  // Floating Gift Toast Banner
  // Responsive gift-arrival toast. Pinned to both left + right with a
  // device-aware max width so the gradient pill always sits inside
  // the screen even when the sender / target names + Lottie + combo
  // count would otherwise push past the edge. The inner flex layout
  // (left text block uses flex:1 + numberOfLines:1 in the JSX) handles
  // truncation cleanly.
  giftToastContainer: {
    position: 'absolute',
    bottom: height * 0.5,
    left: 12,
    right: 12,
    maxWidth: Math.min(width - 24, 360),
    zIndex: 120,
    elevation: 120,
  },
  giftToastGradient: { flexDirection: 'row', alignItems: 'center', padding: 6, paddingRight: 12, borderRadius: 28 },
  giftToastLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0 },
  giftToastAvatar: { width: 32, height: 32, borderRadius: 16, marginRight: 8, borderWidth: 1, borderColor: '#FFF' },
  giftToastUser: { color: '#FFF', fontSize: 12, fontWeight: 'bold' },
  giftToastAction: { color: '#FFF', fontSize: 10, opacity: 0.9 },
  giftToastRight: { flexDirection: 'row', alignItems: 'center', marginLeft: 8 },
  giftToastLottie: { width: 38, height: 38 },
  giftToastCombo: { color: '#FBBF24', fontSize: 18, fontWeight: '900', fontStyle: 'italic', marginLeft: 4, textShadowColor: '#000', textShadowOffset: { width: 1, height: 1 }, textShadowRadius: 2 },

  chatList: { paddingBottom: 10 },
  systemAlertBlock: { backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, alignSelf: 'flex-start', marginBottom: 8 },
  systemAlertText: { color: '#FBBF24', fontSize: 12 },
  entranceBlock: { marginBottom: 8, alignSelf: 'flex-start', borderRadius: 16, overflow: 'hidden' },
  entranceGradient: { paddingHorizontal: 16, paddingVertical: 6, borderRadius: 16 },
  entranceText: { color: '#F472B6', fontSize: 12, fontWeight: 'bold' },
  chatMessageRow: { marginBottom: 8, flexDirection: 'row' },
  chatBubble: { backgroundColor: 'rgba(0,0,0,0.4)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, maxWidth: width * 0.75 },
  giftChatBubble: { backgroundColor: 'rgba(244,114,182,0.18)', borderWidth: 1, borderColor: 'rgba(244,114,182,0.45)' },
  chatUserText: { color: '#FFF', fontSize: 13, lineHeight: 18 },
  liveNotifBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
    marginVertical: 3,
    marginHorizontal: 4,
  },
  liveNotifIcon: { fontSize: 22, marginRight: 10 },
  liveNotifBody: { color: '#FFF', fontSize: 12, fontWeight: '600' },
  liveNotifCta:  { fontSize: 11, fontWeight: '800', marginTop: 2 },
  inputAreaWrap: { paddingHorizontal: 16, marginTop: 4 },
  inputArea: { flexDirection: 'row', alignItems: 'center' },
  chatInputWrapper: { flex: 1, height: 44, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 22, paddingLeft: 16, paddingRight: 8, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  chatInput: { color: '#FFF', fontSize: 14, flex: 1, height: '100%' },
  sendIconInside: { padding: 6, justifyContent: 'center', alignItems: 'center' },
  actionCircleBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', marginLeft: 8 },
  giftCircleBtn: { backgroundColor: BRAND.primary, shadowColor: BRAND.primary, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.5, shadowRadius: 6, elevation: 4 },

  /* Co-host (on-mic) control strip — its own row above the comment input */
  coHostStrip: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  coHostBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', paddingHorizontal: 12, height: 36, borderRadius: 18 },
  coHostBtnDanger: { backgroundColor: 'rgba(239,68,68,0.15)', borderColor: '#EF4444' },
  coHostBtnLabel: { color: '#E5E7EB', fontSize: 12, fontWeight: '600', marginLeft: 6 },

  /* Bottom-bar "More" sheet */
  moreOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  moreSheet: { backgroundColor: BRAND.splashBg, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 8, paddingHorizontal: 20 },
  moreTitle: { color: '#FFF', fontSize: 16, fontWeight: 'bold', marginTop: 8, marginBottom: 16 },
  moreGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 20 },
  moreItem: { alignItems: 'center', width: 64 },
  moreIconBox: { width: 56, height: 56, borderRadius: 28, justifyContent: 'center', alignItems: 'center', marginBottom: 6 },
  moreItemText: { color: '#E5E7EB', fontSize: 12, fontWeight: '500' },
  btnDotNotify: { position: 'absolute', top: 10, right: 10, width: 8, height: 8, borderRadius: 4, backgroundColor: '#F59E0B', borderWidth: 1, borderColor: '#000' },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  modalContent: { backgroundColor: '#251B45', width: '100%', borderRadius: 24, padding: 24, alignItems: 'center' },
  modalAvatar: { width: 80, height: 80, borderRadius: 40, borderWidth: 3, borderColor: BRAND.primary, marginBottom: 16 },
  modalHostName: { color: '#FFF', fontSize: 22, fontWeight: 'bold', marginBottom: 8 },
  modalBio: { color: 'rgba(255,255,255,0.7)', fontSize: 14, textAlign: 'center', marginBottom: 20 },
  modalStats: { flexDirection: 'row', justifyContent: 'space-around', width: '100%', marginBottom: 24 },
  statBox: { alignItems: 'center' },
  statValue: { color: '#FFF', fontSize: 18, fontWeight: 'bold' },
  statLabel: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 4 },
  modalCloseBtn: { backgroundColor: BRAND.primary, paddingVertical: 12, paddingHorizontal: 40, borderRadius: 24, marginTop: 10 },
  modalCloseText: { color: '#FFF', fontWeight: 'bold', fontSize: 16 },

  /* Goal Settings Styles */
  goalSettingsCard: { backgroundColor: BRAND.splashBg, width: width * 0.85, borderRadius: 24, padding: 24, alignItems: 'center', borderWidth: 1, borderColor: '#FFD700' },
  goalModalTitle: { color: '#FFF', fontSize: 20, fontWeight: 'bold', marginBottom: 8 },
  goalModalSubtitle: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginBottom: 20 },
  goalInput: { width: '100%', height: 50, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 12, color: '#FFF', textAlign: 'center', fontSize: 20, fontWeight: 'bold', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', marginBottom: 20 },
  goalPresets: { flexDirection: 'row', gap: 10, marginBottom: 25 },
  presetBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.1)' },
  presetText: { color: '#FFF', fontSize: 12, fontWeight: 'bold' },
  saveGoalBtn: { width: '100%', borderRadius: 15, overflow: 'hidden' },
  saveGoalGradient: { paddingVertical: 14, alignItems: 'center' },
  saveGoalText: { color: '#FFF', fontWeight: 'bold', fontSize: 16 },

  /* Top Up Modal */
  topUpModalCard: { backgroundColor: BRAND.splashBg, width: '100%', borderRadius: 24, padding: 24, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  topUpTitle: { color: '#FFF', fontSize: 22, fontWeight: 'bold', marginBottom: 4 },
  topUpBalance: { color: '#38BDF8', fontSize: 14, fontWeight: 'bold', marginBottom: 20 },
  topUpPackagesContainer: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', width: '100%' },
  topUpPackageItem: { backgroundColor: 'rgba(255,255,255,0.05)', width: '48%', borderRadius: 16, padding: 16, alignItems: 'center', marginBottom: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  topUpDiamondBox: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  topUpDiamondsText: { color: '#FFF', fontSize: 18, fontWeight: 'bold', marginLeft: 6 },
  topUpPriceBox: { backgroundColor: BRAND.primary, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12 },
  topUpPriceText: { color: '#FFF', fontSize: 12, fontWeight: 'bold' },

  /* Gift Bottom Sheet Styles */
  giftModalOverlay: { flex: 1, backgroundColor: 'transparent', justifyContent: 'flex-end' },
  giftModalContent: { backgroundColor: '#0F091E', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 6 },
  // Visual drag indicator at the top of every bottom-sheet so the modal
  // reads as dismissible even though the close X is also there.
  giftDragHandle: { width: 36, height: 4, backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 2, alignSelf: 'center', marginBottom: 8 },
  giftHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)' },
  // Tabs are now inside a horizontal ScrollView; the contentContainerStyle
  // is what gets `gap` so categories can extend off-screen without wrap.
  giftTabs: { flexDirection: 'row', gap: 6, paddingRight: 8, alignItems: 'center' },
  giftTabItem: { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 14 },
  giftTabItemActive: { backgroundColor: `${BRAND.primary}2E` },
  giftTabText: { color: 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: '700' },
  giftTabTextActive: { color: BRAND.primary },

  // Grid responsive sizing comes from GIFT_* constants at top of file so
  // every screen size gets a coherent tile/icon/lottie/font set.
  giftGridRow: { justifyContent: 'flex-start', paddingHorizontal: GIFT_GRID_HPAD / 2, paddingVertical: 3 },
  giftItemCard: { width: GIFT_TILE_W, alignItems: 'center', paddingVertical: 6, borderRadius: 12 },
  giftIconPlaceholder: { width: GIFT_ICON_SIZE, height: GIFT_ICON_SIZE, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: GIFT_ICON_SIZE / 2, justifyContent: 'center', alignItems: 'center', marginBottom: 4, overflow: 'hidden' },
  giftName: { color: '#FFF', fontSize: GIFT_NAME_FONT, marginBottom: 2, textAlign: 'center' },
  giftPriceRow: { flexDirection: 'row', alignItems: 'center' },
  giftPrice: { color: 'rgba(255,255,255,0.75)', fontSize: GIFT_PRICE_FONT, marginLeft: 3, fontWeight: '600' },

  // Bottom area: balance + send button. Slimmer paddings + smaller fonts so
  // the FlatList above gets back ~30px of grid space.
  balanceBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 10, marginTop: 4, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)' },
  balanceInfo: { flexDirection: 'column' },
  balanceLabel: { color: 'rgba(255,255,255,0.5)', fontSize: 10, marginBottom: 2 },
  balanceAmount: { color: '#FFF', fontSize: 14, fontWeight: 'bold', marginLeft: 4 },
  topUpBtn: { backgroundColor: BRAND.primary, paddingHorizontal: 16, paddingVertical: 6, borderRadius: 18 },
  topUpText: { color: '#FFF', fontSize: 11, fontWeight: 'bold' },

  // Send button — gradient pill that sits in the balanceBar row.
  // Kept short/punchy; the bulk multiplier suffix ("3x") fits inside.
  sendGiftBtn: { borderRadius: 20, overflow: 'hidden', shadowColor: BRAND.primary, shadowOpacity: 0.35, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 5 },
  sendGiftGradient: { paddingHorizontal: 22, paddingVertical: 9, borderRadius: 20, alignItems: 'center', justifyContent: 'center', minWidth: 96 },
  sendGiftText: { color: '#FFF', fontSize: 13, fontWeight: '800', letterSpacing: 0.3 },

  /* Game Menu Extension */
  gameListItem: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.05)', padding: 15, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },

  // ── Game picker — compact tile grid, responsive ─────────────────────
  gamePickerHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingTop: 18, paddingBottom: 4,
  },
  gamePickerTitle:    { color: '#FFF', fontSize: 18, fontWeight: '900', letterSpacing: 0.3 },
  gamePickerSubtitle: { color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 2 },
  gamePickerClose:    { width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' },

  gameTileGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    paddingHorizontal: 16, paddingTop: 16, gap: 12,
  },
  gameTile: {
    width: '47.5%', aspectRatio: 0.85,
    borderRadius: 18, overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  gameTileGrad: {
    flex: 1, padding: 14, justifyContent: 'space-between',
  },
  gameTileIconWrap: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: 'rgba(0,0,0,0.25)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  gameTileEmoji: { fontSize: 28 },
  gameTileName:  { color: '#FFF', fontSize: 15, fontWeight: '800', marginTop: 8 },
  gameTileDesc:  { color: 'rgba(255,255,255,0.55)', fontSize: 11, marginTop: 4, lineHeight: 15 },
  gameTileChip:  {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    alignSelf: 'flex-start', marginTop: 8,
    paddingHorizontal: 7, paddingVertical: 3,
    backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 10,
  },
  gameTileChipText: { color: '#FBBF24', fontSize: 9, fontWeight: '800', letterSpacing: 0.4, textTransform: 'uppercase' },

  gameTileEmpty: {
    flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 40,
  },
  gameTileEmptyText: { color: 'rgba(255,255,255,0.5)', marginTop: 12, fontSize: 13 },

  /* Waiting for Host Overlay */
  waitingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 1000, justifyContent: 'center', alignItems: 'center' },
  waitingContent: { alignItems: 'center', backgroundColor: BRAND.splashBg, padding: 30, borderRadius: 24, borderWidth: 1, borderColor: '#38BDF8' },
  waitingText: { color: '#FFF', fontSize: 16, fontWeight: 'bold', marginTop: 15 },
  cancelRequestBtn: { marginTop: 20, paddingVertical: 10, paddingHorizontal: 20, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 20 },
  cancelRequestText: { color: '#EF4444', fontSize: 13, fontWeight: 'bold' },

  /* Host Call Manage Styles */
  hostCallManageBtn: { width: 32, height: 32, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 16, justifyContent: 'center', alignItems: 'center', marginLeft: 10 },
  requestBadge: { position: 'absolute', top: -5, right: -5, backgroundColor: '#EF4444', borderRadius: 8, minWidth: 16, height: 16, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#FFF' },
  requestBadgeText: { color: '#FFF', fontSize: 9, fontWeight: 'bold' },
  requestItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  requestAvatar: { width: 40, height: 40, borderRadius: 20, marginRight: 12 },
  requestName: { color: '#FFF', fontSize: 14, fontWeight: 'bold' },
  requestActionBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 12 },
  requestActionText: { color: '#FFF', fontSize: 12, fontWeight: 'bold' },
  inviteBtn: { backgroundColor: BRAND.primary, paddingHorizontal: 20, paddingVertical: 8, borderRadius: 15 },
  inviteBtnText: { color: '#FFF', fontSize: 12, fontWeight: 'bold' },

  /* Floating UI Styles */
  floatingActionCluster: { position: 'absolute', right: 16, bottom: height * 0.20, zIndex: 100, gap: 12, alignItems: 'flex-end' },
  floatingJoinBtnMain: { minWidth: 44, height: 44 },
  floatingHeartBtn: { width: 44, height: 44 },
  floatingJoinGradient: { minWidth: 44, paddingHorizontal: 12, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center', elevation: 10, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8 },


  pendingDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: '#FFF', marginTop: 2 },
  pendingTag: { position: 'absolute', backgroundColor: 'rgba(245,158,11,0.9)', right: 50, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10 },
  pendingTagText: { color: '#FFF', fontSize: 9, fontWeight: 'bold' },

  /* Host Control Bar Styles */
  hostControlBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 14,
    marginBottom: 8,
    paddingHorizontal: 8,
    paddingTop: 11,
    minHeight: 78,
    borderRadius: 24,
    backgroundColor: 'rgba(8, 8, 55, 0.94)',
    borderWidth: 1,
    borderColor: 'rgba(84, 89, 224, 0.65)',
    shadowColor: '#703CFF',
    shadowOpacity: 0.45,
    shadowRadius: 12,
    elevation: 12,
  },
  hostControlLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' },
  hostActionBtn: { minWidth: 42, alignItems: 'center', opacity: 0.92 },
  // Small purple dot on top-right of the Background icon when a template
  // is applied — lets the host see at a glance that the room has a
  // custom theme without having to open the picker.
  hostActionDot: {
    position: 'absolute', top: -2, right: -2,
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: '#A855F7',
    borderWidth: 1.5, borderColor: BRAND.splashBg,
  },
  hostActionText: { color: '#D8D5F0', fontSize: 9, marginTop: 4, fontWeight: '600' },
  chatToggleBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(87, 37, 177, 0.75)',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 1.2, borderColor: '#A94BFF',
  },
  audioInviteCard: {
    position: 'absolute',
    right: 18,
    bottom: 104,
    width: Math.min(width * 0.47, 210),
    minHeight: 72,
    zIndex: 95,
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: 'rgba(49, 12, 103, 0.92)',
    borderWidth: 1.2,
    borderColor: '#C03AFF',
    shadowColor: '#A02CFF',
    shadowOpacity: 0.65,
    shadowRadius: 12,
    elevation: 12,
  },
  audioInviteIcon: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(77, 42, 180, 0.72)',
  },
  audioInviteTitle: { color: '#FFF', fontSize: 13, fontWeight: '800' },
  audioInviteText: { color: '#E5DDF7', fontSize: 9, lineHeight: 13, marginTop: 2 },
  hostStatsRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  earningsBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(251,191,36,0.3)' },
  earningsText: { color: '#FBBF24', fontSize: 11, fontWeight: 'bold', marginLeft: 4 },
  roomTitleBadge: {
    position: 'absolute',
    left: 16,
    zIndex: 110,
  },
  roomTitleGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  roomTitleText: {
    color: '#FFF',
    fontSize: 12,
    fontWeight: '600',
    maxWidth: width * 0.6,
  },

  /* Confirm Modal Styles */
  confirmOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  confirmBox: { width: '100%', backgroundColor: BRAND.splashBg, borderRadius: 24, padding: 24, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  confirmTitle: { color: '#FFF', fontSize: 20, fontWeight: 'bold', marginBottom: 10, textAlign: 'center' },
  confirmDesc: { color: 'rgba(255,255,255,0.7)', fontSize: 14, textAlign: 'center', marginBottom: 25, lineHeight: 20 },
  confirmActions: { flexDirection: 'row', gap: 12, width: '100%' },
  confirmActionsVertical: { width: '100%', gap: 12 },
  confirmMainAction: { width: '100%', height: 50, borderRadius: 25, overflow: 'hidden' },
  confirmGradientBtn: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  confirmSecondaryAction: { width: '100%', height: 50, justifyContent: 'center', alignItems: 'center' },
  confirmIconContainer: { alignItems: 'center', marginBottom: 20 },
  confirmIconBg: { width: 60, height: 60, borderRadius: 30, justifyContent: 'center', alignItems: 'center' },
  cancelAction: { flex: 1, height: 50, borderRadius: 25, backgroundColor: 'rgba(255,255,255,0.05)', justifyContent: 'center', alignItems: 'center' },
  cancelActionText: { color: '#FFF', fontSize: 15, fontWeight: '600' },
  confirmAction: { flex: 1, height: 50, borderRadius: 25, backgroundColor: '#EF4444', justifyContent: 'center', alignItems: 'center' },
  confirmActionText: { color: '#FFF', fontSize: 15, fontWeight: 'bold' },

  /* Host Control Bar Badges */
  requestBadgeSmall: { position: 'absolute', top: -5, right: -8, backgroundColor: '#EF4444', borderRadius: 10, minWidth: 16, height: 16, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4, borderWidth: 1.5, borderColor: BRAND.splashBg },
  requestBadgeTextSmall: { color: '#FFF', fontSize: 9, fontWeight: 'bold' },

  /* Summary Modal Styles */
  summaryOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  summaryCard: { width: '85%', maxWidth: 330, borderRadius: 22, padding: 20, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', elevation: 20 },
  summaryAvatarWrapper: { width: 78, height: 78, borderRadius: 39, justifyContent: 'center', alignItems: 'center', marginBottom: 10 },
  summaryAvatar: { width: 64, height: 64, borderRadius: 32, borderWidth: 3, borderColor: BRAND.primary },
  summaryAvatarFrame: { position: 'absolute', width: 160, height: 160, top: -28, left: -20, pointerEvents: 'none' },
  summaryBadge: { position: 'absolute', bottom: 2, right: 2, backgroundColor: '#FBBF24', width: 22, height: 22, borderRadius: 11, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: BRAND.splashBg },
  summaryLottie: { width: 150, height: 150 },
  summaryTitle: { color: '#FFF', fontSize: 18, fontWeight: '900', marginTop: 4 },
  summarySubtitle: { color: '#38BDF8', fontSize: 12, fontWeight: 'bold', marginTop: 4, letterSpacing: 0.5, textAlign: 'center' },
  summaryStatsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', width: '100%', marginVertical: 18 },
  sumStatItem: { alignItems: 'center', flex: 1 },
  sumStatValue: { color: '#FFF', fontSize: 15, fontWeight: 'bold', marginTop: 5 },
  sumStatLabel: { color: 'rgba(255,255,255,0.4)', fontSize: 9, marginTop: 3, textTransform: 'uppercase' },
  sumStatBar: { width: 1, height: 32, backgroundColor: 'rgba(255,255,255,0.1)' },
  summaryDoneBtn: { width: '100%', height: 44, borderRadius: 22, overflow: 'hidden', marginTop: 8 },
  summaryDoneGradient: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  summaryDoneText: { color: '#FFF', fontSize: 14, fontWeight: 'bold' },

  /* Frame Styles */
  // marginLeft is applied inline per-avatar in renderTopActions so the
  // FIRST avatar can sit flush (positive margin) while subsequent ones
  // overlap leftward (negative margin) for the Instagram-style cluster.
  topViewerAvatarWrapper: { width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center', overflow: 'visible' },
  avatarFrameMini: { position: 'absolute', width: 60, height: 60, top: -12, left: -12, zIndex: 10, pointerEvents: 'none' },
  avatarFrameList: { position: 'absolute', width: 68, height: 68, top: -12, left: -12, zIndex: 10, pointerEvents: 'none' },
  avatarFrameBroadcaster: { position: 'absolute', width: 60, height: 60, top: -12, left: -12, zIndex: 10, pointerEvents: 'none' },
  avatarFrameMiniVVIP: { position: 'absolute', width: 64, height: 64, top: -14, left: -14, zIndex: 10, pointerEvents: 'none' },
  avatarFrameBroadcasterVVIP: { position: 'absolute', width: 68, height: 68, top: -14, left: -14, zIndex: 10, pointerEvents: 'none' },
  avatarFrameHostAudio: { position: 'absolute', width: 130, height: 130, top: -30, left: -20, pointerEvents: 'none' },
  avatarFrameHostAudioVIP: { position: 'absolute', width: 130, height: 130, top: -30, left: -20, pointerEvents: 'none' },
  avatarFrameSeatAudio: { position: 'absolute', width: 96, height: 96, top: -18, left: -18, pointerEvents: 'none' },
  avatarFrameSeatAudioVVIP: { position: 'absolute', width: 102, height: 102, top: -25, left: -20, pointerEvents: 'none' },

  /* Entrance Banner */
  entranceBannerContainer: { position: 'absolute', top: height * 0.28, left: 0, right: 0, alignItems: 'center', zIndex: 200 },
  entranceGlowLarge: { position: 'absolute', width: width * 0.8, height: 60, borderRadius: 30, filter: 'blur(20px)', opacity: 0.6 },
  entranceBannerGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    width: width * 0.92,
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderRadius: 50,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.5)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.6,
    shadowRadius: 16,
    elevation: 25
  },
  entranceBannerLeft: { width: 60, height: 60, justifyContent: 'center', alignItems: 'center' },
  entranceAvatarBox: { width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.1)', overflow: 'visible' },
  entranceAvatarImage: { width: 44, height: 44, borderRadius: 22 },
  entranceAvatarFrame: { position: 'absolute', width: 66, height: 66, top: -11, left: -11, zIndex: 10 },
  entranceBannerMiddle: { flex: 1, marginLeft: 12 },
  entranceBannerActionText: { color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: '900', letterSpacing: 1.5, textTransform: 'uppercase' },
  entranceBannerText: { color: '#FFF', fontSize: 14, fontWeight: 'bold' },
  entranceBannerName: { color: '#FFF', fontSize: 17, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 6 },
  entranceBannerRight: { paddingRight: 10 },
  levelBadgeEntrance: { backgroundColor: 'rgba(0,0,0,0.3)', paddingHorizontal: 12, paddingVertical: 5, borderRadius: 15, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  levelBadgeTextEntrance: { color: '#FFF', fontSize: 13, fontWeight: '900', fontStyle: 'italic' },

  rewardBanner: { width: '100%', marginBottom: 14, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(251,191,36,0.3)' },
  rewardBannerInner: { flexDirection: 'row', alignItems: 'center', padding: 12 },
  rewardBannerTitle: { color: '#FBBF24', fontSize: 13, fontWeight: 'bold' },
  rewardBannerVal: { color: 'rgba(255,255,255,0.7)', fontSize: 10, marginTop: 2 },

  /* Pinned Message Styles */
  pinnedContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(251,191,36,0.1)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, marginBottom: 12, borderWidth: 1, borderColor: 'rgba(251,191,36,0.2)' },
  pinnedIndicator: { flexDirection: 'row', alignItems: 'center', marginRight: 10, borderRightWidth: 1, borderRightColor: 'rgba(251,191,36,0.3)', paddingRight: 10 },
  pinnedLabel: { color: '#FBBF24', fontSize: 10, fontWeight: 'bold', marginLeft: 4 },
  pinnedContent: { flex: 1 },
  pinnedText: { color: '#FFF', fontSize: 12, fontWeight: '500' },

  /* Admin Mini Indicators */
  muteIndicatorMini: { position: 'absolute', bottom: -2, right: -2, backgroundColor: '#000', borderRadius: 8, padding: 2, borderWidth: 1, borderColor: '#EF4444', zIndex: 100, elevation: 100 },

  /* Floating Reactions Styles */
  reactionsOverlay: { position: 'absolute', bottom: 100, right: 20, width: 100, height: height * 0.6, zIndex: 90 },
  floatingEmoji: { position: 'absolute', bottom: 0, right: 30 },

  /* Video Guest Styles Expansion */
  guestVideoOverlay: { position: 'absolute', top: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 10, padding: 2 },


  /* Live Goal Styles */
  liveGoalContainer: { position: 'absolute', left: 16, width: 160, zIndex: 35 },
  audioLiveGoalContainer: {
    left: 16,
    right: 16,
    width: 'auto',
    minHeight: 76,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 18,
    backgroundColor: 'rgba(15,7,83,.82)',
    borderWidth: 1,
    borderColor: '#345DFF',
    shadowColor: '#D92BFF',
    shadowOpacity: 0.55,
    shadowRadius: 12,
    elevation: 10,
  },
  audioGoalIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,105,27,.18)',
    borderWidth: 1,
    borderColor: '#FF7838',
  },
  audioGoalCompleted: {
    position: 'absolute',
    right: 18,
    top: 38,
    color: '#D8D2FF',
    fontSize: 10,
    fontWeight: '600',
  },
  liveGoalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  liveGoalTitle: { color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: 'bold' },
  audioGoalTitle: { color: '#FFF', fontSize: 16, fontWeight: '900' },
  liveGoalStats: { color: '#FBBF24', fontSize: 12, fontWeight: '900' },
  audioGoalStats: { fontSize: 17 },
  liveGoalBgBar: { height: 10, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 5, overflow: 'hidden' },
  liveGoalProgressBar: { height: '100%', borderRadius: 5 },

  /* Bulk Gift Styles */
  bulkSendRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, marginVertical: 6 },
  bulkLabel: { color: 'rgba(255,255,255,0.5)', fontSize: 11 },
  bulkOptions: { flexDirection: 'row', gap: 6 },
  bulkBtn: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  bulkBtnActive: { backgroundColor: BRAND.primary20, borderColor: BRAND.primary },
  bulkBtnText: { color: 'rgba(255,255,255,0.6)', fontSize: 11, fontWeight: 'bold' },
  bulkBtnTextActive: { color: BRAND.primary },

  /* SFX Modal Styles */
  sfxOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', zIndex: 2000 },
  sfxCard: { width: width * 0.8, backgroundColor: BRAND.splashBg, borderRadius: 24, padding: 20, alignItems: 'center', borderWidth: 1, borderColor: '#38BDF8' },
  sfxTitle: { color: '#FFF', fontSize: 18, fontWeight: 'bold', marginBottom: 20 },
  sfxGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 20 },
  sfxItem: { alignItems: 'center', width: 60 },
  sfxIcon: { fontSize: 30, marginBottom: 8 },
  sfxName: { color: 'rgba(255,255,255,0.7)', fontSize: 11 },
  sfxClose: { position: 'absolute', top: 15, right: 15, padding: 5 },

  /* Premium Admin Action Card Styles */
  premiumAdminCard: { backgroundColor: '#0F091E', borderTopLeftRadius: 35, borderTopRightRadius: 35, paddingHorizontal: 20, paddingTop: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  modalHandle: { width: 40, height: 5, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 2.5, alignSelf: 'center', marginBottom: 20 },
  adminHeader: { alignItems: 'center', marginBottom: 30 },
  adminAvatarWrapper: { position: 'relative', marginBottom: 12 },
  adminAvatarLarge: { width: 90, height: 90, borderRadius: 45, borderWidth: 3, borderColor: BRAND.primary },
  adminMuteBadge: { position: 'absolute', bottom: 0, right: 0, backgroundColor: '#EF4444', width: 28, height: 28, borderRadius: 14, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: '#0F091E' },
  adminGuestName: { color: '#FFF', fontSize: 20, fontWeight: 'bold' },
  adminGuestId: { color: 'rgba(255,255,255,0.4)', fontSize: 12, marginTop: 4 },
  adminActionGrid: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 20 },
  adminActionItem: { alignItems: 'center', flex: 1 },
  adminActionIconBox: { width: 60, height: 60, borderRadius: 30, justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
  adminActionText: { color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: '600' },

  /* Video Guest Grid Styles */
  videoGuestGrid: { position: 'absolute', right: 12, top: height * 0.12, gap: 12, alignItems: 'flex-end', zIndex: 30 },
  // Portrait video tile. Android's RtcSurfaceView (SurfaceView) doesn't fully
  // clip to rounded corners, so we keep a moderate radius and a slightly
  // thicker solid border that masks any minor corner bleed.
  guestVideoBox: { width: 112, height: 150, borderRadius: 12, overflow: 'hidden', borderWidth: 3, borderColor: '#2D1B4E', backgroundColor: '#000', elevation: 8, shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 8 },
  guestVideoFeed: { width: '100%', height: '100%', borderRadius: 10, overflow: 'hidden', resizeMode: 'cover' },
  guestTileSpeaking: { shadowColor: '#38BDF8', shadowOpacity: 0.85, shadowRadius: 10, shadowOffset: { width: 0, height: 0 }, elevation: 14 },
  guestTileGuardian: { position: 'absolute', top: -2, alignSelf: 'center', backgroundColor: '#A855F7', minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, justifyContent: 'center', alignItems: 'center', borderWidth: 1.5, borderColor: '#0E111E', zIndex: 20, left: 0, right: 0, marginLeft: 'auto', marginRight: 'auto' },
  guestTileGuardianText: { color: '#FFF', fontSize: 11, fontWeight: 'bold', lineHeight: 13 },
  // Seat-number tag positioned on the bottom-left of a video tile so it
  // doesn't fight with the name marquee in the centre footer.
  videoSeatNumTag: { position: 'absolute', bottom: 24, left: 4, backgroundColor: 'rgba(0,0,0,0.7)', minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center', zIndex: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  // Host-only quick remove "X" — mirrors the audio seat affordance.
  videoRemoveSeatBtn: { position: 'absolute', top: 6, right: 6, width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center', zIndex: 15, borderWidth: 1, borderColor: 'rgba(239,68,68,0.5)' },
  guestNameTag: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.55)', paddingVertical: 3, paddingHorizontal: 4, alignItems: 'center' },
  guestNameMini: { color: '#FFF', fontSize: 9, fontWeight: '700' },
  removeGuestBtn: { position: 'absolute', top: 8, right: 8, width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)', zIndex: 5 },
  avatarRingSmall: { padding: 2, borderRadius: 30, borderWidth: 1.5, borderColor: '#38BDF8' },
  removeSeatBtn: { position: 'absolute', top: -5, right: 5, backgroundColor: '#000', borderRadius: 10 },

  /* Music Marquee Styles */
  musicMarquee: { position: 'absolute', top: 110, left: 0, right: 0, backgroundColor: 'rgba(56,189,248,0.2)', paddingVertical: 4, alignItems: 'center', zIndex: 10 },
  musicMarqueeText: { color: '#38BDF8', fontSize: 11, fontWeight: 'bold' },

  /* Viewer List Bottom Sheet Styles */
  viewerCountTag: { backgroundColor: 'rgba(56,189,248,0.15)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, marginLeft: 8 },
  viewerCountTagText: { color: '#38BDF8', fontSize: 12, fontWeight: 'bold' },
  viewerItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  viewerItemLeft: { flexDirection: 'row', alignItems: 'center' },
  viewerAvatarWrapper: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center', overflow: 'visible' },
  viewerAvatarMini: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  viewerProfileFrameMini: { position: 'absolute', width: 68, height: 68, top: -12, left: -12, zIndex: 6 },
  vipBadgeSmall: { position: 'absolute', bottom: -2, right: -2, backgroundColor: '#A855F7', width: 16, height: 16, borderRadius: 8, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#000' },
  viewerNameText: { color: '#FFF', fontSize: 14, fontWeight: 'bold' },
  viewerIdText: { color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: '600', marginTop: 3 },
  levelBadgeMini: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, marginLeft: 6 },
  levelBadgeText: { color: '#FFF', fontSize: 9, fontWeight: 'bold' },
  adminTagMini: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#A855F7', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, marginLeft: 6 },
  adminTagMiniText: { color: '#FFF', fontSize: 9, fontWeight: 'bold', marginLeft: 2 },
  viewerCoinsText: { color: 'rgba(255,255,255,0.5)', fontSize: 11, marginLeft: 4 },
  viewerFollowBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: BRAND.primary10, borderWidth: 1, borderColor: BRAND.primary, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 15 },
  viewerFollowBtnDone: { backgroundColor: 'rgba(74,222,128,0.10)', borderColor: 'rgba(74,222,128,0.55)' },
  viewerFollowText: { color: BRAND.primary, fontSize: 12, fontWeight: 'bold' },

  /* Viewer Profile Popup Styles */
  viewerProfileCard: {
    width: width * 0.9,
    maxWidth: 390,
    backgroundColor: 'rgba(10,12,92,0.96)',
    borderRadius: 32,
    padding: 24,
    paddingTop: 28,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#2FE2FF',
    overflow: 'hidden',
    shadowColor: '#FF38E8',
    shadowOpacity: 0.9,
    shadowRadius: 24,
    elevation: 24,
  },
  cardGlowOverlay: { position: 'absolute', top: -120, left: -30, right: -30, height: 360, backgroundColor: 'rgba(216,43,255,0.18)', borderRadius: 180 },
  profileDecorStar: { position: 'absolute', color: '#FFFFFF', fontSize: 24, textShadowColor: '#FF48F4', textShadowRadius: 10 },
  profileDecorStarLeft: { left: 32, top: 58, color: '#79D7FF' },
  profileDecorStarRight: { right: 42, top: 172, color: '#FFD43A' },
  profileDecorHeart: { position: 'absolute', left: 28, bottom: 176, color: '#FF42CB', fontSize: 25, textShadowColor: '#FF42CB', textShadowRadius: 12 },
  cardCloseBtn: { position: 'absolute', top: 18, right: 18, width: 58, height: 58, borderRadius: 29, overflow: 'hidden', borderWidth: 1.3, borderColor: 'rgba(255,255,255,0.6)', zIndex: 5 },
  cardCloseGradient: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  profileHeader: { alignItems: 'center', marginBottom: 18, width: '100%' },
  profileAvatarBox: { position: 'relative', marginBottom: 18 },
  profileAvatarLarge: { width: 116, height: 116, borderRadius: 58, borderWidth: 4, borderColor: '#FFFFFF', backgroundColor: '#FFF' },
  viewerProfileFrameLarge: { position: 'absolute', width: 172, height: 172, top: -28, left: -28, zIndex: 8 },
  levelRingGlow: { position: 'absolute', width: 132, height: 132, borderRadius: 66, borderWidth: 2, borderColor: 'rgba(255,219,74,0.75)', top: -8, left: -8 },
  profileLevelBadge: { position: 'absolute', bottom: -6, right: 2, backgroundColor: '#FBBF24', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 2, borderColor: BRAND.splashBg },
  profileLevelText: { color: '#FFF', fontSize: 10, fontWeight: 'bold' },
  profileNameLarge: { color: '#FFF', fontSize: 30, fontWeight: '900', textShadowColor: '#8E5BFF', textShadowRadius: 7, maxWidth: '82%' },
  profileUserId: { color: 'rgba(255,255,255,0.72)', fontSize: 17, fontWeight: '800', marginTop: 4 },
  profileMetaPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 13,
    paddingHorizontal: 18,
    height: 39,
    borderRadius: 20,
    backgroundColor: 'rgba(9,178,255,0.36)',
    borderWidth: 1.5,
    borderColor: '#20D8FF',
  },
  profileMetaText: { color: '#FFFFFF', fontSize: 16, fontWeight: '900' },
  profileLoadingBox: { height: 34, alignItems: 'center', justifyContent: 'center', marginTop: -8, marginBottom: 4 },
  profileStatsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: 14, paddingVertical: 16, borderWidth: 1.4, borderColor: 'rgba(47,226,255,0.65)', borderRadius: 20, backgroundColor: 'rgba(18,62,180,0.36)' },
  pStatItem: { alignItems: 'center', flex: 1 },
  pStatValue: { color: '#FFF', fontSize: 26, fontWeight: '900', marginTop: 5 },
  pStatLabel: { color: 'rgba(255,255,255,0.78)', fontSize: 11, marginTop: 3, textTransform: 'uppercase', fontWeight: '800' },
  pStatDivider: { width: 1.4, height: 70, backgroundColor: 'rgba(255,255,255,0.26)' },
  profileBioBox: {
    width: '100%',
    minHeight: 74,
    padding: 15,
    borderRadius: 20,
    backgroundColor: 'rgba(126,28,217,0.38)',
    borderWidth: 1.4,
    borderColor: '#ED4BFF',
    marginBottom: 18,
  },
  profileBioLabel: { color: '#22F3FF', fontSize: 14, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 8 },
  profileBioText: { color: '#FFFFFF', fontSize: 16, lineHeight: 22, textAlign: 'center' },
  profileActionsContainer: { width: '100%' },
  pActionMain: { width: '100%', height: 62, borderRadius: 31, overflow: 'hidden', marginBottom: 14, borderWidth: 2, borderColor: 'rgba(255,255,255,0.74)' },
  pActionGradient: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 },
  pActionText: { color: '#FFF', fontSize: 25, fontWeight: '900' },
  pActionMiniRow: { flexDirection: 'row', gap: 10, marginBottom: 15 },
  pActionMini: { flex: 1, minHeight: 58, backgroundColor: 'rgba(24,36,156,0.68)', borderRadius: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderWidth: 1.4, borderColor: 'rgba(47,226,255,0.76)' },
  pActionEmoji: { fontSize: 24 },
  pActionMiniText: { color: '#FFF', fontSize: 15, fontWeight: '900' },
  hostModRow: { flexDirection: 'row', gap: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.05)' },
  hostModBtn: { flex: 1, height: 40, borderRadius: 20, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  hostModRow: { flexDirection: 'row', gap: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.05)' },
  hostModText: { fontSize: 13, fontWeight: 'bold' },

  /* Video Side Bar Styles */
  // Container for the single Host Tools trigger. Repositioned to a
  // spot WAY below where the floating guest tiles live (videoGuestGrid
  // anchors at top: 12% and stacks ~3 tiles downward), so there's no
  // overlap regardless of how many viewers are on the call. Sitting
  // above the host action bar means the host's thumb can reach it
  // without moving from the bottom of the screen.
  videoSideBar: {
    position: 'absolute',
    right: 12,
    bottom: height * 0.18,
    zIndex: 150,
    alignItems: 'center',
  },
  hostToolsBtn: {
    alignItems: 'center',
    gap: 4,
  },
  hostToolsBtnBg: {
    width: 52,
    height: 52,
    borderRadius: 26,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  hostToolsBtnDot: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: 'rgba(0,0,0,0.7)',
  },

  // Bottom sheet containing the 4 host controls in a single row.
  // Uses moreOverlay for the dim backdrop (same as beauty / SFX sheets
  // so the modal stack feels coherent). Grid is intentionally a single
  // 4-column row; tiles are touch-friendly (~70px) so the host can
  // tap any one without aiming.
  hostToolsSheet: {
    backgroundColor: BRAND.splashBg,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingTop: 10,
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  hostToolsTitle: {
    color: '#FFF',
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 16,
  },
  hostToolsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  hostToolsTile: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
  },
  hostToolsTileIcon: {
    width: 60,
    height: 60,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  hostToolsTileIconActive: {
    backgroundColor: 'rgba(251,191,36,0.12)',
    borderColor: 'rgba(251,191,36,0.4)',
  },
  hostToolsTileLabel: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    fontWeight: '600',
  },
  hostToolsTileEmoji: {
    fontSize: 28,
    lineHeight: 32,
  },
  slotModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.62)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  slotModalCard: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 24,
    paddingHorizontal: 22,
    paddingTop: 14,
    paddingBottom: 22,
    backgroundColor: BRAND.splashBg,
    borderWidth: 1,
    borderColor: 'rgba(56,189,248,0.55)',
    alignItems: 'center',
  },
  slotModalTitle: {
    color: '#FFF',
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
    marginTop: -4,
  },
  slotModalSubtitle: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 18,
  },
  slotInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  slotStepperBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  slotInput: {
    width: 86,
    height: 52,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(56,189,248,0.5)',
    color: '#FFF',
    fontSize: 24,
    fontWeight: '900',
    textAlign: 'center',
  },
  slotRangeHint: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 10,
  },
  slotModalActions: {
    width: '100%',
    flexDirection: 'row',
    gap: 10,
    marginTop: 20,
  },
  slotCancelBtn: {
    flex: 1,
    height: 44,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  slotCancelText: {
    color: 'rgba(255,255,255,0.82)',
    fontSize: 13,
    fontWeight: '800',
  },
  slotSaveBtn: {
    flex: 1,
    height: 44,
    borderRadius: 16,
    overflow: 'hidden',
  },
  slotSaveGradient: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slotSaveText: {
    color: '#FFF',
    fontSize: 13,
    fontWeight: '900',
  },
  sideBarBtn: {
    alignItems: 'center',
    gap: 4,
  },
  sideBarIconBg: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  sideBarText: {
    color: '#FFF',
    fontSize: 10,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 2,
  },

  /* Video Duo Mode Styles */
  duoVideoContainer: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'column', // Stacked split screen
    backgroundColor: '#000',
  },
  duoHalf: {
    flex: 1,
    overflow: 'hidden',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  speakingGlowBorder: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 2,
    borderColor: BRAND.primary,
    shadowColor: BRAND.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 10,
  },
  videoNameTagHost: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  videoNameTagGuest: {
    position: 'absolute',
    top: 20,
    right: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  videoNameText: {
    color: '#FFF',
    fontSize: 12,
    fontWeight: 'bold',
  },
  guestMuteBadge: {
    position: 'absolute',
    top: 20,
    left: 20,
    backgroundColor: 'rgba(0,0,0,0.6)',
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },

  /* Mixed Mode Styles */
  audioOnlyGuestBox: {
    backgroundColor: BRAND.splashBg,
    borderColor: 'rgba(168,85,247,0.5)',
  },
  audioGuestPlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  audioGuestAvatarSmall: {
    width: 56,
    height: 56,
    borderRadius: 28,
    zIndex: 2,
    borderWidth: 2,
    borderColor: 'rgba(168,85,247,0.6)',
  },
  audioModeChip: {
    position: 'absolute',
    bottom: 26,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(168,85,247,0.85)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    zIndex: 3,
    gap: 3,
  },
  audioModeChipText: {
    color: '#FFF',
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
});
