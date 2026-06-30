import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import { showCuteAlert } from '../../src/components/CuteAlert';
import { horizontalScale } from '../../src/theme/scaling';

/**
 * Task Center — fully wired to the migration 70 backend.
 *
 *   • Monthly Check-In       — claims via claim_daily_login() RPC
 *   • Daily Missions         — auto-tracked + claimed via claim_task_reward()
 *
 * State sources:
 *   dailyLoginRewards   — [{day_index, diamonds}], admin-tunable per-day pot
 *   dailyLoginClaims    — my recent claims, newest first
 *   tasks               — admin catalogue, filtered to is_active
 *   todayProgress       — [{task_id, count, completed_at, claimed_at}] for UTC today
 *
 * Mutators from context: claimDailyLogin, claimTaskReward.
 */
export default function TasksScreen() {
  const router = useRouter();
  const {
    role,
    tasks: dbTasks,
    dailyLoginRewards,
    dailyLoginClaims,
    todayProgress,
    claimDailyLogin,
    claimTaskReward,
  } = useGlobalState();

  const isHost = role === 'host' || role === 'agency_owner';
  const [busy, setBusy] = useState(false);

  // Derive the calendar — today's day_index follows the streak rules.
  // We mirror the SQL logic so the UI doesn't need a round-trip just
  // to know which card to highlight.
  const calendar = useMemo(() => {
    const todayUtc = new Date().toISOString().slice(0, 10);
    const claimsByDate = new Map((dailyLoginClaims || []).map((c) => [c.claim_date, c]));
    const last = (dailyLoginClaims || [])[0]; // newest first

    const todayClaim = claimsByDate.get(todayUtc);
    const ymd = (offset) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + offset);
      return d.toISOString().slice(0, 10);
    };
    const yesterday = ymd(-1);

    let pendingDayIndex;
    if (todayClaim) {
      pendingDayIndex = todayClaim.day_index; // already claimed today
    } else if (last && last.claim_date === yesterday) {
      pendingDayIndex = last.day_index === 30 ? 1 : last.day_index + 1;
    } else {
      pendingDayIndex = 1;                    // fresh streak or skipped day
    }

    return (dailyLoginRewards || []).map((r) => {
      const claimed = (dailyLoginClaims || []).some((c) => c.day_index === r.day_index);
      const isToday = r.day_index === pendingDayIndex && !todayClaim;
      const isClaimable = isToday;
      return {
        day:      r.day_index,
        reward:   r.diamonds,
        claimed,
        isToday,
        isClaimable,
      };
    });
  }, [dailyLoginRewards, dailyLoginClaims]);

  const todayCard = useMemo(() => calendar.find((c) => c.isToday), [calendar]);
  const alreadyClaimedToday = !todayCard && (calendar.some((c) => c.claimed && c.day === ((dailyLoginClaims || [])[0]?.day_index)));

  // Lookup progress for a task id — defaults to "not started"
  const progressFor = (taskId) => (todayProgress || []).find((p) => p.task_id === taskId)
    || { count: 0, completed_at: null, claimed_at: null };

  // Visible missions: viewer rows for everyone; host rows only for hosts.
  const visibleMissions = useMemo(() => {
    const all = Array.isArray(dbTasks) ? dbTasks : [];
    const viewerOnly = all.filter((t) => t.audience !== 'host');
    if (!isHost) return viewerOnly;
    return [...viewerOnly, ...all.filter((t) => t.audience === 'host')];
  }, [isHost, dbTasks]);

  const handleClaimDaily = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await claimDailyLogin();
      if (res?.success) {
        showCuteAlert('Reward claimed! 🎉', `+${res.reward} 💎 added to your wallet.`);
      } else if (res?.already_claimed) {
        showCuteAlert('Already claimed', 'Come back tomorrow for the next reward.');
      } else {
        showCuteAlert('Couldn\'t claim', res?.message || 'Try again in a moment.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleClaimMission = async (task) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await claimTaskReward(task.id);
      if (res?.success) {
        // Currency icon in the success toast matches what the RPC awarded
        // (hosts earn beans for live-time tasks, viewers earn diamonds).
        const icon = (res.currency || task.reward_currency) === 'bean' ? '🫘' : '💎';
        showCuteAlert('Reward claimed! 🎉', `+${res.reward} ${icon} added to your wallet.`);
      } else {
        showCuteAlert('Not yet', res?.message || 'Finish the mission first.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleGo = (action) => {
    if (action === 'live') router.push('/main/(tabs)/live');
    else router.push('/main/(tabs)/');
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Task Center</Text>
        <View style={{ width: horizontalScale(28) }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>

        {/* ── Monthly Check-In ───────────────────────────────────── */}
        <LinearGradient colors={['#2D1B36', '#1E1A34']} style={styles.heroCard}>
          <Text style={styles.heroTitle}>Monthly Check-In</Text>
          <Text style={styles.heroSub}>
            {todayCard
              ? `Today is Day ${todayCard.day} — claim ${todayCard.reward} 💎`
              : 'You\'ve claimed today\'s reward. See you tomorrow!'}
          </Text>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.calendarScroll}>
            {calendar.map((item) => (
              <View
                key={item.day}
                style={[
                  styles.dayCard,
                  item.isToday && styles.dayCardToday,
                  item.claimed && styles.dayCardClaimed,
                ]}
              >
                <Text style={[styles.dayText, item.claimed && { color: '#9CA3AF' }]}>Day {item.day}</Text>
                <Ionicons name="diamond" size={24} color={item.claimed ? '#4B5563' : '#00E5FF'} style={{ marginVertical: 4 }} />
                <Text style={[styles.rewardText, item.claimed && { color: '#4B5563' }]}>+{item.reward}</Text>
                {item.claimed && (
                  <View style={styles.checkOverlay}>
                    <Ionicons name="checkmark-circle" size={24} color="#34D399" />
                  </View>
                )}
              </View>
            ))}
          </ScrollView>

          <TouchableOpacity
            style={[styles.claimAllBtn, (!todayCard || busy) && { opacity: 0.5 }]}
            onPress={handleClaimDaily}
            disabled={!todayCard || busy}
          >
            <Text style={styles.claimAllText}>
              {todayCard ? `Claim Day ${todayCard.day} — +${todayCard.reward} 💎` : 'Come back tomorrow'}
            </Text>
          </TouchableOpacity>
        </LinearGradient>

        {/* ── Daily Missions ─────────────────────────────────────── */}
        <Text style={styles.sectionTitle}>
          Daily Missions {isHost ? '(Host)' : ''}
        </Text>

        {visibleMissions.length === 0 && (
          <Text style={styles.mutedNote}>No missions live right now. Check back soon.</Text>
        )}

        {visibleMissions.map((mission) => {
          const prog       = progressFor(mission.id);
          const target     = Number(mission.target || 1);
          const cur        = Math.min(Number(prog.count || 0), target);
          const pct        = target > 0 ? Math.round((cur / target) * 100) : 0;
          const completed  = !!prog.completed_at;
          const claimed    = !!prog.claimed_at;
          const buttonMode = claimed   ? 'claimed'
                           : completed ? 'claim'
                                       : 'go';

          return (
            <View key={mission.id} style={styles.missionCard}>
              <View style={styles.missionInfo}>
                <Text style={styles.missionTitle}>{mission.title}</Text>

                {/* Progress bar */}
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${pct}%` }, claimed && { backgroundColor: '#34D399' }]} />
                </View>
                <Text style={styles.progressLabel}>
                  {claimed ? 'Reward claimed' : `${cur} / ${target}`}
                </Text>

                {(() => {
                  // Reward pill picks its icon + tint from the task's
                  // currency so a beans-denominated host mission reads
                  // as amber/yellow ("you'll earn earner-currency") and
                  // a diamond-denominated viewer mission stays cyan.
                  const isBean = mission.reward_currency === 'bean';
                  return (
                    <View style={[styles.rewardPill, isBean && styles.rewardPillBean]}>
                      <Ionicons
                        name={isBean ? 'leaf' : 'diamond'}
                        size={14}
                        color={isBean ? '#FBBF24' : '#00E5FF'}
                      />
                      <Text style={[styles.rewardPillText, isBean && styles.rewardPillTextBean]}>
                        +{mission.reward.toLocaleString()}
                      </Text>
                    </View>
                  );
                })()}
              </View>

              {buttonMode === 'claimed' && (
                <View style={[styles.missionBtn, styles.missionBtnDone]}>
                  <Ionicons name="checkmark" size={16} color="#FFFFFF" />
                </View>
              )}
              {buttonMode === 'claim' && (
                <TouchableOpacity
                  style={[styles.missionBtn, styles.missionBtnClaim]}
                  onPress={() => handleClaimMission(mission)}
                  disabled={busy}
                >
                  <Text style={styles.missionBtnClaimText}>Claim</Text>
                </TouchableOpacity>
              )}
              {buttonMode === 'go' && (
                <TouchableOpacity style={styles.missionBtn} onPress={() => handleGo(mission.action)}>
                  <Text style={styles.missionBtnText}>Go</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })}

        <Text style={styles.footerNote}>
          Missions reset every day at midnight UTC. Progress auto-tracks for live, gift and watch actions; share completes when you tap the share button on a stream.
        </Text>
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

  heroCard: { borderRadius: 20, padding: 20, marginBottom: 24, borderWidth: 1, borderColor: '#374151' },
  heroTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: 'bold', marginBottom: 4 },
  heroSub: { color: '#9CA3AF', fontSize: 12, marginBottom: 16 },
  calendarScroll: { flexDirection: 'row', marginBottom: 16 },
  dayCard: { width: 70, height: 90, backgroundColor: '#0E111E', borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginRight: 12, borderWidth: 1, borderColor: '#374151', padding: 8 },
  dayCardToday: { borderColor: '#00E5FF', borderWidth: 2, backgroundColor: 'rgba(0, 229, 255, 0.1)' },
  dayCardClaimed: { borderColor: '#1E1A34', opacity: 0.7 },
  dayText: { color: '#FFFFFF', fontSize: 12, fontWeight: 'bold' },
  rewardText: { color: '#00E5FF', fontSize: 14, fontWeight: 'bold' },
  checkOverlay: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.6)', width: '100%', height: '100%', borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  claimAllBtn: { backgroundColor: '#00E5FF', paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
  claimAllText: { color: '#1E1B4B', fontWeight: 'bold', fontSize: 16 },

  sectionTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold', marginBottom: 16 },
  mutedNote: { color: '#6B7280', fontSize: 12, fontStyle: 'italic', marginBottom: 12 },

  missionCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#1E1A34', padding: 16, borderRadius: 12, marginBottom: 12 },
  missionInfo: { flex: 1, marginRight: 12 },
  missionTitle: { color: '#FFFFFF', fontSize: 15, fontWeight: '600', marginBottom: 8 },

  progressTrack: { height: 5, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 2.5, marginBottom: 4, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: '#00E5FF', borderRadius: 2.5 },
  progressLabel: { color: '#9CA3AF', fontSize: 11, marginBottom: 8 },

  rewardPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0, 229, 255, 0.1)', alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 },
  rewardPillText: { color: '#00E5FF', fontSize: 12, fontWeight: 'bold', marginLeft: 4 },
  // Bean variant — amber/yellow palette so the host earner-currency
  // reads visually distinct from the diamond-denominated viewer pills.
  rewardPillBean: { backgroundColor: 'rgba(251, 191, 36, 0.12)' },
  rewardPillTextBean: { color: '#FBBF24' },

  missionBtn: { backgroundColor: '#00E5FF', paddingVertical: 8, paddingHorizontal: 20, borderRadius: 20, alignItems: 'center', justifyContent: 'center', minWidth: 70 },
  missionBtnClaim: { backgroundColor: '#FBBF24' },
  missionBtnClaimText: { color: '#1E1B4B', fontWeight: 'bold' },
  missionBtnDone: { backgroundColor: '#34D399' },
  missionBtnText: { color: '#1E1B4B', fontWeight: 'bold' },

  footerNote: { color: '#6B7280', fontSize: 11, marginTop: 12, marginBottom: 40, textAlign: 'center', lineHeight: 16 },
});
