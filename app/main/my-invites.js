import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Share, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useGlobalState } from '../../src/context/GlobalStateContext';

export default function MyInvitesScreen() {
  const router = useRouter();
  const { user } = useGlobalState();
  // Referral code is the user's sequential 202xxx display_id with a YOLO-
  // prefix. We deliberately don't fall back to a UUID slice anymore —
  // that produced "YOLO-2D1814"-style codes users mistook for their
  // real ID. When display_id hasn't hydrated yet (cold start) we keep
  // the code empty and the share UI is gated below.
  const referralCode = user?.displayId ? `YOLO-${user.displayId}` : '';

  const onShare = async () => {
    if (!referralCode) return;
    try {
      await Share.share({
        message: `Join me on YOLO-LIVE! Use my referral code ${referralCode} to get bonus diamonds! https://yolo-live.app/download`,
      });
    } catch (error) {
      Alert.alert('Share failed', error.message);
    }
  };

  // Re-use the native share sheet for copy — every system share sheet has a
  // "Copy" action, and this avoids pulling in the expo-clipboard dependency.
  const copyToClipboard = async () => {
    try {
      await Share.share({ message: referralCode });
    } catch (_) {
      Alert.alert('Your code', referralCode);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Invites</Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        
        {/* Referral Card */}
        <LinearGradient 
          colors={['#5A46B5', '#2A2542']} 
          style={styles.referralCard}
          start={{x:0, y:0}} end={{x:1, y:1}}
        >
          <Text style={styles.cardTitle}>Your Referral Code</Text>
          <View style={styles.codeContainer}>
            <Text style={styles.codeText}>{referralCode || 'Loading…'}</Text>
            <TouchableOpacity
              onPress={copyToClipboard}
              style={[styles.copyBtn, !referralCode && { opacity: 0.4 }]}
              disabled={!referralCode}
            >
              <Ionicons name="copy-outline" size={20} color="#00E5FF" />
            </TouchableOpacity>
          </View>
          <Text style={styles.cardSub}>Share this code with your friends to earn diamonds together!</Text>
        </LinearGradient>

        {/* Action Buttons */}
        <TouchableOpacity style={styles.inviteBtn} onPress={onShare}>
          <LinearGradient 
            colors={['#00E5FF', '#2D9CDB']} 
            style={styles.gradientBtn}
            start={{x:0, y:0}} end={{x:1, y:0}}
          >
            <Ionicons name="share-social" size={20} color="#FFFFFF" style={{marginRight: 8}} />
            <Text style={styles.btnText}>Invite Friends Now</Text>
          </LinearGradient>
        </TouchableOpacity>

        {/* Stats Grid — values will populate when referral tracking ships */}
        <Text style={styles.sectionTitle}>Invitation Stats</Text>
        <View style={styles.statsGrid}>
          <View style={styles.statsBox}>
            <Text style={styles.statsVal}>0</Text>
            <Text style={styles.statsLabel}>Total Invited</Text>
          </View>
          <View style={styles.statsBox}>
            <Text style={styles.statsVal}>0</Text>
            <Text style={styles.statsLabel}>Active Users</Text>
          </View>
          <View style={styles.statsBox}>
            <View style={{flexDirection: 'row', alignItems: 'center'}}>
              <Text style={styles.statsVal}>0</Text>
              <Ionicons name="diamond" size={12} color="#00E5FF" style={{marginLeft: 4}} />
            </View>
            <Text style={styles.statsLabel}>Earned</Text>
          </View>
        </View>
        <Text style={{ color: '#6B7280', fontSize: 11, marginBottom: 16, marginTop: -8, textAlign: 'center' }}>
          Stats populate once your invited friends start signing up.
        </Text>

        {/* How it works */}
        <Text style={styles.sectionTitle}>How it works</Text>
        <View style={styles.stepsCard}>
          <StepItem 
            num="1" 
            title="Invite Friends" 
            desc="Send your referral code or link to your friends." 
            icon="share-outline" 
          />
          <StepItem 
            num="2" 
            title="They Sign Up" 
            desc="Your friends download and sign up using your code." 
            icon="person-add-outline" 
          />
          <StepItem 
            num="3" 
            title="You Earn" 
            desc="Get instant diamonds when they reach Level 5." 
            icon="gift-outline" 
            isLast 
          />
        </View>

        <View style={{height: 40}} />
      </ScrollView>
    </SafeAreaView>
  );
}

const StepItem = ({ num, title, desc, icon, isLast }) => (
  <View style={styles.stepItem}>
    <View style={styles.stepLeft}>
      <View style={styles.stepCircle}>
        <Text style={styles.stepNum}>{num}</Text>
      </View>
      {!isLast && <View style={styles.stepLine} />}
    </View>
    <View style={styles.stepRight}>
      <View style={styles.stepHeader}>
        <Ionicons name={icon} size={18} color="#00E5FF" style={{marginRight: 8}} />
        <Text style={styles.stepTitle}>{title}</Text>
      </View>
      <Text style={styles.stepDesc}>{desc}</Text>
    </View>
  </View>
);

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0E111E' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#251B45' },
  backBtn: { padding: 4 },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },
  
  content: { padding: 16 },

  referralCard: { padding: 24, borderRadius: 24, alignItems: 'center', marginBottom: 20 },
  cardTitle: { color: '#9CA3AF', fontSize: 14, fontWeight: '600', marginBottom: 16 },
  codeContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.3)', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 16, marginBottom: 16 },
  codeText: { color: '#FFFFFF', fontSize: 24, fontWeight: 'bold', letterSpacing: 2 },
  copyBtn: { marginLeft: 16 },
  cardSub: { color: '#E5E7EB', fontSize: 12, textAlign: 'center', opacity: 0.8 },

  inviteBtn: { marginBottom: 30 },
  gradientBtn: { paddingVertical: 16, borderRadius: 16, flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  btnText: { color: '#FFFFFF', fontSize: 16, fontWeight: 'bold' },

  sectionTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: 'bold', marginBottom: 16 },
  
  statsGrid: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 30 },
  statsBox: { width: '30%', backgroundColor: '#1E1A34', paddingVertical: 16, alignItems: 'center', borderRadius: 16 },
  statsVal: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },
  statsLabel: { color: '#9CA3AF', fontSize: 10, marginTop: 4 },

  stepsCard: { backgroundColor: '#1E1A34', borderRadius: 20, padding: 20 },
  stepItem: { flexDirection: 'row' },
  stepLeft: { alignItems: 'center', marginRight: 16 },
  stepCircle: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#00E5FF', justifyContent: 'center', alignItems: 'center' },
  stepNum: { color: '#0E111E', fontSize: 12, fontWeight: 'bold' },
  stepLine: { width: 2, flex: 1, backgroundColor: '#374151', marginVertical: 4 },
  stepRight: { flex: 1, paddingBottom: 24 },
  stepHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  stepTitle: { color: '#FFFFFF', fontSize: 14, fontWeight: 'bold' },
  stepDesc: { color: '#9CA3AF', fontSize: 12, lineHeight: 18 }
});
