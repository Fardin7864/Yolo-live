import NetInfo from '@react-native-community/netinfo';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useGlobalState } from '../context/GlobalStateContext';
import { GameBackendService, type BackendGameId } from './GameBackendService';
import { CrashSocketService } from './CrashSocketService';
import { NativeGameBridge } from './GameBridge';
import { GameLifecycle } from './GameLifecycle';
import { getGameHtml, REGISTERED_GAMES } from './GameLoader';
import type { GameId, GameToNativeMessage } from './GameMessageTypes';

interface PendingBridgeBet {
  roundId: string;
  optionId: string;
  amount: number;
  balance?: number;
}

export interface GameWinAnnouncement {
  amount: number;
  gameName: string;
  roundId: string;
  winnerId?: string | null;
  winnerName?: string;
  winnerAvatar?: string | null;
  isBot?: boolean;
}

interface GameWebViewProps {
  gameId: GameId;
  onExit: () => void;
  onGameWin?: (result: GameWinAnnouncement) => void;
  fillContainer?: boolean;
  soundEnabled?: boolean;
  onOpenHistory?: () => void;
  onOpenRules?: () => void;
  onPerformanceMetrics?: (metrics: Extract<GameToNativeMessage, { type: 'PERFORMANCE_METRICS' }>['payload']) => void;
}

