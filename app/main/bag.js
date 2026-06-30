import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, FlatList, RefreshControl, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { supabase } from '../../src/api/supabase';
import LogoLoader from '../../src/components/LogoLoader';
import { BRAND } from '../../src/theme/brand';

const RARITY_COLOR = {
  common: '#9CA3AF',
  rare: '#38BDF8',
  epic: '#A855F7',
  legendary: '#FBBF24',
};

export default function BagScreen() {
  const router = useRouter();
  const [items, setItems] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [usingItem, setUsingItem] = useState(false);

  const loadBag = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_my_bag');
    if (error) {
      Alert.alert('Bag failed to load', error.message);
      setItems([]);
    } else {
      setItems(Array.isArray(data) ? data : []);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { loadBag(); }, [loadBag]);

  const onRefresh = () => { setRefreshing(true); loadBag(); };

  const handleUse = async () => {
    if (!selectedItem || usingItem) return;
    setUsingItem(true);
    const { error } = await supabase.rpc('use_bag_item', { item: selectedItem.item_id, qty: 1 });
    setUsingItem(false);
    if (error) { Alert.alert('Use failed', error.message); return; }
    setSelectedItem(null);
    loadBag();
  };

  const renderItem = ({ item }) => {
    const rarityColor = RARITY_COLOR[item.rarity] || '#9CA3AF';
    return (
      <TouchableOpacity
        style={[styles.itemCard, selectedItem?.item_id === item.item_id && { borderColor: rarityColor, backgroundColor: '#2A2542' }]}
        onPress={() => setSelectedItem(item)}
      >
        <View style={styles.iconContainer}>
          <Image source={{ uri: item.icon_url }} style={styles.itemIcon} />
          <View style={styles.countBadge}>
            <Text style={styles.countText}>x{item.quantity}</Text>
          </View>
        </View>
        <Text style={styles.itemName} numberOfLines={1}>{item.name}</Text>
        <Text style={[styles.itemType, { color: rarityColor }]}>{item.item_type}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Bag</Text>
        <View style={{ width: 28 }} />
      </View>

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <LogoLoader size="medium" />
        </View>
      ) : items.length === 0 ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 30 }}>
          <Ionicons name="bag-outline" size={48} color="rgba(255,255,255,0.25)" />
          <Text style={{ color: 'rgba(255,255,255,0.5)', marginTop: 12, textAlign: 'center' }}>
            Your bag is empty. Earn items by joining events, lucky bags, or top-ups.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.item_id}
          renderItem={renderItem}
          numColumns={3}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl tintColor={BRAND.primary} refreshing={refreshing} onRefresh={onRefresh} />}
        />
      )}

      {selectedItem && (
        <View style={[styles.detailPanel, { borderTopColor: RARITY_COLOR[selectedItem.rarity] || '#00E5FF' }]}>
          <View style={styles.detailHeader}>
            <Image source={{ uri: selectedItem.icon_url }} style={styles.detailIcon} />
            <View style={{ flex: 1, marginLeft: 16 }}>
              <Text style={styles.detailName}>{selectedItem.name}</Text>
              <Text style={styles.detailType}>{selectedItem.item_type} • Stock: {selectedItem.quantity}</Text>
            </View>
            <TouchableOpacity onPress={() => setSelectedItem(null)}>
              <Ionicons name="close-circle" size={24} color="#6B7280" />
            </TouchableOpacity>
          </View>
          <Text style={styles.detailDesc}>{selectedItem.description}</Text>
          <TouchableOpacity style={[styles.useBtn, usingItem && { opacity: 0.6 }]} disabled={usingItem} onPress={handleUse}>
            <Text style={styles.useBtnText}>{usingItem ? 'Using...' : 'Use Now'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {!selectedItem && items.length > 0 && (
        <View style={styles.emptyTip}>
          <Text style={styles.tipText}>Tap an item to see details</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0E111E' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#251B45' },
  backBtn: { padding: 4 },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },

  listContent: { padding: 8 },
  itemCard: { flex: 1/3, backgroundColor: '#1E1A34', margin: 4, paddingVertical: 16, paddingHorizontal: 4, borderRadius: 16, alignItems: 'center', borderWidth: 1, borderColor: 'transparent' },
  iconContainer: { marginBottom: 8 },
  itemIcon: { width: 44, height: 44 },
  countBadge: { position: 'absolute', bottom: -4, right: -4, backgroundColor: '#F43F5E', paddingHorizontal: 4, borderRadius: 4 },
  countText: { color: '#FFFFFF', fontSize: 10, fontWeight: 'bold' },
  itemName: { color: '#FFFFFF', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  itemType: { fontSize: 10, marginTop: 2 },

  detailPanel: { backgroundColor: '#1E1A34', padding: 20, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderTopWidth: 2 },
  detailHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  detailIcon: { width: 50, height: 50 },
  detailName: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },
  detailType: { color: '#9CA3AF', fontSize: 12, marginTop: 2, textTransform: 'capitalize' },
  detailDesc: { color: '#D1D5DB', fontSize: 14, lineHeight: 20, marginBottom: 20 },
  useBtn: { backgroundColor: '#00E5FF', paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  useBtnText: { color: '#0E111E', fontSize: 16, fontWeight: 'bold' },

  emptyTip: { padding: 20, alignItems: 'center' },
  tipText: { color: '#4B5563', fontSize: 14, fontStyle: 'italic' }
});
