import React, { useMemo, useState } from 'react';
import { ImageBackground, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import GreedyLion from '../../../src/components/games/GreedyLion';
import { useGlobalState } from '../../../src/context/GlobalStateContext';

const APP_BACKGROUND = require('../../../assets/backgrounds/neon-space.webp');
const BETS = [100, 1000, 5000, 50000, 100000];

const GAME_META = {
  fruit_roulette: {
    title: 'Fruit Roulette',
    color: '#FF3AAE',
    icon: 'disc',
    options: [
      { id: 'apple', label: 'Apple', emoji: '🍎', multiplier: 5 },
      { id: 'banana', label: 'Banana', emoji: '🍌', multiplier: 5 },
      { id: 'orange', label: 'Orange', emoji: '🍊', multiplier: 5 },
      { id: 'watermelon', label: 'Melon', emoji: '🍉', multiplier: 5 },
      { id: 'grapes', label: 'Grapes', emoji: '🍇', multiplier: 10 },
      { id: 'pineapple', label: 'Pineapple', emoji: '🍍', multiplier: 15 },
      { id: 'mango', label: 'Mango', emoji: '🥭', multiplier: 25 },
      { id: 'crown', label: 'Crown', emoji: '👑', multiplier: 45 },
    ],
  },
  teen_patti: {
    title: 'Teen Patti',
    color: '#22D3EE',
    icon: 'albums',
    options: [
      { id: 'A', label: 'Chair A', emoji: 'A', multiplier: 2.9 },
      { id: 'B', label: 'Chair B', emoji: 'B', multiplier: 2.9 },
      { id: 'C', label: 'Chair C', emoji: 'C', multiplier: 2.9 },
    ],
  },
  greedy_lion: {
    title: 'Greedy Lion',
    color: '#F5C76A',
    icon: 'trophy',
  },
};

function StandaloneGame({ meta, diamonds, setDiamonds, onBack }) {
  const [selectedBet, setSelectedBet] = useState(BETS[0]);
  const [bets, setBets] = useState([]);
  const [winner, setWinner] = useState(null);
  const [message, setMessage] = useState('Choose an item and place your bet.');
  const totalBet = bets.reduce((sum, bet) => sum + bet.amount, 0);

  const placeBet = (option) => {
    if (selectedBet > diamonds) {
      setMessage('Insufficient diamonds.');
      return;
    }
    setWinner(null);
    setBets((current) => [...current, { option, amount: selectedBet }]);
    setDiamonds((current) => Math.max(0, current - selectedBet));
    setMessage(`${option.label} selected. Tap Reveal when ready.`);
  };

  const reveal = () => {
    if (!bets.length) {
      setMessage('Place at least one bet first.');
      return;
    }
    const picked = meta.options[Math.floor(Math.random() * meta.options.length)];
    const payout = bets
      .filter((bet) => bet.option.id === picked.id)
      .reduce((sum, bet) => sum + Math.round(bet.amount * bet.option.multiplier), 0);
    if (payout > 0) setDiamonds((current) => current + payout);
    setWinner(picked);
    setBets([]);
    setMessage(payout > 0 ? `You won ${payout.toLocaleString()} diamonds!` : 'No win this round. Try again.');
  };

  return (
    <View style={styles.soloWrap}>
      <View style={styles.soloHeader}>
        <TouchableOpacity onPress={onBack} style={styles.headerButton}>
          <Ionicons name="chevron-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <View>
          <Text style={styles.soloTitle}>{meta.title}</Text>
          <Text style={styles.balanceText}>💎 {Number(diamonds || 0).toLocaleString()}</Text>
        </View>
        <TouchableOpacity onPress={onBack} style={styles.headerButton}>
          <Ionicons name="close" size={22} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      <LinearGradient colors={['rgba(35,24,96,.96)', 'rgba(12,9,45,.98)']} style={styles.tableCard}>
        <View style={[styles.heroIcon, { borderColor: meta.color }]}>
          <Ionicons name={meta.icon} size={34} color={meta.color} />
        </View>
        <Text style={styles.statusText}>{message}</Text>
        {winner ? (
          <View style={styles.winnerPill}>
            <Text style={styles.winnerText}>Winner: {winner.emoji} {winner.label}</Text>
          </View>
        ) : null}

        <View style={styles.optionGrid}>
          {meta.options.map((option) => {
            const selected = bets.some((bet) => bet.option.id === option.id);
            return (
              <TouchableOpacity key={option.id} activeOpacity={0.86} onPress={() => placeBet(option)} style={styles.optionTouch}>
                <LinearGradient
                  colors={selected ? ['#1EDCFF', '#E32BF2'] : ['rgba(255,255,255,.12)', 'rgba(255,255,255,.05)']}
                  style={[styles.optionCard, selected && styles.optionCardActive]}
                >
                  <Text style={styles.optionEmoji}>{option.emoji}</Text>
                  <Text style={styles.optionLabel} numberOfLines={1}>{option.label}</Text>
                  <Text style={styles.optionMultiplier}>{option.multiplier}x</Text>
                </LinearGradient>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.betRow}>
          {BETS.map((amount) => (
            <TouchableOpacity key={amount} activeOpacity={0.84} onPress={() => setSelectedBet(amount)} style={styles.betTouch}>
              <View style={[styles.betChip, selectedBet === amount && styles.betChipActive]}>
                <Text style={[styles.betText, selectedBet === amount && styles.betTextActive]}>
                  {amount >= 1000 ? `${amount / 1000}k` : amount}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity activeOpacity={0.88} onPress={reveal} style={styles.revealTouch}>
          <LinearGradient colors={['#22C7FF', '#E126F2']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.revealButton}>
            <Ionicons name="sparkles" size={19} color="#FFFFFF" />
            <Text style={styles.revealText}>{totalBet ? `Reveal (${totalBet.toLocaleString()})` : 'Reveal'}</Text>
          </LinearGradient>
        </TouchableOpacity>
      </LinearGradient>
    </View>
  );
}

export default function HomeGameScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams();
  const gameId = Array.isArray(id) ? id[0] : id;
  const normalizedGameId = gameId === 'royal_feast' ? 'greedy_lion' : gameId;
  const meta = GAME_META[normalizedGameId] || GAME_META.fruit_roulette;
  const { diamonds, setDiamonds } = useGlobalState();

  const controls = useMemo(() => ({
    roomId: null,
    myDiamonds: diamonds,
    setMyDiamonds: setDiamonds,
    onBack: () => router.back(),
    onClose: () => router.back(),
    standalone: true,
  }), [diamonds, router, setDiamonds]);

  return (
    <ImageBackground source={APP_BACKGROUND} style={styles.background} resizeMode="cover">
      <SafeAreaView style={styles.safe}>
        <StatusBar style="light" />
        {normalizedGameId === 'greedy_lion' ? (
          <GreedyLion {...controls} />
        ) : (
          <StandaloneGame meta={meta} diamonds={diamonds} setDiamonds={setDiamonds} onBack={() => router.back()} />
        )}
      </SafeAreaView>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  background: { flex: 1, backgroundColor: '#050427' },
  safe: { flex: 1 },
  soloWrap: { flex: 1, padding: 16 },
  soloHeader: { height: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,.1)',
  },
  soloTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: '900', textAlign: 'center' },
  balanceText: { color: '#BDEBFF', fontSize: 12, fontWeight: '800', textAlign: 'center', marginTop: 2 },
  tableCard: {
    flex: 1,
    marginTop: 16,
    borderRadius: 28,
    padding: 18,
    borderWidth: 1.5,
    borderColor: 'rgba(126,93,255,.62)',
    shadowColor: '#D946EF',
    shadowOpacity: .45,
    shadowRadius: 24,
    elevation: 12,
  },
  heroIcon: {
    alignSelf: 'center',
    width: 82,
    height: 82,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,.08)',
    borderWidth: 1.5,
  },
  statusText: { color: '#D7E7FF', fontSize: 15, lineHeight: 20, textAlign: 'center', marginTop: 16, minHeight: 42 },
  winnerPill: {
    alignSelf: 'center',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: 'rgba(34,211,238,.18)',
    borderWidth: 1,
    borderColor: 'rgba(34,211,238,.52)',
  },
  winnerText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
  optionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 10,
    marginTop: 18,
  },
  optionTouch: { width: '48%', height: 102, borderRadius: 18 },
  optionCard: {
    flex: 1,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,.18)',
  },
  optionCardActive: { borderColor: '#FFFFFF' },
  optionEmoji: { fontSize: 28, fontWeight: '900', color: '#FFFFFF' },
  optionLabel: { color: '#FFFFFF', fontSize: 13, fontWeight: '900', marginTop: 5 },
  optionMultiplier: { color: '#FDE68A', fontSize: 11, fontWeight: '900', marginTop: 3 },
  betRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 7, marginTop: 18 },
  betTouch: { flex: 1 },
  betChip: {
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,.18)',
  },
  betChipActive: { backgroundColor: '#FFD166', borderColor: '#FFFFFF' },
  betText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
  betTextActive: { color: '#33113F' },
  revealTouch: { marginTop: 18, borderRadius: 22, overflow: 'hidden' },
  revealButton: {
    height: 48,
    borderRadius: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
  },
  revealText: { color: '#FFFFFF', fontSize: 16, fontWeight: '900' },
});
