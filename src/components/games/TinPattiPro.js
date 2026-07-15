import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ImageBackground,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { VideoView, useVideoPlayer } from 'expo-video';
import { supabase } from '../../api/supabase';
import { useGlobalState } from '../../context/GlobalStateContext';

const GLOBAL_ROOM_ID = '00000000-0000-0000-0000-000000000002';
const BETS = [100, 500, 1000, 5000];
const ROUND_SECONDS = 30;
const RESULT_SECONDS = 15;
const TIMER_TICK_MS = 250;
const POLL_MS = 20000;
const REALTIME_DEBOUNCE_MS = 350;
const RESULT_SHOW_DELAY_MS = 450;
const BACKGROUND_ASPECT = 1364 / 768;

const A = {
  backgroundVideo: require('../../../assets/games/tin-patti-pro/background.mp4'),
  backgroundPoster: require('../../../assets/games/tin-patti-pro/background_poster.png'),
  chip100: require('../../../assets/games/tin-patti-pro/chip_100.webp'),
  chip500: require('../../../assets/games/tin-patti-pro/chip_500.webp'),
  chip1k: require('../../../assets/games/tin-patti-pro/chip_1k.webp'),
  chip5k: require('../../../assets/games/tin-patti-pro/chip_5k.webp'),
  gCoin: require('../../../assets/games/tin-patti-pro/g_coin.webp'),
  gift: require('../../../assets/games/tin-patti-pro/gift_new_button.webp'),
  help: require('../../../assets/games/tin-patti-pro/help_button.webp'),
  players: require('../../../assets/games/tin-patti-pro/players_button.webp'),
  sound: require('../../../assets/games/tin-patti-pro/sound_button.webp'),
  boardPlain: require('../../../assets/games/tin-patti-pro/board_abc_plain.webp'),
  boardWinner: require('../../../assets/games/tin-patti-pro/board_abc_winner.webp'),
  ribbon: require('../../../assets/games/tin-patti-pro/red_ribbon_banner.webp'),
  cardClub: require('../../../assets/games/tin-patti-pro/card_club.webp'),
  cardDiamond: require('../../../assets/games/tin-patti-pro/card_diamond.webp'),
  cardHeart: require('../../../assets/games/tin-patti-pro/card_heart.webp'),
  cardSpade: require('../../../assets/games/tin-patti-pro/card_spade.webp'),
  inputBar: require('../../../assets/games/tin-patti-pro/orange_input_bar.webp'),
};

const OPTIONS = [
  { id: 'crown', label: 'A' },
  { id: 'coffee', label: 'B' },
  { id: 'cake', label: 'C' },
];

const chipAssetByAmount = {
  100: A.chip100,
  500: A.chip500,
  1000: A.chip1k,
  5000: A.chip5k,
};

const cardSuitAsset = {
  C: A.cardClub,
  D: A.cardDiamond,
  H: A.cardHeart,
  S: A.cardSpade,
};

const normalizeSuit = (suit) => {
  const value = String(suit || '').trim().toUpperCase();
  return ({ CLUB: 'C', CLUBS: 'C', DIAMOND: 'D', DIAMONDS: 'D', HEART: 'H', HEARTS: 'H', SPADE: 'S', SPADES: 'S' })[value] || value;
};

const redSuits = new Set(['H', 'D']);

const compact = (value) => {
  const n = Number(value || 0);
  if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return `${n}`;
};

const formatAmount = (value) => Number(value || 0).toLocaleString();

const chipForAmount = (amount) => {
  const value = Number(amount || 0);
  if (value >= 5000) return A.chip5k;
  if (value >= 1000) return A.chip1k;
  if (value >= 500) return A.chip500;
  return A.chip100;
};

const chipSpot = (index) => {
  const spots = [
    { left: '18%', top: '47%', rotate: '-10deg' },
    { left: '38%', top: '42%', rotate: '7deg' },
    { left: '58%', top: '47%', rotate: '-4deg' },
    { left: '27%', top: '56%', rotate: '12deg' },
    { left: '48%', top: '55%', rotate: '-13deg' },
    { left: '64%', top: '58%', rotate: '9deg' },
    { left: '34%', top: '66%', rotate: '-6deg' },
    { left: '55%', top: '67%', rotate: '11deg' },
  ];
  return spots[index % spots.length];
};

const parseOptions = (multipliers) => {
  const arr = Array.isArray(multipliers) ? multipliers
    : typeof multipliers === 'string'
      ? (() => { try { return JSON.parse(multipliers); } catch (_) { return null; } })()
      : null;
  if (!Array.isArray(arr)) return OPTIONS.map((item) => ({ ...item, m: 2.9 }));
  return OPTIONS.map((base) => {
    const live = arr.find((item) => item?.id === base.id);
    return {
      ...base,
      m: Number(live?.m || 2.9),
    };
  });
};

const GameBackground = memo(function GameBackground() {
  const player = useVideoPlayer(A.backgroundVideo, (instance) => {
    instance.loop = true;
    instance.muted = true;
    instance.volume = 0;
    instance.timeUpdateEventInterval = 0;
    instance.play();
  });

  useEffect(() => () => {
    try { player.pause(); } catch (_) {}
  }, [player]);

  return (
    <VideoView
      player={player}
      style={styles.backgroundVideo}
      nativeControls={false}
      contentFit="cover"
      surfaceType="surfaceView"
      useExoShutter={false}
      requiresLinearPlayback
      pointerEvents="none"
    />
  );
});

