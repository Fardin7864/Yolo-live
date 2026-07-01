import AsyncStorage from '@react-native-async-storage/async-storage';
import LottieView from 'lottie-react-native';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Image, StyleSheet, StatusBar, View } from 'react-native';
import { supabase } from '../api/supabase';

const CACHE_KEY = 'care-live-active-splash';
const DEFAULT_BACKGROUND = '#0F091E';
const FADE_OUT_MS = 350;

let shownThisSession = false;

const normalizeSplash = (row) => {
  if (!row?.media_url) return null;
  return {
    ...row,
    duration_ms: Math.min(6000, Math.max(500, Number(row.duration_ms) || 2000)),
    background_color: row.background_color || DEFAULT_BACKGROUND,
  };
};

export default function RemoteSplashGate() {
  const [phase, setPhase] = useState(shownThisSession ? 'done' : 'resolving');
  const [splash, setSplash] = useState(null);
  const fade = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (shownThisSession) return undefined;
    shownThisSession = true;
    let cancelled = false;

    const resolveSplash = async () => {
      let cached = null;
      try {
        const stored = await AsyncStorage.getItem(CACHE_KEY);
        cached = stored ? normalizeSplash(JSON.parse(stored)) : null;
      } catch (_) {}

      try {
        const { data, error } = await supabase.rpc('get_active_splash');
        if (error) throw error;
        const active = normalizeSplash(Array.isArray(data) ? data[0] : data);

        if (!active) {
          await AsyncStorage.removeItem(CACHE_KEY);
          if (!cancelled) setPhase('done');
          return;
        }

        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(active));
        if (active.media_type === 'image') {
          await Image.prefetch(active.media_url).catch(() => {});
        }
        if (!cancelled) {
          setSplash(active);
          setPhase('showing');
        }
      } catch (_) {
        if (!cancelled && cached) {
          setSplash(cached);
          setPhase('showing');
        } else if (!cancelled) {
          setPhase('done');
        }
      }
    };

    resolveSplash();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (phase !== 'showing' || !splash) return undefined;
    const timer = setTimeout(() => {
      setPhase('fading');
      Animated.timing(fade, {
        toValue: 0,
        duration: FADE_OUT_MS,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setPhase('done');
      });
    }, splash.duration_ms);
    return () => clearTimeout(timer);
  }, [fade, phase, splash]);

  if (phase === 'done') return null;

  return (
    <Animated.View
      pointerEvents={phase === 'showing' ? 'auto' : 'none'}
      style={[
        styles.overlay,
        { backgroundColor: splash?.background_color || DEFAULT_BACKGROUND, opacity: fade },
      ]}
    >
      <StatusBar translucent backgroundColor="transparent" barStyle="light-content" />
      {splash?.media_type === 'lottie' ? (
        <LottieView
          source={{ uri: splash.media_url }}
          autoPlay
          loop
          resizeMode="cover"
          style={styles.media}
        />
      ) : splash ? (
        <Image source={{ uri: splash.media_url }} style={styles.media} resizeMode="cover" />
      ) : (
        <View style={styles.media} />
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    elevation: 9999,
    justifyContent: 'center',
    alignItems: 'center',
  },
  media: { width: '100%', height: '100%' },
});
