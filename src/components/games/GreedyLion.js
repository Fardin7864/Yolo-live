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
import { supabase } from '../../api/supabase';
import { useGlobalState } from '../../context/GlobalStateContext';

const GAME_ID = 'greedy_lion';
const GLOBAL_ROOM_ID = '00000000-0000-0000-0000-000000000001';
const BETS = [100, 1000, 5000, 50000, 100000];
const ROUND_SECONDS = 30;
const POPUP_SECONDS = 15;
const REALTIME_DEBOUNCE_MS = 350;
const FALLBACK_POLL_MS = 20000;
const TIMER_TICK_MS = 1000;
const BETTING_CLOSE_SAFETY_MS = 0;
const BETTING_DISPLAY_GRACE_MS = 120;
const BET_ACCEPTANCE_GRACE_SECONDS = 10;
const SPIN_GRACE_STEP_MS = 110;
const REVEAL_STEP_MS = 70;
const REVEAL_BASE_STEPS = 26;
const POPUP_DELAY_MS = 500;
const ACCEPTED_LOCAL_BET_HOLD_MS = 45000;
const consumedGreedyLionResultRoundIds = new Set();

const rememberConsumedResultRound = (roundId) => {
  if (!roundId) return;
  consumedGreedyLionResultRoundIds.add(roundId);
  if (consumedGreedyLionResultRoundIds.size > 80) {
    const oldestKey = consumedGreedyLionResultRoundIds.values().next().value;
    consumedGreedyLionResultRoundIds.delete(oldestKey);
  }
};

const A = {
  background: require('../../../assets/games/greedy-lion/background.webp'),
  wheel: require('../../../assets/games/greedy-lion/wheel.webp'),
  cat: require('../../../assets/games/greedy-lion/cat.webp'),
  chest: require('../../../assets/games/greedy-lion/chest.webp'),
  pizzaFood: require('../../../assets/games/greedy-lion/pizza-food.webp'),
  saladFood: require('../../../assets/games/greedy-lion/salad-food.webp'),
  chicken: require('../../../assets/games/greedy-lion/chicken.webp'),
  shrimp: require('../../../assets/games/greedy-lion/shrimp.webp'),
  ham: require('../../../assets/games/greedy-lion/ham.webp'),
  fish: require('../../../assets/games/greedy-lion/fish.webp'),
  carrot: require('../../../assets/games/greedy-lion/carrot.webp'),
  pepper: require('../../../assets/games/greedy-lion/pepper.webp'),
  tomato: require('../../../assets/games/greedy-lion/tomato.webp'),
  corn: require('../../../assets/games/greedy-lion/corn.webp'),
};

const DEFAULT_ITEMS = [
  { id: 'corn', label: 'Corn', category: 'salad', m: 5, image: A.corn, x: 24, y: 20 },
  { id: 'chicken', label: 'Chicken', category: 'pizza', m: 45, image: A.chicken, x: 50, y: 9 },
  { id: 'shrimp', label: 'Shrimp', category: 'pizza', m: 25, image: A.shrimp, x: 76, y: 20 },
  { id: 'tomato', label: 'Tomato', category: 'salad', m: 5, image: A.tomato, x: 20, y: 45 },
  { id: 'ham', label: 'Ham', category: 'pizza', m: 15, image: A.ham, x: 80, y: 45 },
  { id: 'pepper', label: 'Pepper', category: 'salad', m: 5, image: A.pepper, x: 28, y: 73 },
  { id: 'fish', label: 'Fish', category: 'pizza', m: 10, image: A.fish, x: 72, y: 73 },
  { id: 'carrot', label: 'Carrot', category: 'salad', m: 5, image: A.carrot, x: 50, y: 82 },
];

const itemImageById = DEFAULT_ITEMS.reduce((acc, item) => ({ ...acc, [item.id]: item.image }), {});
const categoryAsset = { pizza: A.pizzaFood, salad: A.saladFood };
const itemById = DEFAULT_ITEMS.reduce((acc, item) => ({ ...acc, [item.id]: item }), {});

const compact = (value) => {
  const n = Number(value || 0);
  if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `${n}`;
};

const parseItems = (multipliers) => {
  const arr = Array.isArray(multipliers) ? multipliers
    : typeof multipliers === 'string'
      ? (() => { try { return JSON.parse(multipliers); } catch (_) { return null; } })()
      : null;
  if (!Array.isArray(arr)) return DEFAULT_ITEMS;
  return DEFAULT_ITEMS.map((base) => {
    const live = arr.find((it) => it?.id === base.id);
    return {
      ...base,
      label: live?.label || base.label,
      category: live?.category || base.category,
      m: Number(live?.m || base.m),
    };
  });
};

const FoodItem = memo(function FoodItem({
  item,
  itemSize,
  selected,
  userBetAmount,
  revealSpinItemId,
  revealLandingCategory,
  winnerCategory,
  status,
  disabled,
  onPressItem,
}) {
  const revealActive = !!revealSpinItemId || !!revealLandingCategory || status === 'settled';
  const spinning = revealSpinItemId === item.id;
  const landing = revealLandingCategory && (item.category === revealLandingCategory || item.id === revealLandingCategory);
  const win = spinning || landing || (winnerCategory && (item.category === winnerCategory || item.id === winnerCategory));
  const locked = revealActive && !win;
  const handlePress = useCallback(() => onPressItem(item), [item, onPressItem]);

  return (
    <TouchableOpacity
      activeOpacity={0.86}
      disabled={disabled}
      onPress={handlePress}
      style={[
        styles.itemCard,
        {
          width: itemSize,
          height: itemSize * 1.18,
          left: `${item.x}%`,
          top: `${item.y}%`,
          marginLeft: -itemSize / 2,
          marginTop: -(itemSize * 0.58),
        },
        selected && styles.itemCardSelected,
        spinning && styles.itemCardSpin,
        landing && styles.itemCardLanding,
        win && styles.itemCardWin,
      ]}
    >
      {locked ? <View style={styles.itemLockedOverlay} pointerEvents="none" /> : null}
      <Image source={item.image} style={styles.itemImage} resizeMode="contain" />
      {userBetAmount ? <Text style={styles.itemBet}>{compact(userBetAmount)}</Text> : null}
    </TouchableOpacity>
  );
});

const CenterMascot = memo(function CenterMascot({ title, timerLabel }) {
  return (
    <View style={styles.centerMascot}>
      <Image source={A.cat} style={styles.cat} resizeMode="contain" />
      <Text style={styles.centerTitle}>{title}</Text>
      <View style={styles.timerPill}>
        <Text style={styles.timerText}>{timerLabel}</Text>
      </View>
    </View>
  );
});

