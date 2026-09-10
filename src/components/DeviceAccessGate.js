import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { LockKeyhole, RefreshCw } from 'lucide-react-native';
import { supabase } from '../api/supabase';
import { verifyDeviceAccess } from '../api/deviceAccess';
import { DEVICE_ACCESS_NETWORK_MESSAGE } from '../api/deviceAccessPolicy';

export default function DeviceAccessGate({ children }) {
  const [state, setState] = useState({ status: 'checking', code: null, message: null });
  const checkingRef = useRef(false);
  const blockedRef = useRef(false);
  const statusRef = useRef('checking');
  const appActiveRef = useRef(AppState.currentState === 'active');

  const updateState = useCallback((next) => {
    statusRef.current = next.status;
    setState(next);
  }, []);

  const check = useCallback(async (manual = false) => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setState((current) => ['allowed', 'blocked'].includes(current.status) ? current : { ...current, status: 'checking' });
    try {
      const result = await verifyDeviceAccess();
      blockedRef.current = !result.allowed;
      updateState(result.allowed
        ? { status: 'allowed', code: result.code, message: null }
        : { status: 'blocked', code: result.code, message: result.message });
    } catch (error) {
      blockedRef.current = false;
      updateState({ status: 'network-error', code: 'NETWORK_FAILED', message: DEVICE_ACCESS_NETWORK_MESSAGE });
    } finally {
      checkingRef.current = false;
    }
  }, [updateState]);

  useEffect(() => {
    void check();
    let profileChannel = null;

    const watchSession = (session) => {
      if (profileChannel) {
        supabase.removeChannel(profileChannel);
        profileChannel = null;
      }
      if (!session?.user?.id) {
        void check();
        return;
      }
      profileChannel = supabase
        .channel(`access-gate-${session.user.id}`)
        .on('postgres_changes', {
          event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${session.user.id}`,
        }, (payload) => {
          if (payload.new?.is_banned === true || payload.new?.is_deleted === true) {
            blockedRef.current = true;
            updateState({
              status: 'blocked',
              code: payload.new?.is_deleted ? 'ACCOUNT_DELETED' : 'ACCOUNT_BLOCKED',
              message: payload.new?.is_deleted
                ? 'This account is no longer available.'
                : 'This account and its registered access have been blocked.',
            });
            supabase.auth.signOut().catch(() => {});
          } else if (payload.new?.is_banned === false && payload.new?.is_deleted !== true) {
            blockedRef.current = false;
            void check(true);
          }
        })
        .subscribe();
      void check();
    };

    supabase.auth.getSession().then(({ data }) => watchSession(data.session));
    const { data: auth } = supabase.auth.onAuthStateChange((_event, session) => watchSession(session));
    const appState = AppState.addEventListener('change', (next) => {
      appActiveRef.current = next === 'active';
      if (next === 'active') void check();
    });
    const network = NetInfo.addEventListener((connection) => {
      if (connection.isConnected && connection.isInternetReachable !== false
        && statusRef.current === 'network-error') void check(true);
    });
    // A blocked account is signed out, so it cannot retain a private profile
    // subscription. Network failures retry every five seconds, blocked
    // installations every five seconds, and allowed sessions every 30 seconds.
    let recoveryTicks = 0;
    const recoveryTimer = setInterval(() => {
      recoveryTicks += 1;
      if (appActiveRef.current && (
        statusRef.current === 'network-error'
        || blockedRef.current
        || recoveryTicks % 6 === 0
      )) void check();
    }, 5000);
    return () => {
      auth.subscription.unsubscribe();
      appState.remove();
      network();
      clearInterval(recoveryTimer);
      if (profileChannel) supabase.removeChannel(profileChannel);
    };
  }, [check, updateState]);

  if (state.status === 'allowed') return children;

  const blocked = state.status === 'blocked';
  if (state.status === 'checking') {
    return (
      <View style={styles.root}>
        <ActivityIndicator color="#d55cff" size="large" />
      </View>
    );
  }
  if (state.status === 'network-error') {
    return (
      <View style={styles.root}>
        <ActivityIndicator color="#d55cff" size="large" />
        <Text style={styles.networkMessage}>{DEVICE_ACCESS_NETWORK_MESSAGE}</Text>
      </View>
    );
  }
  return (
    <View style={styles.root}>
      <View style={styles.icon}><LockKeyhole color={blocked ? '#ff6b7c' : '#d7b8ff'} size={32} /></View>
      <Text style={styles.title}>{blocked ? 'Access blocked' : 'Verification needed'}</Text>
      <Text style={styles.message}>
        {state.message || 'Please wait while this installation is verified.'}
      </Text>
      <Pressable style={styles.button} onPress={() => check(true)}>
        <RefreshCw color="#fff" size={18} />
        <Text style={styles.buttonText}>Retry</Text>
      </Pressable>
      {state.code ? <Text style={styles.code}>Reference: {state.code}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#08051d', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 34 },
  icon: { width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center', backgroundColor: '#201339', borderWidth: 1, borderColor: '#704493' },
  title: { color: '#fff', fontSize: 24, fontWeight: '800', marginTop: 20 },
  message: { color: '#c9bfdc', fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 10, maxWidth: 360 },
  loader: { marginTop: 24 },
  button: { marginTop: 24, minWidth: 130, height: 46, borderRadius: 23, paddingHorizontal: 22, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#8d3fe0' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  code: { color: '#716983', fontSize: 11, marginTop: 18 },
  networkMessage: { color: '#fff', fontSize: 18, fontWeight: '700', marginTop: 20, textAlign: 'center' },
});
