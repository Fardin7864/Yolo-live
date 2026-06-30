import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import { supabase } from '../../api/supabase';
import { useGlobalState } from '../../context/GlobalStateContext';

const GAME_ID = 'royal_feast';
const GAME_URL = process.env.EXPO_PUBLIC_ROYAL_FEAST_URL;

export default function Html5RoyalFeast({ roomId, myDiamonds, setMyDiamonds, onBack, onClose }) {
  const { user } = useGlobalState();
  const webRef = useRef(null);
  const roundRef = useRef(null);
  const endsAtRef = useRef(null);
  const readyRef = useRef(false);
  const resultSentRef = useRef(false);
  const nextRoundRef = useRef(null);
  const balanceRef = useRef(Number(myDiamonds) || 0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [round, setRound] = useState(null);
  balanceRef.current = Number(myDiamonds) || 0;

  const send = useCallback((type, payload = {}) => {
    if (!readyRef.current || !webRef.current) return;
    const message = JSON.stringify({ version: 1, type, payload }).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    webRef.current.injectJavaScript(`window.YoloGameBridge?.receive('${message}');true;`);
  }, []);

  const openRound = useCallback(async () => {
    if (!roomId) return;
    resultSentRef.current = false;
    const { data, error: rpcError } = await supabase.rpc('start_game_round', {
      p_room_id: roomId,
      p_game_type: GAME_ID,
      p_duration_s: 15,
    });
    if (rpcError || !data?.success) {
      setError(data?.message || rpcError?.message || 'Could not open the game round.');
      return;
    }
    roundRef.current = data.round_id;
    endsAtRef.current = data.ends_at;
    setRound({ ...data, sequence: Date.now() });
  }, [roomId]);

  useEffect(() => {
    openRound();
    return () => clearTimeout(nextRoundRef.current);
  }, [openRound]);

  useEffect(() => {
    if (!roundRef.current) return undefined;
    const channel = supabase
      .channel(`royal-feast-${roundRef.current}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'game_rounds',
        filter: `id=eq.${roundRef.current}`,
      }, ({ new: row }) => {
        if (row.status === 'settled' && row.winner_pos && !resultSentRef.current) {
          resultSentRef.current = true;
          send('ROUND_RESULT', { foodId: row.winner_pos });
          nextRoundRef.current = setTimeout(openRound, 4300);
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [round?.sequence, openRound, send]);

  useEffect(() => {
    if (!round?.round_id || !readyRef.current) return;
    let firstPush = true;
    const pushState = () => {
      const timeLeft = Math.max(0, Math.ceil((new Date(endsAtRef.current).getTime() - Date.now()) / 1000));
      send('ROUND_STATE', {
        round: String(round.round_id).slice(0, 6),
        timeLeft,
        phase: timeLeft > 0 ? 'betting' : 'revealing',
        resetBets: firstPush,
        balance: balanceRef.current,
      });
      firstPush = false;
      if (timeLeft <= 0 && !resultSentRef.current) {
        supabase.rpc('resolve_royal_feast_round', { p_round_id: roundRef.current }).then(({ data }) => {
          if (!data?.success || resultSentRef.current) return;
          resultSentRef.current = true;
          if (Number.isFinite(Number(data.balance))) setMyDiamonds(Number(data.balance));
          send('ROUND_RESULT', {
            foodId: data.winner_pos,
            payout: Number(data.my_win_amount || 0),
            balance: Number(data.balance ?? balanceRef.current),
          });
          nextRoundRef.current = setTimeout(openRound, 4300);
        });
      }
    };
    pushState();
    const timer = setInterval(pushState, 500);
    return () => clearInterval(timer);
  }, [round?.sequence, openRound, send, setMyDiamonds]);

  const reply = useCallback((type, payload) => {
    send(type, payload);
  }, [send]);

  const handleMessage = useCallback(async ({ nativeEvent }) => {
    let message;
    try { message = JSON.parse(nativeEvent.data); } catch { return; }
    if (message?.version !== 1) return;
    const payload = message.payload || {};
    if (message.type === 'GAME_READY') {
      readyRef.current = true;
      setLoading(false);
      send('INIT', {
        playerName: user?.full_name || user?.name || 'Player',
        balance: balanceRef.current,
        round: roundRef.current ? String(roundRef.current).slice(0, 6) : 1,
        timeLeft: endsAtRef.current
          ? Math.max(0, Math.ceil((new Date(endsAtRef.current).getTime() - Date.now()) / 1000))
          : 0,
        phase: 'betting',
        history: [],
      });
      return;
    }
    if (message.type !== 'PLACE_BET') return;
    const foodIds = new Set(['chicken', 'shrimp', 'ham', 'fish', 'carrot', 'pepper', 'tomato', 'corn']);
    const amount = Number(payload.amount);
    if (!foodIds.has(payload.foodId) || !Number.isInteger(amount) || amount <= 0 || !roundRef.current) {
      reply('ERROR', { requestId: payload.requestId, message: 'Invalid bet.' });
      return;
    }
    const { data, error: betError } = await supabase.rpc('place_game_bet', {
      p_round_id: roundRef.current,
      p_position: payload.foodId,
      p_amount: amount,
    });
    if (betError || !data?.success) {
      reply('ERROR', { requestId: payload.requestId, message: data?.message || betError?.message || 'Bet rejected.' });
      return;
    }
    const balance = Math.max(0, balanceRef.current - amount);
    balanceRef.current = balance;
    setMyDiamonds(balance);
    reply('PLACE_BET_RESULT', { requestId: payload.requestId, success: true, balance });
  }, [reply, send, setMyDiamonds, user]);

  if (!GAME_URL) {
    return (
      <View style={styles.message}>
        <Ionicons name="cloud-offline-outline" size={46} color="#F5C76A" />
        <Text style={styles.title}>Royal Feast needs its game URL</Text>
        <Text style={styles.copy}>Set EXPO_PUBLIC_ROYAL_FEAST_URL to the HTTPS address of the deployed HTML5 game.</Text>
        <TouchableOpacity style={styles.action} onPress={onBack}><Text style={styles.actionText}>Back to games</Text></TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.headerButton}><Ionicons name="chevron-back" size={22} color="#fff" /></TouchableOpacity>
        <Text style={styles.headerTitle}>Royal Feast</Text>
        <TouchableOpacity onPress={onClose} style={styles.headerButton}><Ionicons name="close" size={22} color="#fff" /></TouchableOpacity>
      </View>
      <WebView
        ref={webRef}
        source={{ uri: GAME_URL }}
        style={styles.webview}
        originWhitelist={['https://*', 'http://localhost:*', 'http://127.0.0.1:*']}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        setSupportMultipleWindows={false}
        onMessage={handleMessage}
        onError={({ nativeEvent }) => setError(nativeEvent.description || 'Game failed to load.')}
        onHttpError={({ nativeEvent }) => setError(`Game server returned ${nativeEvent.statusCode}.`)}
      />
      {loading && <View style={styles.loader}><ActivityIndicator size="large" color="#F5C76A" /><Text style={styles.copy}>Opening Royal Feast…</Text></View>}
      {!!error && <View style={styles.loader}><Text style={styles.title}>Game unavailable</Text><Text style={styles.copy}>{error}</Text><TouchableOpacity style={styles.action} onPress={() => { setError(null); openRound(); webRef.current?.reload(); }}><Text style={styles.actionText}>Try again</Text></TouchableOpacity></View>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 0, backgroundColor: '#0C0830', overflow: 'hidden', borderRadius: 20 },
  webview: { flex: 1, backgroundColor: '#0C0830' },
  header: { height: 46, paddingHorizontal: 8, backgroundColor: '#160B3E', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerTitle: { color: '#FFF3CF', fontWeight: '900', fontSize: 16 },
  headerButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  loader: { ...StyleSheet.absoluteFillObject, top: 46, backgroundColor: '#0C0830', alignItems: 'center', justifyContent: 'center', padding: 28, gap: 14 },
  message: { minHeight: 500, backgroundColor: '#0C0830', alignItems: 'center', justifyContent: 'center', padding: 28, gap: 14 },
  title: { color: '#FFF3CF', fontWeight: '900', fontSize: 20, textAlign: 'center' },
  copy: { color: '#CBBBE2', fontSize: 14, lineHeight: 20, textAlign: 'center' },
  action: { marginTop: 8, backgroundColor: '#8A35B7', borderWidth: 1, borderColor: '#F5C76A', borderRadius: 14, paddingHorizontal: 22, paddingVertical: 12 },
  actionText: { color: '#fff', fontWeight: '800' },
});