const HistoryRail = memo(function HistoryRail({ history }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.historyRail}>
      {history.length === 0 ? (
        <Text style={styles.emptyHistory}>First result coming soon</Text>
      ) : history.map((row, index) => {
        const type = row.result?.result_type || (['pizza', 'salad'].includes(row.winner_pos) ? 'category' : 'item');
        const winner = row.result?.winner_pos || row.winner_pos || row.result?.category;
        const cat = row.result?.category || winner;
        return (
          <View key={`${row.id || index}-${index}`} style={styles.historyItem}>
            <Image source={type === 'category' ? (categoryAsset[cat] || A.chest) : (itemImageById[winner] || A.chest)} style={styles.historyImage} resizeMode="contain" />
            {index === 0 ? <Text style={styles.newText}>NEW</Text> : null}
            <Text style={styles.historyText}>{type === 'category' ? (cat === 'pizza' ? 'Pizza' : 'Salad') : (itemById[winner]?.label || 'Item')}</Text>
          </View>
        );
      })}
    </ScrollView>
  );
});

const ResultPopupModal = memo(function ResultPopupModal({ resultPopup, onClose }) {
  const hasWin = Number(resultPopup?.winAmount || 0) > 0;
  return (
    <Modal transparent animationType="fade" visible={!!resultPopup} onRequestClose={onClose}>
      <View style={styles.popupOverlay}>
        <LinearGradient colors={['#7B1D9E', '#40106F', '#170034']} style={styles.popup}>
          <TouchableOpacity onPress={onClose} style={styles.popupCloseButton} hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            <Ionicons name="close" size={20} color="#FFFFFF" />
          </TouchableOpacity>
          <LinearGradient colors={hasWin ? ['#FFE584', '#FF9D2E'] : ['#8E6DFF', '#DD6BFF']} style={styles.popupResultHalo}>
            <Image source={resultPopup?.resultType === 'category' ? (categoryAsset[resultPopup?.category] || A.chest) : (itemImageById[resultPopup?.winner] || A.chest)} style={styles.popupImage} resizeMode="contain" />
          </LinearGradient>
          <Text style={styles.popupTitle}>
            {resultPopup?.resultType === 'category'
              ? (resultPopup?.category === 'pizza' ? 'Pizza Wins!' : 'Salad Wins!')
              : `${itemById[resultPopup?.winner]?.label || 'Item'} Wins!`}
          </Text>
          <LinearGradient colors={hasWin ? ['#FFF0A8', '#FFC34C'] : ['#281148', '#3C1A67']} style={[styles.totalWinBox, !hasWin && styles.totalLoseBox]}>
            <Text style={[styles.totalWinLabel, !hasWin && styles.totalLoseLabel]}>Total Win</Text>
            <Text style={[styles.totalWinAmount, !hasWin && styles.totalLoseAmount]}>
              {compact(resultPopup?.winAmount || 0)} diamonds
            </Text>
          </LinearGradient>
          <View style={styles.popupBetsBox}>
            <Text style={styles.popupBetsTitle}>Your Bet On This Board</Text>
            {(resultPopup?.itemWiseBets || []).length ? resultPopup.itemWiseBets.map((bet) => (
              <View key={bet.id} style={styles.popupBetRow}>
                <Image source={itemImageById[bet.id]} style={styles.popupBetIcon} resizeMode="contain" />
                <Text style={styles.popupBetName}>{bet.label}</Text>
                <Text style={[styles.popupBetAmount, bet.won ? styles.popupBetWon : styles.popupBetLost]}>
                  {compact(bet.amount)} 💎 {bet.won ? 'WIN' : 'LOSE'}
                </Text>
              </View>
            )) : (
              <Text style={styles.noWinners}>No bet on this board</Text>
            )}
          </View>
          <View style={styles.popupItems}>
            {(resultPopup?.matchedIds || []).map((id) => (
              <Image key={id} source={itemImageById[id]} style={styles.popupItem} resizeMode="contain" />
            ))}
          </View>
          <View style={styles.winnersBox}>
            <Text style={styles.winnersTitle}>Top Winners</Text>
            {(resultPopup?.topWinners || []).length ? resultPopup.topWinners.slice(0, 3).map((winner, index) => (
              <View key={`${winner.user_id}-${index}`} style={styles.winnerRow}>
                <Text style={styles.winnerRank}>{index + 1}</Text>
                <Text style={styles.winnerName} numberOfLines={1}>{winner.name || 'Guest'}</Text>
                <Text style={styles.winnerAmount}>{compact(winner.win_amount)} 💎</Text>
              </View>
            )) : (
              <Text style={styles.noWinners}>No winners this round</Text>
            )}
          </View>
        </LinearGradient>
      </View>
    </Modal>
  );
});

