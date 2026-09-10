import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Modal, TextInput, Alert,
  Linking, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import LogoLoader from '../../src/components/LogoLoader';
import { supabase } from '../../src/api/supabase';
import { BRAND } from '../../src/theme/brand';

// Bulk-buy rate fallback (BDT per 1000 diamonds) if system_settings
// hasn't hydrated yet. Matches the seed in migration 76 (10 BDT per
// 1000 = 1000 BDT per 1 lakh).
const BULK_RATE_FALLBACK = 10;

export default function ResellerDashboardScreen() {
  const router = useRouter();
  const { user, myReseller, refreshMyReseller, confirmTopupAsReseller, requestResellerStock, systemSettings } = useGlobalState();

  const [tab, setTab] = useState('requests'); // 'requests' | 'history' | 'stock'
  const [pendingRequests, setPendingRequests] = useState([]);
  const [historyRequests, setHistoryRequests] = useState([]);
  const [stockHistory, setStockHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionId, setActionId] = useState(null);

  // Stock-request modal
  const [showStockModal, setShowStockModal] = useState(false);
  const [stockAmount, setStockAmount] = useState('');
  const [stockBdt, setStockBdt] = useState('');
  const [stockNotes, setStockNotes] = useState('');
  const [submittingStock, setSubmittingStock] = useState(false);

  // Direct-send modal — push diamonds straight to a user by display_id
  const [showDirectModal, setShowDirectModal] = useState(false);
  const [directDisplayId, setDirectDisplayId] = useState('');
  const [directAmount, setDirectAmount] = useState('');
  const [directNotes, setDirectNotes] = useState('');
  const [submittingDirect, setSubmittingDirect] = useState(false);

  // BDT pricing rate — pulled from globalState's systemSettings which
  // already has a realtime subscription, so admin retunes propagate
  // instantly without a page refresh. The local one-off fetch the
  // previous version did has been removed in favour of this.
  const bdtPer1000 = (() => {
    const raw = systemSettings?.bulk_diamond_bdt_per_1000;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : BULK_RATE_FALLBACK;
  })();
  const calcBdt = (amount) => {
    const n = parseInt(String(amount).replace(/[^0-9]/g, ''), 10);
    if (!Number.isFinite(n) || n <= 0) return '';
    return String(Math.round((n / 1000) * bdtPer1000));
  };

  useEffect(() => {
    if (myReseller?.id) loadAll();
  }, [myReseller?.id]);

  useEffect(() => {
    if (!myReseller?.id) return;
    // Coalesce realtime bursts into a single refetch. Without this, an
    // admin batch-confirming 5 requests fires 5 events × 3 queries each
    // = 15 supabase round-trips in <200ms. With the 400ms debounce, the
    // whole burst collapses into one refetch (~3 queries) after the
    // last event lands.
    let timer = null;
    const scheduleReload = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(loadAll, 400);
    };
    const ch = supabase
      .channel(`reseller-${myReseller.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'topup_requests',          filter: `reseller_id=eq.${myReseller.id}` }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reseller_stock_requests', filter: `reseller_id=eq.${myReseller.id}` }, scheduleReload)
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      try { supabase.removeChannel(ch); } catch (_) {}
    };
  }, [myReseller?.id]);

  async function loadAll() {
    if (!myReseller?.id) return;
    setLoading(true);
    const [pendRes, histRes, stockRes] = await Promise.all([
      supabase
        .from('topup_requests')
        .select('*, profiles:user_id(full_name, display_id, phone_number, avatar_url)')
        .eq('reseller_id', myReseller.id)
        .in('status', ['pending', 'contacted'])
        .order('created_at', { ascending: false })
        .limit(30),
      supabase
        .from('topup_requests')
        .select('*, profiles:user_id(full_name, display_id)')
        .eq('reseller_id', myReseller.id)
        .in('status', ['confirmed', 'cancelled'])
        .order('created_at', { ascending: false })
        .limit(30),
      supabase
        .from('reseller_stock_requests')
        .select('*')
        .eq('reseller_id', myReseller.id)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);
    if (pendRes.data) setPendingRequests(pendRes.data);
    if (histRes.data) setHistoryRequests(histRes.data);
    if (stockRes.data) setStockHistory(stockRes.data);
    setLoading(false);
  }

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadAll(), refreshMyReseller()]);
    setRefreshing(false);
  };

  const handleContactUser = (req) => {
    const phone = req.profiles?.phone_number;
    if (!phone) {
      Alert.alert('No contact', 'User did not share a phone number.');
      return;
    }
    const clean = phone.replace(/[^0-9]/g, '');
    const msg = encodeURIComponent(
      `Hi ${req.profiles?.full_name || ''},\n\nRegarding your ${req.package_amount.toLocaleString()} diamond order (৳${Number(req.bdt_value).toLocaleString()})\nReq ID: ${req.id.slice(0, 8)}\n\nPlease confirm payment details.`
    );
    const url = `https://wa.me/${clean}?text=${msg}`;
    Linking.openURL(url).catch(() => Alert.alert('Cannot open', url));
  };

  const handleConfirm = async (req) => {
    if (!myReseller || myReseller.diamond_stock < req.package_amount) {
      Alert.alert(
        'Insufficient stock',
        `You have ${(myReseller?.diamond_stock || 0).toLocaleString()} diamonds. Request needs ${req.package_amount.toLocaleString()}.\n\nRequest more stock from admin first.`
      );
      return;
    }
    Alert.alert(
      'Confirm delivery?',
      `Send ${req.package_amount.toLocaleString()} 💎 to ${req.profiles?.full_name}?\n\nThis deducts from YOUR stock and CANNOT be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          style: 'destructive',
          onPress: async () => {
            setActionId(req.id);
            const ok = await confirmTopupAsReseller(req.id);
            setActionId(null);
            if (ok) {
              Alert.alert('Delivered', `${req.package_amount.toLocaleString()} 💎 sent.`);
              loadAll();
            }
          },
        },
      ]
    );
  };

  const handleCancel = async (req) => {
    Alert.alert(
      'Cancel request?',
      'The user will see this as cancelled. Use only if payment did not come through.',
      [
        { text: 'Back', style: 'cancel' },
        {
          text: 'Cancel Request',
          style: 'destructive',
          onPress: async () => {
            setActionId(req.id);
            // Use the RPC instead of a raw UPDATE — topup_requests has no
            // UPDATE policy for resellers, so the old call silently no-op'd.
            // The RPC checks "you own this row" and changes status atomically.
            const { data, error } = await supabase.rpc('cancel_topup_request', {
              p_request_id: req.id,
            });
            setActionId(null);
            if (error || !data?.success) {
              Alert.alert('Failed', data?.message || error?.message || 'Try again.');
              return;
            }
            loadAll();
          },
        },
      ]
    );
  };

  const handleSubmitDirect = async () => {
    const displayId = parseInt(directDisplayId.replace(/[^0-9]/g, ''), 10);
    const amount    = parseInt(directAmount.replace(/[^0-9]/g, ''), 10);
    if (!displayId) { Alert.alert('Invalid ID', 'Enter the recipient ID.'); return; }
    if (!amount || amount < 1) { Alert.alert('Invalid amount', 'Amount must be at least 1 diamond.'); return; }
    if (amount > (myReseller?.diamond_stock || 0)) {
      Alert.alert('Insufficient stock', `You have ${(myReseller?.diamond_stock || 0).toLocaleString()} 💎 in stock.`);
      return;
    }

    setSubmittingDirect(true);
    const { data, error } = await supabase.rpc('reseller_direct_transfer', {
      p_user_display_id: displayId,
      p_amount:          amount,
      p_notes:           directNotes.trim() || null,
    });
    setSubmittingDirect(false);

    const ok = !error && data?.success;
    if (!ok) {
      Alert.alert('Transfer failed', data?.message || error?.message || 'Try again.');
      return;
    }
    setShowDirectModal(false);
    setDirectDisplayId(''); setDirectAmount(''); setDirectNotes('');
    Alert.alert(
      'Transfer complete',
      `${amount.toLocaleString()} 💎 sent to ${data.recipient_name || 'user'}. Stock left: ${Number(data.remaining_stock).toLocaleString()}.`
    );
    refreshMyReseller?.();
    loadAll();
  };

  const handleSubmitStock = async () => {
    const amount = parseInt(stockAmount.replace(/[^0-9]/g, ''), 10);
    const bdt = parseFloat(stockBdt) || null;
    if (!amount || amount < 1000) {
      Alert.alert('Invalid', 'Minimum 1,000 diamonds per request.');
      return;
    }
    setSubmittingStock(true);
    const id = await requestResellerStock(amount, bdt, stockNotes.trim());
    setSubmittingStock(false);
    if (id) {
      Alert.alert('Requested', 'Super admin will contact you for payment & fulfill the stock.');
      setStockAmount(''); setStockBdt(''); setStockNotes('');
      setShowStockModal(false);
      loadAll();
    }
  };

  if (!myReseller) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Reseller Dashboard</Text>
          <View style={{ width: 28 }} />
        </View>
        <View style={styles.emptyState}>
          <Ionicons name="storefront-outline" size={64} color="#374151" />
          <Text style={styles.emptyTitle}>You are not an active reseller</Text>
          <Text style={styles.emptySub}>Apply from Settings → Become a Reseller.</Text>
          <TouchableOpacity style={styles.applyBtn} onPress={() => router.push('/main/apply/reseller')}>
            <Text style={styles.applyBtnText}>Apply Now</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const statusColor = (s) => ({
    pending: '#F59E0B',
    contacted: '#38BDF8',
    confirmed: '#34D399',
    cancelled: '#EF4444',
    fulfilled: '#34D399',
  }[s] || '#9CA3AF');

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Reseller Dashboard</Text>
        <TouchableOpacity onPress={onRefresh}>
          <Ionicons name="refresh" size={22} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#00E5FF" />}
      >
        {/* Stock card */}
        <LinearGradient colors={['#1E1B4B', '#2D1B36']} style={styles.stockCard}>
          <View>
            <Text style={styles.stockLabel}>My Stock</Text>
            <View style={styles.stockRow}>
              <Ionicons name="diamond" size={32} color="#00E5FF" />
              <Text style={styles.stockValue}>{(myReseller.diamond_stock || 0).toLocaleString()}</Text>
            </View>
            <Text style={styles.stockSub}>
              Sold all-time: {(myReseller.total_sold || 0).toLocaleString()} 💎
            </Text>
          </View>
          <View style={{ flexDirection: 'column', gap: 8 }}>
            <TouchableOpacity style={styles.requestStockBtn} onPress={() => setShowStockModal(true)}>
              <Ionicons name="add-circle" size={18} color="#FFF" style={{ marginRight: 6 }} />
              <Text style={styles.requestStockBtnText}>Buy Bulk</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.directSendBtn} onPress={() => setShowDirectModal(true)}>
              <Ionicons name="paper-plane" size={16} color="#FFF" style={{ marginRight: 6 }} />
              <Text style={styles.requestStockBtnText}>Send</Text>
            </TouchableOpacity>
          </View>
        </LinearGradient>

        {/* Status badge */}
        <View style={[styles.statusPill, { borderColor: statusColor(myReseller.status) + '60' }]}>
          <View style={[styles.statusDot, { backgroundColor: statusColor(myReseller.status) }]} />
          <Text style={[styles.statusPillText, { color: statusColor(myReseller.status) }]}>
            {myReseller.name} • {myReseller.status.toUpperCase()}
          </Text>
        </View>

        {/* Tabs */}
        <View style={styles.tabRow}>
          {[
            { id: 'requests', label: 'Pending', count: pendingRequests.length },
            { id: 'history',  label: 'History', count: historyRequests.length },
            { id: 'stock',    label: 'Stock',   count: stockHistory.length },
          ].map((t) => (
            <TouchableOpacity
              key={t.id}
              style={[styles.tabBtn, tab === t.id && styles.tabBtnActive]}
              onPress={() => setTab(t.id)}
            >
              <Text style={[styles.tabText, tab === t.id && styles.tabTextActive]}>
                {t.label} {t.count > 0 && `(${t.count})`}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Tab content */}
        {loading ? (
          <LogoLoader size="medium" style={{ marginVertical: 30 }} />
        ) : tab === 'requests' ? (
          pendingRequests.length === 0 ? (
            <Text style={styles.empty}>No pending requests right now.</Text>
          ) : (
            pendingRequests.map((req) => (
              <View key={req.id} style={styles.reqCard}>
                <View style={styles.reqHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.reqUser}>{req.profiles?.full_name || 'User'}</Text>
                    <Text style={styles.reqMeta}>
                      ID: {req.profiles?.display_id || '—'} • {new Date(req.created_at).toLocaleString()}
                    </Text>
                  </View>
                  <View style={[styles.statusBadge, { backgroundColor: statusColor(req.status) + '20', borderColor: statusColor(req.status) }]}>
                    <Text style={[styles.statusBadgeText, { color: statusColor(req.status) }]}>{req.status.toUpperCase()}</Text>
                  </View>
                </View>
                <View style={styles.reqAmountRow}>
                  <View style={styles.reqAmountLeft}>
                    <Ionicons name="diamond" size={20} color="#00E5FF" />
                    <Text style={styles.reqAmount}>{req.package_amount.toLocaleString()}</Text>
                  </View>
                  <Text style={styles.reqBdt}>৳{Number(req.bdt_value).toLocaleString()}</Text>
                </View>
                <View style={styles.reqActions}>
                  <TouchableOpacity style={[styles.reqBtn, styles.reqBtnChat]} onPress={() => handleContactUser(req)}>
                    <Ionicons name="logo-whatsapp" size={14} color="#FFF" style={{ marginRight: 4 }} />
                    <Text style={styles.reqBtnText}>Chat</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.reqBtn, styles.reqBtnConfirm, actionId === req.id && { opacity: 0.6 }]}
                    onPress={() => handleConfirm(req)}
                    disabled={actionId === req.id}
                  >
                    {actionId === req.id ? (
                      <LogoLoader size={32} />
                    ) : (
                      <>
                        <Ionicons name="checkmark-circle" size={14} color="#FFF" style={{ marginRight: 4 }} />
                        <Text style={styles.reqBtnText}>Confirm</Text>
                      </>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.reqBtn, styles.reqBtnCancel]}
                    onPress={() => handleCancel(req)}
                    disabled={actionId === req.id}
                  >
                    <Ionicons name="close-circle" size={14} color="#FFF" />
                  </TouchableOpacity>
                </View>
              </View>
            ))
          )
        ) : tab === 'history' ? (
          historyRequests.length === 0 ? (
            <Text style={styles.empty}>No completed sales yet.</Text>
          ) : (
            historyRequests.map((req) => {
              // Distinguish a direct outbound send (reseller pushes diamonds
              // to a user) from a regular topup request the reseller
              // confirmed. The `source` column is set by migration 73;
              // older rows are tagged retroactively by the same migration's
              // backfill so the badge is accurate going back through
              // history.
              const isDirect = req.source === 'direct';
              const kindLabel = isDirect ? 'SENT' : 'REQUEST';
              const kindColor = isDirect ? '#34D399' : '#38BDF8';
              return (
                <View key={req.id} style={styles.histRow}>
                  <View style={{ flex: 1 }}>
                    <View style={styles.histTitleRow}>
                      <View style={[styles.kindPill, { borderColor: kindColor + '70', backgroundColor: kindColor + '15' }]}>
                        <Ionicons
                          name={isDirect ? 'paper-plane' : 'arrow-down-circle'}
                          size={10}
                          color={kindColor}
                          style={{ marginRight: 3 }}
                        />
                        <Text style={[styles.kindPillText, { color: kindColor }]}>{kindLabel}</Text>
                      </View>
                      <Text style={styles.histUserFlex} numberOfLines={1}>
                        {isDirect ? '→ ' : ''}{req.profiles?.full_name || 'User'}
                      </Text>
                    </View>
                    <Text style={styles.histMeta}>
                      {req.package_amount.toLocaleString()} 💎 • ৳{Number(req.bdt_value).toLocaleString()}
                    </Text>
                    <Text style={styles.histDate}>User ID: {req.profiles?.display_id || '—'} • Request ID: {req.id}</Text>
                    <Text style={styles.histDate}>{new Date(req.created_at).toLocaleString()}</Text>
                    {req.notes && req.notes !== 'Direct send (off-app payment)' && (
                      <Text style={styles.histNote} numberOfLines={1}>"{req.notes}"</Text>
                    )}
                  </View>
                  <View style={[styles.statusBadge, { backgroundColor: statusColor(req.status) + '20', borderColor: statusColor(req.status) }]}>
                    <Text style={[styles.statusBadgeText, { color: statusColor(req.status) }]}>{req.status.toUpperCase()}</Text>
                  </View>
                </View>
              );
            })
          )
        ) : (
          stockHistory.length === 0 ? (
            <Text style={styles.empty}>No stock requests yet. Tap "Buy Bulk" above to request from admin.</Text>
          ) : (
            stockHistory.map((s) => (
              <View key={s.id} style={styles.histRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.histUser}>+{s.diamond_amount.toLocaleString()} 💎</Text>
                  {s.bdt_value && <Text style={styles.histMeta}>Paid ৳{Number(s.bdt_value).toLocaleString()}</Text>}
                  <Text style={styles.histDate}>{new Date(s.created_at).toLocaleString()}</Text>
                  {s.review_notes && <Text style={styles.histNote}>"{s.review_notes}"</Text>}
                </View>
                <View style={[styles.statusBadge, { backgroundColor: statusColor(s.status) + '20', borderColor: statusColor(s.status) }]}>
                  <Text style={[styles.statusBadgeText, { color: statusColor(s.status) }]}>{s.status.toUpperCase()}</Text>
                </View>
              </View>
            ))
          )
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Stock request modal */}
      <Modal visible={showStockModal} transparent animationType="fade" onRequestClose={() => setShowStockModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Request Bulk Stock</Text>
              <TouchableOpacity onPress={() => setShowStockModal(false)}>
                <Ionicons name="close" size={24} color="#9CA3AF" />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalHint}>
              Super admin will receive this request and contact you for payment. Once paid, stock will be credited to your account.
            </Text>

            <View style={styles.field}>
              <Text style={styles.label}>Diamond Amount *</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. 100000"
                placeholderTextColor="#6B7280"
                value={stockAmount}
                onChangeText={(v) => { setStockAmount(v); setStockBdt(calcBdt(v)); }}
                keyboardType="number-pad"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Offered BDT (auto, editable)</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. 10000"
                placeholderTextColor="#6B7280"
                value={stockBdt}
                onChangeText={setStockBdt}
                keyboardType="decimal-pad"
              />
              <Text style={{ color: '#6B7280', fontSize: 11, marginTop: 4 }}>
                Rate: {bdtPer1000.toLocaleString()} BDT per 1,000 💎
              </Text>
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Notes (optional)</Text>
              <TextInput
                style={[styles.input, { height: 80, textAlignVertical: 'top' }]}
                placeholder="Preferred payment method, etc."
                placeholderTextColor="#6B7280"
                value={stockNotes}
                onChangeText={setStockNotes}
                multiline
              />
            </View>

            <TouchableOpacity style={styles.submitBtn} onPress={handleSubmitStock} disabled={submittingStock}>
              <LinearGradient colors={[BRAND.primary, BRAND.primaryAlt]} style={styles.submitGradient}>
                {submittingStock ? <LogoLoader size={32} /> : <Text style={styles.submitText}>Send Request</Text>}
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Direct send to a user by their display ID */}
      <Modal visible={showDirectModal} transparent animationType="fade" onRequestClose={() => setShowDirectModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Send Diamonds</Text>
              <TouchableOpacity onPress={() => setShowDirectModal(false)}>
                <Ionicons name="close" size={24} color="#9CA3AF" />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalHint}>
              Transfer from your stock directly to a user. Stock left: {(myReseller?.diamond_stock || 0).toLocaleString()} 💎
            </Text>

            <View style={styles.field}>
              <Text style={styles.label}>Recipient ID *</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. 202701"
                placeholderTextColor="#6B7280"
                value={directDisplayId}
                onChangeText={setDirectDisplayId}
                keyboardType="number-pad"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Diamond Amount *</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. 5000"
                placeholderTextColor="#6B7280"
                value={directAmount}
                onChangeText={setDirectAmount}
                keyboardType="number-pad"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Notes (optional)</Text>
              <TextInput
                style={[styles.input, { height: 60, textAlignVertical: 'top' }]}
                placeholder="Customer reference, etc."
                placeholderTextColor="#6B7280"
                value={directNotes}
                onChangeText={setDirectNotes}
                multiline
              />
            </View>

            <TouchableOpacity style={styles.submitBtn} onPress={handleSubmitDirect} disabled={submittingDirect}>
              <LinearGradient colors={['#34D399', '#059669']} style={styles.submitGradient}>
                {submittingDirect ? <LogoLoader size={32} /> : <Text style={styles.submitText}>Send Now</Text>}
              </LinearGradient>
            </TouchableOpacity>
          </View>
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

  stockCard: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: 20, borderRadius: 18, marginBottom: 16,
  },
  stockLabel: { color: '#9CA3AF', fontSize: 12, marginBottom: 6 },
  stockRow: { flexDirection: 'row', alignItems: 'center' },
  stockValue: { color: '#FFF', fontSize: 28, fontWeight: '900', marginLeft: 10 },
  stockSub: { color: '#9CA3AF', fontSize: 11, marginTop: 8 },
  requestStockBtn: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10,
  },
  directSendBtn: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(52,211,153,0.25)',
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10,
    borderWidth: 1, borderColor: '#34D399',
  },
  requestStockBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 12 },

  statusPill: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 100, borderWidth: 1, marginBottom: 16,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  statusPillText: { fontSize: 11, fontWeight: 'bold' },

  tabRow: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: 4, marginBottom: 14 },
  tabBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  tabBtnActive: { backgroundColor: 'rgba(0, 229, 255, 0.15)' },
  tabText: { color: '#9CA3AF', fontSize: 12, fontWeight: '600' },
  tabTextActive: { color: '#00E5FF' },

  empty: { color: '#6B7280', textAlign: 'center', marginVertical: 30, fontSize: 13 },

  // Request card
  reqCard: { backgroundColor: '#1E1A34', borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.04)' },
  reqHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 },
  reqUser: { color: '#FFF', fontSize: 14, fontWeight: 'bold' },
  reqMeta: { color: '#9CA3AF', fontSize: 10, marginTop: 2 },
  reqAmountRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'rgba(0, 229, 255, 0.08)', padding: 10, borderRadius: 10, marginBottom: 10 },
  reqAmountLeft: { flexDirection: 'row', alignItems: 'center' },
  reqAmount: { color: '#00E5FF', fontSize: 16, fontWeight: 'bold', marginLeft: 8 },
  reqBdt: { color: '#FFF', fontWeight: 'bold' },
  reqActions: { flexDirection: 'row', gap: 8 },
  reqBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 9, borderRadius: 8 },
  reqBtnChat: { backgroundColor: '#25D366' },
  reqBtnConfirm: { backgroundColor: '#34D399', flex: 1.2 },
  reqBtnCancel: { backgroundColor: '#EF4444', flex: 0.5 },
  reqBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 12 },

  // History
  histRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E1A34', borderRadius: 12, padding: 12, marginBottom: 10 },
  histTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  histUser: { color: '#FFF', fontSize: 13, fontWeight: 'bold' },
  histUserFlex: { color: '#FFF', fontSize: 13, fontWeight: 'bold', flex: 1 },
  histMeta: { color: '#9CA3AF', fontSize: 11, marginTop: 2 },
  histDate: { color: '#6B7280', fontSize: 10, marginTop: 4 },
  histNote: { color: '#9CA3AF', fontSize: 10, fontStyle: 'italic', marginTop: 4 },
  kindPill: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 6, borderWidth: 1, marginRight: 6,
  },
  kindPillText: { fontSize: 8, fontWeight: '800', letterSpacing: 0.5 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1 },
  statusBadgeText: { fontSize: 9, fontWeight: 'bold' },

  // Empty state
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyTitle: { color: '#FFF', fontSize: 18, fontWeight: 'bold', marginTop: 20, textAlign: 'center' },
  emptySub: { color: '#9CA3AF', fontSize: 13, marginTop: 8, textAlign: 'center' },
  applyBtn: { backgroundColor: BRAND.primary, paddingHorizontal: 24, paddingVertical: 14, borderRadius: 12, marginTop: 24 },
  applyBtnText: { color: '#FFF', fontWeight: 'bold' },

  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', alignItems: 'center', padding: 16 },
  modalBox: { backgroundColor: '#1E1A34', width: '100%', borderRadius: 20, padding: 20, borderWidth: 1, borderColor: BRAND.primary20 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  modalTitle: { color: '#FFF', fontSize: 18, fontWeight: 'bold' },
  modalHint: { color: '#9CA3AF', fontSize: 12, marginBottom: 16, lineHeight: 18 },
  field: { marginBottom: 14 },
  label: { color: '#9CA3AF', fontSize: 12, marginBottom: 6, fontWeight: '600' },
  input: {
    backgroundColor: '#0E111E', borderRadius: 10, color: '#FFF',
    paddingHorizontal: 14, height: 48, fontSize: 14,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  submitBtn: { marginTop: 8 },
  submitGradient: { paddingVertical: 14, borderRadius: 12, alignItems: 'center', justifyContent: 'center', height: 50 },
  submitText: { color: '#FFF', fontSize: 15, fontWeight: 'bold' },
});
