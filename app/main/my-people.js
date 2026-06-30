import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Image, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';

export default function MyPeopleScreen() {
  const router = useRouter();
  const [search, setSearch] = useState('');

  // Referrals depend on a `referred_by` column / referrals table that isn't
  // wired up yet on the backend. Until then we show an honest empty state
  // instead of fake names.
  const referredUsers = [];
  const filteredUsers = referredUsers;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My People</Text>
        <View style={{ width: 28 }} />
      </View>

      {/* Stats Summary */}
      <View style={styles.statsRow}>
        <View style={styles.statItem}>
          <Text style={styles.statVal}>{referredUsers.length}</Text>
          <Text style={styles.statLabel}>Total Invited</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Text style={styles.statVal}>0</Text>
          <Text style={styles.statLabel}>Total Rewards</Text>
        </View>
      </View>

      {/* Search */}
      <View style={styles.searchContainer}>
        <View style={styles.searchBar}>
          <Ionicons name="search" size={20} color="#9CA3AF" />
          <TextInput 
            placeholder="Search by name..." 
            placeholderTextColor="#6B7280"
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
          />
        </View>
      </View>

      {/* List */}
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        {filteredUsers.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="people-outline" size={64} color="#374151" />
            <Text style={styles.emptyText}>No one found.</Text>
          </View>
        ) : (
          filteredUsers.map((user) => (
            <View key={user.id} style={styles.userCard}>
              <View style={styles.userInfo}>
                <Image source={{uri: user.avatar}} style={styles.avatar} />
                <View>
                  <Text style={styles.userName}>{user.name}</Text>
                  <View style={styles.metaRow}>
                    <LinearGradient 
                      colors={['#F59E0B', '#FCD34D']} 
                      style={styles.levelBadge}
                      start={{x:0, y:0}} end={{x:1, y:1}}
                    >
                      <Text style={styles.levelText}>Lv. {user.level}</Text>
                    </LinearGradient>
                    <Text style={styles.joinDate}>Joined {user.joinDate}</Text>
                  </View>
                </View>
              </View>
              <View style={styles.rewardInfo}>
                <Text style={styles.rewardVal}>+{user.diamondsEarned}</Text>
                <Ionicons name="diamond" size={14} color="#00E5FF" style={{marginLeft: 4}} />
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0E111E' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#251B45' },
  backBtn: { padding: 4 },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },
  
  statsRow: { flexDirection: 'row', backgroundColor: '#1E1A34', margin: 16, borderRadius: 16, paddingVertical: 20 },
  statItem: { flex: 1, alignItems: 'center' },
  statVal: { color: '#FFFFFF', fontSize: 20, fontWeight: 'bold' },
  statLabel: { color: '#9CA3AF', fontSize: 12, marginTop: 4 },
  statDivider: { width: 1, height: '60%', backgroundColor: '#374151', alignSelf: 'center' },

  searchContainer: { paddingHorizontal: 16, marginBottom: 12 },
  searchBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E1A34', borderRadius: 12, paddingHorizontal: 12, height: 44 },
  searchInput: { flex: 1, color: '#FFFFFF', marginLeft: 10, fontSize: 14 },

  content: { padding: 16 },
  userCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#1E1A34', padding: 16, borderRadius: 16, marginBottom: 12 },
  userInfo: { flexDirection: 'row', alignItems: 'center' },
  avatar: { width: 50, height: 50, borderRadius: 25, marginRight: 12, borderWidth: 1, borderColor: '#374151' },
  userName: { color: '#FFFFFF', fontSize: 15, fontWeight: 'bold', marginBottom: 4 },
  metaRow: { flexDirection: 'row', alignItems: 'center' },
  joinDate: { color: '#6B7280', fontSize: 11, marginLeft: 8 },
  
  levelBadge: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6 },
  levelText: { color: '#1E1B4B', fontSize: 9, fontWeight: 'bold' },
  
  rewardInfo: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0, 229, 255, 0.1)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  rewardVal: { color: '#00E5FF', fontWeight: 'bold', fontSize: 13 },
  
  emptyState: { marginTop: 60, alignItems: 'center' },
  emptyText: { color: '#6B7280', marginTop: 16, fontSize: 14 }
});
