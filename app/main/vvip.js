import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Image } from 'react-native';
import LogoLoader from '../../src/components/LogoLoader';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import { supabase } from '../../src/api/supabase';
import { showCuteAlert, confirmCuteAlert } from '../../src/components/CuteAlert';

const PERKS = [
  { icon: 'shield-checkmark', title: 'Anti-Kick Protection', desc: 'You cannot be kicked from any live room' },
  { icon: 'flash',            title: 'Rainbow Name',        desc: 'VVIP gradient name + crown badge in chat' },
  { icon: 'car-sport',        title: 'Luxury Entrance',     desc: 'Ferrari-tier full-room entry animation' },
  { icon: 'sparkles',         title: 'God-Tier Avatar',     desc: 'Animated rainbow avatar ring globally' },
];

const PLANS_FALLBACK = [
  { days:  7, cost:  40000, label: '7 Days VVIP' },
  { days: 15, cost:  80000, label: '15 Days VVIP' },
  { days: 30, cost: 150000, label: '1 Month VVIP' },
];

const formatDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

export default function VvipScreen() {
  const router = useRouter();
  const { user, diamonds, refreshUser, vipTiers } = useGlobalState();
  const [busy, setBusy] = useState(false);

  // Live VVIP pricing from the admin-managed vip_tiers row. Fallback
  // keeps the screen functional during cold start before the catalogue
  // hydrates.
  const vvipRow = (vipTiers || []).find((t) => t.id === 'VVIP');
  const PLANS = vvipRow?.pricing
    ? Object.entries(vvipRow.pricing)
        .map(([days, cost]) => ({
          days:  parseInt(days, 10),
          cost:  Number(cost),
          label: parseInt(days, 10) === 30 ? '1 Month VVIP' : `${days} Days VVIP`,
        }))
        .filter((p) => Number.isFinite(p.days) && p.days > 0 && p.cost > 0)
        .sort((a, b) => a.days - b.days)
    : PLANS_FALLBACK;

  const handleActivate = async (plan) => {
    if (busy) return;
    const ok = await confirmCuteAlert(
      'Confirm VVIP Activation',
      `Activate Supreme ${plan.label} for ${plan.cost.toLocaleString()} 💎? You'll join god-tier — anti-kick, rainbow name, luxury entrance.`,
      { confirmText: 'Activate', cancelText: 'Not now' }
    );
    if (!ok) return;
    setBusy(true);
    const { data, error } = await supabase.rpc('purchase_vip', { tier: 'VVIP', days: plan.days });
    setBusy(false);
    if (error) {
      showCuteAlert('Activation failed', error.message);
      return;
    }
    try { await refreshUser?.(); } catch (_) {}
    showCuteAlert(
      'Supreme VVIP Active 👑',
      `Welcome to god-tier. Valid until ${formatDate(data?.expires_at)}.`,
      [{ text: 'Enter the throne' }]
    );
  };

  const isVvipActive = user?.vipType === 'VVIP' && user?.vipExpiresAt && new Date(user.vipExpiresAt) > new Date();

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>VVIP Center</Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>

        <LinearGradient colors={['#FF007A', '#5A46B5']} style={styles.heroCard}>
          <Image source={{ uri: 'https://img.icons8.com/color/96/crown.png' }} style={{ width: 72, height: 72, marginBottom: 10 }} />
          <Text style={styles.heroTitle}>SUPREME VVIP</Text>
          <Text style={styles.heroSub}>The ultimate level of dominance & power</Text>

          {isVvipActive && (
            <View style={styles.statusChip}>
              <Ionicons name="checkmark-circle" size={14} color="#FDE047" />
              <Text style={styles.statusChipText}>
                Active · expires {formatDate(user.vipExpiresAt)}
              </Text>
            </View>
          )}
        </LinearGradient>

        <View style={styles.balanceRow}>
          <Ionicons name="diamond" size={16} color="#38BDF8" />
          <Text style={styles.balanceText}>Balance: {diamonds.toLocaleString()}</Text>
          <TouchableOpacity style={styles.topUpBtn} onPress={() => router.push('/main/wallet')}>
            <Text style={styles.topUpBtnText}>Top up</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionTitle}>God-Tier Privileges</Text>

        {PERKS.map((perk, index) => (
          <View key={index} style={styles.perkRow}>
            <View style={styles.perkIconBox}>
              <Ionicons name={perk.icon} size={24} color="#FDE047" />
            </View>
            <View style={styles.perkInfo}>
              <Text style={styles.perkTitle}>{perk.title}</Text>
              <Text style={styles.perkDesc}>{perk.desc}</Text>
            </View>
          </View>
        ))}

        <Text style={styles.sectionTitle}>Activation Plans</Text>

        {PLANS.map((plan) => (
          <TouchableOpacity key={plan.days} disabled={busy} onPress={() => handleActivate(plan)}>
            <LinearGradient
              colors={['#FF007A', '#5A46B5']}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              style={[styles.subCard, busy && { opacity: 0.6 }]}
            >
              <View>
                <Text style={styles.subDuration}>{plan.label}</Text>
                <Text style={styles.subPrice}>{plan.cost.toLocaleString()} 💎</Text>
              </View>
              <View style={styles.buyBtn}>
                {busy ? <LogoLoader size={32} /> : <Text style={styles.buyBtnText}>Activate</Text>}
              </View>
            </LinearGradient>
          </TouchableOpacity>
        ))}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0E111E' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#251B45' },
  backBtn: { padding: 4 },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },
  content: { padding: 16 },
  heroCard: { borderRadius: 20, padding: 26, alignItems: 'center', marginBottom: 18, borderColor: '#FDE047', borderWidth: 2 },
  heroTitle: { color: '#FDE047', fontSize: 28, fontWeight: '900', fontStyle: 'italic', marginBottom: 6, textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 2, height: 2 }, textShadowRadius: 4 },
  heroSub: { color: '#FFFFFF', fontSize: 13, textAlign: 'center', fontWeight: '600' },
  statusChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14, marginTop: 14, gap: 6, borderWidth: 1, borderColor: '#FDE047' },
  statusChipText: { color: '#FDE047', fontSize: 11, fontWeight: '700' },
  balanceRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E1A34', paddingHorizontal: 14, paddingVertical: 12, borderRadius: 14, marginBottom: 18, gap: 8 },
  balanceText: { color: '#FFF', fontSize: 14, fontWeight: '600', flex: 1 },
  topUpBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 18, backgroundColor: 'rgba(56,189,248,0.15)', borderWidth: 1, borderColor: '#38BDF8' },
  topUpBtnText: { color: '#38BDF8', fontWeight: '700', fontSize: 12 },
  sectionTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: 'bold', marginBottom: 12, marginTop: 4 },
  perkRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E1A34', padding: 14, borderRadius: 14, marginBottom: 10, borderWidth: 1, borderColor: '#251B45' },
  perkIconBox: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(253, 224, 71, 0.12)', justifyContent: 'center', alignItems: 'center', marginRight: 14 },
  perkInfo: { flex: 1 },
  perkTitle: { color: '#FFFFFF', fontSize: 14, fontWeight: 'bold', marginBottom: 2 },
  perkDesc: { color: '#9CA3AF', fontSize: 11 },
  subCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 18, borderRadius: 14, marginBottom: 10 },
  subDuration: { color: '#FFFFFF', fontSize: 15, fontWeight: 'bold', marginBottom: 4 },
  subPrice: { color: '#FDE047', fontSize: 13, fontWeight: 'bold' },
  buyBtn: { backgroundColor: '#FDE047', paddingVertical: 9, paddingHorizontal: 22, borderRadius: 20, minWidth: 96, alignItems: 'center' },
  buyBtnText: { color: '#1E1B4B', fontWeight: '900' },
});