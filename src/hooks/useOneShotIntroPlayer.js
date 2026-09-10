import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useVideoPlayer } from 'expo-video';
import {
  INTRO_LOAD_TIMEOUT_MS,
  normalizeIntroSource,
  shouldUseIntroFallback,
} from './introPlaybackPolicy';

export const INTRO_FALLBACK_CLOSE_MS = 9000;
const DEFAULT_INTRO_VIDEO = require('../../assets/mall/intro/blue-roses.m4v');

export const configureOneShotIntroPlayer = (player) => {
  player.loop = false;
  player.muted = false;
  player.volume = 1;
  player.timeUpdateEventInterval = 0;
  // Entrance audio stays audible without stealing audio focus from the
  // host's room music or interrupting Agora playback.
  player.audioMixingMode = 'mixWithOthers';
};

export function useOneShotIntroPlayer(source, onFinish, fallbackSource = DEFAULT_INTRO_VIDEO) {
  const [ready, setReady] = useState(false);
  const startedRef = useRef(false);
  const closedRef = useRef(false);
  const onFinishRef = useRef(onFinish);
  const fallbackTimerRef = useRef(null);
  const loadTimerRef = useRef(null);
  const fallbackStartedRef = useRef(false);
  const generationRef = useRef(0);
  const resumeOnActiveRef = useRef(false);

  const primarySource = useMemo(() => normalizeIntroSource(source), [source]);
  const normalizedFallback = useMemo(() => normalizeIntroSource(fallbackSource), [fallbackSource]);
  const initialSource = primarySource || normalizedFallback;

  const player = useVideoPlayer(initialSource, (instance) => {
    configureOneShotIntroPlayer(instance);
  });

  useEffect(() => {
    onFinishRef.current = onFinish;
  }, [onFinish]);

  const finish = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    try { player.pause(); } catch (_) {}
    onFinishRef.current?.();
  }, [player]);

  const playOnce = useCallback(() => {
    if (startedRef.current || closedRef.current) return;
    if (player.status !== 'readyToPlay') return;
    startedRef.current = true;
    try {
      configureOneShotIntroPlayer(player);
      player.currentTime = 0;
      player.play();
      if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
      fallbackTimerRef.current = setTimeout(finish, INTRO_FALLBACK_CLOSE_MS);
    } catch (e) {
      if (__DEV__) console.warn('intro play:', e?.message || e);
      startedRef.current = false;
    }
  }, [finish, player]);

  useEffect(() => {
    const generation = ++generationRef.current;
    closedRef.current = false;
    startedRef.current = false;
    fallbackStartedRef.current = !primarySource;
    resumeOnActiveRef.current = false;
    setReady(false);

    const clearLoadTimer = () => {
      if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
      loadTimerRef.current = null;
    };

    const loadFallbackOrFinish = async () => {
      if (generationRef.current !== generation || closedRef.current) return;
      if (fallbackStartedRef.current || !shouldUseIntroFallback(primarySource, normalizedFallback)) {
        finish();
        return;
      }
      fallbackStartedRef.current = true;
      startedRef.current = false;
      setReady(false);
      clearLoadTimer();
      try {
        await player.replaceAsync(normalizedFallback);
        if (generationRef.current !== generation || closedRef.current) return;
        loadTimerRef.current = setTimeout(loadFallbackOrFinish, INTRO_LOAD_TIMEOUT_MS);
        if (player.status === 'readyToPlay') {
          clearLoadTimer();
          setReady(true);
          playOnce();
        }
      } catch (error) {
        if (__DEV__) console.warn('intro fallback:', error?.message || error);
        finish();
      }
    };

    const statusSubscription = player.addListener('statusChange', ({ status, error }) => {
      if (generationRef.current !== generation || closedRef.current) return;
      if (status === 'error') {
        if (__DEV__) console.warn('intro source:', error?.message || 'Unable to load intro');
        void loadFallbackOrFinish();
      } else if (status === 'readyToPlay') {
        clearLoadTimer();
        setReady(true);
        configureOneShotIntroPlayer(player);
        playOnce();
      }
    });
    const endSubscription = player.addListener('playToEnd', finish);
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (generationRef.current !== generation || closedRef.current) return;
      if (state !== 'active') {
        resumeOnActiveRef.current = !!player.playing;
        try { player.pause(); } catch (_) {}
      } else if (resumeOnActiveRef.current && player.status === 'readyToPlay') {
        resumeOnActiveRef.current = false;
        try { player.play(); } catch (_) {}
      }
    });

    if (!initialSource) {
      finish();
    } else if (player.status === 'readyToPlay') {
      setReady(true);
      playOnce();
    } else if (player.status === 'error') {
      void loadFallbackOrFinish();
    } else {
      loadTimerRef.current = setTimeout(loadFallbackOrFinish, INTRO_LOAD_TIMEOUT_MS);
    }

    return () => {
      closedRef.current = true;
      startedRef.current = false;
      statusSubscription.remove();
      endSubscription.remove();
      appStateSubscription.remove();
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
      clearLoadTimer();
      try { player.pause(); } catch (_) {}
    };
  }, [finish, initialSource, normalizedFallback, playOnce, player, primarySource]);

  return { player, ready, finish };
}