const RoundTimer = memo(function RoundTimer({
  status,
  endsAt,
  settledAt,
  displaySeconds,
  graceSeconds,
  clockOffsetMs,
  roundId,
  onBettingOpenChange,
  onTransitionDue,
}) {
  const [label, setLabel] = useState(status === 'settled' ? 'Result 0s' : `Betting ${ROUND_SECONDS}s`);
  const lastSecondRef = useRef(null);
  const bettingOpenRef = useRef(null);
  const transitionKeyRef = useRef(null);
  const callbacksRef = useRef({ onBettingOpenChange, onTransitionDue });

  useEffect(() => {
    callbacksRef.current = { onBettingOpenChange, onTransitionDue };
  }, [onBettingOpenChange, onTransitionDue]);

  useEffect(() => {
    lastSecondRef.current = null;
    bettingOpenRef.current = null;
    transitionKeyRef.current = null;
  }, [roundId, status]);

  useEffect(() => {
    if (!endsAt) {
      setLabel(status === 'loading' ? 'Opening...' : 'Betting 0s');
      return undefined;
    }

    const tick = () => {
      const serverNowMs = Date.now() - Number(clockOffsetMs || 0);
      const endMs = new Date(endsAt).getTime();
      const settledMs = settledAt ? new Date(settledAt).getTime() : endMs;

      if (status === 'settled') {
        const left = Math.max(0, Math.ceil((settledMs + displaySeconds * 1000 - serverNowMs) / 1000));
        if (lastSecondRef.current !== left) {
          lastSecondRef.current = left;
          setLabel(`Result ${left}s`);
        }
        const transitionKey = `settled-${roundId}`;
        if (left <= 0 && transitionKeyRef.current !== transitionKey) {
          transitionKeyRef.current = transitionKey;
          callbacksRef.current.onTransitionDue?.();
        }
        return;
      }

      const left = Math.max(0, Math.ceil((endMs - serverNowMs) / 1000));
      const open = status === 'betting' && left > 0;
      if (bettingOpenRef.current !== open) {
        bettingOpenRef.current = open;
        callbacksRef.current.onBettingOpenChange?.(open);
      }
      if (lastSecondRef.current !== left) {
        lastSecondRef.current = left;
        setLabel(`${status === 'betting' ? 'Betting' : 'Betting'} ${left}s`);
      }
      const transitionKey = `betting-${roundId}`;
      if (serverNowMs >= endMs + graceSeconds * 1000 && transitionKeyRef.current !== transitionKey) {
        transitionKeyRef.current = transitionKey;
        callbacksRef.current.onTransitionDue?.();
      }
    };

    tick();
    const timer = setInterval(tick, TIMER_TICK_MS);
    return () => clearInterval(timer);
  }, [clockOffsetMs, displaySeconds, endsAt, graceSeconds, roundId, settledAt, status]);

  return <Text style={styles.timerText}>{label}</Text>;
});

const PlayingCard = memo(function PlayingCard({ card, hidden, small = false }) {
  const value = card?.value || '?';
  const suit = normalizeSuit(card?.suit);
  const red = redSuits.has(suit);
  const suitIcon = cardSuitAsset[suit];
  return (
    <View style={[styles.card, small && styles.cardSmall, hidden && styles.cardHidden]}>
      {hidden ? (
        <Text style={[styles.cardValue, small && styles.cardValueSmall]}>?</Text>
      ) : (
        <>
          <Text style={[styles.cardValue, red && styles.cardRed, small && styles.cardValueSmall]}>{value}</Text>
          {suitIcon ? (
            <Image source={suitIcon} style={[styles.cardSuitIcon, small && styles.cardSuitIconSmall]} resizeMode="contain" />
          ) : (
            <Text style={[styles.cardSuit, red && styles.cardRed, small && styles.cardSuitSmall]}>{suit}</Text>
          )}
        </>
      )}
    </View>
  );
});

const BoardCard = memo(function BoardCard({
  option,
  pot,
  myBet,
  boardBets,
  hand,
  selected,
  winner,
  disabled,
  onPress,
}) {
  const cards = Array.isArray(hand?.cards) ? hand.cards : [];
  const revealed = !!hand?.rank;
  const allBoardBets = Array.isArray(boardBets) ? boardBets : [];
  const visibleBets = allBoardBets.slice(0, 14);
  const showWinnerFrame = revealed && winner;
  return (
    <TouchableOpacity
      activeOpacity={0.88}
      disabled={disabled}
      onPress={() => onPress(option)}
      style={[styles.boardTouch, selected && styles.boardTouchSelected, winner && styles.boardTouchWinner]}
    >
      <Image source={A.boardWinner} style={styles.winnerPreload} resizeMode="stretch" pointerEvents="none" />
      <ImageBackground source={showWinnerFrame ? A.boardWinner : A.boardPlain} style={styles.boardCard} imageStyle={styles.boardImage} resizeMode="stretch">
        <Text style={styles.boardHeaderText}>{option.label}</Text>
        <View style={styles.potBadge}>
          <Text style={styles.potText}>POT: {compact(pot)}</Text>
        </View>
        <View style={styles.myBetBadge}>
          <Text style={styles.myBetText}>YOU: {compact(myBet)}</Text>
        </View>
        <View style={styles.cardsRow}>
          {[0, 1, 2].map((idx) => (
            <PlayingCard key={`${option.id}-${idx}`} card={cards[idx]} hidden={!revealed} />
          ))}
        </View>
        {!revealed ? <View pointerEvents="none" style={styles.boardChipLayer}>
          {visibleBets.map((bet, index) => {
            const spot = chipSpot(index);
            return (
              <View
                key={`${bet.id || `${option.id}-${index}`}`}
                style={[
                  styles.boardChipWrap,
                  {
                    left: spot.left,
                    top: spot.top,
                    transform: [{ rotate: spot.rotate }, { translateY: -index * 0.5 }],
                    zIndex: index + 1,
                  },
                ]}
              >
                <Image source={chipForAmount(bet.amount)} style={styles.boardChip} resizeMode="contain" />
              </View>
            );
          })}
          {allBoardBets.length > 14 ? (
            <Text style={styles.moreChips}>+{allBoardBets.length - 14}</Text>
          ) : null}
        </View> : null}
        {revealed && winner ? (
          <ImageBackground
            source={A.ribbon}
            style={styles.rankBadge}
            imageStyle={styles.rankBadgeImage}
            resizeMode="stretch"
            pointerEvents="none"
          >
            <Text style={styles.rankText}>{hand.rank}</Text>
          </ImageBackground>
        ) : null}
      </ImageBackground>
    </TouchableOpacity>
  );
});

