import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import LogoLoader from '../../src/components/LogoLoader';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import { supabase } from '../../src/api/supabase';
import { showCuteAlert, confirmCuteAlert } from '../../src/components/CuteAlert';
import { horizontalScale } from '../../src/theme/scaling';
import { BRAND } from '../../src/theme/brand';

// Fallback shown while vip_tiers hasn't hydrated yet. The live values
// override these the moment the admin-managed catalogue arrives.
const PERKS_FALLBACK = [
  { icon: 'star',       title: 'Exclusive Badge',     desc: 'Display a shiny VIP badge next to your name' },
  { icon: 'color-wand', title: 'Silver Name Color',   desc: 'Your name shines in chat across rooms' },
  { icon: 'airplane',   title: 'Entrance Effect',     desc: 'Animated entry banner when you join a room' },
  { icon: 'shield',     title: 'Profile Frame',       desc: 'Silver-tier avatar ring everywhere' },
];
const PLANS_FALLBACK = [
  { days:  7, cost: 15000, label: '7 Days VIP' },
  { days: 15, cost: 28000, label: '15 Days VIP' },
  { days: 30, cost: 50000, label: '1 Month VIP' },
];

// Pick the icon used for each perk string. We render the admin-edited
// text but keep a stable icon mapping so the layout doesn't lurch
// when the perks list changes shape.
const ICON_FOR_PERK = (s) => {
  const text = String(s || '').toLowerCase();
  if (text.includes('badge'))    return 'star';
  if (text.includes('color'))    return 'color-wand';
  if (text.includes('entrance')) return 'airplane';
  if (text.includes('frame'))    return 'shield';
  if (text.includes('emoji'))    return 'happy';
  if (text.includes('theme'))    return 'sparkles';
  if (text.includes('gift'))     return 'gift';
  return 'star';
};

const formatDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

