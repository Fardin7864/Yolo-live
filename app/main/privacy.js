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
        <Text style={styles.lastUpdated}>Last Updated: September 10, 2026</Text>

        <Text style={styles.sectionTitle}>1. Information We Collect</Text>
        <Text style={styles.paragraph}>
          We collect information to provide better services to our users. This includes:
        </Text>
        <Text style={styles.bullet}>• Account Information (Name, Phone number, Email, Avatar).</Text>
        <Text style={styles.bullet}>• Content Information (Live streams, audio, photos, and chat messages).</Text>
        <Text style={styles.bullet}>• Device Information (IP address, device identifier, OS version, device model, and diagnostics).</Text>
        <Text style={styles.bullet}>• Location Information when you use regional or nearby features.</Text>
        <Text style={styles.bullet}>• Wallet & Transaction Data (Diamond top-ups, Bean withdrawals).</Text>

        <Text style={styles.sectionTitle}>2. How We Use Your Information</Text>
        <Text style={styles.paragraph}>
          We use the information we collect to operate, maintain, secure, and improve Popular Live. This includes authentication, live audio and video delivery, messaging, regional features, virtual transactions, customer support, safety monitoring, diagnostics, and fraud prevention.
        </Text>

        <Text style={styles.sectionTitle}>3. Data Protection</Text>
        <Text style={styles.paragraph}>
          We implement strong security measures to protect your data from unauthorized access, alteration, disclosure, or destruction. All communication and transactions are securely encrypted.
        </Text>

        <Text style={styles.sectionTitle}>4. Data Sharing</Text>
        <Text style={styles.paragraph}>
          We do not sell your personal information. We use service providers, including Supabase for authentication, storage, and database services, Agora for live audio and video delivery, and Google for optional sign-in. They process data only as needed to provide their services and are subject to their own privacy and security obligations.
        </Text>

        <Text style={styles.sectionTitle}>5. Your Privacy Rights</Text>
        <Text style={styles.paragraph}>
          You can delete your account through Settings → Delete Account or contact carelive785@gmail.com. Deletion removes or anonymizes profile information and disables the account. Limited transaction, gift, game, safety, and fraud-prevention records may be retained where required for legal, accounting, security, or dispute-resolution purposes.
        </Text>

        <Text style={styles.sectionTitle}>6. Retention and Security</Text>
        <Text style={styles.paragraph}>
          We retain information only while it is needed for the purposes described above, then delete or anonymize it. We use encrypted network connections, access controls, and monitoring to protect information, but no internet service can guarantee absolute security.
        </Text>

        <Text style={styles.sectionTitle}>7. Contact</Text>
        <Text style={styles.paragraph}>
          For privacy questions or deletion requests, contact the Popular Live team at carelive785@gmail.com.
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
