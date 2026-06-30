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

export default function ApplyAgencyScreen() {
  const router = useRouter();
  const { user, applyAgencyOwner } = useGlobalState();

  const [proposedName, setProposedName] = useState('');
  const [proposedCode, setProposedCode] = useState('');
  const [contactPlatform, setContactPlatform] = useState('whatsapp'); // 'whatsapp' | 'telegram'
  const [contactNumber, setContactNumber] = useState('');
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

  // Realtime — flip from "pending" → "approved" / "rejected" without
  // a manual refresh when an admin acts on this user's application.
  useEffect(() => {
    if (!user?.id) return;
    const ch = supabase
      .channel(`agency-app-${user.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'agency_applications', filter: `user_id=eq.${user.id}` },
        () => loadStatus()
      )
      .subscribe();
    return () => { try { supabase.removeChannel(ch); } catch (_) {} };
  }, [user?.id]);

  async function loadStatus() {
    if (!user?.id) return;
    setLoadingStatus(true);
    const { data } = await supabase
      .from('agency_applications')
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
    if (!proposedName.trim() || !proposedCode.trim() || !digits) {
      Alert.alert('Required', 'Name, code and contact number are required.');
      return;
    }
    if (proposedCode.length < 4) {
      Alert.alert('Invalid Code', 'Agency code must be at least 4 characters.');
      return;
    }
    if (digits.length < 8) {
      Alert.alert('Invalid Number', 'Please enter a valid phone number with country code (e.g. 8801XXXXXXXXX).');
      return;
    }
    const contactLink = buildContactLink();
    setSubmitting(true);
    const id = await applyAgencyOwner({
      proposedName: proposedName.trim(),
      proposedCode: proposedCode.trim().toUpperCase(),
      contactLink,
      nidNumber: nidNumber.trim(),
      notes: notes.trim(),
    });
    setSubmitting(false);
    if (id) {
      Alert.alert(
        'Submitted',
        'Your agency application has been received. We will review and respond within 1-3 business days.',
        [{ text: 'OK', onPress: () => loadStatus() }]
      );
      setProposedName(''); setProposedCode(''); setContactNumber(''); setNidNumber(''); setNotes('');
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
      pending: 'Your application is under review.',
      approved: 'Approved! Your agency is now active. Go to the Agency menu to manage hosts and stock.',
      rejected: 'Your application was not approved. You can re-apply after addressing the note below.',
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
              {latestApp.status.toUpperCase()}
            </Text>
            <Text style={styles.statusSub}>{statusMsg}</Text>
            <Text style={styles.proposed}>
              Proposed: <Text style={{ color: '#FFF' }}>{latestApp.proposed_name}</Text> ({latestApp.proposed_code})
            </Text>
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

  const canApply = !latestApp || latestApp.status === 'rejected';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Apply as Agency Owner</Text>
        <View style={{ width: 28 }} />
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <LinearGradient colors={['#7C2D12', '#9F1239']} style={styles.heroCard}>
            <Ionicons name="shield-checkmark" size={40} color="#FCD34D" />
            <Text style={styles.heroTitle}>Become an Agency Owner</Text>
            <Text style={styles.heroSub}>
              Run your own agency: recruit hosts, pay them out in BDT, manage diamond stock, and resell to users.
            </Text>
          </LinearGradient>

          {loadingStatus ? (
            <LogoLoader size="medium" style={{ marginVertical: 30 }} />
          ) : (
            renderStatusCard()
          )}

          {canApply && (
            <>
              <Text style={styles.sectionTitle}>Application Form</Text>

              <View style={styles.field}>
                <Text style={styles.label}>Agency Name *</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Galaxy Live Network"
                  placeholderTextColor="#6B7280"
                  value={proposedName}
                  onChangeText={setProposedName}
                />
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>Agency Code *</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. GALAXY-2026"
                  placeholderTextColor="#6B7280"
                  value={proposedCode}
                  onChangeText={(t) => setProposedCode(t.toUpperCase())}
                  autoCapitalize="characters"
                />
                <Text style={styles.hint}>Hosts will use this code to join your agency.</Text>
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
                  Hosts will reach you via {contactPlatform === 'whatsapp' ? 'WhatsApp' : 'Telegram'}.
                  {contactNumber ? `  Preview: ${buildContactLink()}` : ''}
                </Text>
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
                <Text style={styles.label}>About Your Agency (optional)</Text>
                <TextInput
                  style={[styles.input, { height: 100, textAlignVertical: 'top' }]}
                  placeholder="Hosts you already have, experience, anything else"
                  placeholderTextColor="#6B7280"
                  value={notes}
                  onChangeText={setNotes}
                  multiline
                />
              </View>

              <TouchableOpacity style={styles.submitBtn} onPress={handleSubmit} disabled={submitting}>
                <LinearGradient colors={['#F43F5E', '#E11D48']} style={styles.submitGradient}>
                  {submitting ? <LogoLoader size={32} /> : <Text style={styles.submitText}>Submit Application</Text>}
                </LinearGradient>
              </TouchableOpacity>

              <Text style={styles.disclaimer}>
                ⚠ Agency owners are responsible for paying hosts in BDT. Approval may take 1-3 business days.
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
  heroTitle: { color: '#FFF', fontSize: 22, fontWeight: 'bold', marginTop: 10, textAlign: 'center' },
  heroSub: { color: 'rgba(255,255,255,0.8)', fontSize: 13, marginTop: 8, textAlign: 'center', lineHeight: 18 },

  statusBox: { borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 20 },
  statusHeader: { flexDirection: 'row', alignItems: 'flex-start' },
  statusTitle: { fontSize: 14, fontWeight: 'bold' },
  statusSub: { color: '#D4D4D8', fontSize: 12, marginTop: 4, lineHeight: 18 },
  proposed: { color: '#9CA3AF', fontSize: 11, marginTop: 6 },
  statusMeta: { color: '#6B7280', fontSize: 10, marginTop: 10 },
  reviewBox: {
    backgroundColor: 'rgba(0,0,0,0.3)', padding: 10, borderRadius: 8, marginTop: 12,
    borderLeftWidth: 3, borderLeftColor: 'rgba(255,255,255,0.2)',
  },
  reviewLabel: { color: '#9CA3AF', fontSize: 10, fontWeight: 'bold', marginBottom: 4 },
  reviewText: { color: '#FFF', fontSize: 12, fontStyle: 'italic' },

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
  platformBtnActive: { backgroundColor: '#F43F5E', borderColor: '#F43F5E' },
  platformText: { color: '#9CA3AF', fontSize: 14, fontWeight: '600' },

  submitBtn: { marginTop: 16 },
  submitGradient: { paddingVertical: 16, borderRadius: 14, alignItems: 'center', justifyContent: 'center', height: 56 },
  submitText: { color: '#FFF', fontSize: 16, fontWeight: 'bold' },
  disclaimer: { color: '#6B7280', fontSize: 10, marginTop: 16, textAlign: 'center', lineHeight: 16 },
});