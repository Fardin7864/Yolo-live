/**
 * Host Stats Dashboard
 * ====================
 * Shows the broadcaster a one-page summary of how they're doing:
 *   - Live minutes, sessions, gifts received, diamonds earned
 *   - Three time windows: Today, Last 7 days, All-time (segmented control)
 *   - Recent 10 sessions list with per-session breakdown
 *
 * Data comes from one RPC `get_host_stats(p_host_id)` (migration 75)
 * which aggregates `live_streams` rows server-side, so the screen
 * stays fast even for hosts with thousands of sessions.
 *
 * Access: self only on the mobile side; the RPC also allows admins
 * and the host's agency owner to call it, but those flows live in the
 * admin panel.
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import { supabase } from '../../src/api/supabase';
import LogoLoader from '../../src/components/LogoLoader';
import { BRAND } from '../../src/theme/brand';

const PERIODS = [
  { id: 'today',    label: 'Today'    },
  { id: 'week',     label: 'Week'     },
  { id: 'month',    label: 'Month'    },
  { id: 'all_time', label: 'All time' },
];

/** Format a session's minutes count into a friendly "1h 24m" / "12m" string. */
function formatMinutes(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}

function compactNumber(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1_000)     return (v / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(v);
}

export default function HostStatsScreen() {
  const router = useRouter();
  const { user } = useGlobalState();
  const [period, setPeriod]       = useState('today');
  const [stats, setStats]         = useState(null);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefresh]  = useState(false);
  const [error, setError]         = useState(null);

  const load = useCallback(async () => {
    if (!user?.id) return;
    setError(null);
    const { data, error: rpcErr } = await supabase.rpc('get_host_stats', {
      p_host_id: user.id,
    });
    if (rpcErr) {
      setError(rpcErr.message || 'Failed to load stats');
      setStats(null);
    } else if (data?.error) {
      setError(data.error);
      setStats(null);
    } else {
      setStats(data);
    }
  }, [user?.id]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const onRefresh = async () => {
    setRefresh(true);
    await load();
    setRefresh(false);
  };

  const current = stats?.[period] || { sessions: 0, minutes: 0, gifts: 0, diamonds: 0 };
  const recent  = Array.isArray(stats?.recent_sessions) ? stats.recent_sessions : [];

  const renderHero = () => (
    <LinearGradient
      colors={['#7C3AED', '#EC4899']}
      start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
      style={styles.hero}
    >
      <View style={styles.heroRow}>
        <Image
          source={{ uri: user?.avatar || 'https://picsum.photos/seed/host/100/100' }}
          style={styles.heroAvatar}
        />
        <View style={{ flex: 1, marginLeft: 14 }}>
          <Text style={styles.heroName} numberOfLines={1}>{user?.name || 'Host'}</Text>
          <Text style={styles.heroId}>ID: {user?.displayId || '—'}</Text>
          <View style={styles.heroBadge}>
            <Ionicons name="mic" size={11} color="#FFF" />
            <Text style={styles.heroBadgeText}>HOST STATS</Text>
          </View>
        </View>
      </View>
    </LinearGradient>
  );

  const renderPeriodSelector = () => (
    <View style={styles.periodRow}>
      {PERIODS.map((p) => {
        const active = period === p.id;
        return (
          <TouchableOpacity
            key={p.id}
            style={[styles.periodPill, active && styles.periodPillActive]}
            onPress={() => setPeriod(p.id)}
          >
            <Text style={[styles.periodText, active && styles.periodTextActive]}>
              {p.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  const StatTile = ({ icon, color, label, value, sub }) => (
    <View style={styles.statTile}>
      <View style={[styles.statIcon, { backgroundColor: color + '20' }]}>
        <Ionicons name={icon} size={22} color={color} />
      </View>
      <Text style={styles.statValue} numberOfLines={1}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
      {sub ? <Text style={styles.statSub}>{sub}</Text> : null}
    </View>
  );

  const renderStatsGrid = () => (
    <View style={styles.gridWrap}>
      <View style={styles.gridRow}>
        <StatTile
          icon="time"
          color="#FCD34D"
          label="Live Time"
          value={formatMinutes(current.minutes)}
        />
        <StatTile
          icon="radio"
          color="#38BDF8"
          label="Sessions"
          value={compactNumber(current.sessions)}
        />
      </View>
      <View style={styles.gridRow}>
        <StatTile
          icon="gift"
          color="#F472B6"
          label="Gifts"
          value={compactNumber(current.gifts)}
        />
        <StatTile
          icon="diamond"
          color="#00E5FF"
          label="Diamonds"
          value={compactNumber(current.diamonds)}
        />
      </View>
    </View>
  );

  const renderRecentSessions = () => (
    <View style={styles.sessionsBox}>
      <Text style={styles.sectionTitle}>Recent Sessions</Text>
      {recent.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="videocam-off-outline" size={48} color="rgba(255,255,255,0.2)" />
          <Text style={styles.emptyText}>No sessions yet.</Text>
          <Text style={styles.emptySub}>Your live history will appear here once you go live.</Text>
        </View>
      ) : (
        recent.map((s) => {
          const date = new Date(s.started_at);
          const dateStr = date.toLocaleDateString(undefined, {
            day: 'numeric', month: 'short',
          });
          const timeStr = date.toLocaleTimeString(undefined, {
            hour: '2-digit', minute: '2-digit',
          });
          const isLive = s.status === 'live';
          return (
            <View key={s.id} style={styles.sessionRow}>
              <View style={[styles.sessionIcon, { backgroundColor: isLive ? '#F43F5E20' : '#1E1A34' }]}>
                <Ionicons
                  name={s.type === 'audio' ? 'mic' : 'videocam'}
                  size={20}
                  color={isLive ? '#F43F5E' : '#9CA3AF'}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sessionTitle} numberOfLines={1}>
                  {s.title || (s.type === 'audio' ? 'Audio Live' : 'Video Live')}
                  {isLive ? <Text style={{ color: '#F43F5E', fontSize: 10 }}> • LIVE</Text> : null}
                </Text>
                <Text style={styles.sessionMeta}>
                  {dateStr} • {timeStr} • {formatMinutes(s.minutes)}
                </Text>
              </View>
              <View style={styles.sessionStats}>
                <View style={styles.sessionStatRow}>
                  <Ionicons name="gift" size={12} color="#F472B6" />
                  <Text style={styles.sessionStatText}>{compactNumber(s.total_gifts)}</Text>
                </View>
                <View style={styles.sessionStatRow}>
                  <Ionicons name="diamond" size={12} color="#00E5FF" />
                  <Text style={styles.sessionStatText}>{compactNumber(s.total_earnings)}</Text>
                </View>
              </View>
            </View>
          );
        })
      )}
    </View>
  );

  const renderEarningsCta = () => (
    <TouchableOpacity
      style={styles.earningsCta}
      onPress={() => router.push('/main/earnings')}
    >
      <View style={[styles.statIcon, { backgroundColor: '#FCD34D20' }]}>
        <Ionicons name="sparkles" size={20} color="#FCD34D" />
      </View>
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={styles.earningsCtaTitle}>Settle Beans → BDT</Text>
        <Text style={styles.earningsCtaSub}>Go to Earnings to request payout</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color="#9CA3AF" />
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Host Dashboard</Text>
        <View style={{ width: 28 }} />
      </View>

      {loading ? (
        <View style={styles.centerWrap}>
          <LogoLoader size="medium" />
        </View>
      ) : error ? (
        <View style={styles.centerWrap}>
          <Ionicons name="alert-circle" size={48} color="#F43F5E" />
          <Text style={styles.errorText}>Couldn't load stats</Text>
          <Text style={styles.errorSub}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => { setLoading(true); load().finally(() => setLoading(false)); }}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BRAND.primary} />}
        >
          {renderHero()}
          {renderPeriodSelector()}
          {renderStatsGrid()}
          {renderEarningsCta()}
          {renderRecentSessions()}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0E111E' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#1E1A34',
  },
  backBtn: { padding: 4 },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },

  centerWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  errorText: { color: '#FFF', fontSize: 16, fontWeight: 'bold', marginTop: 14 },
  errorSub: { color: '#9CA3AF', fontSize: 12, marginTop: 6, textAlign: 'center' },
  retryBtn: {
    marginTop: 16, backgroundColor: BRAND.primary,
    paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10,
  },
  retryText: { color: '#FFF', fontWeight: 'bold' },

  hero: { borderRadius: 18, padding: 18, marginBottom: 16 },
  heroRow: { flexDirection: 'row', alignItems: 'center' },
  heroAvatar: {
    width: 64, height: 64, borderRadius: 32,
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.4)',
  },
  heroName: { color: '#FFF', fontSize: 18, fontWeight: '900' },
  heroId: { color: 'rgba(255,255,255,0.75)', fontSize: 12, marginTop: 2 },
  heroBadge: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10,
    alignSelf: 'flex-start', marginTop: 8, gap: 4,
  },
  heroBadgeText: { color: '#FFF', fontSize: 9, fontWeight: '900', letterSpacing: 1 },

  periodRow: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12, padding: 4, marginBottom: 16,
  },
  periodPill: {
    flex: 1, paddingVertical: 9, borderRadius: 10, alignItems: 'center',
  },
  periodPillActive: { backgroundColor: BRAND.primary },
  periodText: { color: '#9CA3AF', fontSize: 12, fontWeight: '700' },
  periodTextActive: { color: '#FFFFFF' },

  gridWrap: { marginBottom: 16 },
  gridRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  statTile: {
    flex: 1,
    backgroundColor: '#1E1A34',
    borderRadius: 16, padding: 16,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.04)',
  },
  statIcon: {
    width: 36, height: 36, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center', marginBottom: 10,
  },
  statValue: { color: '#FFF', fontSize: 22, fontWeight: '900' },
  statLabel: { color: '#9CA3AF', fontSize: 11, marginTop: 2, fontWeight: '600' },
  statSub: { color: '#6B7280', fontSize: 10, marginTop: 4 },

  earningsCta: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(252,211,77,0.08)',
    borderWidth: 1, borderColor: 'rgba(252,211,77,0.25)',
    borderRadius: 14, padding: 14, marginBottom: 18,
  },
  earningsCtaTitle: { color: '#FCD34D', fontSize: 14, fontWeight: 'bold' },
  earningsCtaSub: { color: '#9CA3AF', fontSize: 11, marginTop: 2 },

  sessionsBox: { marginBottom: 20 },
  sectionTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: 'bold', marginBottom: 12 },

  emptyState: { alignItems: 'center', paddingVertical: 30 },
  emptyText: { color: 'rgba(255,255,255,0.6)', marginTop: 14, fontSize: 14, fontWeight: '600' },
  emptySub: { color: 'rgba(255,255,255,0.35)', marginTop: 6, fontSize: 12, textAlign: 'center', paddingHorizontal: 30 },

  sessionRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#1E1A34', borderRadius: 14, padding: 12, marginBottom: 10,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.04)',
  },
  sessionIcon: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', marginRight: 12,
  },
  sessionTitle: { color: '#FFF', fontSize: 13, fontWeight: 'bold' },
  sessionMeta: { color: '#9CA3AF', fontSize: 11, marginTop: 3 },
  sessionStats: { alignItems: 'flex-end', gap: 4 },
  sessionStatRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  sessionStatText: { color: '#FFF', fontSize: 11, fontWeight: '700' },
});
