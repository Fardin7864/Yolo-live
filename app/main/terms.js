import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

export default function TermsScreen() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Terms of Service</Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <Text style={styles.lastUpdated}>Last Updated: October 2026</Text>

        <Text style={styles.sectionTitle}>1. Acceptance of Terms</Text>
        <Text style={styles.paragraph}>
          By accessing and using the Care Live mobile application ("Service"), you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use the app.
        </Text>

        <Text style={styles.sectionTitle}>2. User Conduct & Live Broadcasting</Text>
        <Text style={styles.paragraph}>
          As a user or host, you agree not to broadcast, stream, or share any content that is illegal, abusive, harassing, or violates the intellectual property rights of others. 
          Care Live reserves the right to terminate accounts that violate our safety guidelines without prior notice.
        </Text>

        <Text style={styles.sectionTitle}>3. Virtual Currency & Transactions</Text>
        <Text style={styles.paragraph}>
          The app utilizes virtual currencies (Diamonds and Beans). Diamonds are purchased with real money and used to buy virtual gifts. Beans are earned by receiving gifts and can be converted to real-world cash subject to our withdrawal thresholds and conversion rates. Virtual items have no objective real-world value once purchased until formally requested for withdrawal.
        </Text>

        <Text style={styles.sectionTitle}>4. Subscriptions (VIP/VVIP)</Text>
        <Text style={styles.paragraph}>
          VIP and VVIP subscriptions provide enhanced account features. Fees are non-refundable once the subscription is activated. Care Live reserves the right to modify subscription perks at any time.
        </Text>

        <Text style={styles.sectionTitle}>5. Account Termination</Text>
        <Text style={styles.paragraph}>
          We may suspend or terminate your access to the Service at any time for any reason, including but not limited to breach of these Terms.
        </Text>

        <Text style={styles.sectionTitle}>6. Limitation of Liability</Text>
        <Text style={styles.paragraph}>
          In no event shall Care Live or its developers be liable for any indirect, incidental, or consequential damages arising out of your use of the application.
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
  sectionTitle: { color: '#FCD34D', fontSize: 16, fontWeight: 'bold', marginTop: 16, marginBottom: 8 },
  paragraph: { color: '#D1D5DB', fontSize: 14, lineHeight: 22, textAlign: 'justify' }
});
