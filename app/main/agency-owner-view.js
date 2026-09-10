import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Image, FlatList,
  Modal, TextInput, Alert, RefreshControl, Platform, KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { commonStyles as sharedStyles } from '../../src/agency/styles';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import LogoLoader from '../../src/components/LogoLoader';
import { supabase } from '../../src/api/supabase';
import { useResponsive } from '../../src/hooks/useResponsive';
import { useRouter } from 'expo-router';

/* ================================================================
   AGENCY OWNER DASHBOARD — Premium Redesign
   ================================================================
   Business logic is identical to the previous version.
   Only the JSX + StyleSheet is overhauled.
   ================================================================ */

export default function AgencyOwnerView() {
  const router = useRouter();
  const {
    ownedAgency,
    agencyConvertBeans, agencyTransferToHost,
    updateAgencyRate, markPayoutPaid, refreshAgencies,
    requestAgencyStock, confirmTopupAsAgency,
    updateAgencyName, fetchAgencyHostEarnings,
    systemSettings,
  } = useGlobalState();

  const { width, isPhone, isTablet, isLargeTablet, maxContentWidth } = useResponsive();

  const [ownerSubTab, setOwnerSubTab] = useState('hosts');
  const [searchText, setSearchText] = useState('');

  const [hosts, setHosts] = useState([]);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [leaveRequests, setLeaveRequests] = useState([]);
  const [reviewingRequestId, setReviewingRequestId] = useState(null);
  const [reviewingLeaveRequestId, setReviewingLeaveRequestId] = useState(null);
  const [hostEarnings, setHostEarnings] = useState([]);
  // O(1) host-id → earnings lookup. The host card render used to do
  // `hostEarnings.find(...)` for every card; with 100+ hosts and many
  // re-renders that became hot in profiling. The Map is rebuilt only
  // when hostEarnings changes (which is rarely — once per loadAll).
  const earningsById = useMemo(() => {
    const m = new Map();
    for (const e of hostEarnings) if (e?.host_id) m.set(e.host_id, e);
    return m;
  }, [hostEarnings]);
  const [payouts, setPayouts] = useState([]);
  const [topupRequests, setTopupRequests] = useState([]);
  const [stockRequests, setStockRequests] = useState([]);
  const [loadingData, setLoadingData] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reportRows, setReportRows] = useState([]);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportStart, setReportStart] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; });
  const [reportEnd, setReportEnd] = useState(() => new Date().toISOString().slice(0, 10));

  const [showTransferModal, setShowTransferModal] = useState(false);
  const [selectedHost, setSelectedHost] = useState(null);
  const [transferAmount, setTransferAmount] = useState('');
  const [tempRate, setTempRate] = useState(ownedAgency?.payout_rate?.toString() || '1150');

  const [showStockModal, setShowStockModal] = useState(false);
  const [stockAmount, setStockAmount] = useState('');
  const [stockBdt, setStockBdt] = useState('');
  const [stockNotes, setStockNotes] = useState('');

  const [showRenameModal, setShowRenameModal] = useState(false);
  const [newAgencyName, setNewAgencyName] = useState('');

  const [showDirectModal, setShowDirectModal] = useState(false);
  const [directDisplayId, setDirectDisplayId] = useState('');
  const [directAmount, setDirectAmount] = useState('');
  const [directNotes, setDirectNotes] = useState('');
  const [submittingDirect, setSubmittingDirect] = useState(false);

  // Bulk-buy BDT rate sourced from globalState's systemSettings (which
  // has a realtime subscription on system_settings). Admin retuning the
  // rate in the panel propagates here without a re-mount.
  const bdtPer1000 = (() => {
    const raw = systemSettings?.bulk_diamond_bdt_per_1000;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 10;
  })();
  const calcBdt = (amount) => {
    const n = parseInt(String(amount).replace(/[^0-9]/g, ''), 10);
    if (!Number.isFinite(n) || n <= 0) return '';
    return String(Math.round((n / 1000) * bdtPer1000));
  };

  // ──────────────────────────────────────────────
  // HANDLERS — unchanged from original
  // ──────────────────────────────────────────────
  const handleDirectTransfer = async () => {
    const displayId = parseInt(directDisplayId.replace(/[^0-9]/g, ''), 10);
    const amount    = parseInt(directAmount.replace(/[^0-9]/g, ''), 10);
    if (!displayId) { Alert.alert('Invalid ID', 'Enter the recipient ID.'); return; }
    if (!amount || amount < 1) { Alert.alert('Invalid amount', 'Amount must be at least 1 diamond.'); return; }
    if (amount > (ownedAgency?.diamond_balance || 0)) {
      Alert.alert('Insufficient stock', `You have ${(ownedAgency?.diamond_balance || 0).toLocaleString()} 💎 in stock.`);
      return;
    }
    setSubmittingDirect(true);
    const { data, error } = await supabase.rpc('agency_direct_transfer', {
      p_user_display_id: displayId,
      p_amount:          amount,
      p_notes:           directNotes.trim() || null,
    });
    setSubmittingDirect(false);
    if (error || !data?.success) {
      Alert.alert('Transfer failed', data?.message || error?.message || 'Try again.');
      return;
    }
    setShowDirectModal(false);
    setDirectDisplayId(''); setDirectAmount(''); setDirectNotes('');
    Alert.alert(
      'Transfer complete',
      `${amount.toLocaleString()} 💎 sent to ${data.recipient_name || 'user'}. Stock left: ${Number(data.remaining_stock).toLocaleString()}.`
    );
    refreshAgencies?.();
  };

  const loadAll = useCallback(async () => {
    if (!ownedAgency?.id) return;
    setLoadingData(true);
    const [hostsRes, pendingRes, leaveRes, payoutsRes, topupsRes, stockRes, earningsRes] = await Promise.all([
      supabase.from('agency_members').select('host_id, joined_at, profiles:host_id(id, full_name, avatar_url, display_id, beans, last_seen_at)').eq('agency_id', ownedAgency.id).eq('status', 'active'),
      supabase.from('agency_join_requests')
        .select('id,user_id,agency_id,status,applicant_note,created_at,user:profiles!agency_join_requests_user_id_fkey(id,full_name,avatar_url,display_id)')
        .eq('agency_id', ownedAgency.id)
        .eq('status', 'pending')
        .order('created_at', { ascending: false }),
      supabase.from('agency_leave_requests')
        .select('id,host_id,agency_id,status,penalty_amount,requested_at,host:profiles!agency_leave_requests_host_id_fkey(id,full_name,avatar_url,display_id,diamonds)')
        .eq('agency_id', ownedAgency.id)
        .eq('status', 'pending')
        .order('requested_at', { ascending: false }),
      supabase.from('agency_payouts').select('*, profiles:host_id(full_name, display_id)').eq('agency_id', ownedAgency.id).order('created_at', { ascending: false }).limit(50),
      supabase.from('topup_requests').select('*, user:profiles!topup_requests_user_id_fkey(full_name, display_id, phone_number)').eq('agency_id', ownedAgency.id).order('created_at', { ascending: false }).limit(50),
      supabase.from('agency_stock_requests').select('*').eq('agency_id', ownedAgency.id).order('created_at', { ascending: false }).limit(20),
      fetchAgencyHostEarnings(ownedAgency.id),
    ]);
    if (hostsRes.data) setHosts(hostsRes.data);
    if (pendingRes.data) setPendingRequests(pendingRes.data);
    if (leaveRes.data) setLeaveRequests(leaveRes.data);
    if (payoutsRes.data) setPayouts(payoutsRes.data);
    if (topupsRes.data) setTopupRequests(topupsRes.data);
    if (stockRes.data) setStockRequests(stockRes.data);
    setHostEarnings(earningsRes || []);
    setLoadingData(false);
  }, [ownedAgency?.id, fetchAgencyHostEarnings]);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    if (!ownedAgency?.id) return;
    const ch = supabase
      .channel(`agency-owner-${ownedAgency.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'topup_requests', filter: `agency_id=eq.${ownedAgency.id}` }, () => loadAll())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agency_stock_requests', filter: `agency_id=eq.${ownedAgency.id}` }, () => loadAll())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agency_members', filter: `agency_id=eq.${ownedAgency.id}` }, () => loadAll())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agency_join_requests', filter: `agency_id=eq.${ownedAgency.id}` }, () => loadAll())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agency_leave_requests', filter: `agency_id=eq.${ownedAgency.id}` }, () => loadAll())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [ownedAgency?.id, loadAll]);

  useEffect(() => {
    setTempRate(ownedAgency?.payout_rate?.toString() || '1150');
  }, [ownedAgency?.payout_rate]);

  const onRefresh = async () => {
    setRefreshing(true);
    await refreshAgencies();
    await loadAll();
    if (ownerSubTab === 'reports') await loadHostReport();
    setRefreshing(false);
  };

  const loadHostReport = async (start = reportStart, end = reportEnd) => {
    if (!ownedAgency?.id || !start || !end) return;
    setReportLoading(true);
    const endExclusive = new Date(`${end}T00:00:00+06:00`);
    endExclusive.setDate(endExclusive.getDate() + 1);
    const { data, error } = await supabase.rpc('agency_host_period_report', {
      p_agency_id: ownedAgency.id,
      p_start: new Date(`${start}T00:00:00+06:00`).toISOString(),
      p_end: endExclusive.toISOString(),
    });
    if (error) Alert.alert('Report failed', error.message);
    setReportRows(data || []);
    setReportLoading(false);
  };

  const useReportPreset = (previous = false) => {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() - (previous ? 1 : 0), 1);
    const last = previous ? new Date(now.getFullYear(), now.getMonth(), 0) : now;
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const start = fmt(first); const end = fmt(last);
    setReportStart(start); setReportEnd(end); loadHostReport(start, end);
  };

  useEffect(() => { if (ownerSubTab === 'reports') loadHostReport(); }, [ownerSubTab, ownedAgency?.id]);

  const handleConvertBeans = () => {
    if (!ownedAgency || ownedAgency.accumulated_beans < 100000) {
      Alert.alert('Error', 'Minimum 100,000 beans required.'); return;
    }
    const beans = 100000;
    const rate = Number(ownedAgency.host_conversion_rate || 0.5);
    Alert.alert('Convert Beans', `Convert ${beans.toLocaleString()} beans to ${Math.floor(beans * rate).toLocaleString()} diamonds?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Convert', onPress: async () => { await agencyConvertBeans(beans); } },
    ]);
  };

  const handleRateUpdate = async () => {
    const newRate = parseInt(tempRate, 10);
    if (!newRate || newRate < 100) { Alert.alert('Error', 'Invalid rate. Must be at least 100.'); return; }
    const ok = await updateAgencyRate(newRate);
    if (ok) Alert.alert('Updated', `Payout rate set to ৳${newRate} per 100k beans.`);
  };

  const handleTransfer = async () => {
    const amount = parseInt(transferAmount, 10);
    if (!amount || amount <= 0) { Alert.alert('Error', 'Invalid amount.'); return; }
    const ok = await agencyTransferToHost(selectedHost.profiles.id, amount);
    if (ok) {
      Alert.alert('Success', `${amount.toLocaleString()} diamonds sent to ${selectedHost.profiles.full_name}.`);
      setShowTransferModal(false); setTransferAmount('');
    }
  };

  const reviewJoinRequest = async (request, approve) => {
    setReviewingRequestId(request.id);
    const { data, error } = await supabase.rpc('owner_review_agency_request', {
      p_request_id: request.id,
      p_approve: approve,
      p_review_note: null,
    });
    setReviewingRequestId(null);
    if (error || !data?.success) {
      Alert.alert('Request failed', data?.message || error?.message || 'Please try again.');
      return;
    }
    Alert.alert(approve ? 'Accepted' : 'Rejected', approve
      ? `${request.user?.full_name || 'The user'} is now a host in your agency.`
      : 'The agency request was rejected.');
    await refreshAgencies?.();
    await loadAll();
  };

  const reviewLeaveRequest = async (request, approve) => {
    setReviewingLeaveRequestId(request.id);
    const { data, error } = await supabase.rpc(
      approve ? 'approve_leave_request' : 'reject_leave_request',
      { p_host_id: request.host_id, p_review_note: null },
    );
    setReviewingLeaveRequestId(null);
    if (error || !data?.success) {
      Alert.alert('Request failed', data?.message || error?.message || 'Please try again.');
      return;
    }
    Alert.alert(approve ? 'Leave approved' : 'Leave rejected', approve
      ? `${request.host?.full_name || 'The host'} has been released from your agency.`
      : `${request.host?.full_name || 'The host'} remains active in your agency.`);
    await refreshAgencies?.();
    await loadAll();
  };

  const confirmJoinReview = (request, approve) => {
    Alert.alert(
      approve ? 'Accept host?' : 'Reject request?',
      approve
        ? `${request.user?.full_name || 'This user'} will become an active host in your agency.`
        : `${request.user?.full_name || 'This user'} will be notified that the request was rejected.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: approve ? 'Accept' : 'Reject', style: approve ? 'default' : 'destructive', onPress: () => reviewJoinRequest(request, approve) },
      ]
    );
  };

  const confirmLeaveReview = (request, approve) => {
    Alert.alert(
      approve ? 'Approve leave?' : 'Reject leave?',
      approve
        ? `${request.host?.full_name || 'This host'} will leave your agency and the 50,000 diamond penalty will be charged.`
        : `${request.host?.full_name || 'This host'} will stay active in your agency.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: approve ? 'Approve' : 'Reject', style: approve ? 'destructive' : 'default', onPress: () => reviewLeaveRequest(request, approve) },
      ]
    );
  };

  const handleRename = async () => {
    if (newAgencyName.trim().length < 3) { Alert.alert('Too short', 'Name must be at least 3 characters.'); return; }
    const ok = await updateAgencyName(newAgencyName.trim());
    if (ok) { Alert.alert('Renamed', 'Agency name updated.'); setShowRenameModal(false); setNewAgencyName(''); }
  };

  const handleMarkPaid = async (payoutId) => {
    Alert.alert('Confirm', 'Mark this payout as paid?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Mark Paid', onPress: async () => { const ok = await markPayoutPaid(payoutId); if (ok) { Alert.alert('Marked Paid'); await loadAll(); } } },
    ]);
  };

  const handleConfirmTopup = async (req) => {
    if (ownedAgency.diamond_balance < req.package_amount) {
      Alert.alert('Insufficient Stock', `Need ${req.package_amount.toLocaleString()} 💎, have ${ownedAgency.diamond_balance.toLocaleString()}.`);
      return;
    }
    Alert.alert('Confirm Payment', `Confirm ${req.package_amount.toLocaleString()} 💎 to ${req.user?.full_name}?\nMake sure you received ৳${Number(req.bdt_value).toLocaleString()}.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Confirm', onPress: async () => { const ok = await confirmTopupAsAgency(req.id); if (ok) { Alert.alert('Confirmed'); await loadAll(); } } },
    ]);
  };

  const handleDeclineTopup = async (req) => {
    Alert.alert(
      'Decline this request?',
      `${req.user?.full_name} will see it as cancelled. Use only if payment did not come through.`,
      [
        { text: 'Back', style: 'cancel' },
        {
          text: 'Decline',
          style: 'destructive',
          onPress: async () => {
            // Goes through cancel_topup_request RPC — the agency owner is
            // authorised because the RPC checks owner_id against agency_id.
            const { data, error } = await supabase.rpc('cancel_topup_request', {
              p_request_id: req.id,
            });
            if (error || !data?.success) {
              Alert.alert('Failed', data?.message || error?.message || 'Try again.');
              return;
            }
            await loadAll();
          },
        },
      ]
    );
  };

  const handleRequestStock = async () => {
    const amount = parseInt(stockAmount, 10);
    if (!amount || amount <= 0) { Alert.alert('Error', 'Invalid diamond amount.'); return; }
    const bdt = stockBdt ? parseFloat(stockBdt) : null;
    const id = await requestAgencyStock(amount, bdt, stockNotes);
    if (id) {
      Alert.alert('Submitted', 'Stock request sent to super admin.');
      setShowStockModal(false); setStockAmount(''); setStockBdt(''); setStockNotes('');
      await loadAll();
    }
  };

  const filteredHosts = hosts.filter((m) => {
    const name = m.profiles?.full_name || '';
    const id = m.profiles?.display_id?.toString() || '';
    return name.toLowerCase().includes(searchText.toLowerCase()) || id.includes(searchText);
  });

  const pendingTopups = topupRequests.filter((r) => r.status === 'pending' || r.status === 'contacted');

  // ──────────────────────────────────────────────
  // EARNINGS DATA — unchanged computation
  // ──────────────────────────────────────────────
  const earningsData = (() => {
    const confirmed = topupRequests.filter((r) => r.status === 'confirmed');
    const totalSoldBdt = confirmed.reduce((s, r) => s + Number(r.bdt_value || 0), 0);
    const totalSoldDiamonds = confirmed.reduce((s, r) => s + (r.package_amount || 0), 0);
    const paidPayouts = payouts.filter((p) => p.status === 'paid');
    const pendingPayouts = payouts.filter((p) => p.status === 'pending');
    const totalPaidBdt = paidPayouts.reduce((s, p) => s + Number(p.bdt_value || 0), 0);
    const totalPendingBdt = pendingPayouts.reduce((s, p) => s + Number(p.bdt_value || 0), 0);
    const fulfilledStock = stockRequests.filter((r) => r.status === 'fulfilled');
    const totalStockCostBdt = fulfilledStock.reduce((s, r) => s + Number(r.bdt_value || 0), 0);
    const grossProfit = totalSoldBdt - totalStockCostBdt - totalPaidBdt;
    return { totalSoldBdt, totalSoldDiamonds, totalPaidBdt, totalPendingBdt, totalStockCostBdt, grossProfit, confirmedCount: confirmed.length, paidCount: paidPayouts.length };
  })();

  // ──────────────────────────────────────────────
  // HELPERS
  // ──────────────────────────────────────────────
  const statusColor = (s) => ({
    pending: '#F59E0B', contacted: '#38BDF8', fulfilled: '#34D399', cancelled: '#EF4444', paid: '#34D399',
  }[s] || '#9CA3AF');

  const TABS = [
    { key: 'hosts',     label: 'Hosts',     icon: 'people-outline' },
    { key: 'inventory', label: 'Inventory', icon: 'layers-outline' },
    { key: 'earnings',  label: 'Earnings',  icon: 'trending-up-outline' },
    { key: 'reports',   label: 'Host Report', icon: 'calendar-outline' },
    { key: 'topups',    label: 'Topups',    icon: 'card-outline' },
    { key: 'requests',  label: 'Members',   icon: 'git-pull-request-outline' },
  ];

  const tabBadge = (key) => {
    if (key === 'topups') return pendingTopups.length;
    if (key === 'requests') return pendingRequests.length + leaveRequests.length;
    return 0;
  };

  // Responsive card width for grid layouts
  const cardPadding = 16;
  const earnTileWidth = isPhone ? (width - cardPadding * 2 - 10) / 2 : (Math.min(width, maxContentWidth) - cardPadding * 2 - 20) / (isLargeTablet ? 4 : 2);

  // ════════════════════════════════════════════════
  //  RENDER — HOSTS TAB
  // ════════════════════════════════════════════════
  const renderHosts = () => (
    <View style={{ flex: 1, paddingHorizontal: cardPadding }}>
      {/* Search Bar */}
      <View style={s.searchBar}>
        <View style={s.searchIconWrap}>
          <Ionicons name="search" size={16} color="#9CA3AF" />
        </View>
        <TextInput
          placeholder="Search host by name or ID..."
          placeholderTextColor="#6B728080"
          style={s.searchInput}
          value={searchText}
          onChangeText={setSearchText}
        />
        {searchText.length > 0 && (
          <TouchableOpacity onPress={() => setSearchText('')} style={{ padding: 6 }}>
            <Ionicons name="close-circle" size={18} color="#6B7280" />
          </TouchableOpacity>
        )}
      </View>

      {loadingData ? (
        <LogoLoader size="medium" style={{ marginTop: 30 }} />
      ) : (
        <FlatList
          data={filteredHosts}
          keyExtractor={(item) => item.host_id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#A78BFA" />}
          contentContainerStyle={{ paddingBottom: 30 }}
          ListEmptyComponent={<Text style={s.emptyText}>No hosts yet. Share your agency code to invite!</Text>}
          numColumns={isTablet || isLargeTablet ? 2 : 1}
          key={isPhone ? 'phone' : 'tablet'}
          columnWrapperStyle={!isPhone ? { gap: 10 } : undefined}
          renderItem={({ item, index }) => {
            const earn = earningsById.get(item.host_id);
            const currentBdt = Number(earn?.current_bdt || 0);
            const pendingBdt = Number(earn?.pending_bdt || 0);
            const paidBdt    = Number(earn?.paid_bdt || 0);
            return (
              <View style={[s.hostCard, !isPhone && { flex: 1 }]}>
                {/* Rank badge */}
                <View style={s.rankBadge}>
                  <Text style={s.rankText}>{index + 1}</Text>
                </View>

                <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                  <View>
                    <Image
                      source={{ uri: item.profiles?.avatar_url || `https://i.pravatar.cc/150?u=${item.host_id}` }}
                      style={s.hostAvatar}
                    />
                    {/* Online dot */}
                    <View style={s.onlineDot} />
                  </View>

                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={s.hostName} numberOfLines={1}>{item.profiles?.full_name || 'Host'}</Text>
                    <Text style={s.hostId}>ID: {item.profiles?.display_id} • {(item.profiles?.beans || 0).toLocaleString()} beans</Text>

                    {/* Salary chips */}
                    <View style={s.salaryRow}>
                      <View style={[s.salaryChip, { borderColor: 'rgba(52,211,153,0.5)', backgroundColor: 'rgba(52,211,153,0.10)' }]}>
                        <Ionicons name="wallet-outline" size={10} color="#34D399" />
                        <Text style={[s.salaryChipText, { color: '#34D399' }]}>৳{currentBdt.toLocaleString()}</Text>
                      </View>
                      {pendingBdt > 0 && (
                        <View style={[s.salaryChip, { borderColor: 'rgba(251,191,36,0.5)', backgroundColor: 'rgba(251,191,36,0.10)' }]}>
                          <Ionicons name="time-outline" size={10} color="#FBBF24" />
                          <Text style={[s.salaryChipText, { color: '#FBBF24' }]}>৳{pendingBdt.toLocaleString()}</Text>
                        </View>
                      )}
                      {paidBdt > 0 && (
                        <View style={[s.salaryChip, { borderColor: 'rgba(148,163,184,0.4)', backgroundColor: 'rgba(148,163,184,0.08)' }]}>
                          <Ionicons name="checkmark-done-outline" size={10} color="#94A3B8" />
                          <Text style={[s.salaryChipText, { color: '#94A3B8' }]}>৳{paidBdt.toLocaleString()}</Text>
                        </View>
                      )}
                    </View>
                  </View>
                </View>

                {/* Actions */}
                <View style={s.hostActions}>
                  <TouchableOpacity
                    style={s.sendDiamondBtn}
                    onPress={() => { setSelectedHost(item); setShowTransferModal(true); }}
                  >
                    <LinearGradient colors={['#A78BFA', '#7C3AED']} style={s.sendDiamondGrad}>
                      <Text style={s.sendDiamondText}>Send 💎</Text>
                    </LinearGradient>
                  </TouchableOpacity>
                </View>
              </View>
            );
          }}
        />
      )}
    </View>
  );

  // ════════════════════════════════════════════════
  //  RENDER — INVENTORY TAB
  // ════════════════════════════════════════════════
  const renderInventory = () => (
    <ScrollView
      contentContainerStyle={{ padding: cardPadding, paddingBottom: 40, maxWidth: maxContentWidth, alignSelf: 'center', width: '100%' }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#A78BFA" />}
    >
      <TouchableOpacity onPress={() => router.push('/main/earnings')} style={{ backgroundColor: '#6D28D9', borderRadius: 14, padding: 14, marginBottom: 14, flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
        <Ionicons name="wallet-outline" size={18} color="#FFF" />
        <Text style={{ color: '#FFF', fontWeight: '900' }}>Withdraw My Own Bins</Text>
      </TouchableOpacity>
      {/* Inventory Cards */}
      <View style={[s.invRow, !isPhone && { flexDirection: 'row', gap: 12 }]}>
        {/* Beans Card */}
        <LinearGradient colors={['#1E1B4B', '#312E81', '#1E1B4B']} style={[s.invCard, !isPhone && { flex: 1 }]}>
          <View style={[s.invIconCircle, { backgroundColor: 'rgba(251,191,36,0.15)' }]}>
            <Ionicons name="leaf-outline" size={22} color="#FCD34D" />
          </View>
          <Text style={s.invLabel}>Accumulated Beans</Text>
          <Text style={[s.invValue, { color: '#FCD34D' }]}>{(ownedAgency?.accumulated_beans || 0).toLocaleString()}</Text>
          <TouchableOpacity onPress={handleConvertBeans} activeOpacity={0.8}>
            <LinearGradient colors={['#F59E0B', '#D97706']} style={s.invActionBtn}>
              <Ionicons name="swap-horizontal-outline" size={14} color="#FFF" />
              <Text style={s.invActionText}>Convert 100k → 💎</Text>
            </LinearGradient>
          </TouchableOpacity>
        </LinearGradient>

        {/* Diamond Stock Card */}
        <LinearGradient colors={['#0C4A6E', '#164E63', '#0C4A6E']} style={[s.invCard, !isPhone && { flex: 1 }]}>
          <View style={[s.invIconCircle, { backgroundColor: 'rgba(0,229,255,0.15)' }]}>
            <Ionicons name="diamond-outline" size={22} color="#00E5FF" />
          </View>
          <Text style={s.invLabel}>Diamond Stock</Text>
          <Text style={[s.invValue, { color: '#00E5FF' }]}>{(ownedAgency?.diamond_balance || 0).toLocaleString()}</Text>
          <TouchableOpacity onPress={() => setShowStockModal(true)} activeOpacity={0.8}>
            <LinearGradient colors={['#0891B2', '#0E7490']} style={s.invActionBtn}>
              <Ionicons name="add-circle-outline" size={14} color="#FFF" />
              <Text style={s.invActionText}>Buy Bulk Stock</Text>
            </LinearGradient>
          </TouchableOpacity>
        </LinearGradient>
      </View>

      {/* Stock Request History */}
      {stockRequests.length > 0 && (
        <View style={s.sectionBlock}>
          <View style={s.sectionHeader}>
            <Ionicons name="time-outline" size={18} color="#A78BFA" />
            <Text style={s.sectionTitle}>Stock Requests</Text>
          </View>
          {stockRequests.slice(0, 5).map((r) => {
            const color = statusColor(r.status);
            return (
              <View key={r.id} style={s.timelineItem}>
                <View style={[s.timelineDot, { backgroundColor: color }]} />
                <View style={s.timelineContent}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={s.timelineValue}>{r.diamond_amount.toLocaleString()} 💎</Text>
                    <View style={[s.statusPill, { borderColor: color, backgroundColor: color + '18' }]}>
                      <Text style={{ color, fontSize: 9, fontWeight: 'bold', textTransform: 'uppercase' }}>{r.status}</Text>
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                    <Text style={s.timelineDate}>{new Date(r.created_at).toLocaleDateString()}</Text>
                    {r.bdt_value && <Text style={{ color: '#34D399', fontSize: 12, fontWeight: '600' }}>৳{Number(r.bdt_value).toLocaleString()}</Text>}
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {/* Payout Rate */}
      <View style={s.glassCard}>
        <View style={s.sectionHeader}>
          <Ionicons name="settings-outline" size={18} color="#FCD34D" />
          <Text style={s.sectionTitle}>Payout Rate</Text>
        </View>
        <Text style={s.helperText}>৳ per 100,000 beans paid to hosts</Text>
        <View style={s.rateRow}>
          <View style={s.rateInputWrap}>
            <Text style={s.rateCurrency}>৳</Text>
            <TextInput
              style={s.rateInput}
              value={tempRate}
              onChangeText={setTempRate}
              keyboardType="numeric"
              placeholder="1150"
              placeholderTextColor="#6B728060"
            />
          </View>
          <TouchableOpacity onPress={handleRateUpdate} activeOpacity={0.8}>
            <LinearGradient colors={['#FCD34D', '#F59E0B']} style={s.rateSaveBtn}>
              <Text style={s.rateSaveBtnText}>Save</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </View>

      {/* Pending Payouts */}
      <View style={s.sectionBlock}>
        <View style={s.sectionHeader}>
          <Ionicons name="hourglass-outline" size={18} color="#F59E0B" />
          <Text style={s.sectionTitle}>Pending Payouts</Text>
        </View>
        {payouts.filter((p) => p.status === 'pending').length === 0 ? (
          <Text style={s.emptyText}>No pending payouts 🎉</Text>
        ) : (
          payouts.filter((p) => p.status === 'pending').map((p) => (
            <View key={p.id} style={s.payoutCard}>
              <View style={s.payoutLeft}>
                <View style={[s.payoutAvatar, { backgroundColor: 'rgba(167,139,250,0.2)' }]}>
                  <Ionicons name="person" size={18} color="#A78BFA" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.payoutName}>{p.profiles?.full_name || 'Host'}</Text>
                  <Text style={s.payoutDate}>{new Date(p.created_at).toLocaleDateString()}</Text>
                </View>
              </View>
              <View style={{ alignItems: 'flex-end', marginRight: 10 }}>
                <Text style={s.payoutBeans}>{p.beans_amount.toLocaleString()} beans</Text>
                <Text style={s.payoutBdt}>৳{Number(p.bdt_value).toLocaleString()}</Text>
              </View>
              <TouchableOpacity onPress={() => handleMarkPaid(p.id)} activeOpacity={0.8}>
                <LinearGradient colors={['#34D399', '#059669']} style={s.markPaidBtn}>
                  <Text style={s.markPaidText}>Pay</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );

  const renderReports = () => (
    <ScrollView contentContainerStyle={{ padding: cardPadding, paddingBottom: 40, maxWidth: maxContentWidth, alignSelf: 'center', width: '100%' }}>
      <Text style={s.sectionTitle}>Host income and video-time report</Text>
      <View style={{ flexDirection: 'row', gap: 8, marginVertical: 12 }}>
        <TouchableOpacity onPress={() => useReportPreset(false)} style={{ flex: 1, padding: 11, borderRadius: 10, backgroundColor: '#2563EB' }}><Text style={{ color: '#FFF', textAlign: 'center', fontWeight: '800' }}>Current Month</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => useReportPreset(true)} style={{ flex: 1, padding: 11, borderRadius: 10, backgroundColor: '#4C1D95' }}><Text style={{ color: '#FFF', textAlign: 'center', fontWeight: '800' }}>Previous Month</Text></TouchableOpacity>
      </View>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <TextInput value={reportStart} onChangeText={setReportStart} placeholder="YYYY-MM-DD" placeholderTextColor="#6B7280" style={{ flex: 1, color: '#FFF', backgroundColor: '#111827', borderRadius: 10, paddingHorizontal: 10, height: 42 }} />
        <TextInput value={reportEnd} onChangeText={setReportEnd} placeholder="YYYY-MM-DD" placeholderTextColor="#6B7280" style={{ flex: 1, color: '#FFF', backgroundColor: '#111827', borderRadius: 10, paddingHorizontal: 10, height: 42 }} />
        <TouchableOpacity onPress={() => loadHostReport()} style={{ padding: 11, borderRadius: 10, backgroundColor: '#059669' }}><Ionicons name="search" size={18} color="#FFF" /></TouchableOpacity>
      </View>
      {reportLoading ? <LogoLoader size="small" /> : reportRows.length === 0 ? <Text style={s.emptyText}>No host activity in this date range.</Text> : reportRows.map((row, index) => (
        <View key={`${row.host_id}-${row.report_day}-${index}`} style={s.payoutCard}>
          <View style={{ flex: 1 }}>
            <Text style={s.payoutName}>{row.host_name || 'Host'} • ID {row.host_display_id || '—'}</Text>
            <Text style={s.payoutDate}>{row.report_day} • {Number(row.live_sessions || 0)} valid day</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={s.payoutBeans}>{Number(row.income || 0).toLocaleString()} bins</Text>
            <Text style={s.payoutBdt}>{Number(row.live_minutes || 0).toLocaleString()} video min</Text>
          </View>
        </View>
      ))}
    </ScrollView>
  );

  // ════════════════════════════════════════════════
  //  RENDER — EARNINGS TAB
  // ════════════════════════════════════════════════
  const renderEarnings = () => (
    <ScrollView
      contentContainerStyle={{ padding: cardPadding, paddingBottom: 40, maxWidth: maxContentWidth, alignSelf: 'center', width: '100%' }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#A78BFA" />}
    >
      {/* Gross Profit Hero */}
      <LinearGradient colors={['#1E1B4B', '#312E81', '#1E1B4B']} style={s.profitHero}>
        <Text style={s.profitLabel}>Gross Profit (Lifetime)</Text>
        <Text style={[s.profitValue, { color: earningsData.grossProfit >= 0 ? '#34D399' : '#F43F5E' }]}>
          ৳ {earningsData.grossProfit.toLocaleString()}
        </Text>
        <View style={s.profitFormula}>
          <Text style={s.profitFormulaText}>Sales − Stock Cost − Host Payouts</Text>
        </View>
      </LinearGradient>

      {/* Stats Grid */}
      <View style={[s.earnGrid, isLargeTablet && { flexWrap: 'nowrap' }]}>
        {[
          { icon: 'cash-outline', color: '#34D399', bg: 'rgba(52,211,153,0.12)', label: 'Diamond Sales', value: `৳ ${earningsData.totalSoldBdt.toLocaleString()}`, sub: `${earningsData.confirmedCount} confirmed` },
          { icon: 'diamond-outline', color: '#00E5FF', bg: 'rgba(0,229,255,0.12)', label: 'Diamonds Sold', value: earningsData.totalSoldDiamonds.toLocaleString(), sub: 'via topup confirms' },
          { icon: 'arrow-up-circle-outline', color: '#F59E0B', bg: 'rgba(245,158,11,0.12)', label: 'Stock Cost', value: `৳ ${earningsData.totalStockCostBdt.toLocaleString()}`, sub: 'paid to admin' },
          { icon: 'arrow-down-circle-outline', color: '#F43F5E', bg: 'rgba(244,63,94,0.12)', label: 'Host Payouts', value: `৳ ${earningsData.totalPaidBdt.toLocaleString()}`, sub: `${earningsData.paidCount} paid` },
        ].map((tile, i) => (
          <View key={i} style={[s.earnTile, { width: earnTileWidth }]}>
            <View style={[s.earnTileIcon, { backgroundColor: tile.bg }]}>
              <Ionicons name={tile.icon} size={20} color={tile.color} />
            </View>
            <Text style={s.earnTileLabel}>{tile.label}</Text>
            <Text style={s.earnTileValue}>{tile.value}</Text>
            <Text style={s.earnTileSub}>{tile.sub}</Text>
          </View>
        ))}
      </View>

      {/* Pending Warning */}
      {earningsData.totalPendingBdt > 0 && (
        <View style={s.warningBanner}>
          <View style={s.warningIcon}>
            <Ionicons name="warning-outline" size={18} color="#FCD34D" />
          </View>
          <Text style={s.warningText}>
            ৳ {earningsData.totalPendingBdt.toLocaleString()} owed to hosts (pending payouts)
          </Text>
        </View>
      )}

      {/* Recent Sales */}
      <View style={s.sectionBlock}>
        <View style={s.sectionHeader}>
          <Ionicons name="receipt-outline" size={18} color="#34D399" />
          <Text style={s.sectionTitle}>Recent Sales</Text>
        </View>
        {topupRequests.filter((r) => r.status === 'confirmed').length === 0 ? (
          <Text style={s.emptyText}>No sales yet.</Text>
        ) : (
          topupRequests.filter((r) => r.status === 'confirmed').slice(0, 10).map((r) => (
            <View key={r.id} style={s.saleRow}>
              <View style={[s.payoutAvatar, { backgroundColor: 'rgba(52,211,153,0.15)' }]}>
                <Ionicons name="person" size={16} color="#34D399" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.saleName}>{r.user?.full_name || 'User'}</Text>
                <Text style={s.saleDate}>{r.package_amount.toLocaleString()} 💎 • {new Date(r.confirmed_at || r.created_at).toLocaleDateString()}</Text>
              </View>
              <Text style={s.saleAmount}>+৳{Number(r.bdt_value).toLocaleString()}</Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );

  // ════════════════════════════════════════════════
  //  RENDER — TOPUPS TAB
  // ════════════════════════════════════════════════
  const renderTopups = () => (
    <ScrollView
      contentContainerStyle={{ padding: cardPadding, paddingBottom: 40, maxWidth: maxContentWidth, alignSelf: 'center', width: '100%' }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#A78BFA" />}
    >
      <View style={s.topupStockChip}>
        <Ionicons name="diamond" size={14} color="#00E5FF" />
        <Text style={s.topupStockText}>Stock: {(ownedAgency?.diamond_balance || 0).toLocaleString()} 💎</Text>
      </View>

      <View style={s.sectionHeader}>
        <Ionicons name="arrow-down-circle-outline" size={18} color="#F59E0B" />
        <Text style={s.sectionTitle}>Incoming Requests</Text>
      </View>
      <Text style={s.helperText}>Confirm only after receiving payment</Text>

      {pendingTopups.length === 0 ? (
        <View style={s.emptyBlock}>
          <Ionicons name="checkmark-done-circle-outline" size={48} color="#374151" />
          <Text style={s.emptyText}>No pending requests</Text>
        </View>
      ) : (
        pendingTopups.map((req) => (
          <View key={req.id} style={s.topupCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
              <View style={[s.payoutAvatar, { backgroundColor: 'rgba(167,139,250,0.15)' }]}>
                <Ionicons name="person" size={16} color="#A78BFA" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.payoutName}>{req.user?.full_name || 'User'}</Text>
                <Text style={s.payoutDate}>ID: {req.user?.display_id} • {req.user?.phone_number}</Text>
              </View>
            </View>
            <View style={s.topupAmountBox}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="diamond" size={18} color="#00E5FF" />
                <Text style={s.topupDiamonds}>{req.package_amount.toLocaleString()}</Text>
              </View>
              <Text style={s.topupBdt}>৳{Number(req.bdt_value).toLocaleString()}</Text>
            </View>
            <Text style={s.topupTime}>{new Date(req.created_at).toLocaleString()}</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
              <TouchableOpacity onPress={() => handleConfirmTopup(req)} activeOpacity={0.8} style={{ flex: 1 }}>
                <LinearGradient colors={['#34D399', '#059669']} style={s.confirmBtn}>
                  <Ionicons name="checkmark-circle" size={16} color="#FFF" />
                  <Text style={s.confirmBtnText}>Confirm</Text>
                </LinearGradient>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => handleDeclineTopup(req)}
                activeOpacity={0.8}
                style={{
                  paddingHorizontal: 14,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: 'rgba(244,63,94,0.5)',
                  backgroundColor: 'rgba(244,63,94,0.08)',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Ionicons name="close-circle-outline" size={16} color="#F43F5E" />
                <Text style={{ color: '#F43F5E', fontWeight: '700', fontSize: 13 }}>Decline</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))
      )}

      {/* Recent Confirmed */}
      <View style={[s.sectionHeader, { marginTop: 24 }]}>
        <Ionicons name="checkmark-done-outline" size={18} color="#34D399" />
        <Text style={s.sectionTitle}>Recent Confirmed</Text>
      </View>
      {topupRequests.filter((r) => r.status === 'confirmed').slice(0, 5).map((req) => (
        <View key={req.id} style={[s.saleRow, { opacity: 0.7 }]}>
          <View style={[s.payoutAvatar, { backgroundColor: 'rgba(52,211,153,0.12)' }]}>
            <Ionicons name="checkmark" size={16} color="#34D399" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.saleName}>{req.user?.full_name}</Text>
            <Text style={s.saleDate}>{new Date(req.confirmed_at || req.created_at).toLocaleDateString()}</Text>
          </View>
          <Text style={s.saleAmount}>৳{Number(req.bdt_value).toLocaleString()}</Text>
        </View>
      ))}
    </ScrollView>
  );

  // ════════════════════════════════════════════════
  //  RENDER — REQUESTS TAB (Join + Leave)
  // ════════════════════════════════════════════════
  const renderRequests = () => (
    <ScrollView
      contentContainerStyle={{ padding: cardPadding, paddingBottom: 40, maxWidth: maxContentWidth, alignSelf: 'center', width: '100%' }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#A78BFA" />}
    >
      {/* ── Join Requests ── */}
      <View style={s.sectionHeader}>
        <View style={[s.sectionIconCircle, { backgroundColor: 'rgba(52,211,153,0.15)' }]}>
          <Ionicons name="log-in-outline" size={16} color="#34D399" />
        </View>
        <Text style={s.sectionTitle}>Join Requests</Text>
        {pendingRequests.length > 0 && (
          <View style={s.countBadge}><Text style={s.countBadgeText}>{pendingRequests.length}</Text></View>
        )}
      </View>

      {pendingRequests.length === 0 ? (
        <Text style={s.emptyText}>No pending join requests.</Text>
      ) : (
        pendingRequests.map((req) => (
          <View key={`join-${req.id}`} style={[s.requestCard, { borderLeftColor: '#34D399' }]}>
            <Image
              source={{ uri: req.user?.avatar_url || `https://i.pravatar.cc/150?u=${req.user_id}` }}
              style={s.reqAvatar}
            />
            <View style={{ flex: 1 }}>
              <Text style={s.reqName}>{req.user?.full_name || 'User'}</Text>
              <Text style={s.reqId}>ID: {req.user?.display_id}</Text>
              <Text style={s.reqId}>{new Date(req.created_at).toLocaleString()}</Text>
              {!!req.applicant_note && <Text style={s.reqId} numberOfLines={2}>{req.applicant_note}</Text>}
            </View>
            <View style={s.ownerRequestActions}>
              <TouchableOpacity
                disabled={reviewingRequestId === req.id}
                onPress={() => confirmJoinReview(req, true)}
                style={[s.ownerReviewAction, s.ownerApproveAction]}
              >
                <Ionicons name="checkmark" size={15} color="#FFF" />
                <Text style={s.ownerReviewActionText}>{reviewingRequestId === req.id ? 'Wait' : 'Accept'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                disabled={reviewingRequestId === req.id}
                onPress={() => confirmJoinReview(req, false)}
                style={[s.ownerReviewAction, s.ownerRejectAction]}
              >
                <Ionicons name="close" size={15} color="#FFF" />
              </TouchableOpacity>
            </View>
          </View>
        ))
      )}

      {/* -- Leave Requests -- */}
      <View style={[s.sectionHeader, { marginTop: 24 }]}>
        <View style={[s.sectionIconCircle, { backgroundColor: 'rgba(244,63,94,0.15)' }]}>
          <Ionicons name="log-out-outline" size={16} color="#F43F5E" />
        </View>
        <Text style={s.sectionTitle}>Leave Requests</Text>
        {leaveRequests.length > 0 && (
          <View style={[s.countBadge, { backgroundColor: '#F43F5E' }]}><Text style={s.countBadgeText}>{leaveRequests.length}</Text></View>
        )}
      </View>

      {leaveRequests.length === 0 ? (
        <Text style={s.emptyText}>No pending leave requests.</Text>
      ) : (
        leaveRequests.map((req) => (
          <View key={`leave-${req.id}`} style={[s.requestCard, { borderLeftColor: '#F43F5E' }]}>
            <Image
              source={{ uri: req.host?.avatar_url || `https://i.pravatar.cc/150?u=${req.host_id}` }}
              style={s.reqAvatar}
            />
            <View style={{ flex: 1 }}>
              <Text style={s.reqName}>{req.host?.full_name || 'Host'}</Text>
              <Text style={s.reqId}>ID: {req.host?.display_id}</Text>
              <Text style={s.reqId}>{new Date(req.requested_at).toLocaleString()}</Text>
              <Text style={[s.reqId, { color: '#FBBF24' }]}>
                Penalty on approval: {Number(req.penalty_amount || 50000).toLocaleString()} diamonds
              </Text>
            </View>
            <View style={s.ownerRequestActions}>
              <TouchableOpacity
                disabled={reviewingLeaveRequestId === req.id}
                onPress={() => confirmLeaveReview(req, true)}
                style={[s.ownerReviewAction, s.ownerRejectAction]}
              >
                <Ionicons name="checkmark" size={15} color="#FFF" />
                <Text style={s.ownerReviewActionText}>{reviewingLeaveRequestId === req.id ? 'Wait' : 'Accept'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                disabled={reviewingLeaveRequestId === req.id}
                onPress={() => confirmLeaveReview(req, false)}
                style={[s.ownerReviewAction, s.ownerApproveAction]}
              >
                <Ionicons name="close" size={15} color="#FFF" />
                <Text style={s.ownerReviewActionText}>Reject</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))
      )}

    </ScrollView>
  );

  // ════════════════════════════════════════════════
  //  MODAL RENDERER — Reusable premium modal wrapper
  // ════════════════════════════════════════════════
  const PremiumModal = ({ visible, onClose, title, subtitle, children }) => (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView 
        style={s.modalOverlay} 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={[s.modalContent, { maxWidth: Math.min(maxContentWidth, 500) }]}>
          <View style={s.modalHandle} />
          <Text style={s.modalTitle}>{title}</Text>
          {subtitle && <Text style={s.modalSubtitle}>{subtitle}</Text>}
          {children}
          <TouchableOpacity onPress={onClose} style={s.modalCancelBtn}>
            <Text style={s.modalCancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );

  // ════════════════════════════════════════════════
  //  MAIN RENDER
  // ════════════════════════════════════════════════
  if (!ownedAgency) {
    return (
      <View style={s.center}>
        <Ionicons name="business-outline" size={48} color="#374151" />
        <Text style={{ color: '#9CA3AF', marginTop: 12 }}>Agency not found.</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#0E111E' }}>
      {/* ═══ HERO HEADER ═══ */}
      <LinearGradient
        colors={['#1E1B4B', '#312E81', '#4C1D95']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[s.hero, { paddingHorizontal: isPhone ? 20 : 32 }]}
      >
        {/* Agency Name + Edit */}
        <View style={s.heroTopRow}>
          <View style={{ flex: 1 }}>
            <Text style={[s.heroTitle, !isPhone && { fontSize: 26 }]}>{ownedAgency.name} 👑</Text>
            <TouchableOpacity style={s.codeChip} activeOpacity={0.7}>
              <Ionicons name="key-outline" size={12} color="rgba(255,255,255,0.6)" />
              <Text style={s.codeChipText}>Code: {ownedAgency.code}</Text>
            </TouchableOpacity>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity
              style={s.heroIconBtn}
              onPress={() => { setNewAgencyName(ownedAgency.name); setShowRenameModal(true); }}
            >
              <Ionicons name="create-outline" size={18} color="#FFF" />
            </TouchableOpacity>
            <TouchableOpacity style={s.heroIconBtn} onPress={() => setShowDirectModal(true)}>
              <Ionicons name="paper-plane-outline" size={18} color="#34D399" />
            </TouchableOpacity>
          </View>
        </View>

        {/* Stats Row */}
        <View style={s.heroStats}>
          {[
            { value: ownedAgency.member_count || hosts.length, label: 'Hosts', icon: 'people', color: '#A78BFA' },
            { value: pendingTopups.length, label: 'Topups', icon: 'card', color: '#FCD34D' },
            { value: (ownedAgency.diamond_balance || 0).toLocaleString(), label: 'Stock 💎', icon: 'diamond', color: '#00E5FF' },
          ].map((stat, i) => (
            <View key={i} style={s.heroStatBox}>
              <View style={[s.heroStatIconCircle, { backgroundColor: stat.color + '20' }]}>
                <Ionicons name={stat.icon} size={16} color={stat.color} />
              </View>
              <Text style={[s.heroStatValue, !isPhone && { fontSize: 20 }]}>{stat.value}</Text>
              <Text style={s.heroStatLabel}>{stat.label}</Text>
            </View>
          ))}
        </View>

        {/* Alert Chips */}
        {(pendingRequests.length > 0 || leaveRequests.length > 0) && (
          <View style={s.alertRow}>
            {pendingRequests.length > 0 && (
              <TouchableOpacity style={[s.alertChip, { backgroundColor: 'rgba(52,211,153,0.20)' }]} onPress={() => setOwnerSubTab('requests')}>
                <View style={[s.alertPulse, { backgroundColor: '#34D399' }]} />
                <Ionicons name="log-in-outline" size={12} color="#FFF" />
                <Text style={s.alertChipText}>{pendingRequests.length} join</Text>
              </TouchableOpacity>
            )}
            {leaveRequests.length > 0 && (
              <TouchableOpacity style={[s.alertChip, { backgroundColor: 'rgba(244,63,94,0.20)' }]} onPress={() => setOwnerSubTab('requests')}>
                <View style={[s.alertPulse, { backgroundColor: '#F43F5E' }]} />
                <Ionicons name="log-out-outline" size={12} color="#FFF" />
                <Text style={s.alertChipText}>{leaveRequests.length} leave</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </LinearGradient>

      {/* ═══ TAB NAVIGATION — Pill Style ═══ */}
      <View style={[s.tabContainer, { maxWidth: maxContentWidth, alignSelf: 'center', width: '100%' }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.tabScroll}>
          {TABS.map((tab) => {
            const active = ownerSubTab === tab.key;
            const badge = tabBadge(tab.key);
            return (
              <TouchableOpacity
                key={tab.key}
                onPress={() => setOwnerSubTab(tab.key)}
                activeOpacity={0.8}
              >
                {active ? (
                  <LinearGradient colors={['#7C3AED', '#A78BFA']} style={s.tabPill}>
                    <Ionicons name={tab.icon} size={14} color="#FFF" />
                    <Text style={s.tabPillTextActive}>{tab.label}</Text>
                    {badge > 0 && <View style={s.tabBadge}><Text style={s.tabBadgeText}>{badge}</Text></View>}
                  </LinearGradient>
                ) : (
                  <View style={s.tabPillInactive}>
                    <Ionicons name={tab.icon} size={14} color="#9CA3AF" />
                    <Text style={s.tabPillText}>{tab.label}</Text>
                    {badge > 0 && <View style={[s.tabBadge, { backgroundColor: '#F43F5E' }]}><Text style={s.tabBadgeText}>{badge}</Text></View>}
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* ═══ TAB CONTENT ═══ */}
      {ownerSubTab === 'hosts'      ? renderHosts()
        : ownerSubTab === 'inventory' ? renderInventory()
        : ownerSubTab === 'earnings'  ? renderEarnings()
        : ownerSubTab === 'reports'   ? renderReports()
        : ownerSubTab === 'topups'    ? renderTopups()
        : renderRequests()}

      {/* ═══ MODALS ═══ */}
      {/* Transfer to Host */}
      <PremiumModal
        visible={showTransferModal}
        onClose={() => setShowTransferModal(false)}
        title={`Send 💎 to ${selectedHost?.profiles?.full_name || ''}`}
        subtitle={`Stock: ${(ownedAgency?.diamond_balance || 0).toLocaleString()} 💎`}
      >
        <TextInput
          style={s.modalInput}
          placeholder="Diamond amount"
          placeholderTextColor="#6B728060"
          keyboardType="numeric"
          value={transferAmount}
          onChangeText={setTransferAmount}
        />
        <TouchableOpacity onPress={handleTransfer} activeOpacity={0.8}>
          <LinearGradient colors={['#A78BFA', '#7C3AED']} style={s.modalSubmitBtn}>
            <Text style={s.modalSubmitText}>Confirm Transfer</Text>
          </LinearGradient>
        </TouchableOpacity>
      </PremiumModal>

      {/* Direct Send by ID */}
      <PremiumModal
        visible={showDirectModal}
        onClose={() => setShowDirectModal(false)}
        title="Send Diamonds by ID"
        subtitle={`Stock: ${(ownedAgency?.diamond_balance || 0).toLocaleString()} 💎`}
      >
        <TextInput style={s.modalInput} placeholder="Recipient ID (e.g. 202701)" placeholderTextColor="#6B728060" keyboardType="number-pad" value={directDisplayId} onChangeText={setDirectDisplayId} />
        <TextInput style={s.modalInput} placeholder="Diamond amount" placeholderTextColor="#6B728060" keyboardType="number-pad" value={directAmount} onChangeText={setDirectAmount} />
        <TextInput style={[s.modalInput, { height: 60, textAlignVertical: 'top' }]} placeholder="Notes (optional)" placeholderTextColor="#6B728060" multiline value={directNotes} onChangeText={setDirectNotes} />
        <TouchableOpacity onPress={handleDirectTransfer} disabled={submittingDirect} activeOpacity={0.8}>
          <LinearGradient colors={['#34D399', '#059669']} style={s.modalSubmitBtn}>
            {submittingDirect ? <LogoLoader size={32} /> : <Text style={s.modalSubmitText}>Send Now</Text>}
          </LinearGradient>
        </TouchableOpacity>
      </PremiumModal>

      {/* Rename Agency */}
      <PremiumModal
        visible={showRenameModal}
        onClose={() => setShowRenameModal(false)}
        title="Rename Agency"
        subtitle={`Code "${ownedAgency?.code}" stays the same`}
      >
        <TextInput style={s.modalInput} placeholder="New agency name" placeholderTextColor="#6B728060" value={newAgencyName} onChangeText={setNewAgencyName} maxLength={40} />
        <TouchableOpacity onPress={handleRename} activeOpacity={0.8}>
          <LinearGradient colors={['#A78BFA', '#7C3AED']} style={s.modalSubmitBtn}>
            <Text style={s.modalSubmitText}>Save</Text>
          </LinearGradient>
        </TouchableOpacity>
      </PremiumModal>

      {/* Stock Request */}
      <PremiumModal
        visible={showStockModal}
        onClose={() => setShowStockModal(false)}
        title="Request Bulk Stock"
        subtitle="Super admin will contact you to confirm payment"
      >
        <TextInput style={s.modalInput} placeholder="Diamond amount (e.g. 1000000)" placeholderTextColor="#6B728060" keyboardType="numeric" value={stockAmount} onChangeText={(v) => { setStockAmount(v); setStockBdt(calcBdt(v)); }} />
        <TextInput style={s.modalInput} placeholder="Proposed BDT (auto, editable)" placeholderTextColor="#6B728060" keyboardType="numeric" value={stockBdt} onChangeText={setStockBdt} />
        <Text style={{ color: '#6B7280', fontSize: 11, marginBottom: 10 }}>Rate: {bdtPer1000.toLocaleString()} BDT per 1,000 💎</Text>
        <TextInput style={[s.modalInput, { height: 70, textAlignVertical: 'top' }]} placeholder="Notes (optional)" placeholderTextColor="#6B728060" value={stockNotes} onChangeText={setStockNotes} multiline />
        <TouchableOpacity onPress={handleRequestStock} activeOpacity={0.8}>
          <LinearGradient colors={['#0891B2', '#0E7490']} style={s.modalSubmitBtn}>
            <Text style={s.modalSubmitText}>Send Request</Text>
          </LinearGradient>
        </TouchableOpacity>
      </PremiumModal>
    </View>
  );
}

/* ════════════════════════════════════════════════════════════════
   STYLES — Premium Glassmorphic Design System
   ════════════════════════════════════════════════════════════════ */
const GLASS = {
  bg: 'rgba(30, 27, 75, 0.50)',
  border: 'rgba(255, 255, 255, 0.08)',
  borderLight: 'rgba(255, 255, 255, 0.12)',
};

const s = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0E111E' },

  // ── Hero ──
  hero: {
    paddingTop: 16,
    paddingBottom: 20,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  heroTitle: {
    color: '#FFF',
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  codeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 6,
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    alignSelf: 'flex-start',
  },
  codeChipText: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 11,
    fontWeight: '600',
  },
  heroIconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.10)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  heroStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
  },
  heroStatBox: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.20)',
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  heroStatIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 6,
  },
  heroStatValue: {
    color: '#FFF',
    fontSize: 18,
    fontWeight: '800',
  },
  heroStatLabel: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 10,
    marginTop: 2,
    fontWeight: '600',
  },
  alertRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginTop: 14,
    flexWrap: 'wrap',
  },
  alertChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(244,63,94,0.20)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  alertPulse: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#F43F5E',
  },
  alertChipText: {
    color: '#FFF',
    fontSize: 11,
    fontWeight: '700',
  },

  // ── Tabs ──
  tabContainer: {
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  tabScroll: {
    gap: 8,
    paddingHorizontal: 4,
  },
  tabPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 24,
  },
  tabPillInactive: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  tabPillText: {
    color: '#9CA3AF',
    fontSize: 12,
    fontWeight: '600',
  },
  tabPillTextActive: {
    color: '#FFF',
    fontSize: 12,
    fontWeight: '700',
  },
  tabBadge: {
    backgroundColor: '#7C3AED',
    width: 18,
    height: 18,
    borderRadius: 9,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 2,
  },
  tabBadgeText: {
    color: '#FFF',
    fontSize: 9,
    fontWeight: 'bold',
  },

  // ── Search ──
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: GLASS.bg,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: GLASS.border,
    paddingHorizontal: 12,
    height: 46,
    marginBottom: 14,
  },
  searchIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(255,255,255,0.05)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  searchInput: {
    flex: 1,
    marginLeft: 10,
    color: '#FFFFFF',
    fontSize: 14,
  },

  // ── Host Card ──
  hostCard: {
    backgroundColor: GLASS.bg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: GLASS.border,
    padding: 14,
    marginBottom: 10,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 8 },
      android: { elevation: 3 },
    }),
  },
  rankBadge: {
    position: 'absolute',
    top: 8,
    right: 10,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(167,139,250,0.20)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  rankText: {
    color: '#A78BFA',
    fontSize: 10,
    fontWeight: '800',
  },
  hostAvatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 2,
    borderColor: 'rgba(167,139,250,0.3)',
  },
  onlineDot: {
    position: 'absolute',
    bottom: 2,
    right: 0,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#34D399',
    borderWidth: 2,
    borderColor: '#0E111E',
  },
  hostName: {
    color: '#FFF',
    fontSize: 15,
    fontWeight: '700',
  },
  hostId: {
    color: '#6B7280',
    fontSize: 11,
    marginTop: 2,
  },
  salaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    marginTop: 6,
  },
  salaryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
  },
  salaryChipText: {
    fontSize: 10,
    fontWeight: '700',
  },
  hostActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    justifyContent: 'flex-end',
  },
  sendDiamondBtn: {
    borderRadius: 10,
    overflow: 'hidden',
  },
  sendDiamondGrad: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
  },
  sendDiamondText: {
    color: '#FFF',
    fontWeight: '700',
    fontSize: 12,
  },
  releaseBtn: {
    padding: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(244,63,94,0.30)',
    backgroundColor: 'rgba(244,63,94,0.08)',
  },

  // ── Glass Card (reusable) ──
  glassCard: {
    backgroundColor: GLASS.bg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: GLASS.border,
    padding: 16,
    marginBottom: 16,
  },

  // ── Inventory ──
  invRow: {
    gap: 12,
    marginBottom: 20,
  },
  invCard: {
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    borderColor: GLASS.borderLight,
    marginBottom: 12,
  },
  invIconCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
  },
  invLabel: {
    color: '#9CA3AF',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  invValue: {
    fontSize: 28,
    fontWeight: '900',
    marginVertical: 6,
  },
  invActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 12,
    marginTop: 8,
  },
  invActionText: {
    color: '#FFF',
    fontSize: 12,
    fontWeight: '700',
  },

  // ── Section Block ──
  sectionBlock: {
    marginBottom: 20,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  sectionIconCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sectionTitle: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
    flex: 1,
  },
  countBadge: {
    backgroundColor: '#7C3AED',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  countBadgeText: {
    color: '#FFF',
    fontSize: 10,
    fontWeight: 'bold',
  },

  // ── Timeline ──
  timelineItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  timelineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 6,
    marginRight: 12,
  },
  timelineContent: {
    flex: 1,
    backgroundColor: GLASS.bg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: GLASS.border,
    padding: 12,
  },
  timelineValue: {
    color: '#FFF',
    fontWeight: '700',
    fontSize: 14,
  },
  timelineDate: {
    color: '#6B7280',
    fontSize: 11,
  },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
  },

  // ── Rate ──
  rateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 10,
  },
  rateInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.30)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#FCD34D40',
    paddingHorizontal: 12,
    flex: 1,
    height: 46,
  },
  rateCurrency: {
    color: '#FCD34D',
    fontSize: 16,
    fontWeight: 'bold',
    marginRight: 6,
  },
  rateInput: {
    flex: 1,
    color: '#FCD34D',
    fontSize: 16,
    fontWeight: '700',
  },
  rateSaveBtn: {
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 12,
  },
  rateSaveBtnText: {
    color: '#1E1B4B',
    fontWeight: '800',
    fontSize: 14,
  },
  helperText: {
    color: '#6B7280',
    fontSize: 12,
    marginBottom: 10,
    fontStyle: 'italic',
  },

  // ── Payout Card ──
  payoutCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: GLASS.bg,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: GLASS.border,
    padding: 12,
    marginBottom: 10,
  },
  payoutLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  payoutAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  payoutName: {
    color: '#FFF',
    fontWeight: '700',
    fontSize: 13,
  },
  payoutDate: {
    color: '#6B7280',
    fontSize: 10,
    marginTop: 2,
  },
  payoutBeans: {
    color: '#FFF',
    fontWeight: '600',
    fontSize: 12,
  },
  payoutBdt: {
    color: '#34D399',
    fontWeight: '700',
    fontSize: 14,
    marginTop: 2,
  },
  markPaidBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
  },
  markPaidText: {
    color: '#FFF',
    fontWeight: '700',
    fontSize: 12,
  },

  // ── Earnings ──
  profitHero: {
    borderRadius: 20,
    padding: 24,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: GLASS.borderLight,
    alignItems: 'center',
  },
  profitLabel: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  profitValue: {
    fontSize: 36,
    fontWeight: '900',
    marginVertical: 8,
  },
  profitFormula: {
    backgroundColor: 'rgba(0,0,0,0.20)',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
    marginTop: 4,
  },
  profitFormulaText: {
    color: 'rgba(255,255,255,0.40)',
    fontSize: 10,
    fontWeight: '500',
  },
  earnGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 16,
  },
  earnTile: {
    backgroundColor: GLASS.bg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: GLASS.border,
    padding: 16,
    marginBottom: 0,
  },
  earnTileIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  earnTileLabel: {
    color: '#9CA3AF',
    fontSize: 11,
    fontWeight: '600',
  },
  earnTileValue: {
    color: '#FFF',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 4,
  },
  earnTileSub: {
    color: '#6B7280',
    fontSize: 10,
    marginTop: 3,
  },
  warningBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(252,211,77,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(252,211,77,0.25)',
    borderRadius: 14,
    padding: 14,
    gap: 10,
    marginBottom: 16,
  },
  warningIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(252,211,77,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  warningText: {
    color: '#FCD34D',
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
  },

  // ── Sale Row ──
  saleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: GLASS.bg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: GLASS.border,
    padding: 12,
    marginBottom: 8,
  },
  saleName: {
    color: '#FFF',
    fontWeight: '600',
    fontSize: 13,
  },
  saleDate: {
    color: '#6B7280',
    fontSize: 10,
    marginTop: 2,
  },
  saleAmount: {
    color: '#34D399',
    fontWeight: '700',
    fontSize: 14,
  },

  // ── Topup ──
  topupStockChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-end',
    backgroundColor: 'rgba(0,229,255,0.10)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(0,229,255,0.25)',
    marginBottom: 14,
  },
  topupStockText: {
    color: '#00E5FF',
    fontSize: 12,
    fontWeight: '700',
  },
  topupCard: {
    backgroundColor: GLASS.bg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: GLASS.border,
    borderLeftWidth: 3,
    borderLeftColor: '#FCD34D',
    padding: 14,
    marginBottom: 12,
  },
  topupAmountBox: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(0,229,255,0.06)',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(0,229,255,0.15)',
  },
  topupDiamonds: {
    color: '#00E5FF',
    fontSize: 18,
    fontWeight: '800',
  },
  topupBdt: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
  },
  topupTime: {
    color: '#6B7280',
    fontSize: 10,
    marginTop: 6,
  },
  confirmBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
  },
  confirmBtnText: {
    color: '#FFF',
    fontWeight: '700',
    fontSize: 14,
  },

  // ── Requests ──
  requestCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: GLASS.bg,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: GLASS.border,
    borderLeftWidth: 3,
    padding: 12,
    marginBottom: 10,
    gap: 10,
  },
  reqAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  reqName: {
    color: '#FFF',
    fontWeight: '700',
    fontSize: 14,
  },
  reqId: {
    color: '#6B7280',
    fontSize: 11,
    marginTop: 2,
  },
  ownerRequestActions: {
    alignItems: 'stretch',
    gap: 6,
  },
  ownerReviewAction: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 9,
  },
  ownerApproveAction: { backgroundColor: '#059669' },
  ownerRejectAction: { backgroundColor: '#BE123C' },
  ownerReviewActionText: {
    color: '#FFF',
    fontSize: 10,
    fontWeight: '800',
  },
  reqApproveBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
  },
  reqBtnText: {
    color: '#FFF',
    fontWeight: '700',
    fontSize: 12,
  },
  reqRejectBtn: {
    padding: 8,
    borderRadius: 10,
    backgroundColor: '#F43F5E',
  },

  // ── Empty ──
  emptyText: {
    color: '#6B7280',
    textAlign: 'center',
    marginVertical: 20,
    fontSize: 13,
    fontStyle: 'italic',
  },
  emptyBlock: {
    alignItems: 'center',
    paddingVertical: 30,
  },

  // ── Modal ──
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.80)',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#1A1540',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 24,
    width: '100%',
    borderWidth: 1,
    borderColor: 'rgba(167,139,250,0.15)',
    borderBottomWidth: 0,
  },
  modalHandle: {
    width: 40,
    height: 5,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 3,
    alignSelf: 'center',
    marginBottom: 18,
  },
  modalTitle: {
    color: '#FFF',
    fontSize: 20,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 6,
  },
  modalSubtitle: {
    color: '#9CA3AF',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 20,
  },
  modalInput: {
    backgroundColor: 'rgba(0,0,0,0.30)',
    borderRadius: 14,
    color: '#FFF',
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    marginBottom: 12,
  },
  modalSubmitBtn: {
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  modalSubmitText: {
    color: '#FFF',
    fontSize: 15,
    fontWeight: '800',
  },
  modalCancelBtn: {
    alignItems: 'center',
    marginTop: 16,
    paddingVertical: 8,
  },
  modalCancelText: {
    color: '#6B7280',
    fontSize: 14,
  },
});
