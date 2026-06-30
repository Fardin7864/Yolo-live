import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Linking, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { horizontalScale } from '../../src/theme/scaling';
import { BRAND } from '../../src/theme/brand';

// Static FAQ. Edit here when the product team wants to update copy;
// no server fetch needed because the answers don't change per user.
const FAQ = [
  {
    q: 'How do I top up diamonds?',
    a: 'Open the Wallet tab, pick an amount, then contact any reseller or agency listed there via WhatsApp. They confirm your payment and the diamonds arrive in your account.',
  },
  {
    q: 'How does gifting work?',
    a: 'In a live room, tap the Gift icon, pick a recipient (host or any seated guest) and a gift. The cost is deducted from your diamonds and the host earns beans worth 50% of the cost.',
  },
  {
    q: 'What is the difference between diamonds and beans?',
    a: 'Diamonds are what you spend. Beans are what hosts earn from receiving gifts. Hosts can convert beans to diamonds (or cash) through an approved agency or reseller.',
  },
  {
    q: 'How do I become a host?',
    a: 'Tap the + button on the Home tab and start a live stream. Your first live will earn the "First Streamer" badge.',
  },
  {
    q: 'How do I report another user?',
    a: 'In a live room, long-press the user\'s tile or open their profile, then tap Report. Admins review reports daily.',
  },
  {
    q: 'How do I stop someone from messaging me?',
    a: 'Go to Settings → General and turn off Direct Messages. Resellers and admins can still reach you for support.',
  },
  {
    q: 'Why was my account banned?',
    a: 'Bans usually follow community guideline violations (harassment, spam, fraud). Reach out to support@yolo.live with your phone number for a review.',
  },
  {
    q: 'How do I delete my account?',
    a: 'Settings → Danger Zone → Delete Account. Account deletion is permanent and removes your diamonds, beans, and personal info.',
  },
];

const SUPPORT_EMAIL = 'support@yolo.live';
const SUPPORT_PHONE = '+8801711234567';

export default function HelpScreen() {
  const router = useRouter();
  const [openIdx, setOpenIdx] = useState(null);

  const openEmail = async () => {
    const url = `mailto:${SUPPORT_EMAIL}?subject=Yolo-Live%20Support&body=Hi%20team%2C%20I%20need%20help%20with...`;
    try {
      await Linking.openURL(url);
    } catch (_) {
      Alert.alert('Email', `Email us at ${SUPPORT_EMAIL}`);
    }
  };

  const openWhatsApp = async () => {
    const url = `https://wa.me/${SUPPORT_PHONE.replace(/[^0-9]/g, '')}`;
    try {
      await Linking.openURL(url);
    } catch (_) {
      Alert.alert('WhatsApp', `Message us at ${SUPPORT_PHONE}`);
    }
  };

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Help Center</Text>
        <View style={{ width: horizontalScale(28) }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.content}>
        {/* Hero */}
        <View style={s.hero}>
          <View style={s.heroIconWrap}>
            <Ionicons name="help-buoy" size={28} color="#FFF" />
          </View>
          <Text style={s.heroTitle}>How can we help?</Text>
          <Text style={s.heroSub}>Browse the FAQ or reach out directly. We reply within 24 hours.</Text>
        </View>

        {/* Contact cards */}
        <View style={s.contactRow}>
          <TouchableOpacity style={s.contactCard} onPress={openEmail}>
            <View style={[s.contactIcon, { backgroundColor: 'rgba(56,189,248,0.15)' }]}>
              <Ionicons name="mail" size={20} color="#38BDF8" />
            </View>
            <Text style={s.contactLabel}>Email</Text>
            <Text style={s.contactValue} numberOfLines={1}>{SUPPORT_EMAIL}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={s.contactCard} onPress={openWhatsApp}>
            <View style={[s.contactIcon, { backgroundColor: 'rgba(34,197,94,0.15)' }]}>
              <Ionicons name="logo-whatsapp" size={20} color="#22C55E" />
            </View>
            <Text style={s.contactLabel}>WhatsApp</Text>
            <Text style={s.contactValue} numberOfLines={1}>{SUPPORT_PHONE}</Text>
          </TouchableOpacity>
        </View>

        {/* FAQ */}
        <Text style={s.sectionTitle}>Frequently asked questions</Text>
        {FAQ.map((item, idx) => {
          const open = openIdx === idx;
          return (
            <TouchableOpacity
              key={idx}
              style={[s.faqItem, open && s.faqItemOpen]}
              activeOpacity={0.85}
              onPress={() => setOpenIdx(open ? null : idx)}
            >
              <View style={s.faqHeader}>
                <Text style={s.faqQ}>{item.q}</Text>
                <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color="#9CA3AF" />
              </View>
              {open && <Text style={s.faqA}>{item.a}</Text>}
            </TouchableOpacity>
          );
        })}

        {/* Reach out CTA at bottom */}
        <View style={s.bottomCTA}>
          <Text style={s.bottomCTATitle}>Still stuck?</Text>
          <Text style={s.bottomCTABody}>Email us with your phone number and we'll look into it.</Text>
          <TouchableOpacity style={s.bottomBtn} onPress={openEmail}>
            <Ionicons name="mail-outline" size={16} color="#FFF" />
            <Text style={s.bottomBtnText}>Contact support</Text>
          </TouchableOpacity>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0E111E' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#251B45' },
  backBtn: { padding: 4 },
  headerTitle: { color: '#FFF', fontSize: 18, fontWeight: 'bold' },
  content: { padding: 16, paddingBottom: 32 },

  hero: { alignItems: 'center', paddingVertical: 20 },
  heroIconWrap: { width: 56, height: 56, borderRadius: 28, backgroundColor: BRAND.primary, alignItems: 'center', justifyContent: 'center', marginBottom: 12, shadowColor: BRAND.primary, shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
  heroTitle: { color: '#FFF', fontSize: 20, fontWeight: '800' },
  heroSub: { color: '#9CA3AF', fontSize: 13, marginTop: 6, textAlign: 'center', paddingHorizontal: 20 },

  contactRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  contactCard: { flex: 1, backgroundColor: '#1E1A34', borderRadius: 16, padding: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' },
  contactIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  contactLabel: { color: 'rgba(255,255,255,0.55)', fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  contactValue: { color: '#FFF', fontSize: 12, fontWeight: '600', marginTop: 2 },

  sectionTitle: { color: '#6B7280', fontSize: 12, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: 1, marginTop: 24, marginBottom: 10, marginLeft: 4 },

  faqItem: { backgroundColor: '#1E1A34', borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.04)' },
  faqItemOpen: { borderColor: BRAND.primary30 },
  faqHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  faqQ: { color: '#FFF', fontSize: 14, fontWeight: '600', flex: 1, marginRight: 12 },
  faqA: { color: 'rgba(255,255,255,0.6)', fontSize: 13, lineHeight: 19, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.05)' },

  bottomCTA: { backgroundColor: '#1E1A34', borderRadius: 16, padding: 20, marginTop: 24, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' },
  bottomCTATitle: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  bottomCTABody: { color: '#9CA3AF', fontSize: 12, marginTop: 4, textAlign: 'center', marginBottom: 14 },
  bottomBtn: { flexDirection: 'row', gap: 8, alignItems: 'center', backgroundColor: BRAND.primary, paddingVertical: 10, paddingHorizontal: 20, borderRadius: 12 },
  bottomBtnText: { color: '#FFF', fontWeight: '700', fontSize: 13 },
});