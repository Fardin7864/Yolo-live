import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useGlobalState } from '../context/GlobalStateContext';
import { BRAND } from '../theme/brand';

/**
 * Wraps the entire app. When system_settings.maintenance_mode is true,
 * renders a maintenance screen instead of children. Admins are allowed
 * through so they can manage the platform during maintenance.
 */
export default function MaintenanceGate({ children }) {
  const { systemSettings, role, loading } = useGlobalState();

  // While we're still bootstrapping (auth + system settings), let children render.
  // Avoids a maintenance flash on cold start when defaults are false anyway.
  if (loading) return children;

  const isAdmin = role === 'admin' || role === 'super_admin';
  if (!systemSettings.maintenance_mode || isAdmin) return children;

  const platform = systemSettings.platform_name || 'Care Live';
  const message = systemSettings.maintenance_message ||
    "We'll be right back. Maintenance in progress.";

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient
        colors={['#0E111E', BRAND.splashBg]}
        style={StyleSheet.absoluteFillObject}
      />
      <View style={styles.content}>
        <View style={styles.iconCircle}>
          <Ionicons name="construct" size={64} color="#FCD34D" />
        </View>
        <Text style={styles.brand}>{platform}</Text>
        <Text style={styles.title}>Under Maintenance</Text>
        <Text style={styles.message}>{message}</Text>

        <View style={styles.tipBox}>
          <Ionicons name="information-circle" size={18} color="#9CA3AF" />
          <Text style={styles.tipText}>
            This screen will update automatically once we're back online.
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0E111E' },
  content: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 32,
  },
  iconCircle: {
    width: 120, height: 120, borderRadius: 60,
    backgroundColor: 'rgba(252, 211, 77, 0.1)',
    borderWidth: 2, borderColor: 'rgba(252, 211, 77, 0.3)',
    justifyContent: 'center', alignItems: 'center',
    marginBottom: 24,
  },
  brand: {
    color: '#FCD34D', fontSize: 14, fontWeight: 'bold',
    letterSpacing: 2, marginBottom: 12,
  },
  title: {
    color: '#FFFFFF', fontSize: 28, fontWeight: '900',
    textAlign: 'center', marginBottom: 16,
  },
  message: {
    color: '#9CA3AF', fontSize: 15, lineHeight: 22,
    textAlign: 'center', marginBottom: 32,
  },
  tipBox: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12, padding: 14, gap: 10,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  tipText: { flex: 1, color: '#9CA3AF', fontSize: 12, lineHeight: 18 },
});