function HistoryRail({ history, optionsById }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.historyRail}>
      {history.length ? history.map((row, index) => {
        const winner = row.winner_pos || row.result?.winner_pos;
        const option = optionsById[winner] || OPTIONS[0];
        return (
          <View key={`${row.id || index}-${index}`} style={styles.historyPill}>
            <Text style={styles.historyName}>{option.label}</Text>
            {index === 0 ? <Text style={styles.historyNew}>NEW</Text> : null}
          </View>
        );
      }) : (
        <Text style={styles.emptyHistory}>First result coming soon</Text>
      )}
    </ScrollView>
  );
}

function PublicBetRail({ bets }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.publicBetRail}>
      {bets.length ? bets.slice(0, 18).map((bet, index) => (
        <View key={`${bet.id || index}`} style={styles.publicBetItem}>
          <View style={styles.publicAvatar}>
            {bet.avatar_url ? (
              <Image source={{ uri: bet.avatar_url }} style={styles.publicAvatarImage} />
            ) : (
              <Ionicons name="person" size={13} color="#FFE7A2" />
            )}
          </View>
          <Text style={styles.publicBetName} numberOfLines={1}>{bet.name || 'Guest'}</Text>
          <Text style={styles.publicBetAmount}>{compact(bet.amount)}</Text>
        </View>
      )) : (
        <Text style={styles.emptyPublicBets}>No public bets yet</Text>
      )}
    </ScrollView>
  );
}

const DealerReveal = memo(function DealerReveal() {
  return (
    <View style={styles.revealOverlay} pointerEvents="none">
      <LinearGradient colors={['rgba(80,20,72,.96)', 'rgba(31,10,60,.97)']} style={styles.revealPopup}>
        <Text style={styles.revealEyebrow}>NO MORE BETS</Text>
        <View style={styles.revealCards}>
          {[-10, 0, 10].map((rotation, index) => (
            <View key={rotation} style={[styles.revealCard, { transform: [{ rotate: `${rotation}deg` }, { translateY: index === 1 ? -5 : 0 }] }]}>
              <Ionicons name="diamond" size={18} color="#FFE47C" />
            </View>
          ))}
        </View>
        <View style={styles.revealStatus}>
          <ActivityIndicator size="small" color="#FFE47C" />
          <Text style={styles.revealText}>Dealer is revealing the cards...</Text>
        </View>
      </LinearGradient>
    </View>
  );
});

function ResultModal({ result, optionsById, onClose }) {
  if (!result) return null;
  const option = optionsById[result.winner] || OPTIONS[0];
  const hand = result.hands?.[result.winner] || {};
  const hasWin = Number(result.winAmount || 0) > 0;
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <LinearGradient colors={hasWin ? ['#61156D', '#2A0B4E'] : ['#2B155B', '#140829']} style={styles.resultModal}>
          <TouchableOpacity onPress={onClose} style={styles.modalClose}>
            <Ionicons name="close" size={20} color="#FFFFFF" />
          </TouchableOpacity>
          <Text style={styles.resultTitle}>{option.label} Wins</Text>
          <Text style={styles.resultSubtitle}>{hand.rank || 'Result'}</Text>
          <View style={styles.resultCards}>
            {(hand.cards || []).map((card, idx) => (
              <PlayingCard key={`${card.value}-${card.suit}-${idx}`} card={card} small />
            ))}
          </View>
          <LinearGradient colors={hasWin ? ['#FFECA3', '#FFB547'] : ['#35205D', '#1B1034']} style={styles.resultAmountBox}>
            <Text style={[styles.resultAmountLabel, !hasWin && styles.resultLoseLabel]}>Total Win</Text>
            <Text style={[styles.resultAmount, !hasWin && styles.resultLoseAmount]}>{formatAmount(result.winAmount)} diamonds</Text>
          </LinearGradient>
          <View style={styles.resultWinners}>
            <Text style={styles.resultWinnersTitle}>Top Winners</Text>
            {(result.topWinners || []).length ? result.topWinners.slice(0, 5).map((winner, index) => (
              <View key={`${winner.user_id}-${index}`} style={styles.resultWinnerRow}>
                <Text style={styles.resultWinnerRank}>{index + 1}</Text>
                <Text style={styles.resultWinnerName} numberOfLines={1}>{winner.name || 'Guest'}</Text>
                <Text style={styles.resultWinnerAmount}>{compact(winner.win_amount)}</Text>
              </View>
            )) : (
              <Text style={styles.noWinners}>No winners this round</Text>
            )}
          </View>
        </LinearGradient>
      </View>
    </Modal>
  );
}

