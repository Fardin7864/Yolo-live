import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert,
  Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import LogoLoader from '../../src/components/LogoLoader';
import { supabase } from '../../src/api/supabase';

// Host BDT-per-1000-beans fallback if system_settings hasn't loaded
// yet. Matches the seed in migration 76 (9 BDT per 1000 beans = 900
// BDT per 1 lakh). Super admin tunes the live rate from the admin
// panel — clients pick it up via realtime on system_settings.
const HOST_PAYOUT_PER_1K_FALLBACK = 9;
const DEFAULT_CONVERSION_RATE = 0.5; // beans -> diamonds

export default function EarningsScreen() {
  const router = useRouter();
  const { beans, user, myAgency, convertBeansSecurely, requestPayout, systemSettings } = useGlobalState();

  const [showTransferModal, setShowTransferModal] = useState(false);
  const [transferAmount, setTransferAmount] = useState('');
  const [settlementMode, setSettlementMode] = useState('agency'); // 'agency' | 'diamonds'
  const [transferHistory, setTransferHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  // True while a payout / conversion RPC is in flight. Disables the
  // submit button + shows a spinner so the user can't double-tap and
  // submit twice while the network round-trip is still settling.
  const [submitting, setSubmitting]         = useState(false);
  // null when last fetch succeeded; an error message string when it
  // failed so the UI can show a retryable banner instead of an empty
  // "no settlements" state.
  const [historyError, setHistoryError] = useState(null);

  const isInAgency = !!myAgency;
  // Number() coerces strings, then isFinite weeds out NaN/Infinity so
  // the BDT card never shows "NaN" or "Infinity" when realtime data
  // hasn't arrived yet.
  const safeNumber = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  // Payout rate is now PLATFORM-WIDE (set by super admin via
  // system_settings.host_payout_bdt_per_1000) — not per-agency. The
  // agencies.payout_rate column is kept on the table for historical
  // records but no longer drives the live calculation. This keeps the
  // pricing consistent across every agency and lets admin retune
  // without an app update.
  const payoutRatePer1k = safeNumber(systemSettings?.host_payout_bdt_per_1000, HOST_PAYOUT_PER_1K_FALLBACK);
  const conversionRate  = safeNumber(myAgency?.host_conversion_rate, DEFAULT_CONVERSION_RATE);
  const beansSafe       = safeNumber(beans, 0);

  const bdtValue = (beansSafe / 1000) * payoutRatePer1k;
  const usdValue = (bdtValue / 124).toFixed(2);

  // ----- Load history -----
  useEffect(() => {
    if (user?.id) loadHistory();
  }, [user?.id]);

  async function loadHistory() {
    setLoadingHistory(true);
    setHistoryError(null);
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', user.id)
      .in('type', ['agency_payout', 'bean_convert'])
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) {
      console.warn('earnings loadHistory:', error.message);
      setHistoryError(error.message);
      setTransferHistory([]);
    } else {
      setTransferHistory(data || []);
    }
    setLoadingHistory(false);
  }

  // ----- Handle transfer based on mode -----
  const handleTransfer = () => {
    const amount = parseInt(transferAmount, 10);
    if (!amount || amount <= 0) {
      Alert.alert('Error', 'Please enter a valid amount.');
      return;
    }
    if (amount < 100) {
      Alert.alert('Error', 'Minimum 100 beans required.');
      return;
    }
    if (amount > beans) {
      Alert.alert('Error', 'Insufficient beans balance.');
      return;
    }

    let title = 'Confirm';
    let message = '';

    if (settlementMode === 'agency') {
      if (!isInAgency) {
        Alert.alert('No Agency', 'You are not bound to any agency. Join one first.');
        return;
      }
      title = 'Agency Payout';
      const earnTk = (amount / 1000) * payoutRatePer1k;
      message = `Request payout of ${amount.toLocaleString()} beans from ${myAgency.name}?\n\nYou will receive ৳${earnTk.toFixed(0)} after approval.`;
    } else {
      title = 'Convert to Diamonds';
      const dia = Math.floor(amount * conversionRate);
      message = `Exchange ${amount.toLocaleString()} beans for ${dia.toLocaleString()} diamonds?`;
    }

    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Confirm',
        onPress: async () => {
          // Guard against the rare case where the confirm modal is
          // dismissed and reopened mid-RPC. The submitting flag in the
          // outer screen + the disabled button below cover the common
          // path; this is just defence in depth for the alert path.
          if (submitting) return;
          setSubmitting(true);
          let success = false;
          try {
            if (settlementMode === 'agency') {
              const res = await requestPayout(amount);
              success = !!res;
            } else {
              success = await convertBeansSecurely(amount, conversionRate);
            }
          } finally {
            setSubmitting(false);
          }
          if (success) {
            Alert.alert('Success', 'Transaction completed!');
            setShowTransferModal(false);
            setTransferAmount('');
            loadHistory();
          }
        },
      },
    ]);
  };

  const renderHistoryRow = (tx) => {
    const isCredit = tx.amount > 0;
    const isAgency = tx.type === 'agency_payout';
    const icon = isAgency ? 'business' : 'swap-horizontal';
    const label = isAgency ? 'Agency Payout' : tx.currency === 'diamond' ? 'Converted to Diamonds' : 'Beans Used';

    return (
      <View key={tx.id} style={styles.historyRow}>
        <View style={styles.historyIconBox}>
          <Ionicons name={icon} size={22} color={isAgency ? '#38BDF8' : '#FCD34D'} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.historyTarget}>{label}</Text>
          <Text style={styles.historyDate}>{new Date(tx.created_at).toLocaleString()}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[styles.historyAmount, { color: isCredit ? '#34D399' : '#F43F5E' }]}>
            {isCredit ? '+' : ''}{tx.amount.toLocaleString()}
          </Text>
          <Text style={[styles.historyStatus, { color: tx.status === 'completed' ? '#34D399' : '#F59E0B' }]}>
            {tx.status}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Earnings</Text>
        <Ionicons name="receipt-outline" size={24} color="#9CA3AF" style={{ marginRight: 8 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <LinearGradient colors={['#FCD34D', '#F59E0B']} style={styles.heroCard}>
          <Text style={styles.heroLabel}>Total Beans</Text>
          <View style={styles.beanRow}>
            <Ionicons name="sparkles" size={48} color="#1E1B4B" style={{ marginRight: 12 }} />
            <Text style={styles.beanValue}>{beans.toLocaleString()}</Text>
          </View>
          <View style={styles.cashBox}>
            <Text style={styles.cashLabel}>Estimated Cash Value</Text>
            <Text style={styles.cashValue}>${usdValue}</Text>
            <Text style={styles.cashSub}>৳{bdtValue.toFixed(0)} • Rate: ৳{payoutRatePer1k}/1k beans</Text>
          </View>
        </LinearGradient>

        {isInAgency ? (
          <View style={styles.agencyBadge}>
            <Ionicons name="shield-checkmark" size={14} color="#38BDF8" />
            <Text style={styles.agencyBadgeText}>Connected to {myAgency.name}</Text>
          </View>
        ) : (
          <TouchableOpacity style={styles.joinAgencyBox} onPress={() => router.push('/main/agency')}>
            <Ionicons name="warning" size={18} color="#FCD34D" />
            <Text style={styles.joinAgencyText}>Join an agency to get better cash rates →</Text>
          </TouchableOpacity>
        )}

        <View style={styles.settlementHeader}>
          <Text style={styles.sectionTitle}>Settlement Methods</Text>
        </View>

        <View style={styles.methodsGrid}>
          {isInAgency && (
            <TouchableOpacity
              style={[styles.methodCard, settlementMode === 'agency' && styles.methodCardActive]}
              onPress={() => { setSettlementMode('agency'); setShowTransferModal(true); }}
            >
              <View style={[styles.methodIcon, { backgroundColor: 'rgba(56, 189, 248, 0.1)' }]}>
                <Ionicons name="business" size={24} color="#38BDF8" />
              </View>
              <Text style={styles.methodName}>Agency Payout</Text>
              <Text style={styles.methodSub}>BDT Cash</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[styles.methodCard, settlementMode === 'diamonds' && styles.methodCardActive]}
            onPress={() => { setSettlementMode('diamonds'); setShowTransferModal(true); }}
          >
            <View style={[styles.methodIcon, { backgroundColor: 'rgba(0, 229, 255, 0.1)' }]}>
              <Ionicons name="diamond" size={24} color="#00E5FF" />
            </View>
            <Text style={styles.methodName}>Exchange</Text>
            <Text style={styles.methodSub}>Get Diamonds</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.historySection}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recent Settlements</Text>
          </View>

          {loadingHistory ? (
            <Text style={styles.emptyHistory}>Loading…</Text>
          ) : historyError ? (
            // Network / RLS error — show a clear failure + Retry button
            // so the user isn't fooled by "No settlements yet." when the
            // truth is "we don't know, query failed."
            <TouchableOpacity onPress={loadHistory} style={styles.historyErrorRow}>
              <Ionicons name="alert-circle" size={16} color="#FCA5A5" />
              <Text style={styles.historyErrorText}>Couldn't load history — tap to retry.</Text>
            </TouchableOpacity>
          ) : transferHistory.length === 0 ? (
            <Text style={styles.emptyHistory}>No settlements yet.</Text>
          ) : (
            transferHistory.map(renderHistoryRow)
          )}
        </View>
      </ScrollView>

      {/* Transfer Modal */}
      <Modal visible={showTransferModal} transparent animationType="slide" onRequestClose={() => setShowTransferModal(false)}>
        <View style={styles.modalOverlay}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ width: '100%', justifyContent: 'flex-end' }}
          >
            <View style={styles.modalContent}>
              <View style={styles.modalHandle} />
              <Text style={styles.modalTitle}>
                {settlementMode === 'agency' ? 'Agency Payout' : 'Exchange for Diamonds'}
              </Text>

              {settlementMode === 'agency' && myAgency && (
                <View style={styles.agencyInfoBox}>
                  <Ionicons name="business" size={20} color="#38BDF8" />
                  <Text style={styles.agencyInfoText}>Receiver: {myAgency.name}</Text>
                </View>
              )}

              <View style={styles.inputGroup}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                  <Text style={styles.inputLabel}>Amount (Beans)</Text>
                  <TouchableOpacity onPress={() => setTransferAmount(beans.toString())}>
                    <Text style={{ color: '#FCD34D', fontSize: 12, fontWeight: 'bold' }}>
                      Max: {beans.toLocaleString()}
                    </Text>
                  </TouchableOpacity>
                </View>
                <TextInput
                  style={styles.textInput}
                  placeholder="Minimum 100 Beans"
                  placeholderTextColor="#6B7280"
                  value={transferAmount}
                  onChangeText={setTransferAmount}
                  keyboardType="number-pad"
                />
              </View>

              {parseInt(transferAmount, 10) > 0 && (
                <View style={styles.conversionPreview}>
                  <Text style={styles.conversionText}>
                    {settlementMode === 'agency' ? 'You will receive:' : 'You will get:'}
                  </Text>
                  <Text style={styles.conversionValue}>
                    {settlementMode === 'agency'
                      ? `৳${((parseInt(transferAmount, 10) / 1000) * payoutRatePer1k).toLocaleString()}`
                      : `${Math.floor(parseInt(transferAmount, 10) * conversionRate).toLocaleString()} 💎`}
                  </Text>
                </View>
              )}

              <TouchableOpacity
                style={[styles.submitBtn, submitting && { opacity: 0.6 }]}
                onPress={handleTransfer}
                disabled={submitting}
              >
                <LinearGradient colors={['#FCD34D', '#F59E0B']} style={styles.submitGradient}>
                  {submitting ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                      <LogoLoader size={32} />
                      <Text style={[styles.submitText, { marginLeft: 8 }]}>
                        {settlementMode === 'agency' ? 'Submitting…' : 'Converting…'}
                      </Text>
                    </View>
                  ) : (
                    <Text style={styles.submitText}>
                      {settlementMode === 'agency' ? 'Request Payout' : 'Convert Now'}
                    </Text>
                  )}
                </LinearGradient>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalCloseBtn}
                onPress={() => setShowTransferModal(false)}
                disabled={submitting}
              >
                <Text style={styles.modalCloseText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0E111E' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#251B45',
  },
  backBtn: { padding: 4 },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },
  content: { padding: 16 },

  heroCard: { borderRadius: 20, padding: 24, alignItems: 'center', marginBottom: 16 },
  heroLabel: { color: '#1E1B4B', fontSize: 16, fontWeight: 'bold', marginBottom: 12 },
  beanRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 24 },
  beanValue: { color: '#1E1B4B', fontSize: 48, fontWeight: '900' },
  cashBox: {
    backgroundColor: 'rgba(30, 27, 75, 0.1)', paddingVertical: 12, paddingHorizontal: 24,
    borderRadius: 12, alignItems: 'center', width: '100%',
  },
  cashLabel: { color: '#1E1B4B', fontSize: 12, opacity: 0.8 },
  cashValue: { color: '#1E1B4B', fontSize: 28, fontWeight: 'bold', marginTop: 4 },
  cashSub: { color: '#1E1B4B', fontSize: 11, marginTop: 4, fontWeight: '600', opacity: 0.8 },

  agencyBadge: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(56, 189, 248, 0.1)', borderColor: 'rgba(56, 189, 248, 0.3)',
    borderWidth: 1, padding: 10, borderRadius: 12, marginBottom: 16,
  },
  agencyBadgeText: { color: '#38BDF8', fontSize: 12, fontWeight: 'bold', marginLeft: 6 },

  joinAgencyBox: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(252, 211, 77, 0.08)', borderColor: 'rgba(252, 211, 77, 0.3)',
    borderWidth: 1, padding: 12, borderRadius: 12, marginBottom: 16,
  },
  joinAgencyText: { color: '#FCD34D', fontSize: 12, marginLeft: 8, flex: 1 },

  settlementHeader: { marginBottom: 16, marginTop: 8 },
  methodsGrid: { flexDirection: 'row', gap: 12, marginBottom: 32 },
  methodCard: {
    flex: 1, backgroundColor: '#1E1A34', borderRadius: 16, padding: 16,
    alignItems: 'center', borderWidth: 1, borderColor: 'transparent',
  },
  methodCardActive: { borderColor: '#FCD34D', backgroundColor: 'rgba(252, 211, 77, 0.05)' },
  methodIcon: {
    width: 44, height: 44, borderRadius: 12, justifyContent: 'center',
    alignItems: 'center', marginBottom: 8,
  },
  methodName: { color: '#FFFFFF', fontSize: 13, fontWeight: 'bold', textAlign: 'center' },
  methodSub: { color: '#9CA3AF', fontSize: 10, marginTop: 2 },

  agencyInfoBox: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(56, 189, 248, 0.1)', padding: 12, borderRadius: 12, marginBottom: 20,
  },
  agencyInfoText: { color: '#38BDF8', fontSize: 13, marginLeft: 8, fontWeight: '600' },

  conversionPreview: {
    backgroundColor: 'rgba(0, 0, 0, 0.3)', borderRadius: 12, padding: 16,
    alignItems: 'center', marginBottom: 20,
    borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  conversionText: { color: '#9CA3AF', fontSize: 12, marginBottom: 4 },
  conversionValue: { color: '#34D399', fontSize: 24, fontWeight: '900' },

  historySection: { marginBottom: 40 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  sectionTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },
  historyRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.02)', padding: 12, borderRadius: 16, marginBottom: 12,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.03)',
  },
  historyIconBox: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.05)',
    justifyContent: 'center', alignItems: 'center', marginRight: 12,
  },
  historyTarget: { color: '#FFFFFF', fontSize: 15, fontWeight: '600', marginBottom: 4 },
  historyDate: { color: '#6B7280', fontSize: 11 },
  historyAmount: { fontSize: 16, fontWeight: 'bold', marginBottom: 4 },
  historyStatus: { fontSize: 10, fontWeight: '600', textTransform: 'capitalize' },
  emptyHistory: { color: '#6B7280', textAlign: 'center', marginTop: 20, fontStyle: 'italic' },
  historyErrorRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginTop: 16, paddingVertical: 8, paddingHorizontal: 12,
    backgroundColor: 'rgba(248, 113, 113, 0.08)', borderRadius: 10,
    borderWidth: 1, borderColor: 'rgba(248, 113, 113, 0.25)',
  },
  historyErrorText: { color: '#FCA5A5', fontSize: 12, marginLeft: 6 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'flex-end' },
  modalContent: {
    backgroundColor: '#1E1A34', borderTopLeftRadius: 30, borderTopRightRadius: 30,
    padding: 24, paddingBottom: 40, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  modalHandle: {
    width: 40, height: 5, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 3,
    alignSelf: 'center', marginBottom: 20,
  },
  modalTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: 'bold', marginBottom: 24, textAlign: 'center' },
  inputGroup: { marginBottom: 20 },
  inputLabel: { color: '#9CA3AF', fontSize: 14 },
  textInput: {
    backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 12, color: '#FFFFFF',
    paddingHorizontal: 16, height: 56, fontSize: 16,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  submitBtn: { marginTop: 12 },
  submitGradient: { paddingVertical: 16, borderRadius: 16, alignItems: 'center' },
  submitText: { color: '#1E1B4B', fontSize: 16, fontWeight: 'bold' },
  modalCloseBtn: { marginTop: 20, alignItems: 'center' },
  modalCloseText: { color: '#9CA3AF', fontSize: 14 },
});