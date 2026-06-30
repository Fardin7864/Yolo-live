import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

export default function PrivacyScreen() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Privacy Policy</Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <Text style={styles.lastUpdated}>Last Updated: October 2026</Text>

        <Text style={styles.sectionTitle}>1. Information We Collect</Text>
        <Text style={styles.paragraph}>
          We collect information to provide better services to our users. This includes:
        </Text>
        <Text style={styles.bullet}>• Account Information (Name, Phone number, Email, Avatar).</Text>
        <Text style={styles.bullet}>• Content Information (Live streams, Chat messages).</Text>
        <Text style={styles.bullet}>• Device Information (IP address, OS version, Device model).</Text>
        <Text style={styles.bullet}>• Wallet & Transaction Data (Diamond top-ups, Bean withdrawals).</Text>

        <Text style={styles.sectionTitle}>2. How We Use Your Information</Text>
        <Text style={styles.paragraph}>
          We use the information we collect to operate, maintain, and improve Yolo-Live. Specifically, we use it to authenticate you, process your virtual transactions, monitor safety, and prevent fraudulent activities.
        </Text>

        <Text style={styles.sectionTitle}>3. Data Protection</Text>
        <Text style={styles.paragraph}>
          We implement strong security measures to protect your data from unauthorized access, alteration, disclosure, or destruction. All communication and transactions are securely encrypted.
        </Text>

        <Text style={styles.sectionTitle}>4. Data Sharing</Text>
        <Text style={styles.paragraph}>
          We do not sell your personal information to third parties. We may share information with trusted third-party service providers (such as Supabase for database integration) solely to facilitate our Services, subject to rigorous data processing agreements.
        </Text>

        <Text style={styles.sectionTitle}>5. Your Privacy Rights</Text>
        <Text style={styles.paragraph}>
          You have the right to request the deletion of your account and associated data. You can perform this action via the "Delete Account" button in the Settings page. Upon clicking, all your personal data will be wiped from our secure servers.
        </Text>
        
        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0E111E' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#251B45' },
  backBtn: { padding: 4 },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },
  content: { padding: 20 },
  lastUpdated: { color: '#9CA3AF', fontSize: 12, fontStyle: 'italic', marginBottom: 20 },
  sectionTitle: { color: '#34D399', fontSize: 16, fontWeight: 'bold', marginTop: 16, marginBottom: 8 },
  paragraph: { color: '#D1D5DB', fontSize: 14, lineHeight: 22, textAlign: 'justify', marginBottom: 6 },
  bullet: { color: '#E5E7EB', fontSize: 14, lineHeight: 22, marginLeft: 10, marginTop: 4 }
});