function TinPattiPro({
  myDiamonds,
  setMyDiamonds,
  onBack,
  onClose,
  standalone = false,
}) {
  const { width, height } = useWindowDimensions();
  const {
    user,
    diamonds: globalDiamonds,
    setDiamonds: setGlobalDiamonds,
    lockBalanceUpdates,
    unlockBalanceUpdates,
  } = useGlobalState();
  const walletSource = Number(myDiamonds ?? globalDiamonds ?? 0);
  const setParentWallet = setMyDiamonds || setGlobalDiamonds;

  const [settings, setSettings] = useState(null);
  const [options, setOptions] = useState(OPTIONS.map((item) => ({ ...item, m: 2.9 })));
  const [round, setRound] = useState(null);
  const [status, setStatus] = useState('loading');
  const [bettingClosed, setBettingClosed] = useState(true);
  const [displayWallet, setDisplayWallet] = useState(walletSource);
  const [publicBets, setPublicBets] = useState([]);
  const [myBets, setMyBets] = useState([]);
  const [betTotals, setBetTotals] = useState({});
  const [history, setHistory] = useState([]);
  const [selectedAmount, setSelectedAmount] = useState(BETS[0]);
  const [message, setMessage] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [muted, setMuted] = useState(true);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [resultPopup, setResultPopup] = useState(null);

  const fetchTimerRef = useRef(null);
  const realtimeDebounceRef = useRef(null);
  const fetchInFlightRef = useRef(false);
  const fetchQueuedRef = useRef(false);
  const resultShownRef = useRef(null);
  const transitionFetchRef = useRef(null);
  const walletRef = useRef(walletSource);
  const selectedAmountRef = useRef(BETS[0]);
  const myBetsRef = useRef([]);
  const roundRef = useRef(null);
  const statusRef = useRef('loading');
  const bettingOpenRef = useRef(false);
  const pendingBetsRef = useRef(new Map());
  const optimisticBetIdRef = useRef(0);
  const syncTimerRef = useRef(null);

  const boardW = Math.min(width, standalone ? width : 430);
  const boardH = height;
  const heroHeight = Math.round(boardW * BACKGROUND_ASPECT);
  const roundId = round?.id || null;
  const endsAt = round?.ends_at;
  const result = round?.result || {};
  const winnerPos = result?.winner_pos || round?.winner_pos || null;
  const displaySeconds = Number(settings?.result_display_s || RESULT_SECONDS);
  const graceSeconds = useMemo(() => {
    const rawRules = settings?.special_result_rules;
    let rules = rawRules;
    if (typeof rawRules === 'string') {
      try { rules = JSON.parse(rawRules); } catch (_) { rules = {}; }
    }
    return Math.max(0, Math.min(30, Number(rules?.bet_acceptance_grace_s ?? 10)));
  }, [settings?.special_result_rules]);
  const optionsById = useMemo(() => Object.fromEntries(options.map((item) => [item.id, item])), [options]);

  const myBetTotals = useMemo(() => {
    const totals = {};
    myBets.forEach((bet) => {
      totals[bet.position] = (totals[bet.position] || 0) + Number(bet.amount || 0);
    });
    return totals;
  }, [myBets]);
  const publicBetsByPosition = useMemo(() => {
    const map = {};
    publicBets.forEach((bet) => {
      if (!bet?.position) return;
      if (!map[bet.position]) map[bet.position] = [];
      map[bet.position].push(bet);
    });
    return map;
  }, [publicBets]);
  const myRoundBet = useMemo(() => myBets.reduce((sum, bet) => sum + Number(bet.amount || 0), 0), [myBets]);

  useEffect(() => { walletRef.current = Number(displayWallet || 0); }, [displayWallet]);
  useEffect(() => { selectedAmountRef.current = selectedAmount; }, [selectedAmount]);
  useEffect(() => { myBetsRef.current = myBets; }, [myBets]);
  useEffect(() => { roundRef.current = round; }, [round]);
  useEffect(() => { statusRef.current = status; }, [status]);

  useEffect(() => {
    const open = status === 'betting' && !!round?.ends_at;
    bettingOpenRef.current = open;
    setBettingClosed(!open);
  }, [round?.id, round?.ends_at, status]);

  useEffect(() => {
    lockBalanceUpdates?.();
    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      setParentWallet?.(Number(walletRef.current || 0));
      unlockBalanceUpdates?.();
    };
  }, [lockBalanceUpdates, setParentWallet, unlockBalanceUpdates]);

  useEffect(() => {
    setDisplayWallet(Number(walletSource || 0));
  }, [walletSource]);

  const syncWallet = useCallback((nextWallet) => {
    const value = Number(nextWallet ?? walletRef.current ?? 0);
    walletRef.current = value;
    setDisplayWallet(value);
    setParentWallet?.(value);
  }, [setParentWallet]);

  const backToGameMenu = useCallback(() => {
    syncWallet();
    unlockBalanceUpdates?.();
    onBack?.();
  }, [onBack, syncWallet, unlockBalanceUpdates]);

  const closeGame = useCallback(() => {
    syncWallet();
    unlockBalanceUpdates?.();
    onClose?.();
  }, [onClose, syncWallet, unlockBalanceUpdates]);

  const applyState = useCallback((payload) => {
    if (!payload?.success) {
      setStatus('offline');
      setMessage(payload?.message || 'Tin Patti Pro is offline.');
      return;
    }
    const nextRound = payload.round || null;
    setSettings(payload.settings || null);
    setOptions(parseOptions(payload.settings?.multipliers));
    setRound(nextRound);
    setStatus(nextRound?.status || 'idle');
    const serverPublicBets = Array.isArray(payload.public_bets) ? payload.public_bets : [];
    const serverMyBets = Array.isArray(payload.my_bets) ? payload.my_bets : [];
    const serverBetIds = new Set(serverPublicBets.map((bet) => bet.id));
    const pendingBets = [];
    pendingBetsRef.current.forEach((bet, tempId) => {
      if (bet.round_id !== nextRound?.id) {
        pendingBetsRef.current.delete(tempId);
      } else if (bet.serverId && serverBetIds.has(bet.serverId)) {
        pendingBetsRef.current.delete(tempId);
      } else {
        pendingBets.push(bet);
      }
    });
    setPublicBets([...pendingBets, ...serverPublicBets]);
    setMyBets([...serverMyBets, ...pendingBets]);
    const nextBetTotals = { ...(payload.bet_totals || {}) };
    pendingBets.forEach((bet) => {
      nextBetTotals[bet.position] = Number(nextBetTotals[bet.position] || 0) + Number(bet.amount || 0);
    });
    setBetTotals(nextBetTotals);
    setHistory(Array.isArray(payload.history) ? payload.history : []);
    if (typeof payload.my_balance === 'number') {
      const pendingAmount = pendingBets.reduce((sum, bet) => sum + Number(bet.amount || 0), 0);
      syncWallet(Math.max(0, payload.my_balance - pendingAmount));
    }
    if (payload.server_now) {
      setClockOffsetMs(Date.now() - new Date(payload.server_now).getTime());
    }
    if (nextRound?.status === 'settled') {
      const nextWinner = nextRound.result?.winner_pos || nextRound.winner_pos;
      if (nextWinner && resultShownRef.current !== nextRound.id) {
        resultShownRef.current = nextRound.id;
        setTimeout(() => {
          const popupResult = nextRound.result || {};
          setResultPopup({
            winner: nextWinner,
            hands: popupResult.hands || {},
            winAmount: myBetsRef.current.reduce((sum, bet) => sum + Number(bet.win_amount || 0), 0),
            topWinners: popupResult.top_winners || [],
          });
        }, RESULT_SHOW_DELAY_MS);
      }
    } else if (nextRound?.status === 'betting') {
      resultShownRef.current = null;
      setResultPopup(null);
    }
  }, [syncWallet]);

  const fetchState = useCallback(async () => {
    if (fetchInFlightRef.current) {
      fetchQueuedRef.current = true;
      return;
    }
    fetchInFlightRef.current = true;
    try {
      const { data, error } = await supabase.rpc('get_tin_patti_pro_state');
      if (error) {
        setStatus('offline');
        setMessage(error.message || 'Could not load Tin Patti Pro.');
      } else {
        applyState(data);
      }
    } finally {
      fetchInFlightRef.current = false;
      if (fetchQueuedRef.current) {
        fetchQueuedRef.current = false;
        setTimeout(fetchState, 0);
      }
    }
  }, [applyState]);

  const scheduleFetchState = useCallback(() => {
    if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current);
    realtimeDebounceRef.current = setTimeout(() => {
      realtimeDebounceRef.current = null;
      fetchState();
    }, REALTIME_DEBOUNCE_MS);
  }, [fetchState]);

  useEffect(() => {
    fetchState();
    fetchTimerRef.current = setInterval(fetchState, POLL_MS);
    return () => {
      if (fetchTimerRef.current) clearInterval(fetchTimerRef.current);
      if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current);
    };
  }, [fetchState]);

  useEffect(() => {
    const roundChannel = supabase
      .channel(`tin-patti-pro-global-${Date.now()}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'game_rounds', filter: `room_id=eq.${GLOBAL_ROOM_ID}` },
        () => scheduleFetchState())
      .subscribe();
    return () => { try { supabase.removeChannel(roundChannel); } catch (_) {} };
  }, [scheduleFetchState]);

  useEffect(() => {
    if (!roundId) return undefined;
    const betChannel = supabase
      .channel(`tin-patti-pro-bets-${roundId}-${Date.now()}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'game_round_bets', filter: `round_id=eq.${roundId}` },
        () => scheduleFetchState())
      .subscribe();
    return () => { try { supabase.removeChannel(betChannel); } catch (_) {} };
  }, [roundId, scheduleFetchState]);

  const handleBettingOpenChange = useCallback((open) => {
    bettingOpenRef.current = open;
    setBettingClosed(!open);
  }, []);

  const handleTransitionDue = useCallback(() => {
    const transitionKey = `${statusRef.current}-${roundRef.current?.id || 'none'}`;
    if (transitionFetchRef.current === transitionKey) return;
    transitionFetchRef.current = transitionKey;
    fetchState();
  }, [fetchState]);

  const placeBet = useCallback(async (option) => {
    const liveRound = roundRef.current;
    const liveAmount = Number(selectedAmountRef.current || 0);
    const liveWallet = Number(walletRef.current || 0);
    if (!liveRound?.id || statusRef.current !== 'betting' || !bettingOpenRef.current) {
      setMessage('Betting is closed for this round.');
      return;
    }
    if (liveWallet < liveAmount) {
      setMessage('Insufficient diamonds.');
      return;
    }

    const tempId = `optimistic-${Date.now()}-${optimisticBetIdRef.current += 1}`;
    const optimisticBet = {
      id: tempId,
      round_id: liveRound.id,
      user_id: user?.id,
      name: user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'You',
      avatar_url: user?.user_metadata?.avatar_url || null,
      position: option.id,
      amount: liveAmount,
      created_at: new Date().toISOString(),
      optimistic: true,
    };
    pendingBetsRef.current.set(tempId, optimisticBet);
    setPublicBets((current) => [optimisticBet, ...current]);
    setMyBets((current) => [...current, optimisticBet]);
    setBetTotals((current) => ({
      ...current,
      [option.id]: Number(current?.[option.id] || 0) + liveAmount,
    }));
    setMessage(`${option.label} +${compact(liveAmount)}`);
    syncWallet(liveWallet - liveAmount);

    try {
      const { data, error } = await supabase.rpc('place_tin_patti_pro_bet', {
        p_round_id: liveRound.id,
        p_position: option.id,
        p_amount: liveAmount,
      });
      if (!data?.success) {
        pendingBetsRef.current.delete(tempId);
        setPublicBets((current) => current.filter((bet) => bet.id !== tempId));
        setMyBets((current) => current.filter((bet) => bet.id !== tempId));
        setBetTotals((current) => ({
          ...current,
          [option.id]: Math.max(0, Number(current?.[option.id] || 0) - liveAmount),
        }));
        syncWallet(Number(walletRef.current || 0) + liveAmount);
        setMessage(data?.message || error?.message || 'Bet failed.');
        scheduleFetchState();
        return;
      }
      const pending = pendingBetsRef.current.get(tempId);
      if (pending) pending.serverId = data.bet_id;
      scheduleFetchState();
    } catch (err) {
      pendingBetsRef.current.delete(tempId);
      setPublicBets((current) => current.filter((bet) => bet.id !== tempId));
      setMyBets((current) => current.filter((bet) => bet.id !== tempId));
      setBetTotals((current) => ({
        ...current,
        [option.id]: Math.max(0, Number(current?.[option.id] || 0) - liveAmount),
      }));
      syncWallet(Number(walletRef.current || 0) + liveAmount);
      setMessage(err?.message || 'Bet failed.');
      scheduleFetchState();
    }
  }, [scheduleFetchState, syncWallet, user]);

  const repeatBet = useCallback(async () => {
    const lastPositions = [...new Set(myBetsRef.current.map((bet) => bet.position))];
    if (!lastPositions.length) {
      setMessage('No current round bets to repeat.');
      return;
    }
    for (const position of lastPositions) {
      const option = optionsById[position];
      if (option) await placeBet(option);
    }
  }, [optionsById, placeBet]);

  const hands = result?.hands || {};
  const controlsDisabled = status !== 'betting' || bettingClosed;
  const waitingForResult = status === 'betting'
    && bettingClosed
    && !!endsAt
    && Date.now() - Number(clockOffsetMs || 0) >= new Date(endsAt).getTime();

  const body = (
    <View style={[styles.shell, { width: boardW, height: boardH }]}>
      <LinearGradient colors={['rgba(91,38,9,.74)', 'rgba(146,66,16,.88)']} style={styles.topbar}>
        <TouchableOpacity onPress={backToGameMenu} style={styles.iconButton}>
          <Ionicons name="chevron-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <View style={styles.titleWrap}>
          <Text style={styles.gameTitle}>Tin Patti Pro</Text>
          <RoundTimer
            status={status}
            endsAt={endsAt}
            settledAt={result?.settled_at}
            displaySeconds={displaySeconds}
            graceSeconds={graceSeconds}
            clockOffsetMs={clockOffsetMs}
            roundId={roundId}
            onBettingOpenChange={handleBettingOpenChange}
            onTransitionDue={handleTransitionDue}
          />
        </View>
          <TouchableOpacity onPress={closeGame} style={styles.iconButton}>
          <Ionicons name="close" size={22} color="#FFFFFF" />
        </TouchableOpacity>
      </LinearGradient>
      <View style={styles.stage}>
        <Image source={A.backgroundPoster} style={styles.backgroundPoster} resizeMode="cover" pointerEvents="none" />
        <GameBackground />
        <View style={styles.videoShade} />
        <View style={styles.actionRow}>
          <Image source={A.gift} style={styles.giftButton} resizeMode="contain" />
          <PublicBetRail bets={publicBets} />
          <TouchableOpacity onPress={() => setHelpOpen(true)}>
            <Image source={A.help} style={styles.roundButton} resizeMode="contain" />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setMuted((v) => !v)}>
            <Image source={muted ? A.sound : A.players} style={styles.roundButton} resizeMode="contain" />
          </TouchableOpacity>
        </View>

        <View style={styles.boardRow}>
          {options.map((option) => (
            <BoardCard
              key={option.id}
              option={option}
              pot={Number(betTotals?.[option.id] || 0)}
              myBet={Number(myBetTotals?.[option.id] || 0)}
              boardBets={publicBetsByPosition[option.id] || []}
              hand={hands?.[option.id]}
              selected={Number(myBetTotals?.[option.id] || 0) > 0}
              winner={winnerPos === option.id}
              disabled={controlsDisabled}
              onPress={placeBet}
            />
          ))}
        </View>

        <View style={styles.bottomDock}>
          <ImageBackground source={A.inputBar} style={styles.betBar} imageStyle={styles.betBarImage} resizeMode="stretch">
            <View style={styles.balancePill}>
              <Image source={A.gCoin} style={styles.coin} resizeMode="contain" />
              <Text style={styles.balanceText}>{compact(displayWallet)}</Text>
            </View>
            <View style={styles.chipRow}>
              {BETS.map((amount) => (
                <TouchableOpacity
                  key={amount}
                  onPress={() => setSelectedAmount(amount)}
                  activeOpacity={0.86}
                  style={[styles.chipTouch, selectedAmount === amount && styles.chipTouchActive]}
                >
                  <Image source={chipAssetByAmount[amount]} style={styles.chipImage} resizeMode="contain" />
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity disabled={controlsDisabled} onPress={repeatBet} style={[styles.repeatButton, controlsDisabled && styles.repeatDisabled]}>
              <Text style={styles.repeatText}>Repeat</Text>
            </TouchableOpacity>
          </ImageBackground>

          {message ? <Text style={styles.messageText}>{message}</Text> : null}

          <LinearGradient colors={['rgba(82,38,9,.84)', 'rgba(33,82,50,.78)']} style={styles.historyPanel}>
            <Text style={styles.historyTitle}>Result History</Text>
            <HistoryRail history={history} optionsById={optionsById} />
          </LinearGradient>

          <View style={styles.summaryRow}>
            <View style={styles.summaryPill}>
              <Text style={styles.summaryLabel}>Round Bet</Text>
              <Text style={styles.summaryValue}>{compact(myRoundBet)}</Text>
            </View>
            <View style={styles.summaryPill}>
              <Text style={styles.summaryLabel}>Round</Text>
              <Text style={styles.summaryValue}>{roundId ? String(roundId).slice(-5) : '...'}</Text>
            </View>
          </View>
        </View>

        {waitingForResult ? <DealerReveal /> : null}
      </View>

      {status === 'loading' && (
        <View style={styles.loading}>
          <ActivityIndicator color="#FFE27A" size="large" />
          <Text style={styles.loadingText}>Opening Tin Patti Pro...</Text>
        </View>
      )}

      <ResultModal result={resultPopup} optionsById={optionsById} onClose={() => setResultPopup(null)} />

      <Modal transparent animationType="fade" visible={helpOpen} onRequestClose={() => setHelpOpen(false)}>
        <View style={styles.modalOverlay}>
          <LinearGradient colors={['#643218', '#1F5D42']} style={styles.helpCard}>
            <Text style={styles.resultTitle}>Tin Patti Pro</Text>
            <Text style={styles.helpText}>Select Crown, Coffee, or Cake during the shared global countdown. Every player sees the same pots, cards, and result.</Text>
            <Text style={styles.helpText}>Winning boards pay the configured multiplier. Admin controls timing, payout range, and forced next result from the dashboard.</Text>
            <TouchableOpacity onPress={() => setHelpOpen(false)} style={styles.helpButton}>
              <Text style={styles.helpButtonText}>Got it</Text>
            </TouchableOpacity>
          </LinearGradient>
        </View>
      </Modal>
    </View>
  );

  return standalone ? body : <View style={styles.host}>{body}</View>;
}

export default memo(TinPattiPro);

const styles = StyleSheet.create({
  host: { alignItems: 'center', justifyContent: 'flex-start' },
  shell: {
    alignSelf: 'center',
    overflow: 'hidden',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    backgroundColor: 'transparent',
  },
  stage: {
    flex: 1,
    position: 'relative',
    backgroundColor: 'transparent',
  },
  backgroundVideo: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#4D2A17',
    transform: [{ translateY: -150 }],
  },
  backgroundPoster: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  videoStage: {
    marginHorizontal: -8,
    marginTop: 0,
    overflow: 'hidden',
    backgroundColor: '#4D2A17',
  },
  videoLayer: { backgroundColor: '#4D2A17' },
  videoShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(79,36,13,.04)' },
  topbar: {
    height: 50,
    zIndex: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,232,149,.32)',
  },
  iconButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  titleWrap: { alignItems: 'center' },
  gameTitle: { color: '#FFF4C0', fontSize: 18, fontWeight: '900' },
  timerText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900', marginTop: 1 },
  scrollBody: { paddingHorizontal: 8, paddingTop: 0, paddingBottom: 310, backgroundColor: 'transparent' },
  actionRow: {
    position: 'absolute',
    top: 8,
    left: 8,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 58,
    zIndex: 5,
  },
  giftButton: { width: 54, height: 54 },
  roundButton: { width: 44, height: 44 },
  publicBetRail: { flexGrow: 1, gap: 6, alignItems: 'center', paddingHorizontal: 2 },
  publicBetItem: { width: 48, alignItems: 'center' },
  publicAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 2,
    borderColor: '#F9C85C',
    backgroundColor: 'rgba(71,25,11,.72)',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  publicAvatarImage: { width: '100%', height: '100%' },
  publicBetName: { color: '#FFFFFF', fontSize: 8, fontWeight: '900', maxWidth: 44, marginTop: 1 },
  publicBetAmount: { color: '#FFE66E', fontSize: 9, fontWeight: '900' },
  emptyPublicBets: { color: '#FFE7A2', fontSize: 11, fontWeight: '800', alignSelf: 'center' },
  boardRow: {
    position: 'absolute',
    left: 2,
    right: 2,
    bottom: 196,
    flexDirection: 'row',
    gap: 1,
    alignItems: 'stretch',
    zIndex: 4,
  },
  bottomDock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 8,
    paddingBottom: 4,
    zIndex: 6,
  },
  boardTouch: { flex: 1, borderRadius: 14, minWidth: 0 },
  boardTouchSelected: { transform: [{ translateY: -3 }] },
  boardTouchWinner: { shadowColor: '#FFE66E', shadowOpacity: 1, shadowRadius: 16, elevation: 10 },
  boardCard: { height: 248, justifyContent: 'flex-start', alignItems: 'center', paddingTop: 32, overflow: 'hidden' },
  boardImage: { borderRadius: 14 },
  winnerPreload: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  boardHeaderText: {
    position: 'absolute',
    top: 11,
    color: '#6B2D08',
    fontSize: 17,
    fontWeight: '900',
    textAlign: 'center',
  },
  potBadge: {
    minWidth: 88,
    height: 28,
    borderRadius: 9,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 21,
    paddingHorizontal: 4,
  },
  potText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
    textShadowColor: 'rgba(66,17,4,.92)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  myBetBadge: {
    minWidth: 78,
    height: 23,
    borderRadius: 11,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 22,
    paddingHorizontal: 6,
    transform: [{ translateY: -16 }],
  },
  myBetText: { color: '#FFEA4C', fontSize: 12, fontWeight: '900' },
  cardsRow: { flexDirection: 'row', marginTop: 46, gap: 1, zIndex: 8 },
  card: {
    width: 30,
    height: 43,
    borderRadius: 4,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#D3D8E3',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: .22,
    shadowRadius: 3,
    elevation: 2,
  },
  cardSmall: { width: 42, height: 58, borderRadius: 6 },
  cardHidden: { backgroundColor: '#BF1D2E', borderColor: '#FFE0A3' },
  cardValue: { color: '#111827', fontSize: 18, fontWeight: '900', lineHeight: 20 },
  cardValueSmall: { fontSize: 22, lineHeight: 24 },
  cardSuit: { color: '#111827', fontSize: 11, fontWeight: '900', marginTop: -2 },
  cardSuitSmall: { fontSize: 13 },
  cardSuitIcon: { width: 13, height: 13, marginTop: -1 },
  cardSuitIconSmall: { width: 17, height: 17, marginTop: 0 },
  cardRed: { color: '#D21F33' },
  boardChipLayer: { ...StyleSheet.absoluteFillObject, zIndex: 4 },
  boardChipWrap: { position: 'absolute', width: 27, height: 27 },
  boardChip: { width: 29, height: 29 },
  moreChips: {
    position: 'absolute',
    right: 13,
    top: '61%',
    minWidth: 28,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(30,15,7,.78)',
    borderWidth: 1,
    borderColor: '#FFD978',
    color: '#FFF4B8',
    fontSize: 10,
    fontWeight: '900',
    lineHeight: 18,
    textAlign: 'center',
    overflow: 'hidden',
  },
  rankBadge: {
    position: 'absolute',
    bottom: 86,
    width: 101,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 11,
  },
  rankBadgeImage: { width: '100%', height: '100%' },
  rankText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900',
    textAlign: 'center',
    textShadowColor: '#7A0000',
    textShadowRadius: 4,
    transform: [{ translateY: -1 }],
  },
  betBar: { height: 84, marginTop: 4, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center' },
  betBarImage: { borderRadius: 22 },
  balancePill: {
    width: 92,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(98,25,18,.76)',
    borderWidth: 1,
    borderColor: '#EAA047',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 5,
  },
  coin: { width: 30, height: 30 },
  balanceText: { flex: 1, color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  chipRow: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2 },
  chipTouch: { width: 42, height: 50, alignItems: 'center', justifyContent: 'center' },
  chipTouchActive: { transform: [{ translateY: -5 }, { scale: 1.06 }] },
  chipImage: { width: 44, height: 44 },
  repeatButton: {
    width: 68,
    height: 36,
    borderRadius: 19,
    backgroundColor: '#DADDE2',
    borderWidth: 2,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 0,
  },
  repeatDisabled: { opacity: 0.5 },
  repeatText: { color: '#777C84', fontSize: 14, fontWeight: '900' },
  messageText: { color: '#FFF4A8', textAlign: 'center', fontSize: 12, fontWeight: '900', marginTop: -4, minHeight: 16 },
  historyPanel: { minHeight: 54, marginTop: 4, borderRadius: 14, borderWidth: 2, borderColor: '#E7B456', paddingVertical: 3, paddingHorizontal: 6 },
  historyTitle: { color: '#FFFFFF', textAlign: 'center', fontSize: 13, fontWeight: '900', marginBottom: 3 },
  historyRail: { gap: 7, alignItems: 'center', minWidth: '100%' },
  historyPill: {
    minWidth: 70,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#FFD67A',
    borderWidth: 2,
    borderColor: '#FFF1B0',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  historyName: { color: '#6A270F', fontSize: 12, fontWeight: '900' },
  historyNew: { position: 'absolute', top: -7, color: '#FF2639', fontSize: 8, fontWeight: '900' },
  emptyHistory: { color: '#FFE7A2', textAlign: 'center', fontSize: 12, fontWeight: '800', width: '100%' },
  summaryRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
  summaryPill: {
    flex: 1,
    minHeight: 42,
    borderRadius: 14,
    backgroundColor: 'rgba(73,30,10,.76)',
    borderWidth: 1,
    borderColor: 'rgba(255,220,126,.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  summaryLabel: { color: '#FFDFA4', fontSize: 11, fontWeight: '800' },
  summaryValue: { color: '#FFFFFF', fontSize: 16, fontWeight: '900', marginTop: 1 },
  loading: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(39,16,6,.72)', alignItems: 'center', justifyContent: 'center', zIndex: 20 },
  loadingText: { color: '#FFF4C0', fontSize: 14, fontWeight: '900', marginTop: 10 },
  revealOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 15,
    backgroundColor: 'rgba(28,9,23,.28)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 34,
  },
  revealPopup: {
    width: '100%',
    maxWidth: 300,
    minHeight: 176,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: '#FFD86A',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 16,
    shadowColor: '#000000',
    shadowOpacity: 0.42,
    shadowRadius: 14,
    elevation: 12,
  },
  revealEyebrow: { color: '#FFE47C', fontSize: 16, fontWeight: '900' },
  revealCards: { height: 72, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  revealCard: {
    width: 43,
    height: 60,
    marginHorizontal: -3,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#FFE8A3',
    backgroundColor: '#B7193D',
    alignItems: 'center',
    justifyContent: 'center',
  },
  revealStatus: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  revealText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(27,9,4,.68)', alignItems: 'center', justifyContent: 'center', padding: 22 },
  resultModal: { width: '100%', maxWidth: 350, borderRadius: 24, borderWidth: 3, borderColor: '#FFD86A', alignItems: 'center', padding: 16 },
  modalClose: {
    position: 'absolute',
    top: 10,
    right: 10,
    zIndex: 3,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(44,14,60,.82)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  resultTitle: { color: '#FFF8C7', fontSize: 24, fontWeight: '900', textAlign: 'center' },
  resultSubtitle: { color: '#FFD76A', fontSize: 14, fontWeight: '900', marginTop: 2 },
  resultCards: { flexDirection: 'row', gap: 6, marginTop: 12 },
  resultAmountBox: { width: '100%', minHeight: 64, borderRadius: 18, borderWidth: 2, borderColor: '#FFF4A2', alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  resultAmountLabel: { color: '#6A2800', fontSize: 12, fontWeight: '900', textTransform: 'uppercase' },
  resultLoseLabel: { color: '#D8C4EF' },
  resultAmount: { color: '#431050', fontSize: 22, fontWeight: '900', marginTop: 1 },
  resultLoseAmount: { color: '#FFFFFF' },
  resultWinners: { width: '100%', backgroundColor: 'rgba(19,5,49,.45)', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,216,106,.42)', padding: 10, marginTop: 10 },
  resultWinnersTitle: { color: '#FFE7A2', fontSize: 12, fontWeight: '900', textAlign: 'center', marginBottom: 6 },
  resultWinnerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  resultWinnerRank: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#FFC55D', color: '#431050', textAlign: 'center', lineHeight: 20, fontWeight: '900' },
  resultWinnerName: { flex: 1, color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  resultWinnerAmount: { color: '#FFE7A2', fontSize: 12, fontWeight: '900' },
  noWinners: { color: '#D8C4EF', textAlign: 'center', fontSize: 12, fontWeight: '800' },
  helpCard: { width: '100%', maxWidth: 340, borderRadius: 24, borderWidth: 3, borderColor: '#FFD86A', padding: 20 },
  helpText: { color: '#FFFFFF', fontSize: 14, lineHeight: 20, fontWeight: '700', marginTop: 10 },
  helpButton: { minWidth: 120, height: 40, borderRadius: 18, backgroundColor: '#FFC55D', alignItems: 'center', justifyContent: 'center', marginTop: 14, alignSelf: 'center' },
  helpButtonText: { color: '#431050', fontSize: 15, fontWeight: '900' },
});
