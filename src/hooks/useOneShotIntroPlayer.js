import { useCallback, useEffect, useRef, useState } from 'react';
import { useVideoPlayer } from 'expo-video';

export const INTRO_FALLBACK_CLOSE_MS = 9000;

export const configureOneShotIntroPlayer = (player) => {
  player.loop = false;
  player.muted = false;
  player.volume = 1;
  player.timeUpdateEventInterval = 0;
  player.audioMixingMode = 'doNotMix';
};

export function useOneShotIntroPlayer(source, onFinish) {
  const [ready, setReady] = useState(false);
  const startedRef = useRef(false);
  const closedRef = useRef(false);
  const onFinishRef = useRef(onFinish);
  const fallbackTimerRef = useRef(null);

  const player = useVideoPlayer(source, (instance) => {
    configureOneShotIntroPlayer(instance);
  });

  useEffect(() => {
    onFinishRef.current = onFinish;
  }, [onFinish]);

  const finish = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
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
      fallbackTimerRef.current = setTimeout(finish, INTRO_FALLBACK_CLOSE_MS);
    } catch (e) {
      if (__DEV__) console.warn('intro play:', e?.message || e);
      startedRef.current = false;
      try {
        player.play();
        startedRef.current = true;
        fallbackTimerRef.current = setTimeout(finish, INTRO_FALLBACK_CLOSE_MS);
      } catch (_) {}
    }
  }, [finish, player]);

  useEffect(() => {
    const statusSubscription = player.addListener('statusChange', ({ status }) => {
      if (status !== 'readyToPlay') return;
      setReady(true);
      configureOneShotIntroPlayer(player);
      playOnce();
    });
    const endSubscription = player.addListener('playToEnd', finish);

    playOnce();

    return () => {
      closedRef.current = true;
      startedRef.current = false;
      statusSubscription.remove();
      endSubscription.remove();
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
      try { player.pause(); } catch (_) {}
    };
  }, [finish, playOnce, player]);

  return { player, ready, finish };
}
