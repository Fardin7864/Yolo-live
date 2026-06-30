import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Image, Alert, Modal,
  Linking, useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import LogoLoader from '../../src/components/LogoLoader';
import { supabase } from '../../src/api/supabase';

// Diamond package units (in diamonds). BDT price is derived at render
// time from `systemSettings.sell_diamond_bdt_per_1000` so super admin
// can tune the sale rate platform-wide from the admin panel and every
// app picks it up via the realtime sub on system_settings.
const PACKAGE_UNITS = [10000, 50000, 100000, 500000, 1000000];

// Fallback if system_settings hasn't loaded yet — matches the seed in
// migration 76 (11 BDT per 1000 diamonds = 1100 BDT per 1 lakh).
const SELL_RATE_FALLBACK = 11;

export default function WalletScreen() {
  const router = useRouter();
  const { diamonds, user, createTopupRequest, createAgencyTopupRequest, systemSettings } = useGlobalState();

  const sellRate = (() => {
    const raw = systemSettings?.sell_diamond_bdt_per_1000;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : SELL_RATE_FALLBACK;
  })();
  const PACKAGES = PACKAGE_UNITS.map((amount, idx) => ({
    id:     idx + 1,
    amount,
    bdt:    Math.round((amount / 1000) * sellRate),
  }));

  // Responsive modal heights — proportional to screen so the source list
  // and history list don't crop on short phones (<= 600px height) or
  // waste space on tall ones. Old code used fixed 280/400 px which cut
  // off rows on budget Androids.
  const { height: screenH } = useWindowDimensions();
  const sourceListMaxH  = Math.round(screenH * 0.42);
  const historyListMaxH = Math.round(screenH * 0.55);

  const [sourceTab, setSourceTab] = useState('resellers'); // 'resellers' | 'agencies'
  const [resellers, setResellers] = useState([]);
  const [agencies, setAgencies] = useState([]);
  const [loadingSources, setLoadingSources] = useState(true);
  const [sourcesError, setSourcesError] = useState(null); // null | string
  const [showSourceModal, setShowSourceModal] = useState(false);
  const [selectedPkg, setSelectedPkg] = useState(null);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [recentRequests, setRecentRequests] = useState([]);

  useEffect(() => {
    loadSources();
    if (user?.id) loadRecentRequests();
  }, [user?.id]);

  // Realtime — user sees their own topup request flip from pending to
  // confirmed / cancelled the moment the reseller or admin acts on it.
  // Scoped to the user's own rows.
  useEffect(() => {
    if (!user?.id) return;
    const ch = supabase
      .channel(`wallet-topups-${user.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'topup_requests', filter: `user_id=eq.${user.id}` },
        () => loadRecentRequests()
      )
      .subscribe();
    return () => { try { supabase.removeChannel(ch); } catch (_) {} };
  }, [user?.id]);

  async function loadSources() {
    setLoadingSources(true);
    setSourcesError(null);
    const [resRes, agRes] = await Promise.all([
      supabase
        .from('resellers')
        .select('*')
        .neq('status', 'inactive')
        .order('priority', { ascending: false }),
      supabase
        .from('agencies')
        .select('id, name, code, status, diamond_balance, owner_id, profiles:owner_id(full_name, avatar_url)')
        .eq('status', 'verified')
        .order('diamond_balance', { ascending: false }),
    ]);

    // We treat the two queries independently — if resellers loads but
    // agencies fails (or vice versa), the user still sees a partial
    // list rather than an empty modal. Only when BOTH fail do we
    // surface a top-of-modal error banner so the user knows to retry.
    if (resRes.data) setResellers(resRes.data); else setResellers([]);
    if (agRes.data)  setAgencies(agRes.data);  else setAgencies([]);
    if (resRes.error && agRes.error) {
      const msg = resRes.error.message || agRes.error.message || 'Network error';
      console.warn('wallet loadSources:', msg);
      setSourcesError(msg);
    } else if (resRes.error) {
      console.warn('wallet resellers load:', resRes.error.message);
    } else if (agRes.error) {
      console.warn('wallet agencies load:', agRes.error.message);
    }
    setLoadingSources(false);
  }

  async function loadRecentRequests() {
    const { data } = await supabase
      .from('topup_requests')
      .select('*, resellers(name), agencies(name)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10);
    if (data) setRecentRequests(data);
  }

  const handlePurchase = (pkg) => {
    setSelectedPkg(pkg);
    setShowSourceModal(true);
  };

  const handleContactSource = async (source, kind) => {
    if (!selectedPkg) return;

    // Sanity guard against negative / zero / NaN package amounts.
    // The server-side RPC also rejects these, but stopping them here
    // means we don't open a WhatsApp thread or write a topup row for
    // an obviously bogus request — e.g. a tampered package selector
    // that handed us amount=-10000.
    const amount = Number(selectedPkg.amount);
    const bdt    = Number(selectedPkg.bdt);
    if (!Number.isFinite(amount) || amount <= 0 ||
        !Number.isFinite(bdt)    || bdt    <= 0) {
      Alert.alert('Invalid amount', 'This package has an invalid amount. Please pick another.');
      return;
    }

    // Determine which source — agency or reseller — and build request
    let requestId = null;
    let contactLink = '';
    let sourceName = '';

    if (kind === 'reseller') {
      requestId = await createTopupRequest(source.id, selectedPkg.amount, selectedPkg.bdt);
      contactLink = source.contact_link;
      sourceName = source.name;
    } else {
      // For an agency, resolve the owner's contact link in this order:
      //   1. The agency owner's phone_number on profiles (works for
      //      every promoted owner, no reseller row required).
      //   2. The matching `resellers.contact_link` if the owner also
      //      operates as a reseller (legacy path).
      // If neither yields anything we still show a clean "Request Sent"
      // alert instead of dropping the user on a blank WhatsApp button.
      requestId = await createAgencyTopupRequest(source.id, selectedPkg.amount, selectedPkg.bdt);

      const { data: ownerProfile } = await supabase
        .from('profiles')
        .select('phone_number, full_name')
        .eq('id', source.owner_id)
        .maybeSingle();

      let resolved = '';
      if (ownerProfile?.phone_number) {
        resolved = String(ownerProfile.phone_number).trim();
      }
      if (!resolved) {
        const { data: agencyContact } = await supabase
          .from('resellers')
          .select('contact_link')
          .eq('user_id', source.owner_id)
          .maybeSingle();
        resolved = agencyContact?.contact_link || '';
      }
      contactLink = resolved;
      sourceName = source.name;
    }

    if (!requestId) return;

    if (contactLink) {
      // User-facing message — only the 202xxx display_id makes sense
      // here. The reseller's `reseller_direct_transfer` RPC takes a
      // BIGINT display_id; pasting the UUID would make the reseller
      // unable to look the buyer up. If display_id is somehow unset
      // (very old account / hydration race), render "—" so it's
      // obvious the buyer needs to retry rather than the reseller
      // chasing a UUID.
      const myUserId = user?.displayId ? user.displayId : '—';
      const msg = encodeURIComponent(
        `Hello ${sourceName},\n\nI want to buy ${selectedPkg.amount.toLocaleString()} diamonds for ৳${selectedPkg.bdt.toLocaleString()}.\n\nMy User ID: ${myUserId}\nRequest ID: ${requestId.slice(0, 8)}\n\nPlease confirm payment method.`
      );

      // Normalise the link admins/resellers entered. Common shapes we have to
      // tolerate:
      //   "+8801XXXXXXXXX"   -> bare phone, build a wa.me URL
      //   "8801XXXXXXXXX"    -> same
      //   "wa.ma/8801..."    -> known typo (was missing the scheme too)
      //   "https://wa.me/.." -> already fine
      let url = String(contactLink).trim();
      url = url.replace(/\bwa\.ma\b/gi, 'wa.me');           // fix typo
      if (/^\+?\d{6,}$/.test(url)) {
        url = `https://wa.me/${url.replace(/^\+/, '')}`;     // bare number -> wa.me
      } else if (!/^https?:\/\//i.test(url) && /wa\.me|whatsapp\.com/i.test(url)) {
        url = `https://${url}`;                              // scheme-less wa.me -> add https
      }
      if (url.includes('wa.me') || url.includes('whatsapp.com')) {
        url = url.includes('?') ? `${url}&text=${msg}` : `${url}?text=${msg}`;
      }

      try {
        // Don't gate on canOpenURL — on Android 11+ it returns false unless
        // we declare a <queries> intent filter, even when the URL would open
        // fine. openURL itself will throw if there's truly no handler.
        await Linking.openURL(url);
      } catch (err) {
        console.warn('Linking error:', err?.message);
        Alert.alert(
          'Could not open WhatsApp',
          `Please install WhatsApp or contact ${sourceName} manually:\n${contactLink}`
        );
      }
    } else {
      Alert.alert('Request Sent', `Your request has been sent to ${sourceName}. They will contact you to arrange payment.`);
    }

    setShowSourceModal(false);
    loadRecentRequests();
  };

  const statusColor = (s) => ({
    pending: '#F59E0B',
    contacted: '#38BDF8',
    confirmed: '#34D399',
    cancelled: '#EF4444',
  }[s] || '#9CA3AF');

  // ---- Source modal (tabbed) ----
  const renderSourceModal = () => (
    <Modal visible={showSourceModal} transparent animationType="fade" onRequestClose={() => setShowSourceModal(false)}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalBox}>
          {selectedPkg && (
            <>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Purchase Diamonds</Text>
                <TouchableOpacity onPress={() => setShowSourceModal(false)}>
                  <Ionicons name="close" size={24} color="#9CA3AF" />
                </TouchableOpacity>
              </View>

              <View style={styles.selectedPkgSummary}>
                <View style={styles.pkgSummaryLeft}>
                  <Ionicons name="diamond" size={24} color="#00E5FF" />
                  <Text style={styles.pkgSummaryAmount}>{selectedPkg.amount.toLocaleString()}</Text>
                </View>
                <Text style={styles.pkgSummaryPrice}>৳ {selectedPkg.bdt.toLocaleString()}</Text>
              </View>

              {/* Tabs */}
              <View style={styles.tabRow}>
                <TouchableOpacity
                  style={[styles.tabBtn, sourceTab === 'resellers' && styles.tabBtnActive]}
                  onPress={() => setSourceTab('resellers')}
                >
                  <Ionicons name="storefront" size={14} color={sourceTab === 'resellers' ? '#00E5FF' : '#9CA3AF'} />
                  <Text style={[styles.tabText, sourceTab === 'resellers' && styles.tabTextActive]}>
                    Resellers ({resellers.length})
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.tabBtn, sourceTab === 'agencies' && styles.tabBtnActive]}
                  onPress={() => setSourceTab('agencies')}
                >
                  <Ionicons name="shield-checkmark" size={14} color={sourceTab === 'agencies' ? '#00E5FF' : '#9CA3AF'} />
                  <Text style={[styles.tabText, sourceTab === 'agencies' && styles.tabTextActive]}>
                    Agencies ({agencies.length})
                  </Text>
                </TouchableOpacity>
              </View>

              {sourcesError && !loadingSources && (
                // Both queries failed — show a retryable error banner.
                // Partial failures (only one tab failed) still let the
                // other tab work, so we don't block that flow.
                <View style={styles.errorBanner}>
                  <Ionicons name="alert-circle" size={16} color="#FCA5A5" style={{ marginRight: 6 }} />
                  <Text style={styles.errorBannerText} numberOfLines={2}>
                    Couldn't load sources. {sourcesError}
                  </Text>
                  <TouchableOpacity onPress={loadSources} style={styles.errorBannerBtn}>
                    <Text style={styles.errorBannerBtnText}>Retry</Text>
                  </TouchableOpacity>
                </View>
              )}

              {loadingSources ? (
                <LogoLoader size="medium" style={{ marginVertical: 30 }} />
              ) : sourceTab === 'resellers' ? (
                resellers.length === 0 ? (
                  <Text style={styles.emptyText}>No active resellers. Try the Agencies tab.</Text>
                ) : (
                  <ScrollView style={{ maxHeight: sourceListMaxH }}>
                    {resellers.map((rs) => (
                      <View key={rs.id} style={styles.sourceCard}>
                        <Image
                          source={{ uri: rs.avatar_url || `https://i.pravatar.cc/150?u=${rs.id}` }}
                          style={styles.sourceAvatar}
                        />
                        <View style={styles.sourceInfo}>
                          <Text style={styles.sourceName}>{rs.name}</Text>
                          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <View style={[styles.statusDot, { backgroundColor: rs.status === 'active' ? '#34D399' : '#F59E0B' }]} />
                            <Text style={styles.sourceStatus}>
                              {rs.status === 'active' ? 'Online' : 'Busy'} • {rs.type === 'official' ? 'Official' : 'Agency'}
                            </Text>
                          </View>
                        </View>
                        <TouchableOpacity
                          style={[styles.contactBtn, rs.status !== 'active' && { opacity: 0.6 }]}
                          onPress={() => handleContactSource(rs, 'reseller')}
                        >
                          <Ionicons name="logo-whatsapp" size={16} color="#FFF" style={{ marginRight: 4 }} />
                          <Text style={styles.contactBtnText}>Chat</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </ScrollView>
                )
              ) : (
                agencies.length === 0 ? (
                  <Text style={styles.emptyText}>No agencies available right now. Try the Resellers tab.</Text>
                ) : (
                  <ScrollView style={{ maxHeight: sourceListMaxH }}>
                    {agencies.map((a) => {
                      // diamond_balance can be NULL in the DB (newly created
                      // agency before first topup). Treat NULL as 0 so the
                      // "Low Stock" badge correctly applies and we don't
                      // call .toLocaleString() on undefined.
                      const stock      = Number(a.diamond_balance ?? 0);
                      const needAmount = Number(selectedPkg?.amount ?? 0);
                      const lowStock   = stock < needAmount;
                      return (
                        <View key={a.id} style={styles.sourceCard}>
                          <Image
                            source={{ uri: a.profiles?.avatar_url || `https://i.pravatar.cc/150?u=${a.id}` }}
                            style={styles.sourceAvatar}
                          />
                          <View style={styles.sourceInfo}>
                            <Text style={styles.sourceName}>{a.name}</Text>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                              <Ionicons name="diamond" size={10} color="#00E5FF" style={{ marginRight: 4 }} />
                              <Text style={styles.sourceStatus}>
                                {stock.toLocaleString()} in stock
                              </Text>
                            </View>
                            {a.profiles?.full_name && (
                              <Text style={styles.sourceOwner}>Owner: {a.profiles.full_name}</Text>
                            )}
                          </View>
                          <TouchableOpacity
                            style={[styles.contactBtn, lowStock && { opacity: 0.5 }]}
                            disabled={lowStock}
                            onPress={() => handleContactSource(a, 'agency')}
                          >
                            <Ionicons
                              name={lowStock ? 'close-circle' : 'chatbubble'}
                              size={16}
                              color="#FFF"
                              style={{ marginRight: 4 }}
                            />
                            <Text style={styles.contactBtnText}>
                              {lowStock ? 'Low Stock' : 'Request'}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      );
                    })}
                  </ScrollView>
                )
              )}

              <Text style={styles.warning}>
                ⚠ Only use certified sources listed here. Diamonds credit after the seller confirms payment.
              </Text>
            </>
          )}
        </View>
      </View>
    </Modal>
  );

  // ---- History modal ----
  const renderHistoryModal = () => (
    <Modal visible={showHistoryModal} transparent animationType="fade" onRequestClose={() => setShowHistoryModal(false)}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalBox}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>My Recharge History</Text>
            <TouchableOpacity onPress={() => setShowHistoryModal(false)}>
              <Ionicons name="close" size={24} color="#9CA3AF" />
            </TouchableOpacity>
          </View>
          <ScrollView style={{ maxHeight: historyListMaxH }}>
            {recentRequests.length === 0 ? (
              <Text style={styles.emptyText}>No recharge requests yet.</Text>
            ) : (
              recentRequests.map((tx) => (
                <View key={tx.id} style={styles.historyRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.historyAmount}>{tx.package_amount.toLocaleString()} 💎</Text>
                    <Text style={styles.historySub}>
                      ৳{tx.bdt_value.toLocaleString()} • {tx.resellers?.name || tx.agencies?.name || 'Source'}
                    </Text>
                    <Text style={styles.historyDate}>{new Date(tx.created_at).toLocaleString()}</Text>
                  </View>
                  <View style={[styles.statusBadge, { backgroundColor: statusColor(tx.status) + '20', borderColor: statusColor(tx.status) }]}>
                    <Text style={[styles.statusBadgeText, { color: statusColor(tx.status) }]}>
                      {tx.status.toUpperCase()}
                    </Text>
                  </View>
                </View>
              ))
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Wallet</Text>
        <TouchableOpacity onPress={() => setShowHistoryModal(true)}>
          <Ionicons name="time-outline" size={24} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <LinearGradient colors={['#2D1B36', '#1E1A34']} style={styles.balanceCard}>
          <Text style={styles.balanceLabel}>Current Balance</Text>
          <View style={styles.balanceRow}>
            <Ionicons name="diamond" size={40} color="#00E5FF" />
            <Text style={styles.balanceValue}>{diamonds.toLocaleString()}</Text>
          </View>
          <Text style={styles.balanceSub}>≈ ৳ {Math.round((diamonds / 1000) * sellRate).toLocaleString()}</Text>
        </LinearGradient>

        <Text style={styles.sectionTitle}>Top-up Diamonds</Text>

        <View style={styles.packageGrid}>
          {PACKAGES.map((pkg) => (
            <TouchableOpacity key={pkg.id} style={styles.packageCard} onPress={() => handlePurchase(pkg)}>
              <View style={styles.pkgTop}>
                <Ionicons name="diamond" size={24} color="#00E5FF" />
                <Text style={styles.pkgAmount}>{pkg.amount.toLocaleString()}</Text>
              </View>
              <View style={styles.pkgBottom}>
                <Text style={styles.pkgPrice}>৳ {pkg.bdt.toLocaleString()}</Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.infoBox}>
          <Ionicons name="information-circle" size={20} color="#FCD34D" style={{ marginRight: 8 }} />
          <Text style={styles.infoText}>
            Buy diamonds from a <Text style={{ fontWeight: 'bold' }}>Reseller</Text> or directly from a verified <Text style={{ fontWeight: 'bold' }}>Agency</Text>. Diamonds are credited after payment is confirmed.
          </Text>
        </View>
      </ScrollView>

      {renderSourceModal()}
      {renderHistoryModal()}
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

  balanceCard: { borderRadius: 20, padding: 24, alignItems: 'center', marginBottom: 24, borderWidth: 1, borderColor: '#374151' },
  balanceLabel: { color: '#9CA3AF', fontSize: 14, marginBottom: 12 },
  balanceRow: { flexDirection: 'row', alignItems: 'center' },
  balanceValue: { color: '#FFFFFF', fontSize: 40, fontWeight: '900', marginLeft: 12 },
  balanceSub: { color: '#9CA3AF', fontSize: 12, marginTop: 8 },

  sectionTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold', marginBottom: 16 },
  packageGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  packageCard: { width: '48%', backgroundColor: '#1E1A34', borderRadius: 16, marginBottom: 16, overflow: 'hidden', borderWidth: 1, borderColor: '#374151' },
  pkgTop: { padding: 16, alignItems: 'center', justifyContent: 'center', flexDirection: 'row' },
  pkgAmount: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold', marginLeft: 8 },
  pkgBottom: { backgroundColor: 'rgba(0, 229, 255, 0.1)', paddingVertical: 8, alignItems: 'center' },
  pkgPrice: { color: '#00E5FF', fontWeight: 'bold', fontSize: 14 },

  infoBox: {
    flexDirection: 'row', alignItems: 'flex-start',
    backgroundColor: 'rgba(252, 211, 77, 0.08)', borderColor: 'rgba(252, 211, 77, 0.3)', borderWidth: 1,
    padding: 12, borderRadius: 12, marginTop: 8,
  },
  infoText: { flex: 1, color: '#D4D4D8', fontSize: 12, lineHeight: 18 },

  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', alignItems: 'center' },
  modalBox: {
    backgroundColor: '#1E1A34', width: '90%', borderRadius: 24, padding: 20,
    borderWidth: 1, borderColor: 'rgba(0, 229, 255, 0.2)',
  },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  modalTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },

  selectedPkgSummary: {
    backgroundColor: 'rgba(0, 229, 255, 0.1)', flexDirection: 'row',
    justifyContent: 'space-between', alignItems: 'center',
    padding: 14, borderRadius: 12, marginBottom: 16,
  },
  pkgSummaryLeft: { flexDirection: 'row', alignItems: 'center' },
  pkgSummaryAmount: { color: '#00E5FF', fontSize: 16, fontWeight: 'bold', marginLeft: 8 },
  pkgSummaryPrice: { color: '#FFFFFF', fontSize: 16, fontWeight: 'bold' },

  tabRow: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: 4, marginBottom: 14 },
  tabBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 8, borderRadius: 8,
  },
  tabBtnActive: { backgroundColor: 'rgba(0, 229, 255, 0.15)' },
  tabText: { color: '#9CA3AF', fontSize: 12, fontWeight: '600', marginLeft: 6 },
  tabTextActive: { color: '#00E5FF' },

  sourceCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.05)', padding: 12, borderRadius: 12, marginBottom: 10 },
  sourceAvatar: { width: 42, height: 42, borderRadius: 21, marginRight: 12 },
  sourceInfo: { flex: 1 },
  sourceName: { color: '#FFFFFF', fontSize: 13, fontWeight: 'bold', marginBottom: 3 },
  sourceStatus: { color: '#9CA3AF', fontSize: 11 },
  sourceOwner: { color: '#6B7280', fontSize: 10, marginTop: 2 },
  statusDot: { width: 7, height: 7, borderRadius: 3.5, marginRight: 5 },
  contactBtn: { backgroundColor: '#25D366', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  contactBtnText: { color: '#FFFFFF', fontWeight: 'bold', fontSize: 11 },
  warning: { color: '#6B7280', fontSize: 10, marginTop: 14, textAlign: 'center', fontStyle: 'italic' },

  emptyText: { color: '#6B7280', textAlign: 'center', marginVertical: 30 },
  errorBanner: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(248, 113, 113, 0.1)',
    borderColor: 'rgba(248, 113, 113, 0.3)', borderWidth: 1,
    borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8,
    marginVertical: 8,
  },
  errorBannerText:    { color: '#FCA5A5', fontSize: 11, flex: 1 },
  errorBannerBtn:     { backgroundColor: '#FCA5A5', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, marginLeft: 6 },
  errorBannerBtnText: { color: '#0F091E', fontSize: 11, fontWeight: '800' },

  historyRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.04)', padding: 12, borderRadius: 12, marginBottom: 10 },
  historyAmount: { color: '#00E5FF', fontWeight: 'bold', fontSize: 15 },
  historySub: { color: '#D4D4D8', fontSize: 12, marginTop: 2 },
  historyDate: { color: '#6B7280', fontSize: 10, marginTop: 4 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1 },
  statusBadgeText: { fontSize: 10, fontWeight: 'bold' },
});