import React, { useCallback, useEffect } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import GameScreen from '../../../src/game-platform/GameScreen';
import { useGlobalState } from '../../../src/context/GlobalStateContext';
import { publishGlobalLiveAnnouncement } from '../../../src/api/liveAnnouncements';
import { stableAssetIndex } from '../../../src/theme/announcementAssets';

const SUPPORTED_GAMES = new Set(['greedy_lion', 'greedy_pro', 'tin_patti_pro', 'lucky_dice', 'crash']);

export default function HomeGameScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams();
  const gameId = Array.isArray(id) ? id[0] : id;
  const normalizedGameId = gameId === 'royal_feast' ? 'greedy_lion' : gameId;
  const { user, gameSettings, gameSettingsLoaded } = useGlobalState();
  const supported = SUPPORTED_GAMES.has(normalizedGameId)
    && (normalizedGameId !== 'crash' || !gameSettingsLoaded || gameSettings?.crash?.is_active === true);

  useEffect(() => {
    if (!supported) router.replace('/main/(tabs)/');
  }, [router, supported]);

  const onGameWin = useCallback(({ amount, gameName, roundId, winnerId, winnerName, winnerAvatar, isBot }) => {
    const resolvedWinnerId = winnerId || user?.id;
    const resolvedWinnerName = winnerName || user?.name || 'Someone';
    publishGlobalLiveAnnouncement('game_win_in_live', {
      eventId: `game-${roundId}-${resolvedWinnerId || resolvedWinnerName}`,
      winnerId: resolvedWinnerId,
      winnerName: resolvedWinnerName,
      winnerAvatar: winnerAvatar || (!isBot ? user?.avatar : null) || null,
      winnerAvatarIndex: isBot ? stableAssetIndex(resolvedWinnerId || resolvedWinnerName, 25) : undefined,
      isBot: isBot === true,
      amount,
      gameName,
      roomId: null,
    }).catch(() => {});
  }, [user?.avatar, user?.id, user?.name]);

  if (!supported || (normalizedGameId === 'crash' && !gameSettingsLoaded)) return null;

  return <GameScreen gameId={normalizedGameId} onGameWin={onGameWin} />;
}
