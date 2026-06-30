import React from 'react';
import { View, StyleSheet, TouchableOpacity, Text } from 'react-native';
import LogoLoader from '../../src/components/LogoLoader';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import AgencyOwnerView from './agency-owner-view';
import AgencyHostView from './agency-host-view';
import { useGlobalState } from '../../src/context/GlobalStateContext';

export default function AgencyScreen() {
  const router = useRouter();
  const { ownedAgency, loading } = useGlobalState();

  // Route: if user owns an agency, show owner panel; else host panel
  const isOwner = !!ownedAgency;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{isOwner ? 'Agency Dashboard' : 'Agency Center'}</Text>
        <View style={{ width: 28 }} />
      </View>

      <View style={styles.content}>
        {loading ? (
          <View style={styles.center}>
            <LogoLoader size="medium" />
          </View>
        ) : isOwner ? (
          <AgencyOwnerView />
        ) : (
          <AgencyHostView />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0E111E' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#1E1A34',
  },
  backBtn: { padding: 4 },
  headerTitle: { color: '#FFF', fontSize: 18, fontWeight: 'bold' },
  content: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
});