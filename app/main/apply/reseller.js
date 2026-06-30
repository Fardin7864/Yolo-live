import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput, Alert,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useGlobalState } from '../../../src/context/GlobalStateContext';
import LogoLoader from '../../../src/components/LogoLoader';
import { supabase } from '../../../src/api/supabase';
import { BRAND } from '../../../src/theme/brand';

export default function ApplyResellerScreen() {
  const router = useRouter();
  const { user, applyReseller, myAgency } = useGlobalState();
  // Mutual exclusion with the host-under-agency role (migration 74).
  // If they're already bound, the DB will reject the apply RPC; we show
  // a hard block here so they don't even fill out the form.
  const isAgencyBound = !!myAgency;

  const [businessName, setBusinessName] = useState('');
  const [contactPlatform, setContactPlatform] = useState('whatsapp'); // 'whatsapp' | 'telegram'
  const [contactNumber, setContactNumber] = useState('');
  const [paymentMethods, setPaymentMethods] = useState('');
  const [nidNumber, setNidNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const buildContactLink = () => {
    const digits = contactNumber.replace(/[^0-9]/g, '');
    if (!digits) return '';
    if (contactPlatform === 'whatsapp') return `https://wa.me/${digits}`;
    return `https://t.me/+${digits}`;
  };

  const [latestApp, setLatestApp] = useState(null);
  const [loadingStatus, setLoadingStatus] = useState(true);

  useEffect(() => { loadStatus(); }, [user?.id]);

  // Realtime — when an admin approves / rejects this user's application
  // the screen flips from "pending" to the new state without a manual
  // refresh. Scoped to this user's rows so we don't pull global traffic.
  useEffect(() => {
    if (!user?.id) return;
    const ch = supabase
      .channel(`reseller-app-${user.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'reseller_applications', filter: `user_id=eq.${user.id}` },
        () => loadStatus()
      )
      .subscribe();
    return () => { try { supabase.removeChannel(ch); } catch (_) {} };
  }, [user?.id]);

  async function loadStatus() {
    if (!user?.id) return;
    setLoadingStatus(true);
    const { data } = await supabase
      .from('reseller_applications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setLatestApp(data || null);
    setLoadingStatus(false);
  }

  const handleSubmit = async () => {
    const digits = contactNumber.replace(/[^0-9]/g, '');
    if (!businessName.trim() || !digits) {
      Alert.alert('Required', 'Business name and contact number are required.');
      return;
    }
    if (digits.length < 8) {
      Alert.alert('Invalid Number', 'Please enter a valid phone number with country code (e.g. 8801XXXXXXXXX).');
      return;
    }
    const contactLink = buildContactLink();
    setSubmitting(true);
    const id = await applyReseller({
      businessName: businessName.trim(),
      contactLink,
      paymentMethods: paymentMethods.trim(),
      nidNumber: nidNumber.trim(),
      notes: notes.trim(),
    });
    setSubmitting(false);
    if (id) {
      Alert.alert('Submitted', 'Your reseller application has been received. We will review and respond soon.', [
        { text: 'OK', onPress: () => loadStatus() },
      ]);
      setBusinessName(''); setContactNumber(''); setPaymentMethods(''); setNidNumber(''); setNotes('');
    }
  };

  const renderStatusCard = () => {
    if (!latestApp) return null;
    const statusColor = {
      pending:  '#FCD34D',
      approved: '#34D399',
      rejected: '#F43F5E',
    }[latestApp.status] || '#9CA3AF';

    const statusMsg = {
      pending: 'Your application is under review by our admin team.',
      approved: 'Congratulations! You are now an active reseller. Open the app menu to access reseller tools.',
      rejected: 'Your application was not approved. See note below — you can re-apply.',
    }[latestApp.status];

    return (
      <View style={[styles.statusBox, { borderColor: statusColor + '60', backgroundColor: statusColor + '10' }]}>
        <View style={styles.statusHeader}>
          <Ionicons
            name={latestApp.status === 'approved' ? 'checkmark-circle'
              : latestApp.status === 'rejected' ? 'close-circle'
              : 'hourglass'}
            size={32}
            color={statusColor}
          />
          <View style={{ marginLeft: 12, flex: 1 }}>
            <Text style={[styles.statusTitle, { color: statusColor }]}>
              Status: {latestApp.status.toUpperCase()}
            </Text>
            <Text style={styles.statusSub}>{statusMsg}</Text>
          </View>
        </View>
        {latestApp.review_notes && (
          <View style={styles.reviewBox}>
            <Text style={styles.reviewLabel}>Admin note:</Text>
            <Text style={styles.reviewText}>{latestApp.review_notes}</Text>
          </View>
        )}
        <Text style={styles.statusMeta}>Submitted: {new Date(latestApp.created_at).toLocaleString()}</Text>
      </View>
    );
  };

  const canApply = (!latestApp || latestApp.status === 'rejected') && !isAgencyBound;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Apply as Reseller</Text>
        <View style={{ width: 28 }} />
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <LinearGradient colors={['#1E1B4B', '#2D1B36']} style={styles.heroCard}>
            <Ionicons name="storefront" size={40} color="#FCD34D" />
            <Text style={styles.heroTitle}>Become a Reseller</Text>
            <Text style={styles.heroSub}>
              Sell diamonds to YOLO users and earn commission on every top-up.
            </Text>
          </LinearGradient>

          {loadingStatus ? (
            <LogoLoader size="medium" style={{ marginVertical: 30 }} />
          ) : (
            renderStatusCard()
          )}

          {/* Role-conflict guard. The DB also enforces this (migration 74)
              but blocking the form up-front saves the user the wasted
              effort of filling everything in only to be rejected. */}
          {!loadingStatus && isAgencyBound && (
            <View style={styles.guardBox}>
              <Ionicons name="ban" size={28} color="#F43F5E" />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.guardTitle}>You are an agency host</Text>
                <Text style={styles.guardSub}>
                  You are bound to <Text style={{ color: '#FFF', fontWeight: 'bold' }}>{myAgency?.name || 'an agency'}</Text> as a host. An account cannot be both an agency host AND a reseller — leave your agency first, then apply.
                </Text>
                <TouchableOpacity
                  style={styles.guardCta}
                  onPress={() => router.push('/main/agency')}
                >
                  <Text style={styles.guardCtaText}>Go to Agency →</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {canApply && (
            <>
              <Text style={styles.sectionTitle}>Application Form</Text>

              <View style={styles.field}>
                <Text style={styles.label}>Business Name *</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Rahim Telecom"
                  placeholderTextColor="#6B7280"
                  value={businessName}
                  onChangeText={setBusinessName}
                />
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>Contact Platform *</Text>
                <View style={styles.platformRow}>
                  <TouchableOpacity
                    style={[styles.platformBtn, contactPlatform === 'whatsapp' && styles.platformBtnActive]}
                    onPress={() => setContactPlatform('whatsapp')}
                  >
                    <Ionicons name="logo-whatsapp" size={20} color={contactPlatform === 'whatsapp' ? '#FFF' : '#9CA3AF'} />
                    <Text style={[styles.platformText, contactPlatform === 'whatsapp' && { color: '#FFF' }]}>WhatsApp</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.platformBtn, contactPlatform === 'telegram' && styles.platformBtnActive]}
                    onPress={() => setContactPlatform('telegram')}
                  >
                    <Ionicons name="paper-plane" size={20} color={contactPlatform === 'telegram' ? '#FFF' : '#9CA3AF'} />
                    <Text style={[styles.platformText, contactPlatform === 'telegram' && { color: '#FFF' }]}>Telegram</Text>
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>Phone Number (with country code) *</Text>
                <TextInput
                  style={styles.input}
                  placeholder="8801XXXXXXXXX"
                  placeholderTextColor="#6B7280"
                  value={contactNumber}
                  onChangeText={setContactNumber}
                  keyboardType="phone-pad"
                />
                <Text style={styles.hint}>
                  Customers will be redirected via {contactPlatform === 'whatsapp' ? 'WhatsApp' : 'Telegram'}.
                  {contactNumber ? `  Preview: ${buildContactLink()}` : ''}
                </Text>
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>Accepted Payment Methods</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Bkash, Nagad, Bank Transfer"
                  placeholderTextColor="#6B7280"
                  value={paymentMethods}
                  onChangeText={setPaymentMethods}
                />
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>NID Number (optional)</Text>
                <TextInput
                  style={styles.input}
                  placeholder="10-17 digit NID"
                  placeholderTextColor="#6B7280"
                  value={nidNumber}
                  onChangeText={setNidNumber}
                  keyboardType="number-pad"
                />
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>Notes (optional)</Text>
                <TextInput
                  style={[styles.input, { height: 100, textAlignVertical: 'top' }]}
                  placeholder="Any additional info you'd like us to know"
                  placeholderTextColor="#6B7280"
                  value={notes}
                  onChangeText={setNotes}
                  multiline
                />
              </View>

              <TouchableOpacity
                style={styles.submitBtn}
                onPress={handleSubmit}
                disabled={submitting}
              >
                <LinearGradient colors={[BRAND.primary, BRAND.primaryAlt]} style={styles.submitGradient}>
                  {submitting ? (
                    <LogoLoader size={32} />
                  ) : (
                    <Text style={styles.submitText}>Submit Application</Text>
                  )}
                </LinearGradient>
              </TouchableOpacity>

              <Text style={styles.disclaimer}>
                ⚠ By applying, you agree to YOLO's reseller terms. Approval may take 1-3 business days.
              </Text>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0E111E' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1E1A34',
  },
  backBtn: { padding: 4 },
  headerTitle: { color: '#FFF', fontSize: 18, fontWeight: 'bold' },
  content: { padding: 16, paddingBottom: 40 },

  heroCard: { padding: 24, borderRadius: 20, alignItems: 'center', marginBottom: 20 },
  heroTitle: { color: '#FFF', fontSize: 22, fontWeight: 'bold', marginTop: 10 },
  heroSub: { color: '#9CA3AF', fontSize: 13, marginTop: 8, textAlign: 'center', lineHeight: 18 },

  statusBox: { borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 20 },
  statusHeader: { flexDirection: 'row', alignItems: 'center' },
  statusTitle: { fontSize: 14, fontWeight: 'bold' },
  statusSub: { color: '#D4D4D8', fontSize: 12, marginTop: 4, lineHeight: 18 },
  statusMeta: { color: '#6B7280', fontSize: 10, marginTop: 10 },
  reviewBox: {
    backgroundColor: 'rgba(0,0,0,0.3)', padding: 10, borderRadius: 8, marginTop: 12,
    borderLeftWidth: 3, borderLeftColor: 'rgba(255,255,255,0.2)',
  },
  reviewLabel: { color: '#9CA3AF', fontSize: 10, fontWeight: 'bold', marginBottom: 4 },
  reviewText: { color: '#FFF', fontSize: 12, fontStyle: 'italic' },

  guardBox: {
    flexDirection: 'row', alignItems: 'flex-start',
    backgroundColor: 'rgba(244, 63, 94, 0.08)',
    borderWidth: 1, borderColor: 'rgba(244, 63, 94, 0.35)',
    borderRadius: 16, padding: 16, marginBottom: 20,
  },
  guardTitle: { color: '#F43F5E', fontSize: 15, fontWeight: 'bold' },
  guardSub: { color: '#D4D4D8', fontSize: 12, marginTop: 6, lineHeight: 18 },
  guardCta: {
    alignSelf: 'flex-start',
    backgroundColor: '#F43F5E', borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 6, marginTop: 10,
  },
  guardCtaText: { color: '#FFF', fontSize: 12, fontWeight: 'bold' },

  sectionTitle: { color: '#FFF', fontSize: 16, fontWeight: 'bold', marginBottom: 16, marginTop: 8 },
  field: { marginBottom: 16 },
  label: { color: '#9CA3AF', fontSize: 12, marginBottom: 6, fontWeight: '600' },
  input: {
    backgroundColor: '#1E1A34', borderRadius: 10, color: '#FFF',
    paddingHorizontal: 14, height: 50, fontSize: 14,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  hint: { color: '#6B7280', fontSize: 10, marginTop: 6, fontStyle: 'italic' },

  platformRow: { flexDirection: 'row', gap: 10 },
  platformBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 14, borderRadius: 10, backgroundColor: '#1E1A34',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)', gap: 8,
  },
  platformBtnActive: { backgroundColor: BRAND.primary, borderColor: BRAND.primary },
  platformText: { color: '#9CA3AF', fontSize: 14, fontWeight: '600' },

  submitBtn: { marginTop: 16 },
  submitGradient: {
    paddingVertical: 16, borderRadius: 14, alignItems: 'center', justifyContent: 'center', height: 56,
  },
  submitText: { color: '#FFF', fontSize: 16, fontWeight: 'bold' },
  disclaimer: { color: '#6B7280', fontSize: 10, marginTop: 16, textAlign: 'center', lineHeight: 16 },
});