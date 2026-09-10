import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, TextInput,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { commonStyles as styles } from '../../src/agency/styles';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import LogoLoader from '../../src/components/LogoLoader';
import { supabase } from '../../src/api/supabase';
import { BRAND } from '../../src/theme/brand';

export default function AgencyHostView() {
  const router = useRouter();
  const { user, myAgency, myReseller, beans, bindToAgency, refreshAgencies } = useGlobalState();
  // Mutual exclusion with the reseller role (migration 74). If the user
  // is already a reseller, bind_to_agency will reject; we surface a
  // banner up front so the join UI isn't a dead-end.
  const isReseller = !!myReseller;

  const [agencyCodeInput, setAgencyCodeInput] = useState('');
  const [topAgencies, setTopAgencies] = useState([]);
  const [myPayouts, setMyPayouts] = useState([]);
  const [bindingStatus, setBindingStatus] = useState(null); // 'active' | null
  const [joinRequest, setJoinRequest] = useState(null);
  const [leaveRequest, setLeaveRequest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchingAgency, setSearchingAgency] = useState(false);

  const loadData = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);

    // 1. Get current binding status
    const { data: memberData } = await supabase
      .from('agency_members')
      .select('status, agency_id')
      .eq('host_id', user.id)
      .eq('status', 'active')
      .order('joined_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    setBindingStatus(memberData?.status || null);

    const { data: requestData } = await supabase
      .from('agency_join_requests')
      .select('id, status, review_note, created_at, agency_id, agencies:agency_id(name)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setJoinRequest(requestData || null);

    const { data: leaveRequestData } = await supabase
      .from('agency_leave_requests')
      .select('id,status,penalty_amount,requested_at,review_note')
      .eq('host_id', user.id)
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setLeaveRequest(leaveRequestData || null);

    // 2. If not bound, show top agencies to join
    if (!memberData) {
      const { data: agencies } = await supabase
        .from('agencies')
        .select('id, name, code, member_count, status, owner_id, owner:profiles!agencies_owner_id_fkey(full_name, avatar_url)')
        .eq('status', 'verified')
        .order('member_count', { ascending: false })
        .limit(20);
      setTopAgencies(agencies || []);
    }

    // 3. Get payout history
    const { data: payouts } = await supabase
      .from('bins_withdrawal_requests')
      .select('*, holder:holder_id(display_id,name)')
      .eq('requester_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20);
    setMyPayouts(payouts || []);

    setLoading(false);
  }, [user?.id]);

  useEffect(() => { loadData(); }, [loadData]);

  const onRefresh = async () => {
    setRefreshing(true);
    await refreshAgencies();
    await loadData();
    setRefreshing(false);
  };

  // -------- Handlers --------
  const handleJoinWithCode = async () => {
    const code = agencyCodeInput.trim().toUpperCase();
    if (!code || searchingAgency) return;
    setSearchingAgency(true);
    const { data: matches, error: searchError } = await supabase.rpc('search_agencies_by_code', {
      p_code: code,
      p_limit: 1,
    });
    const agency = Array.isArray(matches) ? matches[0] : null;
    if (searchError) {
      setSearchingAgency(false);
      Alert.alert('Search failed', searchError.message || 'Please try again.');
      return;
    }
    if (!agency) {
      setSearchingAgency(false);
      Alert.alert('Agency not found', 'Check the agency code and try again.');
      return;
    }
    const { data, error } = await supabase.rpc('submit_agency_join_request', { p_agency_id: agency.agency_id, p_note: null });
    setSearchingAgency(false);
    if (!error && data?.success) {
      setAgencyCodeInput('');
      await loadData();
    } else {
      Alert.alert('Could not apply', data?.message || error?.message || 'Please try again.');
    }
  };

  const handleJoinAgency = async (agency) => {
    Alert.alert('Join Agency', `Send a join request to ${agency.name}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Send Request',
        onPress: async () => {
          const { data, error } = await supabase.rpc('submit_agency_join_request', {
            p_agency_id: agency.id,
            p_note: null,
          });
          if (error || !data?.success) Alert.alert('Could not apply', data?.message || error?.message || 'Please try again.');
          else await loadData();
        },
      },
    ]);
  };

  const handleLeave = () => {
    if (leaveRequest?.status === 'pending') return;
    Alert.alert('Request Agency Leave', 'An admin or your agency owner must approve this request. You will remain in the agency and no diamonds will be deducted while it is pending.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: async () => {
          const { data, error } = await supabase.rpc('leave_agency', { p_host_id: user.id });
          if (error) {
            Alert.alert('Failed', error.message);
            return;
          }
          if (!data?.success) {
            Alert.alert('Failed', data?.message || 'Could not leave');
            return;
          }
          await refreshAgencies();
          await loadData();
          Alert.alert('Requested', 'Your membership remains active while the request waits for admin or agency approval. The 50,000 diamond penalty is charged only after approval.');
        },
      },
    ]);
  };

  // -------- Renderers --------
  if (loading) {
    return (
      <View style={hostStyles.center}>
        <LogoLoader size="medium" />
      </View>
    );
  }

  // PENDING approval state
  if (joinRequest?.status === 'pending' && bindingStatus !== 'active') {
    return (
      <ScrollView
        contentContainerStyle={{ padding: 20 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BRAND.primary} />}
      >
        <View style={hostStyles.pendingBox}>
          <Ionicons name="hourglass" size={48} color="#FCD34D" />
          <Text style={hostStyles.pendingTitle}>Awaiting Approval</Text>
          <Text style={hostStyles.pendingSub}>
            Your request to join {joinRequest?.agencies?.name || 'the agency'} is waiting for dashboard admin approval. Live broadcasting unlocks after approval.
          </Text>
          <TouchableOpacity style={hostStyles.cancelBtn} onPress={async () => {
            const { data, error } = await supabase.rpc('cancel_agency_join_request', { p_request_id: joinRequest.id });
            if (error || !data?.success) Alert.alert('Could not cancel', data?.message || error?.message);
            else await loadData();
          }}>
            <Text style={{ color: '#F43F5E' }}>Cancel Request</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  }

  // SOLO state — not in any agency
  if (!myAgency || bindingStatus !== 'active') {
    return (
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BRAND.primary} />}
      >
        {/* Reseller role conflict (migration 74). The DB rejects the
            bind RPC for resellers, but blocking the join UI up front
            avoids the user typing a code only to see an error toast. */}
        {isReseller ? (
          <View style={hostStyles.guardBox}>
            <Ionicons name="ban" size={32} color="#F43F5E" />
            <Text style={hostStyles.guardTitle}>You are a reseller</Text>
            <Text style={hostStyles.guardSub}>
              An account cannot be both a reseller AND an agency-bound host. To join an agency as a host, your reseller status would need to be deactivated by an admin first.
            </Text>
            <TouchableOpacity
              style={hostStyles.guardCta}
              onPress={() => router.push('/main/reseller-dashboard')}
            >
              <Text style={hostStyles.guardCtaText}>Go to Reseller Dashboard →</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={hostStyles.soloHero}>
              <Ionicons name="shield-checkmark" size={48} color="#FCD34D" />
              <Text style={hostStyles.soloTitle}>Join an Agency</Text>
              <Text style={hostStyles.soloSub}>Get better cash rates and dedicated support from agency owners.</Text>
              {joinRequest?.status === 'rejected' ? (
                <Text style={[hostStyles.soloSub, { color: '#FB7185', marginTop: 8 }]}>Last application was not approved{joinRequest.review_note ? `: ${joinRequest.review_note}` : '.'}</Text>
              ) : null}
            </View>

            <View style={hostStyles.formSection}>
              <TextInput
                style={[styles.textInput, { flex: 1 }]}
                placeholder="Enter Agency Code"
                placeholderTextColor="#6B7280"
                value={agencyCodeInput}
                onChangeText={setAgencyCodeInput}
                autoCapitalize="characters"
              />
              <TouchableOpacity style={[hostStyles.joinBtn, searchingAgency && { opacity: 0.55 }]} onPress={handleJoinWithCode} disabled={searchingAgency}>
                <Text style={{ color: '#000', fontWeight: 'bold' }}>{searchingAgency ? 'Finding…' : 'Join'}</Text>
              </TouchableOpacity>
            </View>

            <Text style={hostStyles.sectionTitle}>Top Agencies</Text>
            {topAgencies.length === 0 ? (
              <Text style={hostStyles.emptyText}>No verified agencies available yet.</Text>
            ) : (
              topAgencies.map((agency) => (
                <View key={agency.id} style={hostStyles.listCard}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: '#FFF', fontWeight: 'bold' }}>{agency.name}</Text>
                    <Text style={{ color: '#9CA3AF', fontSize: 11 }}>
                      Code: {agency.code} • {agency.member_count || 0} hosts
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                    <TouchableOpacity onPress={() => router.push(`/main/chat/${agency.owner_id}?name=${encodeURIComponent(agency.owner?.full_name || agency.name)}`)}>
                      <Text style={{ color: '#C084FC', fontWeight: 'bold' }}>Message</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => handleJoinAgency(agency)}>
                      <Text style={{ color: '#38BDF8', fontWeight: 'bold' }}>Apply</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))
            )}
          </>
        )}
      </ScrollView>
    );
  }

  // BOUND state
  return (
    <ScrollView
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BRAND.primary} />}
    >
      <View style={hostStyles.agencyHeader}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: '#9CA3AF', fontSize: 12 }}>Connected to</Text>
          <Text style={{ color: '#FFF', fontSize: 18, fontWeight: 'bold' }}>{myAgency.name}</Text>
          <Text style={{ color: '#6B7280', fontSize: 11, marginTop: 2 }}>
            Rate: ৳{myAgency.payout_rate} per 100k beans
          </Text>
        </View>
        <TouchableOpacity onPress={handleLeave} disabled={leaveRequest?.status === 'pending'}>
          <Text style={{ color: leaveRequest?.status === 'pending' ? '#FCD34D' : '#F43F5E', fontWeight: 'bold' }}>
            {leaveRequest?.status === 'pending' ? 'Leave Pending' : 'Request Leave'}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={hostStyles.earningsRedirect}>
        <View>
          <Text style={{ color: '#9CA3AF', fontSize: 13 }}>My Earnings</Text>
          <Text style={{ color: '#FFF', fontSize: 20, fontWeight: 'bold' }}>
            {beans.toLocaleString()} Beans
          </Text>
        </View>
        <TouchableOpacity style={hostStyles.goToEarningsBtn} onPress={() => router.push('/main/earnings')}>
          <Text style={hostStyles.goToEarningsText}>Settle Now</Text>
        </TouchableOpacity>
      </View>

      <Text style={hostStyles.sectionTitle}>Payout History</Text>
      {myPayouts.length === 0 ? (
        <Text style={hostStyles.emptyText}>No payout requests yet.</Text>
      ) : (
        myPayouts.map((p) => (
          <View key={p.id} style={styles.txRow}>
            <View style={styles.txIconBox}>
              <Ionicons
                name={p.status === 'paid' ? 'checkmark-circle' : 'hourglass'}
                size={24}
                color={p.status === 'paid' ? '#34D399' : '#F59E0B'}
              />
            </View>
            <View style={styles.txDetails}>
              <Text style={styles.txTitle}>{p.beans_amount.toLocaleString()} beans</Text>
              <Text style={styles.txDate}>{new Date(p.created_at).toLocaleString()}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ color: '#34D399', fontWeight: 'bold' }}>৳{Number(p.bdt_value).toLocaleString()}</Text>
              <Text style={{
                color: p.status === 'paid' ? '#34D399' : '#F59E0B',
                fontSize: 10,
                textTransform: 'uppercase',
                fontWeight: 'bold',
              }}>
                {p.status}
              </Text>
            </View>
          </View>
        ))
      )}
    </ScrollView>
  );
}

const hostStyles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },

  agencyHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: '#1E1A34', padding: 20, borderRadius: 15, marginBottom: 20,
  },
  earningsRedirect: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: 'rgba(252, 211, 77, 0.05)', padding: 20, borderRadius: 16,
    borderWidth: 1, borderColor: 'rgba(252, 211, 77, 0.2)', marginBottom: 25,
  },
  goToEarningsBtn: { backgroundColor: '#FCD34D', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10 },
  goToEarningsText: { color: '#1E1B4B', fontWeight: 'bold', fontSize: 13 },

  sectionTitle: { color: '#FFF', fontSize: 18, fontWeight: 'bold', marginBottom: 15 },

  soloHero: { alignItems: 'center', padding: 30, backgroundColor: '#1E1A34', borderRadius: 20, marginBottom: 20 },
  soloTitle: { color: '#FFF', fontSize: 18, fontWeight: 'bold', marginTop: 15 },
  soloSub: { color: '#9CA3AF', textAlign: 'center', fontSize: 12, marginTop: 5 },

  formSection: { flexDirection: 'row', gap: 10, marginBottom: 25 },
  joinBtn: { backgroundColor: '#00E5FF', paddingHorizontal: 20, borderRadius: 12, justifyContent: 'center' },

  listCard: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 15, backgroundColor: '#1E1A34', borderRadius: 12, marginBottom: 10,
  },
  emptyText: { color: '#6B7280', textAlign: 'center', marginVertical: 20, fontStyle: 'italic' },

  pendingBox: {
    alignItems: 'center', padding: 30, backgroundColor: '#1E1A34',
    borderRadius: 20, borderWidth: 1, borderColor: 'rgba(252, 211, 77, 0.3)',
  },
  pendingTitle: { color: '#FCD34D', fontSize: 20, fontWeight: 'bold', marginTop: 16 },
  pendingSub: { color: '#9CA3AF', textAlign: 'center', fontSize: 13, marginTop: 8, lineHeight: 20 },
  cancelBtn: {
    marginTop: 20, paddingHorizontal: 20, paddingVertical: 10,
    borderWidth: 1, borderColor: '#F43F5E', borderRadius: 8,
  },

  guardBox: {
    alignItems: 'center', padding: 30,
    backgroundColor: 'rgba(244, 63, 94, 0.08)',
    borderRadius: 20, borderWidth: 1, borderColor: 'rgba(244, 63, 94, 0.35)',
    marginBottom: 20,
  },
  guardTitle: { color: '#F43F5E', fontSize: 18, fontWeight: 'bold', marginTop: 14, textAlign: 'center' },
  guardSub: { color: '#D4D4D8', textAlign: 'center', fontSize: 13, marginTop: 10, lineHeight: 20 },
  guardCta: {
    backgroundColor: '#F43F5E', borderRadius: 10,
    paddingHorizontal: 16, paddingVertical: 10, marginTop: 18,
  },
  guardCtaText: { color: '#FFF', fontSize: 13, fontWeight: 'bold' },
});
