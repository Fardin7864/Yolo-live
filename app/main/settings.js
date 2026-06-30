import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Switch, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import { supabase } from '../../src/api/supabase';
import { useResponsive } from '../../src/hooks/useResponsive';
import { horizontalScale } from '../../src/theme/scaling';

export default function SettingsScreen() {
  const router = useRouter();
  const { role, user, ownedAgency, myReseller, refreshUser } = useGlobalState();
  const { maxContentWidth, isTablet } = useResponsive();

  // Notification + DM preferences are server-persisted (profiles columns).
  // We seed from the cached user object so the toggles flip instantly on
  // mount instead of waiting for the next refresh.
  const [pushEnabled, setPushEnabled]         = useState(user?.pushNotificationsEnabled !== false);
  const [messagesEnabled, setMessagesEnabled] = useState(user?.dmNotificationsEnabled  !== false);
  const [cacheSizeLabel, setCacheSizeLabel]   = useState('—');
  const [savingPrefs, setSavingPrefs]         = useState(false);

  // Stay in sync if the user object updates from a realtime profile UPDATE.
  useEffect(() => {
    if (user?.pushNotificationsEnabled !== undefined) {
      setPushEnabled(user.pushNotificationsEnabled);
    }
    if (user?.dmNotificationsEnabled !== undefined) {
      setMessagesEnabled(user.dmNotificationsEnabled);
    }
  }, [user?.pushNotificationsEnabled, user?.dmNotificationsEnabled]);

  // Compute cache size on mount so the Clear Cache row shows a real number.
  useEffect(() => {
    (async () => {
      try {
        const keys = await AsyncStorage.getAllKeys();
        const items = await AsyncStorage.multiGet(keys);
        const bytes = items.reduce((sum, [k, v]) => sum + (v ? v.length + k.length : 0), 0);
        setCacheSizeLabel(bytes > 1024 * 1024
          ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
          : `${Math.max(1, Math.round(bytes / 1024))} KB`);
      } catch (_) {
        setCacheSizeLabel('—');
      }
    })();
  }, []);

  // Save a notification preference back to the server. The RPC bypasses
  // the protect_profile_columns trigger for these two specific flags.
  const persistPref = async (key, value) => {
    if (savingPrefs) return;
    setSavingPrefs(true);
    const { error } = await supabase.rpc('update_my_notification_prefs', {
      p_push: key === 'push' ? value : pushEnabled,
      p_dm:   key === 'dm'   ? value : messagesEnabled,
    });
    setSavingPrefs(false);
    if (error) {
      // Roll back the optimistic UI.
      Alert.alert('Could not update', error.message);
      if (key === 'push') setPushEnabled(!value);
      if (key === 'dm')   setMessagesEnabled(!value);
      return;
    }
    // Refresh the cached profile so the user object reflects the new pref
    // everywhere (e.g. settings reopen, conditional UI elsewhere).
    try { await refreshUser?.(); } catch (_) {}
  };

  const togglePush = (val) => {
    setPushEnabled(val);
    persistPref('push', val);
  };
  const toggleDM = (val) => {
    setMessagesEnabled(val);
    persistPref('dm', val);
  };

  const handleLogout = () => {
    Alert.alert('Log Out', 'Are you sure you want to log out of your account?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Log Out',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.auth.signOut();
          if (error) { Alert.alert('Error', error.message); return; }
          router.replace('/auth/login');
        },
      },
    ]);
  };

  // Two-step delete: a warning, then a confirmation phrase. The server
  // RPC requires the exact word 'DELETE' so an accidental tap can't
  // wipe an account.
  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'This action is permanent. Your diamonds, beans, agency membership and personal info will be removed and your account will be locked.\n\nThis cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: confirmDeleteAccount,
        },
      ]
    );
  };

  const confirmDeleteAccount = () => {
    // Alert.prompt is iOS-only, so we re-confirm via a second Alert that
    // states the rule and asks the user to tap a clearly-labeled button.
    Alert.alert(
      'Final confirmation',
      'Tap "Delete Permanently" below to confirm. There is no recovery after this step.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Permanently',
          style: 'destructive',
          onPress: async () => {
            const { data, error } = await supabase.rpc('delete_my_account', {
              p_confirm: 'DELETE',
            });
            if (error) { Alert.alert('Failed', error.message); return; }
            if (!data?.success) { Alert.alert('Failed', data?.message || 'Try again.'); return; }
            // Clear cached AsyncStorage so a future signup on the same
            // device doesn't inherit stale state.
            try { await AsyncStorage.clear(); } catch (_) {}
            try { await supabase.auth.signOut(); } catch (_) {}
            Alert.alert('Account deleted', 'Your account has been removed.', [
              { text: 'OK', onPress: () => router.replace('/auth/login') },
            ]);
          },
        },
      ]
    );
  };

  // Clear non-auth AsyncStorage keys. We deliberately skip Supabase auth
  // session keys so the user doesn't get signed out by clearing cache.
  const handleClearCache = async () => {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const purgeable = keys.filter((k) =>
        !k.startsWith('supabase.auth.') &&
        !k.startsWith('sb-')             // legacy / refresh tokens
      );
      if (purgeable.length === 0) {
        Alert.alert('Cache', 'Nothing to clear.');
        return;
      }
      await AsyncStorage.multiRemove(purgeable);
      setCacheSizeLabel('0 KB');
      Alert.alert('Cache cleared', `${purgeable.length} item(s) removed.`);
    } catch (e) {
      Alert.alert('Cache', 'Could not clear cache: ' + (e?.message || 'unknown error'));
    }
  };

  const SettingsItem = ({ icon, label, value, onPress, isDestructive }) => (
    <TouchableOpacity style={styles.menuItem} onPress={onPress} disabled={!onPress}>
      <View style={styles.menuItemLeft}>
        <Ionicons name={icon} size={22} color={isDestructive ? '#F43F5E' : '#9CA3AF'} style={{ marginRight: 16 }} />
        <Text style={[styles.menuItemLabel, isDestructive && { color: '#F43F5E' }]}>{label}</Text>
      </View>
      <View style={styles.menuItemRight}>
        {value && <Text style={styles.menuItemValue}>{value}</Text>}
        {onPress && <Ionicons name="chevron-forward" size={20} color="#4B5563" />}
      </View>
    </TouchableOpacity>
  );

  const SettingsToggle = ({ icon, label, value, onValueChange, disabled }) => (
    <View style={styles.menuItem}>
      <View style={styles.menuItemLeft}>
        <Ionicons name={icon} size={22} color="#9CA3AF" style={{ marginRight: 16 }} />
        <Text style={styles.menuItemLabel}>{label}</Text>
      </View>
      <Switch
        trackColor={{ false: '#374151', true: '#00E5FF' }}
        thumbColor={'#FFFFFF'}
        ios_backgroundColor="#374151"
        onValueChange={onValueChange}
        value={value}
        disabled={disabled}
      />
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={{ width: horizontalScale(28) }} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.content,
          isTablet && { width: maxContentWidth, alignSelf: 'center' },
        ]}
      >
        {/* Account */}
        <Text style={styles.sectionTitle}>Account</Text>
        <View style={styles.cardGroup}>
          <SettingsItem
            icon="phone-portrait-outline"
            label="Linked Phone"
            value={user?.phone ? `${user.phone.slice(0, 6)}***${user.phone.slice(-2)}` : '—'}
          />
          <SettingsItem
            icon="person-outline"
            label="Role"
            value={role?.replace('_', ' ').toUpperCase() || 'USER'}
          />
          <SettingsItem icon="globe-outline" label="Language" value="English" />
        </View>

        {/* Partner Program */}
        <Text style={styles.sectionTitle}>Partner Program</Text>
        <View style={styles.cardGroup}>
          {role === 'reseller' || myReseller ? (
            <>
              <SettingsItem
                icon="storefront"
                label="Reseller Dashboard"
                value={myReseller?.name || 'Manage sales'}
                onPress={() => router.push('/main/reseller-dashboard')}
              />
              <SettingsItem
                icon="document-text-outline"
                label="Application Status"
                value="View"
                onPress={() => router.push('/main/apply/reseller')}
              />
            </>
          ) : (
            <SettingsItem
              icon="storefront-outline"
              label="Become a Reseller"
              value="Sell diamonds"
              onPress={() => router.push('/main/apply/reseller')}
            />
          )}
          {(role === 'agency_owner' || ownedAgency) && (
            <SettingsItem
              icon="shield-checkmark"
              label="Agency Dashboard"
              value={ownedAgency?.name || 'My Agency'}
              onPress={() => router.push('/main/agency')}
            />
          )}
        </View>

        {/* General */}
        <Text style={styles.sectionTitle}>General</Text>
        <View style={styles.cardGroup}>
          <SettingsToggle
            icon="notifications-outline"
            label="Push Notifications"
            value={pushEnabled}
            onValueChange={togglePush}
            disabled={savingPrefs}
          />
          <SettingsToggle
            icon="chatbubbles-outline"
            label="Direct Messages"
            value={messagesEnabled}
            onValueChange={toggleDM}
            disabled={savingPrefs}
          />
          <SettingsItem icon="trash-bin-outline" label="Clear Cache" value={cacheSizeLabel} onPress={handleClearCache} />
        </View>

        {/* Support & About */}
        <Text style={styles.sectionTitle}>Support & About</Text>
        <View style={styles.cardGroup}>
          <SettingsItem icon="help-buoy-outline" label="Help Center" onPress={() => router.push('/main/help')} />
          <SettingsItem icon="document-text-outline" label="Terms of Service" onPress={() => router.push('/main/terms')} />
          <SettingsItem icon="shield-checkmark-outline" label="Privacy Policy" onPress={() => router.push('/main/privacy')} />
          <SettingsItem icon="information-circle-outline" label="App Version" value="v1.0.0" />
        </View>

        {/* Danger Zone */}
        <Text style={[styles.sectionTitle, { color: '#F43F5E', marginTop: 10 }]}>Danger Zone</Text>
        <View style={styles.cardGroup}>
          <SettingsItem icon="warning-outline" label="Delete Account" onPress={handleDeleteAccount} isDestructive />
        </View>

        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Ionicons name="log-out-outline" size={24} color="#FFFFFF" style={{ marginRight: 8 }} />
          <Text style={styles.logoutBtnText}>Log Out</Text>
        </TouchableOpacity>

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

  content: { padding: 16 },
  sectionTitle: { color: '#6B7280', fontSize: 12, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, marginLeft: 8, marginTop: 16 },

  cardGroup: { backgroundColor: '#1E1A34', borderRadius: 16, overflow: 'hidden', paddingHorizontal: 16, marginBottom: 8 },
  menuItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: 'rgba(55, 65, 81, 0.4)' },
  menuItemLeft: { flexDirection: 'row', alignItems: 'center' },
  menuItemLabel: { color: '#FFFFFF', fontSize: 16, fontWeight: '500' },
  menuItemRight: { flexDirection: 'row', alignItems: 'center' },
  menuItemValue: { color: '#9CA3AF', fontSize: 14, marginRight: 8 },

  logoutBtn: { flexDirection: 'row', backgroundColor: '#E11D48', marginTop: 32, paddingVertical: 16, borderRadius: 16, justifyContent: 'center', alignItems: 'center', elevation: 5, shadowColor: '#E11D48', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8 },
  logoutBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: 'bold' },
});