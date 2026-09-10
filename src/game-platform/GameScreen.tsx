import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ErrorBoundary from '../components/ErrorBoundary';
import GameWebView, { type GameWinAnnouncement } from './GameWebView';
import { REGISTERED_GAMES } from './GameLoader';
import type { GameId } from './GameMessageTypes';

interface GameScreenProps {
  gameId: GameId;
  onGameWin?: (result: GameWinAnnouncement) => void;
}

export default function GameScreen({ gameId, onGameWin }: GameScreenProps) {
  const router = useRouter();
  const game = REGISTERED_GAMES[gameId];

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <TouchableOpacity accessibilityLabel="Back" style={styles.iconButton} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={23} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.title}>{game.title}</Text>
        <View style={styles.headerSpacer} />
      </View>
      <ErrorBoundary name={`${game.title} WebView`}>
        <GameWebView gameId={gameId} onExit={() => router.back()} onGameWin={onGameWin} />
      </ErrorBoundary>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#090B18' },
  header: { height: 48, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#272A38', paddingHorizontal: 8 },
  iconButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, color: '#FFFFFF', fontSize: 15, fontWeight: '800', textAlign: 'center' },
  headerSpacer: { width: 40, height: 40 },
});