export default function GameWebView({
  gameId,
  onExit,
  onGameWin,
  fillContainer = false,
  soundEnabled = true,
  onOpenHistory,
  onOpenRules,
  onPerformanceMetrics,
}: GameWebViewProps) {
  const webViewRef = useRef<WebView>(null);
  const { diamonds, setDiamonds, user } = useGlobalState();
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const bridge = useMemo(() => new NativeGameBridge(gameId), [gameId]);
  const bridgeRef = useRef(bridge);
  const onExitRef = useRef(onExit);
  const onGameWinRef = useRef(onGameWin);
  const announcedWinRoundsRef = useRef(new Set<string>());
  const metricsRef = useRef(onPerformanceMetrics);
  const historyRef = useRef(onOpenHistory);
  const rulesRef = useRef(onOpenRules);
  const userRef = useRef(user);
  const diamondsRef = useRef(diamonds);
  const pendingBetsRef = useRef(new Map<string, PendingBridgeBet>());
  const completedBetRequestsRef = useRef(new Map<string, boolean>());
  const networkConnectedRef = useRef<boolean | null>(null);
  const latestServerWalletRef = useRef(Number(diamonds || 0));

  const projectedWallet = useCallback((authoritativeBalance: number) => {
    const pendingBalances = [...pendingBetsRef.current.values()]
      .map((request) => request.balance)
      .filter((balance): balance is number => typeof balance === 'number' && Number.isFinite(balance));
    return pendingBalances.length
      ? Math.min(authoritativeBalance, ...pendingBalances)
      : authoritativeBalance;
  }, []);

  bridgeRef.current = bridge;
  onExitRef.current = onExit;
  onGameWinRef.current = onGameWin;
  metricsRef.current = onPerformanceMetrics;
  historyRef.current = onOpenHistory;
  rulesRef.current = onOpenRules;
  userRef.current = user;
  diamondsRef.current = diamonds;

  const service = useMemo(() => gameId === 'crash' ? null : new GameBackendService(gameId as BackendGameId, {
    onState: (snapshot, reason) => {
      latestServerWalletRef.current = snapshot.wallet;
      bridgeRef.current.send('ROUND_STATE', { snapshot, reason });
      const wallet = projectedWallet(snapshot.wallet);
      bridgeRef.current.send('WALLET_UPDATE', {
        balance: wallet,
        authoritative: pendingBetsRef.current.size === 0,
      });
      const roundId = snapshot.round?.id;
      if (snapshot.phase === 'RESULT_RECEIVED'
        && roundId
        && snapshot.myPayout > 0
        && !announcedWinRoundsRef.current.has(`${roundId}:self`)) {
        announcedWinRoundsRef.current.add(`${roundId}:self`);
        if (announcedWinRoundsRef.current.size > 50) {
          const oldest = announcedWinRoundsRef.current.values().next().value;
          if (oldest) announcedWinRoundsRef.current.delete(oldest);
        }
        onGameWinRef.current?.({
          amount: snapshot.myPayout,
          gameName: REGISTERED_GAMES[gameId].title,
          roundId,
          winnerId: userRef.current?.id || null,
          winnerName: userRef.current?.name || userRef.current?.full_name || 'Player',
          winnerAvatar: userRef.current?.avatar || userRef.current?.avatar_url || null,
          isBot: false,
        });
      }
      const rankedWinners = Array.isArray(snapshot.round?.result?.top_winners)
        ? snapshot.round?.result?.top_winners as Array<Record<string, unknown>>
        : [];
      if (snapshot.phase === 'RESULT_RECEIVED' && roundId) rankedWinners.forEach((winner, index) => {
        const winnerId = String(winner.user_id || winner.userId || '');
        const winnerName = String(winner.name || winner.full_name || 'Player');
        const winnerAmount = Number(winner.win_amount || winner.amount || 0);
        const winnerIsBot = winner.is_robot === true || winnerId.startsWith('robot:');
        const winnerKey = `${roundId}:winner:${winnerId || winnerName}:${index}`;
        const isCurrentPlayer = !!winnerId && winnerId === userRef.current?.id && snapshot.myPayout > 0;
        if (winnerAmount <= 0 || isCurrentPlayer || announcedWinRoundsRef.current.has(winnerKey)) return;
        announcedWinRoundsRef.current.add(winnerKey);
        onGameWinRef.current?.({
          amount: winnerAmount,
          gameName: REGISTERED_GAMES[gameId].title,
          roundId,
          winnerId,
          winnerName,
          winnerAvatar: String(winner.avatar_url || winner.avatarUrl || '') || null,
          isBot: winnerIsBot,
        });
      });
      while (announcedWinRoundsRef.current.size > 200) {
        const oldest = announcedWinRoundsRef.current.values().next().value;
        if (oldest) announcedWinRoundsRef.current.delete(oldest);
        else break;
      }
    },
    onError: (message, recoverable) => {
      bridgeRef.current.send('ERROR', { code: 'BACKEND_SYNC', message, recoverable });
    },
    onNetworkChange: (connected, synchronizing) => {
      bridgeRef.current.send('NETWORK_STATE', { connected, synchronizing });
    },
    onWalletChange: (balance) => setDiamonds(projectedWallet(balance)),
    onBetBatchResult: (result) => {
      result.requestIds.forEach((requestId) => {
        pendingBetsRef.current.delete(requestId);
        completedBetRequestsRef.current.set(requestId, result.accepted);
      });
      while (completedBetRequestsRef.current.size > 200) {
        const oldest = completedBetRequestsRef.current.keys().next().value;
        if (oldest) completedBetRequestsRef.current.delete(oldest);
        else break;
      }
      bridgeRef.current.send('BET_BATCH_RESULT', {
        ...result,
        status: result.accepted ? 'accepted' : 'failed',
      });
      if (result.balance !== undefined) {
        latestServerWalletRef.current = result.balance;
        bridgeRef.current.send('WALLET_UPDATE', { balance: result.balance, authoritative: true });
      } else if (!result.accepted) {
        const restoredBalance = projectedWallet(latestServerWalletRef.current);
        bridgeRef.current.send('WALLET_UPDATE', { balance: restoredBalance, authoritative: true });
        setDiamonds(restoredBalance);
      }
    },
  }), [gameId, projectedWallet, setDiamonds]);

  const crashService = useMemo(() => gameId !== 'crash' ? null : new CrashSocketService({
    onState: (snapshot, reason) => {
      latestServerWalletRef.current = snapshot.wallet;
      bridgeRef.current.send('CRASH_STATE', { snapshot, reason });
      bridgeRef.current.send('WALLET_UPDATE', { balance: snapshot.wallet, authoritative: true });
      const roundId = snapshot.round?.id;
      if (roundId && snapshot.myBet?.status === 'cashed_out' && Number(snapshot.myBet.payout) > 0
        && !announcedWinRoundsRef.current.has(`${roundId}:self`)) {
        announcedWinRoundsRef.current.add(`${roundId}:self`);
        onGameWinRef.current?.({
          amount: Number(snapshot.myBet.payout), gameName: REGISTERED_GAMES.crash.title, roundId,
          winnerId: userRef.current?.id || null,
          winnerName: userRef.current?.name || userRef.current?.full_name || 'Player',
          winnerAvatar: userRef.current?.avatar || userRef.current?.avatar_url || null,
          isBot: false,
        });
      }
    },
    onNetworkChange: (connected, synchronizing) => bridgeRef.current.send('NETWORK_STATE', { connected, synchronizing }),
    onWalletChange: (balance) => {
      latestServerWalletRef.current = balance;
      setDiamonds(balance);
      bridgeRef.current.send('WALLET_UPDATE', { balance, authoritative: true });
    },
    onBetResult: (result) => bridgeRef.current.send('CRASH_BET_RESULT', {
      requestId: result.requestId, accepted: result.accepted, balance: result.wallet,
      betId: result.betId, code: result.code, message: result.message,
    }),
    onCashoutResult: (result) => bridgeRef.current.send('CRASH_CASHOUT_RESULT', {
      requestId: result.requestId, accepted: result.accepted, balance: result.wallet,
      payout: result.payout, multiplierBp: result.multiplierBp, code: result.code, message: result.message,
    }),
    onError: (message, recoverable) => bridgeRef.current.send('ERROR', { code: 'CRASH_SOCKET', message, recoverable }),
  }), [gameId, setDiamonds]);

  const activeService = crashService || service;

  const lifecycle = useMemo(() => new GameLifecycle(
    bridge,
    (reason) => activeService?.resume(reason),
    () => activeService?.pause(),
  ), [activeService, bridge]);

  const sendBootstrap = useCallback(() => {
    const profile = userRef.current;
    service?.setViewerIdentity({ userId: profile?.id || null, name: profile?.name || profile?.full_name || 'Player', avatarUrl: profile?.avatar || profile?.avatar_url || null });
    bridge.send('INIT', {
      targetFps: 30,
      locale: 'en-BD',
      currencySymbol: '',
      debug: typeof __DEV__ !== 'undefined' && __DEV__,
    });
    bridge.send('AUTH', {
      userId: profile?.id || null,
      displayName: profile?.name || profile?.full_name || 'Player',
      avatarUrl: profile?.avatar || profile?.avatar_url || null,
    });
    bridge.send('WALLET_UPDATE', { balance: Number(diamondsRef.current || 0), authoritative: true });
    bridge.send('SOUND_SETTINGS', { enabled: soundEnabled, volume: soundEnabled ? 0.8 : 0 });
  }, [bridge, service, soundEnabled]);

  const handleGameMessage = useCallback((message: GameToNativeMessage) => {
    switch (message.type) {
      case 'GAME_READY':
        setLoading(false);
        sendBootstrap();
        activeService?.resume('game-ready');
        break;
      case 'PLACE_BET': {
        if (!service) break;
        // A tap proves this WebView is interactive. Recover from a missed
        // focus transition before validating the request against local state.
        service.ensureActive('game-interaction');
        const request = message.payload;
        const completedResult = completedBetRequestsRef.current.get(request.requestId);
        if (completedResult !== undefined) {
          bridge.send('PLACE_BET_RESULT', {
            requestId: request.requestId,
            accepted: completedResult,
            queued: false,
            status: completedResult ? 'accepted' : 'failed',
            message: completedResult ? undefined : 'Bet was not accepted.',
          });
          break;
        }
        const existing = pendingBetsRef.current.get(request.requestId);
        if (existing) {
          bridge.send('PLACE_BET_RESULT', {
            requestId: request.requestId,
            accepted: true,
            queued: true,
            status: 'pending',
            balance: existing.balance,
          });
          break;
        }
        const response = service.queueBet(request);
        if (response.accepted && response.queued) {
          pendingBetsRef.current.set(request.requestId, {
            roundId: request.roundId,
            optionId: request.optionId,
            amount: request.amount,
            balance: response.balance,
          });
        }
        bridge.send('PLACE_BET_RESULT', {
          ...response,
          status: response.accepted ? (response.queued ? 'pending' : 'accepted') : 'failed',
        });
        if (response.accepted && response.balance !== undefined) {
          bridge.send('WALLET_UPDATE', { balance: response.balance, authoritative: false });
          setDiamonds(response.balance);
        }
        break;
      }
      case 'PLACE_CRASH_BET':
        crashService?.placeBet(message.payload);
        break;
      case 'CASH_OUT':
        crashService?.cashout(message.payload);
        break;
      case 'REQUEST_STATE_REFRESH':
        // Phaser only emits this while its loop is awake. resume() makes the
        // request self-healing if React Navigation delivered blur/focus out of
        // order during a reload or deep-link transition.
        activeService?.requestRefresh(message.payload.reason || 'game-request');
        break;
      case 'RESULT_ANIMATION_COMPLETE':
        // The snapshot that started the animation is already authoritative.
        // GameBackendService schedules the next sync at the result boundary.
        break;
      case 'EXIT_GAME':
        onExitRef.current();
        break;
      case 'ERROR':
        if (message.payload.fatal) setFatalError(message.payload.message);
        break;
      case 'PERFORMANCE_METRICS':
        metricsRef.current?.(message.payload);
        break;
      case 'OPEN_HISTORY':
        historyRef.current?.();
        break;
      case 'OPEN_RULES':
        rulesRef.current?.();
        break;
      default:
        break;
    }
  }, [activeService, bridge, crashService, sendBootstrap, service, setDiamonds]);

  useEffect(() => {
    lifecycle.start();
    activeService?.start();
    const unsubscribeBridge = bridge.subscribe(handleGameMessage);
    const unsubscribeNetwork = NetInfo.addEventListener((state) => {
      const connected = state.isConnected === true && state.isInternetReachable !== false;
      const reconnected = connected && networkConnectedRef.current === false;
      networkConnectedRef.current = connected;
      bridge.send('NETWORK_STATE', { connected, synchronizing: connected && reconnected });
      if (reconnected) activeService?.resume('network-reconnected');
    });
    return () => {
      bridge.send('EXIT_GAME', { reason: 'native-unmount' });
      unsubscribeBridge();
      unsubscribeNetwork();
      lifecycle.stop();
      activeService?.stop();
      pendingBetsRef.current.clear();
      completedBetRequestsRef.current.clear();
      networkConnectedRef.current = null;
      latestServerWalletRef.current = Number(diamondsRef.current || 0);
      bridge.reset();
    };
  }, [activeService, bridge, handleGameMessage, lifecycle]);

  useFocusEffect(useCallback(() => {
    lifecycle.setFocused(true);
    return () => lifecycle.setFocused(false);
  }, [lifecycle]));

  useEffect(() => {
    if (pendingBetsRef.current.size) return;
    bridge.send('WALLET_UPDATE', { balance: Number(diamonds || 0), authoritative: true });
  }, [bridge, diamonds]);

  const attachWebView = useCallback((instance: WebView | null) => {
    webViewRef.current = instance;
    bridge.attach(instance);
  }, [bridge]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    if (!bridge.receive(event.nativeEvent.data)) {
      bridge.send('ERROR', { code: 'INVALID_BRIDGE_MESSAGE', message: 'Ignored invalid game message.', recoverable: true });
    }
  }, [bridge]);

  const reload = useCallback(() => {
    setFatalError(null);
    setLoading(true);
    bridge.reset();
    setReloadKey((value) => value + 1);
  }, [bridge]);

  const gameHtml = useMemo(() => getGameHtml(gameId, { fillContainer }), [fillContainer, gameId]);

  return (
    <View style={styles.root}>
      <WebView
        key={`${gameId}-${reloadKey}`}
        ref={attachWebView}
        source={{ html: gameHtml, baseUrl: 'https://games.local/' }}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={gameId === 'crash' ? 'Crash game. Swipe through the accessible action button to place a bet or cash out.' : `${REGISTERED_GAMES[gameId].title} game`}
        style={styles.webView}
        onMessage={handleMessage}
        onError={(event) => setFatalError(event.nativeEvent.description || 'WebView failed to load.')}
        onHttpError={(event) => setFatalError(`Game HTTP error ${event.nativeEvent.statusCode}.`)}
        onContentProcessDidTerminate={reload}
        javaScriptEnabled
        domStorageEnabled={false}
        allowFileAccess={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        thirdPartyCookiesEnabled={false}
        sharedCookiesEnabled={false}
        originWhitelist={['https://games.local', 'about:blank']}
        onShouldStartLoadWithRequest={(request) => request.url === 'about:blank' || request.url.startsWith('https://games.local')}
        overScrollMode="never"
        bounces={false}
        scrollEnabled={false}
        setSupportMultipleWindows={false}
      />
      {loading && !fatalError ? (
        <View style={styles.overlay} pointerEvents="none">
          <ActivityIndicator color="#FFD76A" />
          <Text style={styles.loadingText}>Loading game...</Text>
        </View>
      ) : null}
      {fatalError ? (
        <View style={styles.overlay}>
          <Text style={styles.errorTitle}>Game needs to reload</Text>
          <Text style={styles.errorText}>{fatalError}</Text>
          <View style={styles.actions}>
            <TouchableOpacity style={styles.primaryButton} onPress={reload}>
              <Text style={styles.primaryText}>Reload</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryButton} onPress={onExit}>
              <Text style={styles.secondaryText}>Exit</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#090B18' },
  webView: { flex: 1, backgroundColor: '#090B18' },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    backgroundColor: '#090B18',
  },
  loadingText: { marginTop: 12, color: '#FFF5CD', fontSize: 13, fontWeight: '700' },
  errorTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: '900', textAlign: 'center' },
  errorText: { color: '#D7D9E5', fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 8 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 20 },
  primaryButton: { backgroundColor: '#FFD15C', paddingHorizontal: 22, paddingVertical: 12, borderRadius: 6 },
  secondaryButton: { borderWidth: 1, borderColor: '#73778B', paddingHorizontal: 22, paddingVertical: 12, borderRadius: 6 },
  primaryText: { color: '#251608', fontWeight: '900' },
  secondaryText: { color: '#FFFFFF', fontWeight: '800' },
});
