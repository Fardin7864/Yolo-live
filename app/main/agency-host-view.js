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
  const [bindingStatus, setBindingStatus] = useState(null); // 'active' | 'pending' | null
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);

    // 1. Get current binding status
    const { data: memberData } = await supabase
      .from('agency_members')
      .select('status, agency_id')
      .eq('host_id', user.id)
      .in('status', ['active', 'pending'])
      .order('joined_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    setBindingStatus(memberData?.status || null);

    // 2. If not bound, show top agencies to join
    if (!memberData) {
      const { data: agencies } = await supabase
        .from('agencies')
        .select('id, name, code, member_count, status')
        .eq('status', 'verified')
        .order('member_count', { ascending: false })
        .limit(20);
      setTopAgencies(agencies || []);
    }

    // 3. Get payout history
    const { data: payouts } = await supabase
      .from('agency_payouts')
      .select('*, agencies:agency_id(name)')
      .eq('host_id', user.id)
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
    if (!code) return;
    const ok = await bindToAgency(code);
    if (ok) {
      setAgencyCodeInput('');
      await loadData();
    }
  };

  const handleJoinAgency = async (agency) => {
    Alert.alert('Join Agency', `Send a join request to ${agency.name}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Send Request',
        onPress: async () => {
          const ok = await bindToAgency(agency.code);
          if (ok) await loadData();
        },
      },
    ]);
  };

  const handleLeave = () => {
    Alert.alert('Leave Agency', 'Are you sure you want to leave this agency? Your binding will be released.', [
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
          Alert.alert('Left', 'You have been released from your agency.');
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
  if (bindingStatus === 'pending') {
    return (
      <ScrollView
        contentContainerStyle={{ padding: 20 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BRAND.primary} />}
      >
        <View style={hostStyles.pendingBox}>
          <Ionicons name="hourglass" size={48} color="#FCD34D" />
          <Text style={hostStyles.pendingTitle}>Awaiting Approval</Text>
          <Text style={hostStyles.pendingSub}>
            Your request to join {myAgency?.name || 'the agency'} is pending owner approval. You will be notified once approved.
          </Text>
          <TouchableOpacity style={hostStyles.cancelBtn} onPress={handleLeave}>
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
              <TouchableOpacity style={hostStyles.joinBtn} onPress={handleJoinWithCode}>
                <Text style={{ color: '#000', fontWeight: 'bold' }}>Join</Text>
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
                  <TouchableOpacity onPress={() => handleJoinAgency(agency)}>
                    <Text style={{ color: '#38BDF8', fontWeight: 'bold' }}>Request</Text>
                  </TouchableOpacity>
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
        <TouchableOpacity onPress={handleLeave}>
          <Text style={{ color: '#F43F5E', fontWeight: 'bold' }}>Leave</Text>
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