function GreedyLion({
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
  const [items, setItems] = useState(DEFAULT_ITEMS);
  const [round, setRound] = useState(null);
  const [status, setStatus] = useState('loading');
  const [timeLeft, setTimeLeft] = useState(ROUND_SECONDS);
  const [popupLeft, setPopupLeft] = useState(0);
  const [displayWallet, setDisplayWallet] = useState(walletSource);
  const [bettingLocked, setBettingLocked] = useState(false);
  const [winnerCategory, setWinnerCategory] = useState(null);
  const [betRows, setBetRows] = useState([]);
  const [history, setHistory] = useState([]);
  const [selectedAmount, setSelectedAmount] = useState(BETS[0]);
  const [message, setMessage] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [resultPopup, setResultPopup] = useState(null);
  const [resultGateOpen, setResultGateOpen] = useState(false);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [revealSpinIndex, setRevealSpinIndex] = useState(-1);
  const [revealLandingCategory, setRevealLandingCategory] = useState(null);
  const [roundPhase, setRoundPhase] = useState('loading');

  const resultShownRef = useRef(null);
  const resultPopupRef = useRef(null);
  const resultGateOpenRef = useRef(false);
  const revealTimersRef = useRef([]);
  const spinLoopRef = useRef(null);
  const fetchTimerRef = useRef(null);
  const realtimeDebounceRef = useRef(null);
  const fetchInFlightRef = useRef(false);
  const fetchQueuedRef = useRef(false);
  const fetchStateRef = useRef(null);
  const roundRef = useRef(null);
  const betRowsRef = useRef([]);
  const walletRef = useRef(walletSource);
  const localWalletDirtyRef = useRef(false);
  const selectedAmountRef = useRef(selectedAmount);
  const statusRef = useRef(status);
  const timeLeftRef = useRef(timeLeft);
  const pendingBetsRef = useRef(new Map());
  const bettingLockedRef = useRef(false);
  const lastTickRef = useRef({ timeLeft: null, popupLeft: null });
  const activeResultRoundIdRef = useRef(null);
  const resultLockUntilMsRef = useRef(0);

  const boardW = Math.min(width - 18, standalone ? 430 : width - 18);
  const boardH = Math.min(height - 2, standalone ? height - 2 : 720);
  const itemSize = Math.max(68, Math.min(98, boardW * 0.22));
  const categorySize = Math.max(88, Math.min(132, boardW * 0.24));

  const roundId = round?.id || null;
  const endsAt = round?.ends_at || null;
  const displaySeconds = Number(settings?.result_display_s || POPUP_SECONDS);
  const timingRules = useMemo(() => {
    const rawRules = settings?.special_result_rules;
    return typeof rawRules === 'string'
      ? (() => { try { return JSON.parse(rawRules); } catch (_) { return null; } })()
      : rawRules;
  }, [settings?.special_result_rules]);
  const betGraceSeconds = useMemo(() => {
    const nextGrace = Number(timingRules?.bet_acceptance_grace_s ?? BET_ACCEPTANCE_GRACE_SECONDS);
    return Number.isFinite(nextGrace) ? Math.max(0, Math.min(30, nextGrace)) : BET_ACCEPTANCE_GRACE_SECONDS;
  }, [timingRules]);

  const myBetRows = useMemo(
    () => betRows.filter((row) => row.user_id === user?.id || row.user_id === 'demo'),
    [betRows, user?.id]
  );
  const selectedItems = useMemo(() => new Set(myBetRows.map((row) => row.position)), [myBetRows]);
  const myRoundBet = useMemo(() => myBetRows.reduce((sum, row) => sum + Number(row.amount || 0), 0), [myBetRows]);
  const myItemBets = useMemo(() => {
    const map = {};
    myBetRows.forEach((row) => { map[row.position] = (map[row.position] || 0) + Number(row.amount || 0); });
    return map;
  }, [myBetRows]);

  useEffect(() => {
    roundRef.current = round;
  }, [round]);

  useEffect(() => {
    betRowsRef.current = betRows;
  }, [betRows]);

  useEffect(() => {
    if (localWalletDirtyRef.current || pendingBetsRef.current.size > 0 || resultGateOpenRef.current) return;
    const nextWallet = Number(walletSource || 0);
    walletRef.current = nextWallet;
    setDisplayWallet(nextWallet);
  }, [walletSource]);

  useEffect(() => {
    lockBalanceUpdates?.();
    return () => {
      if (localWalletDirtyRef.current) {
        setParentWallet?.(walletRef.current);
      }
      unlockBalanceUpdates?.();
    };
  }, [lockBalanceUpdates, setParentWallet, unlockBalanceUpdates]);

  useEffect(() => {
    selectedAmountRef.current = selectedAmount;
  }, [selectedAmount]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    timeLeftRef.current = timeLeft;
  }, [timeLeft]);

  useEffect(() => {
    bettingLockedRef.current = bettingLocked;
  }, [bettingLocked]);

  useEffect(() => {
    resultPopupRef.current = resultPopup;
  }, [resultPopup]);

  useEffect(() => {
    resultGateOpenRef.current = resultGateOpen;
  }, [resultGateOpen]);

  const setBetRowsSynced = useCallback((updater) => {
    const currentRows = betRowsRef.current;
    const nextRows = typeof updater === 'function' ? updater(currentRows) : updater;
    betRowsRef.current = nextRows;
    setBetRows(nextRows);
  }, []);

  const setWalletSynced = useCallback((nextWallet, options = {}) => {
    const safeWallet = Math.max(0, Number(nextWallet || 0));
    walletRef.current = safeWallet;
    setDisplayWallet(safeWallet);
    if (options.markDirty !== false) localWalletDirtyRef.current = true;
  }, []);

  const syncParentWallet = useCallback((nextWallet = walletRef.current) => {
    const safeWallet = Math.max(0, Number(nextWallet || 0));
    localWalletDirtyRef.current = false;
    setParentWallet?.(safeWallet);
  }, [setParentWallet]);

  const closeGame = useCallback(() => {
    syncParentWallet();
    unlockBalanceUpdates?.();
    (onClose || onBack)?.();
  }, [onBack, onClose, syncParentWallet, unlockBalanceUpdates]);

  const backToGameMenu = useCallback(() => {
    syncParentWallet();
    onBack?.();
  }, [onBack, syncParentWallet]);

  const setResultGateSynced = useCallback((isOpen) => {
    resultGateOpenRef.current = isOpen;
    setResultGateOpen(isOpen);
  }, []);

  const debugGame = useCallback((event, details = {}) => {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.log(`[GreedyLion] ${event}`, details);
    }
  }, []);

  const getBettingMsLeft = useCallback(() => {
    const liveRound = roundRef.current;
    if (!liveRound?.ends_at) return 0;
    const endMs = new Date(liveRound.ends_at).getTime();
    if (!Number.isFinite(endMs)) return 0;
    const serverNowMs = Date.now() - Number(clockOffsetMs || 0);
    return endMs - serverNowMs;
  }, [clockOffsetMs]);

  const getSettledAtMs = useCallback((roundLike) => {
    const rawSettledAt = roundLike?.result?.settled_at || roundLike?.settled_at;
    const settledAtMs = rawSettledAt ? new Date(rawSettledAt).getTime() : NaN;
    if (Number.isFinite(settledAtMs)) return settledAtMs;
    const endMs = new Date(roundLike?.ends_at || Date.now()).getTime();
    return Number.isFinite(endMs) ? endMs + betGraceSeconds * 1000 : Date.now();
  }, [betGraceSeconds]);

  const clearSpinLoop = useCallback(() => {
    if (spinLoopRef.current) {
      clearInterval(spinLoopRef.current);
      spinLoopRef.current = null;
    }
  }, []);

  const clearRevealTimers = useCallback(() => {
    revealTimersRef.current.forEach((timer) => clearTimeout(timer));
    revealTimersRef.current = [];
    clearSpinLoop();
  }, [clearSpinLoop]);

  const showResult = useCallback((settledRound, winner, result = {}, rowsOverride = null) => {
    const resultType = result?.result_type || (winner === 'pizza' || winner === 'salad' ? 'category' : 'item');
    const category = result?.category || (resultType === 'category' ? winner : items.find((it) => it.id === winner)?.category);
    const roundResultId = settledRound?.id ? String(settledRound.id) : null;
    const key = `${settledRound.id}:${resultType}:${winner}`;
    const lockUntilMs = getSettledAtMs(settledRound) + displaySeconds * 1000;
    if (roundResultId && consumedGreedyLionResultRoundIds.has(roundResultId)) {
      const serverNowMs = Date.now() - Number(clockOffsetMs || 0);
      if (serverNowMs < lockUntilMs) {
        activeResultRoundIdRef.current = roundResultId;
        resultLockUntilMsRef.current = lockUntilMs;
        setResultGateSynced(true);
        bettingLockedRef.current = true;
        setBettingLocked(true);
        setRoundPhase(resultPopupRef.current ? 'result' : 'result_closed_locked');
      }
      return;
    }
    rememberConsumedResultRound(roundResultId);
    resultShownRef.current = key;
    activeResultRoundIdRef.current = roundResultId;
    resultLockUntilMsRef.current = lockUntilMs;
    clearRevealTimers();
    clearSpinLoop();
    setRoundPhase('result');
    setResultGateSynced(true);
    bettingLockedRef.current = true;
    setBettingLocked(true);

    const sourceRows = Array.isArray(rowsOverride) ? rowsOverride : myBetRows;
    const myRows = sourceRows.filter((row) => row.user_id === user?.id || row.user_id === 'demo');
    const matching = myRows.filter((row) => {
      const item = items.find((it) => it.id === row.position);
      return resultType === 'category' ? item?.category === category : row.position === winner;
    });
    const winAmount = matching.reduce((sum, row) => sum + Number(row.win_amount || 0), 0);
    const betAmount = myRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const matchedBetAmount = matching.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const winnerItem = items.find((item) => item.id === winner);
    const itemWiseBets = items
      .map((item) => ({
        id: item.id,
        label: item.label,
        amount: myRows
          .filter((row) => row.position === item.id)
          .reduce((sum, row) => sum + Number(row.amount || 0), 0),
        won: resultType === 'category' ? item.category === category : item.id === winner,
      }))
      .filter((row) => row.amount > 0);
    const popup = {
      category,
      resultType,
      winner,
      winnerLabel: resultType === 'category'
        ? (category === 'pizza' ? 'Pizza' : 'Salad')
        : (winnerItem?.label || 'Item'),
      winAmount,
      betAmount,
      matchedBetAmount,
      itemWiseBets,
      matchedIds: [...new Set(matching.map((row) => row.position))],
      topWinners: result?.top_winners || [],
    };

    resultPopupRef.current = null;
    setResultPopup(null);
    setWinnerCategory(null);
    setRevealLandingCategory(null);

    const winningIndex = Math.max(0, items.findIndex((item) => resultType === 'category' ? item.category === category : item.id === winner));
    const serverNowMs = Date.now() - Number(clockOffsetMs || 0);
    const revealStartMs = getSettledAtMs(settledRound);
    const isLateReveal = Number.isFinite(revealStartMs) && serverNowMs - revealStartMs > 1200;
    const totalSteps = (isLateReveal ? 8 : REVEAL_BASE_STEPS) + winningIndex;
    for (let step = 0; step <= totalSteps; step += 1) {
      const timer = setTimeout(() => setRevealSpinIndex(step % items.length), step * REVEAL_STEP_MS);
      revealTimersRef.current.push(timer);
    }

    const landDelay = (totalSteps + 1) * REVEAL_STEP_MS;
    const landTimer = setTimeout(() => {
      setRevealSpinIndex(-1);
      setRevealLandingCategory(resultType === 'category' ? category : winner);
      setWinnerCategory(resultType === 'category' ? category : winner);
    }, landDelay);
    const popupTimer = setTimeout(() => {
      resultPopupRef.current = popup;
      setResultPopup(popup);
    }, landDelay + POPUP_DELAY_MS);
    const fallbackTimer = setTimeout(() => {
      if (!resultPopupRef.current && resultShownRef.current === key) {
        setRevealSpinIndex(-1);
        setRevealLandingCategory(resultType === 'category' ? category : winner);
        setWinnerCategory(resultType === 'category' ? category : winner);
        resultPopupRef.current = popup;
        setResultPopup(popup);
      }
    }, landDelay + POPUP_DELAY_MS + 900);
    revealTimersRef.current.push(landTimer, popupTimer, fallbackTimer);
  }, [clearRevealTimers, clearSpinLoop, clockOffsetMs, displaySeconds, getSettledAtMs, items, myBetRows, setResultGateSynced, user?.id]);

  const closeResultPopup = useCallback(() => {
    clearRevealTimers();
    resultPopupRef.current = null;
    setResultPopup(null);
    syncParentWallet();
  }, [clearRevealTimers, syncParentWallet]);

  const applyState = useCallback((payload) => {
    if (!payload?.success) {
      setStatus('offline');
      setMessage(payload?.message || 'Greedy Lion is offline.');
      return;
    }
    const nextSettings = payload.settings || null;
    const nextRound = payload.round || null;
    const previousRoundId = roundRef.current?.id;
    const serverNowMs = payload.server_now ? new Date(payload.server_now).getTime() : Date.now();
    setSettings(nextSettings);
    if (nextSettings?.multipliers) setItems(parseItems(nextSettings.multipliers));
    if (payload.server_now) setClockOffsetMs(Date.now() - serverNowMs);
    if (typeof payload.my_balance === 'number' && pendingBetsRef.current.size === 0) {
      setWalletSynced(Number(payload.my_balance), { fromServer: true });
    }

    const resultLockActive = resultLockUntilMsRef.current > serverNowMs;
    const incomingNewBettingRound = nextRound?.status === 'betting'
      && activeResultRoundIdRef.current
      && String(nextRound.id) !== String(activeResultRoundIdRef.current);
    if (resultLockActive && incomingNewBettingRound) {
      bettingLockedRef.current = true;
      setBettingLocked(true);
      setRoundPhase(resultPopupRef.current ? 'result' : 'result_closed_locked');
      return;
    }

    roundRef.current = nextRound;
    statusRef.current = nextRound?.status || 'loading';
    const nextLocked = resultGateOpenRef.current || nextRound?.status !== 'betting' || getBettingMsLeft() <= BETTING_CLOSE_SAFETY_MS;
    bettingLockedRef.current = nextLocked;
    setBettingLocked(nextLocked);
    setRound(nextRound);
    setStatus(nextRound?.status || 'loading');
    const serverBets = Array.isArray(payload.my_bets)
      ? payload.my_bets
      : Array.isArray(payload.bets)
        ? payload.bets.filter((row) => row.user_id === user?.id || row.user_id === 'demo')
        : [];
    let mergedBetRows = serverBets;
    setBetRowsSynced((currentRows) => {
      const serverIds = new Set(serverBets.map((row) => row.id));
      const keepLocalRows = currentRows.filter((row) => (
        (pendingBetsRef.current.has(row.id) || row?._serverAccepted || row?._localUntil)
        && row.round_id === nextRound?.id
        && (pendingBetsRef.current.has(row.id) || row?._serverAccepted || row._localUntil > Date.now())
        && !serverIds.has(row.id)
      ));
      mergedBetRows = [...serverBets, ...keepLocalRows];
      return mergedBetRows;
    });
    setHistory(Array.isArray(payload.history) ? payload.history.slice(0, 15) : []);

    const result = nextRound?.result || {};
    const winner = result?.winner_pos || nextRound?.winner_pos || result?.category;
    if (nextRound?.status === 'settled' && winner) {
      const mergedIds = new Set(mergedBetRows.map((row) => row.id));
      const pendingRows = [...pendingBetsRef.current.values()].filter((row) => row.round_id === nextRound.id && !mergedIds.has(row.id));
      showResult(nextRound, winner, result, [...mergedBetRows, ...pendingRows]);
    } else if (nextRound?.status === 'betting') {
      if (!previousRoundId || previousRoundId !== nextRound.id) {
        clearRevealTimers();
        setResultGateSynced(false);
        setWinnerCategory(null);
        setRevealSpinIndex(-1);
        setRevealLandingCategory(null);
        resultPopupRef.current = null;
        setResultPopup(null);
        resultShownRef.current = null;
        activeResultRoundIdRef.current = null;
        resultLockUntilMsRef.current = 0;
        const roundOpen = getBettingMsLeft() > BETTING_CLOSE_SAFETY_MS;
        bettingLockedRef.current = !roundOpen;
        setBettingLocked(!roundOpen);
        setRoundPhase(roundOpen ? 'betting' : 'spinning_grace');
      }
    }
  }, [clearRevealTimers, getBettingMsLeft, setBetRowsSynced, setResultGateSynced, setWalletSynced, showResult, user?.id]);

  const fetchState = useCallback(async () => {
    if (fetchInFlightRef.current) {
      fetchQueuedRef.current = true;
      return;
    }
    fetchInFlightRef.current = true;
    try {
      const { data, error } = await supabase.rpc('get_greedy_lion_state');
      if (error) {
        setStatus('offline');
        setMessage(error.message || 'Could not load Greedy Lion.');
        return;
      }
      applyState(data);
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
    fetchStateRef.current = fetchState;
  }, [fetchState]);

  useEffect(() => {
    fetchStateRef.current?.();
    fetchTimerRef.current = setInterval(() => fetchStateRef.current?.(), FALLBACK_POLL_MS);
    return () => {
      if (fetchTimerRef.current) clearInterval(fetchTimerRef.current);
      if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current);
      clearRevealTimers();
    };
  }, [clearRevealTimers]);

  useEffect(() => {
    if (!roundId) return undefined;
    const roundChannel = supabase
      .channel(`greedy-lion-global-rounds-${Date.now()}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'game_rounds', filter: `room_id=eq.${GLOBAL_ROOM_ID}` },
        () => scheduleFetchState())
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'game_round_bets', filter: `round_id=eq.${roundId}` },
        () => scheduleFetchState())
      .subscribe();
    return () => { try { supabase.removeChannel(roundChannel); } catch (_) {} };
  }, [roundId, scheduleFetchState]);

  useEffect(() => {
    if (!endsAt) return undefined;
    const tick = () => {
      const serverNowMs = Date.now() - Number(clockOffsetMs || 0);
      const endMs = new Date(endsAt).getTime();
      if (status === 'settled') {
        const resultEndMs = getSettledAtMs(roundRef.current) + displaySeconds * 1000;
        const left = Math.max(0, Math.ceil((resultEndMs - serverNowMs) / 1000));
        setRoundPhase(resultPopupRef.current ? 'result' : 'result_closed_locked');
        if (!bettingLockedRef.current) {
          bettingLockedRef.current = true;
          setBettingLocked(true);
        }
        if (!resultGateOpenRef.current) setResultGateSynced(true);
        if (lastTickRef.current.popupLeft !== left) {
          lastTickRef.current.popupLeft = left;
          setPopupLeft(left);
        }
        if (lastTickRef.current.timeLeft !== 0) {
          lastTickRef.current.timeLeft = 0;
          timeLeftRef.current = 0;
          setTimeLeft(0);
        }
        if (left <= 0) fetchState();
      } else {
        const msLeft = endMs - serverNowMs;
        const left = msLeft > BETTING_DISPLAY_GRACE_MS ? Math.max(1, Math.floor(msLeft / 1000)) : 0;
        const nextPhase = msLeft > BETTING_CLOSE_SAFETY_MS ? 'betting' : 'spinning_grace';
        setRoundPhase(nextPhase);
        const nextLocked = resultGateOpenRef.current || status !== 'betting' || msLeft <= BETTING_CLOSE_SAFETY_MS;
        if (bettingLockedRef.current !== nextLocked) {
          bettingLockedRef.current = nextLocked;
          setBettingLocked(nextLocked);
        }
        if (lastTickRef.current.timeLeft !== left) {
          lastTickRef.current.timeLeft = left;
          timeLeftRef.current = left;
          setTimeLeft(left);
        }
        if (lastTickRef.current.popupLeft !== 0) {
          lastTickRef.current.popupLeft = 0;
          setPopupLeft(0);
        }
        if (left <= 0) fetchState();
      }
    };
    tick();
    const timer = setInterval(tick, TIMER_TICK_MS);
    return () => clearInterval(timer);
  }, [clockOffsetMs, displaySeconds, endsAt, fetchState, getSettledAtMs, setResultGateSynced, status]);

  useEffect(() => {
    if (roundPhase !== 'spinning_grace' || status !== 'betting' || items.length === 0) {
      return undefined;
    }
    clearSpinLoop();
    setResultGateSynced(true);
    setWinnerCategory(null);
    setRevealLandingCategory(null);
    let spinIndex = 0;
    setRevealSpinIndex(spinIndex % items.length);
    spinLoopRef.current = setInterval(() => {
      spinIndex = (spinIndex + 1) % items.length;
      setRevealSpinIndex(spinIndex);
    }, SPIN_GRACE_STEP_MS);
    return () => clearSpinLoop();
  }, [clearSpinLoop, items.length, roundPhase, setResultGateSynced, status]);

  useEffect(() => {
    if (!endsAt || status !== 'betting') return undefined;
    const msUntilLock = Math.max(0, getBettingMsLeft() - BETTING_CLOSE_SAFETY_MS);
    if (msUntilLock <= 0) {
      if (!bettingLockedRef.current) {
        bettingLockedRef.current = true;
        setBettingLocked(true);
      }
      return undefined;
    }
    const timer = setTimeout(() => {
      bettingLockedRef.current = true;
      setBettingLocked(true);
    }, msUntilLock);
    return () => clearTimeout(timer);
  }, [endsAt, getBettingMsLeft, status]);

  const placeBet = useCallback(async (item) => {
    const liveRound = roundRef.current;
    const liveRoundId = liveRound?.id || roundId;
    const liveStatus = statusRef.current;
    const liveTimeLeft = timeLeftRef.current;
    const liveMsLeft = getBettingMsLeft();
    const liveAmount = Number(selectedAmountRef.current || selectedAmount || 0);
    const liveRows = betRowsRef.current.filter((row) => row.user_id === user?.id || row.user_id === 'demo');
    const liveSelectedItems = new Set(liveRows.map((row) => row.position));
    const liveWallet = Number(walletRef.current || 0);

    if (resultGateOpenRef.current || liveStatus !== 'betting' || liveTimeLeft <= 0 || liveMsLeft <= BETTING_CLOSE_SAFETY_MS || bettingLockedRef.current) {
      setMessage('Betting is closed for this round.');
      return;
    }
    const isNew = !liveSelectedItems.has(item.id);
    if (isNew && liveSelectedItems.size >= 6) {
      setMessage('Maximum 6 unique items per round. You can still add more to selected items.');
      return;
    }
    if (!liveRoundId || liveAmount <= 0) {
      setMessage('Round is not ready.');
      return;
    }
    if (liveWallet < liveAmount) {
      setMessage('Insufficient diamonds.');
      return;
    }

    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}-${item.id}`;
    const tempRow = {
      id: tempId,
      round_id: liveRoundId,
      user_id: user?.id || 'demo',
      position: item.id,
      amount: liveAmount,
      win_amount: 0,
      _optimistic: true,
      _localUntil: Date.now() + 5000,
      _createdAt: Date.now(),
    };
    pendingBetsRef.current.set(tempId, tempRow);
    debugGame('tap:optimistic', {
      roundId: liveRoundId,
      position: item.id,
      amount: liveAmount,
      walletBefore: liveWallet,
      pending: pendingBetsRef.current.size,
    });
    setMessage(`${item.label} +${compact(liveAmount)}`);
    setBetRowsSynced((cur) => [...cur, tempRow]);
    setWalletSynced(liveWallet - liveAmount);

    try {
      const { data, error } = await supabase.rpc('place_greedy_lion_bet', {
        p_round_id: liveRoundId,
        p_position: item.id,
        p_amount: liveAmount,
      });

      if (!data?.success) {
        pendingBetsRef.current.delete(tempId);
        setBetRowsSynced((cur) => cur.filter((row) => row.id !== tempId));
        setWalletSynced(Number(walletRef.current || 0) + liveAmount);
        const failMessage = data?.message || error?.message || 'Bet failed.';
        debugGame('tap:rejected', { tempId, position: item.id, amount: liveAmount, message: failMessage });
        setMessage(/closed|expired/i.test(failMessage) ? 'Last bet missed the round.' : failMessage);
        if (pendingBetsRef.current.size === 0) syncParentWallet();
        if (statusRef.current === 'betting') fetchState();
        return;
      }

      pendingBetsRef.current.delete(tempId);
      if (typeof data.balance === 'number' && pendingBetsRef.current.size === 0) {
        setWalletSynced(Math.min(Number(walletRef.current || 0), Number(data.balance)), { fromServer: true });
        syncParentWallet(Math.min(Number(walletRef.current || 0), Number(data.balance)));
        fetchState();
      }
      debugGame('tap:accepted', {
        tempId,
        betId: data.bet_id,
        position: item.id,
        amount: liveAmount,
        pending: pendingBetsRef.current.size,
      });
      setBetRowsSynced((cur) => cur.map((row) => row.id === tempId ? {
        ...row,
        id: data.bet_id || tempId,
        _optimistic: false,
        _serverAccepted: true,
        _localUntil: Date.now() + ACCEPTED_LOCAL_BET_HOLD_MS,
      } : row));
    } catch (err) {
      pendingBetsRef.current.delete(tempId);
      setBetRowsSynced((cur) => cur.filter((row) => row.id !== tempId));
      setWalletSynced(Number(walletRef.current || 0) + liveAmount);
      const failMessage = err?.message || 'Bet failed.';
      debugGame('tap:error', { tempId, position: item.id, amount: liveAmount, message: failMessage });
      setMessage(/closed|expired/i.test(failMessage) ? 'Last bet missed the round.' : failMessage);
      if (pendingBetsRef.current.size === 0) syncParentWallet();
      if (statusRef.current === 'betting') fetchState();
    } finally {
      pendingBetsRef.current.delete(tempId);
    }
  }, [debugGame, fetchState, getBettingMsLeft, roundId, selectedAmount, setBetRowsSynced, setWalletSynced, syncParentWallet, user?.id]);

  const spinningGrace = roundPhase === 'spinning_grace';
  const title = status === 'settled'
    ? `${winnerCategory === 'pizza' ? 'Pizza' : winnerCategory === 'salad' ? 'Salad' : (itemById[winnerCategory]?.label || 'Item')} Wins`
    : timeLeft > 0
      ? 'Select Time'
      : 'Spinning';
  const timerLabel = status === 'settled' ? `${Math.max(0, popupLeft)}s` : spinningGrace ? '...' : `${Math.max(0, timeLeft)}s`;
  const controlsDisabled = resultGateOpen || bettingLocked || status !== 'betting' || roundPhase !== 'betting';

  const body = (
    <View style={[styles.shell, { width: boardW, maxHeight: boardH }]}>
      <LinearGradient colors={['#1E0C49', '#160532']} style={styles.topbar}>
        <TouchableOpacity onPress={backToGameMenu} style={styles.iconButton}>
          <Ionicons name="chevron-back" size={22} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.gameTitle}>Greedy Lion</Text>
        <TouchableOpacity onPress={closeGame} style={styles.iconButton}>
          <Ionicons name="close" size={22} color="#FFFFFF" />
        </TouchableOpacity>
      </LinearGradient>

      <ScrollView bounces={false} showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollBody}>
        <ImageBackground source={A.background} style={styles.board} imageStyle={styles.boardImage} resizeMode="cover">
          <View style={styles.darkOverlay} />
          <View style={styles.hudRow}>
            <View style={styles.roundPill}>
              <Ionicons name="trophy" size={16} color="#FBD35D" />
              <Text style={styles.roundText}>Round: {roundId ? String(roundId).slice(-5) : '...'}</Text>
            </View>
            <View style={styles.hudButtons}>
              <TouchableOpacity onPress={() => setHelpOpen(true)} style={styles.squareButton}>
                <Ionicons name="help" size={23} color="#FFFFFF" />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setMuted((v) => !v)} style={styles.squareButton}>
                <Ionicons name={muted ? 'volume-mute' : 'volume-high'} size={20} color="#BDF3FF" />
              </TouchableOpacity>
            </View>
          </View>

          <View style={[styles.wheelWrap, { height: Math.min(404, boardW * 0.98) }]}>
            <Image source={A.wheel} style={[styles.wheel, { width: Math.min(boardW * 1.02, 424), height: Math.min(boardW * 1.02, 424) }]} resizeMode="contain" />
            <CenterMascot title={title} timerLabel={timerLabel} />
            {items.map((item) => (
              <FoodItem
                key={item.id}
                item={item}
                itemSize={itemSize}
                selected={selectedItems.has(item.id)}
                userBetAmount={myItemBets[item.id] || 0}
                revealSpinItemId={revealSpinIndex >= 0 ? items[revealSpinIndex]?.id : null}
                revealLandingCategory={revealLandingCategory}
                winnerCategory={winnerCategory}
                status={status}
                disabled={controlsDisabled}
                onPressItem={placeBet}
              />
            ))}
          </View>

          <View style={styles.categoryRow}>
            <TouchableOpacity activeOpacity={0.88} style={styles.categoryTouch} onPress={() => setMessage('Salad wins pay the four 5x items you selected.')}>
              <Image source={A.saladFood} style={[styles.categoryImage, { width: categorySize, height: categorySize * 0.7 }]} resizeMode="contain" />
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.88} style={styles.categoryTouch} onPress={() => setMessage('Pizza wins pay selected 10x, 15x, 25x and 45x items.')}>
              <Image source={A.pizzaFood} style={[styles.categoryImage, { width: categorySize, height: categorySize * 0.7 }]} resizeMode="contain" />
            </TouchableOpacity>
          </View>
        </ImageBackground>

        <LinearGradient colors={['rgba(99,24,145,.96)', 'rgba(51,10,92,.98)']} style={styles.betPanel}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>Select Amount</Text>
            <View style={styles.panelDivider} />
            <Text style={styles.panelTitle}>Select Food</Text>
          </View>
          <View style={styles.amountRow}>
            {BETS.map((amount) => (
              <TouchableOpacity key={amount} disabled={controlsDisabled} onPress={() => setSelectedAmount(amount)} style={styles.amountTouch}>
                <View style={[styles.amountChip, controlsDisabled && styles.amountChipDisabled, selectedAmount === amount && styles.amountChipActive]}>
                  <Text style={[styles.amountText, selectedAmount === amount && styles.amountTextActive]}>{compact(amount)}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
          {message ? <Text style={styles.messageText}>{message}</Text> : null}
        </LinearGradient>

        <LinearGradient colors={['rgba(78,13,123,.98)', 'rgba(38,8,80,.98)']} style={styles.resultPanel}>
          <Text style={styles.resultTitle}>Result</Text>
          <HistoryRail history={history} />
        </LinearGradient>

        <View style={styles.footerRow}>
          <LinearGradient colors={['#FFE2BE', '#F1CDA9']} style={styles.balanceCard}>
            <Image source={A.cat} style={styles.avatar} resizeMode="contain" />
            <View style={{ flex: 1 }}>
              <Text style={styles.footerName} numberOfLines={1}>Current Balance</Text>
              <Text style={styles.diamondText}>{compact(displayWallet)} diamonds</Text>
            </View>
          </LinearGradient>
          <LinearGradient colors={['#FFE2BE', '#F1CDA9']} style={styles.balanceCard}>
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Text style={styles.footerLabel}>Round Bet</Text>
              <Text style={styles.diamondText}>{compact(myRoundBet)} diamonds</Text>
            </View>
          </LinearGradient>
          <Image source={A.chest} style={styles.chest} resizeMode="contain" />
        </View>
      </ScrollView>

      {status === 'loading' && (
        <View style={styles.loading}>
          <ActivityIndicator color="#FBD35D" size="large" />
          <Text style={styles.loadingText}>Opening Greedy Lion...</Text>
        </View>
      )}

      <ResultPopupModal resultPopup={resultPopup} onClose={closeResultPopup} />

      <Modal transparent animationType="fade" visible={helpOpen} onRequestClose={() => setHelpOpen(false)}>
        <View style={styles.popupOverlay}>
          <LinearGradient colors={['#4D1477', '#210743']} style={styles.helpCard}>
            <Text style={styles.popupTitle}>Greedy Lion</Text>
            <Text style={styles.helpText}>Pick up to 6 unique items. You can add unlimited diamonds to already selected items during the round.</Text>
            <Text style={styles.helpText}>Pizza pays selected 10x, 15x, 25x and 45x items. Salad pays selected 5x items.</Text>
            <TouchableOpacity onPress={() => setHelpOpen(false)} style={styles.popupButton}>
              <Text style={styles.popupButtonText}>Got it</Text>
            </TouchableOpacity>
          </LinearGradient>
        </View>
      </Modal>
    </View>
  );

  return standalone ? body : <View style={styles.host}>{body}</View>;
}

export default memo(GreedyLion);

const styles = StyleSheet.create({
  host: { alignItems: 'center', justifyContent: 'flex-start' },
  shell: {
    alignSelf: 'center',
    overflow: 'hidden',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    backgroundColor: '#08001C',
  },
  topbar: { height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14 },
  iconButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  gameTitle: { color: '#FFF2BF', fontSize: 18, fontWeight: '900' },
  scrollBody: { paddingBottom: 14, backgroundColor: '#07001C' },
  board: { minHeight: 482, overflow: 'hidden' },
  boardImage: { opacity: 1 },
  darkOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(5,0,27,.48)' },
  hudRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 2, zIndex: 4 },
  roundPill: {
    minWidth: 118,
    height: 40,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: '#F6C44F',
    backgroundColor: 'rgba(31,11,63,.9)',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 11,
    gap: 7,
  },
  roundText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
  hudButtons: { flexDirection: 'row', gap: 8 },
  squareButton: {
    width: 42,
    height: 42,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: '#F7D56A',
    backgroundColor: 'rgba(46,16,91,.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  wheelWrap: { marginTop: -16, marginHorizontal: 0, alignItems: 'center', justifyContent: 'center' },
  wheel: { position: 'absolute', top: '-6%', alignSelf: 'center', zIndex: 1 },
  centerMascot: { position: 'absolute', top: '30%', left: '35%', width: '34%', alignItems: 'center', zIndex: 6 },
  cat: { width: 90, height: 80 },
  centerTitle: { color: '#FFFFFF', fontSize: 15, fontWeight: '900', textShadowColor: '#210020', textShadowRadius: 6, marginTop: -12 },
  timerPill: { minWidth: 50, height: 24, borderRadius: 12, backgroundColor: '#FFC04C', alignItems: 'center', justifyContent: 'center', marginTop: 3, paddingHorizontal: 9 },
  timerText: { color: '#3F0B4B', fontSize: 15, fontWeight: '900' },
  itemCard: {
    position: 'absolute',
    zIndex: 5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  itemLockedOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
    borderRadius: 18,
    backgroundColor: 'rgba(5,0,24,.62)',
  },
  itemCardSelected: { transform: [{ scale: 1.08 }] },
  itemCardSpin: { transform: [{ scale: 1.22 }] },
  itemCardLanding: { transform: [{ scale: 1.16 }] },
  itemCardWin: { shadowColor: '#FDE68A', shadowOpacity: 1, shadowRadius: 16, elevation: 10 },
  itemImage: {
    width: '100%',
    height: '78%',
    shadowColor: '#000',
    shadowOpacity: .45,
    shadowRadius: 6,
  },
  itemBet: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '900',
    lineHeight: 18,
    textShadowColor: '#270038',
    textShadowRadius: 4,
    marginTop: -2,
    backgroundColor: 'rgba(10,0,30,.72)',
    borderRadius: 9,
    overflow: 'hidden',
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  categoryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingHorizontal: 38,
    marginTop: -40,
    paddingBottom: 0,
    zIndex: 30,
    elevation: 30,
  },
  categoryTouch: { zIndex: 31, elevation: 31 },
  categoryImage: { shadowColor: '#000', shadowOpacity: .45, shadowRadius: 12, zIndex: 32, elevation: 32 },
  betPanel: { marginHorizontal: 18, marginTop: -22, borderRadius: 15, borderWidth: 3, borderColor: '#E8B74E', paddingHorizontal: 8, paddingVertical: 6 },
  panelHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 4 },
  panelTitle: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
  panelDivider: { width: 1, height: 14, backgroundColor: 'rgba(255,255,255,.35)' },
  amountRow: { flexDirection: 'row', gap: 5 },
  amountTouch: { flex: 1 },
  amountChip: { height: 29, borderRadius: 9, borderWidth: 2, borderColor: '#D8A33D', backgroundColor: 'rgba(255,255,255,.08)', alignItems: 'center', justifyContent: 'center' },
  amountChipDisabled: { opacity: 0.48 },
  amountChipActive: { backgroundColor: '#FFC55D', borderColor: '#FFF4A2' },
  amountText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  amountTextActive: { color: '#40104E' },
  messageText: { color: '#FFE7A2', textAlign: 'center', fontSize: 9, fontWeight: '800', marginTop: 3 },
  resultPanel: { marginHorizontal: 18, marginTop: 4, borderRadius: 15, borderWidth: 3, borderColor: '#D8A33D', paddingHorizontal: 7, paddingVertical: 4, minHeight: 62 },
  resultTitle: { color: '#FFFFFF', textAlign: 'center', fontSize: 13, fontWeight: '900', marginBottom: 1 },
  historyRail: { gap: 6, alignItems: 'center', minWidth: '100%' },
  emptyHistory: { color: '#D8C4EF', fontSize: 12, fontWeight: '800', textAlign: 'center', width: '100%', marginTop: 8 },
  historyItem: { width: 56, height: 48, borderRadius: 8, borderWidth: 2, borderColor: '#F2CA68', backgroundColor: '#F4D5A8', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  historyImage: { width: 58, height: 42 },
  newText: { position: 'absolute', bottom: 12, color: '#FF3131', fontSize: 7, fontWeight: '900' },
  historyText: { position: 'absolute', bottom: 0, color: '#371447', fontSize: 8, fontWeight: '900' },
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 18, marginTop: 8 },
  balanceCard: { flex: 1, minHeight: 50, borderRadius: 14, borderWidth: 2, borderColor: '#F8D783', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  avatar: { width: 38, height: 38, marginRight: 6 },
  footerName: { color: '#4B1834', fontSize: 13, fontWeight: '900' },
  footerLabel: { color: '#4B1834', fontSize: 13, fontWeight: '900' },
  diamondText: { color: '#9A5C04', fontSize: 14, fontWeight: '900' },
  chest: { width: 58, height: 50 },
  loading: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(8,0,28,.78)', alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: '#FFF2BF', fontSize: 14, fontWeight: '900', marginTop: 10 },
  popupOverlay: { flex: 1, backgroundColor: 'rgba(5,0,20,.72)', alignItems: 'center', justifyContent: 'center', padding: 22 },
  popup: { width: '100%', maxWidth: 348, borderRadius: 26, borderWidth: 3, borderColor: '#FFD86A', alignItems: 'center', paddingHorizontal: 16, paddingTop: 18, paddingBottom: 16 },
  popupCloseButton: {
    position: 'absolute',
    top: 10,
    right: 10,
    zIndex: 5,
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 2,
    borderColor: 'rgba(255,232,143,.9)',
    backgroundColor: 'rgba(31,8,62,.86)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  popupResultHalo: {
    width: 188,
    height: 126,
    borderRadius: 28,
    borderWidth: 2,
    borderColor: '#FFF3A6',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#FFD76A',
    shadowOpacity: .85,
    shadowRadius: 16,
    elevation: 12,
  },
  popupImage: { width: 172, height: 106 },
  popupTitle: { color: '#FFF8C7', fontSize: 25, fontWeight: '900', marginTop: 9, textAlign: 'center', textShadowColor: '#42002F', textShadowRadius: 7 },
  totalWinBox: { width: '100%', minHeight: 64, borderRadius: 18, borderWidth: 2, borderColor: '#FFF4A2', alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  totalLoseBox: { borderColor: 'rgba(255,255,255,.24)' },
  totalWinLabel: { color: '#6A2800', fontSize: 12, fontWeight: '900', textTransform: 'uppercase' },
  totalLoseLabel: { color: '#D8C4EF' },
  totalWinAmount: { color: '#431050', fontSize: 24, fontWeight: '900', marginTop: 1 },
  totalLoseAmount: { color: '#FFFFFF' },
  popupBetsBox: { width: '100%', marginTop: 10, backgroundColor: 'rgba(16,2,38,.46)', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,216,106,.42)', padding: 9 },
  popupBetsTitle: { color: '#FFE7A2', fontSize: 12, fontWeight: '900', textAlign: 'center', marginBottom: 5 },
  popupBetRow: { flexDirection: 'row', alignItems: 'center', minHeight: 28, gap: 6 },
  popupBetIcon: { width: 24, height: 24 },
  popupBetName: { flex: 1, color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  popupBetAmount: { fontSize: 11, fontWeight: '900' },
  popupBetWon: { color: '#27F58B' },
  popupBetLost: { color: '#FF7373' },
  popupItems: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 8, minHeight: 34 },
  popupItem: { width: 40, height: 40 },
  winnersBox: { width: '100%', backgroundColor: 'rgba(19,5,49,.55)', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,216,106,.42)', padding: 10, marginTop: 10 },
  winnersTitle: { color: '#FFE7A2', fontSize: 12, fontWeight: '900', textAlign: 'center', marginBottom: 6 },
  winnerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  winnerRank: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#FFC55D', color: '#431050', textAlign: 'center', lineHeight: 20, fontWeight: '900' },
  winnerName: { flex: 1, color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  winnerAmount: { color: '#FFE7A2', fontSize: 12, fontWeight: '900' },
  noWinners: { color: '#D8C4EF', textAlign: 'center', fontSize: 12, fontWeight: '800' },
  popupButton: { minWidth: 120, height: 40, borderRadius: 18, backgroundColor: '#FFC55D', alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  popupButtonText: { color: '#431050', fontSize: 15, fontWeight: '900' },
  helpCard: { width: '100%', maxWidth: 340, borderRadius: 26, borderWidth: 3, borderColor: '#F0C35A', padding: 20 },
  helpText: { color: '#F3E8FF', fontSize: 14, lineHeight: 20, fontWeight: '700', marginTop: 10 },
});