export default function VipScreen() {
  const router = useRouter();
  const { user, diamonds, refreshUser, vipTiers } = useGlobalState();
  const [busy, setBusy] = useState(false);

  // Pull the VIP-tier row from the live catalogue. Fall back to the
  // bundled defaults until vipTiers hydrates so the screen never
  // renders an empty plan grid on cold start.
  const vipRow = (vipTiers || []).find((t) => t.id === 'VIP');
  const PLANS = vipRow?.pricing
    ? Object.entries(vipRow.pricing)
        .map(([days, cost]) => ({
          days:  parseInt(days, 10),
          cost:  Number(cost),
          label: parseInt(days, 10) === 30 ? '1 Month VIP' : `${days} Days VIP`,
        }))
        .filter((p) => Number.isFinite(p.days) && p.days > 0 && p.cost > 0)
        .sort((a, b) => a.days - b.days)
    : PLANS_FALLBACK;
  const PERKS = Array.isArray(vipRow?.perks) && vipRow.perks.length > 0
    ? vipRow.perks.map((p) => ({
        icon:  ICON_FOR_PERK(p),
        title: p,
        desc:  '',
      }))
    : PERKS_FALLBACK;

  const handlePurchase = async (plan) => {
    if (busy) return;
    const ok = await confirmCuteAlert(
      'Confirm Purchase',
      `Activate ${plan.label} for ${plan.cost.toLocaleString()} 💎? Your balance will drop to ${Math.max(0, diamonds - plan.cost).toLocaleString()}.`,
      { confirmText: 'Activate', cancelText: 'Not now' }
    );
    if (!ok) return;
    setBusy(true);
    const { data, error } = await supabase.rpc('purchase_vip', { tier: 'VIP', days: plan.days });
    setBusy(false);
    if (error) {
      showCuteAlert('Purchase failed', error.message);
      return;
    }
    // Refresh the cached profile so the VIP badge updates immediately.
    // The purchase RPC succeeded — that's the source of truth. The
    // refresh is just a UX nicety, so a failure here is non-fatal.
    //
    // We bound the wait at 3s so a slow network doesn't strand the user
    // staring at a loading indicator while waiting for a refresh that
    // would otherwise take ~10s. Dev gets the full failure cause; the
    // user sees a friendly action ("pull-to-refresh on profile") rather
    // than the more drastic "restart the app".
    let refreshOk = true;
    let refreshReason = null;
    try {
      const refreshPromise = refreshUser?.() ?? Promise.resolve();
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('refresh timed out')), 3000));
      await Promise.race([refreshPromise, timeout]);
    } catch (err) {
      refreshOk = false;
      refreshReason = err?.message || String(err) || 'unknown error';
      if (__DEV__) console.warn('[vip] refreshUser failed:', refreshReason);
    }
    showCuteAlert(
      'Activated 🎉',
      `${plan.label} is now active. Valid until ${formatDate(data?.expires_at)}.`
      + (refreshOk ? '' : '\n\nIf your VIP badge doesn\'t appear within 30 seconds, pull-to-refresh on your Profile.'),
      [{ text: 'Awesome' }]
    );
  };

  const isVipActive = user?.vipType && user?.vipExpiresAt && new Date(user.vipExpiresAt) > new Date();
  const showStatus = !!user?.vipType;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>VIP Center</Text>
        <View style={{ width: horizontalScale(28) }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>

        <LinearGradient colors={['#A855F7', BRAND.vvip]} style={styles.heroCard}>
          <Ionicons name="ribbon" size={64} color="#FFFFFF" style={{ marginBottom: 12 }} />
          <Text style={styles.heroTitle}>Premium VIP</Text>
          <Text style={styles.heroSub}>Unlock exclusive privileges and stand out</Text>

          {showStatus && (
            <View style={styles.statusChip}>
              <Ionicons name={isVipActive ? 'checkmark-circle' : 'time'} size={14} color="#FFF" />
              <Text style={styles.statusChipText}>
                {isVipActive
                  ? `${user.vipType} active · expires ${formatDate(user.vipExpiresAt)}`
                  : `${user.vipType} expired · activate to renew`}
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

        <Text style={styles.sectionTitle}>VIP Privileges</Text>

        {PERKS.map((perk, index) => (
          <View key={index} style={styles.perkRow}>
            <View style={styles.perkIconBox}>
              <Ionicons name={perk.icon} size={24} color={BRAND.vvip} />
            </View>
            <View style={styles.perkInfo}>
              <Text style={styles.perkTitle}>{perk.title}</Text>
              <Text style={styles.perkDesc}>{perk.desc}</Text>
            </View>
          </View>
        ))}

        <Text style={styles.sectionTitle}>Subscription Plans</Text>

        {PLANS.map((plan) => (
          <TouchableOpacity
            key={plan.days}
            style={[styles.subCard, busy && { opacity: 0.6 }]}
            disabled={busy}
            onPress={() => handlePurchase(plan)}
          >
            <View>
              <Text style={styles.subDuration}>{plan.label}</Text>
              <Text style={styles.subPrice}>{plan.cost.toLocaleString()} 💎</Text>
            </View>
            <View style={styles.buyBtn}>
              {busy ? <LogoLoader size={32} /> : <Text style={styles.buyBtnText}>Activate</Text>}
            </View>
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
  heroCard: { borderRadius: 20, padding: 28, alignItems: 'center', marginBottom: 18 },
  heroTitle: { color: '#FFFFFF', fontSize: 26, fontWeight: '900', fontStyle: 'italic', marginBottom: 6 },
  heroSub: { color: 'rgba(255,255,255,0.85)', fontSize: 13, textAlign: 'center' },
  statusChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.3)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, marginTop: 12, gap: 6 },
  statusChipText: { color: '#FFF', fontSize: 11, fontWeight: '600' },
  balanceRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E1A34', paddingHorizontal: 14, paddingVertical: 12, borderRadius: 14, marginBottom: 18, gap: 8 },
  balanceText: { color: '#FFF', fontSize: 14, fontWeight: '600', flex: 1 },
  topUpBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 18, backgroundColor: 'rgba(56,189,248,0.15)', borderWidth: 1, borderColor: '#38BDF8' },
  topUpBtnText: { color: '#38BDF8', fontWeight: '700', fontSize: 12 },
  sectionTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: 'bold', marginBottom: 12, marginTop: 4 },
  perkRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E1A34', padding: 14, borderRadius: 14, marginBottom: 10 },
  perkIconBox: { width: 44, height: 44, borderRadius: 22, backgroundColor: `${BRAND.vvip}1F`, justifyContent: 'center', alignItems: 'center', marginRight: 14 },
  perkInfo: { flex: 1 },
  perkTitle: { color: '#FFFFFF', fontSize: 14, fontWeight: 'bold', marginBottom: 2 },
  perkDesc: { color: '#9CA3AF', fontSize: 11 },
  subCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#2D1B36', padding: 18, borderRadius: 14, borderWidth: 1, borderColor: BRAND.vvip, marginBottom: 10 },
  subDuration: { color: '#FFFFFF', fontSize: 15, fontWeight: 'bold', marginBottom: 4 },
  subPrice: { color: BRAND.vvip, fontSize: 13, fontWeight: '600' },
  buyBtn: { backgroundColor: BRAND.vvip, paddingVertical: 9, paddingHorizontal: 22, borderRadius: 20, minWidth: 96, alignItems: 'center' },
  buyBtnText: { color: '#FFFFFF', fontWeight: 'bold' },
});