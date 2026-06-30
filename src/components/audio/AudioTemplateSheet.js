/**
 * AudioTemplateSheet — host-side audio room background picker.
 *
 * Two tabs (Free / Premium). Each card shows:
 *   - the template's preview image (falls back to background_url)
 *   - the name
 *   - a status pill: "FREE" / "OWNED" / "12,000 💎"
 *
 * Tap behaviour:
 *   - Free OR already-owned → instantly calls apply_audio_template RPC
 *     and closes.
 *   - Paid + not owned → confirmation alert "Buy XYZ for 12,000 💎?".
 *     Disabled if the host doesn't have enough diamonds. On confirm:
 *       1. purchaseAudioTemplate RPC (deduct + ownership row)
 *       2. apply_audio_template RPC (set live_streams.active_template_id)
 *
 * There's also a "Clear background" pill at the top so the host can
 * reset to the default purple gradient.
 *
 * Backend contracts honored:
 *   - purchase_audio_template       — mig 88
 *   - apply_audio_template          — mig 88
 *   - audio_templates table         — mig 88
 *   - user_audio_templates table    — mig 88
 *   - live_streams.active_template_id — mig 88 (FK)
 */
import React, { useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, Image, FlatList,
  ActivityIndicator, Alert, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useGlobalState } from '../../context/GlobalStateContext';
import { supabase } from '../../api/supabase';
import { BRAND } from '../../theme/brand';

const { width } = Dimensions.get('window');
const CARD_W = (width - 16 * 2 - 12) / 2; // 2 columns, 16 outer pad, 12 inner gap

export default function AudioTemplateSheet({
  visible,
  onClose,
  streamId,
  activeTemplateId,
  onApplied,
}) {
  const { audioTemplates, myOwnedTemplates, purchaseAudioTemplate, diamonds } = useGlobalState();
  const [tab, setTab] = useState('free'); // 'free' | 'premium'
  const [busyId, setBusyId] = useState(null);

  const ownedSet = useMemo(
    () => new Set((myOwnedTemplates || []).map((r) => r.template_id)),
    [myOwnedTemplates],
  );

  const free = useMemo(
    () => (audioTemplates || []).filter((t) => Number(t.diamond_cost) === 0),
    [audioTemplates],
  );
  const premium = useMemo(
    () => (audioTemplates || []).filter((t) => Number(t.diamond_cost) > 0),
    [audioTemplates],
  );

  const list = tab === 'free' ? free : premium;

  const applyTemplate = async (templateId) => {
    if (!streamId) {
      Alert.alert('Not live', 'Start the live stream before changing the background.');
      return;
    }
    setBusyId(templateId || 'clear');
    try {
      const { data, error } = await supabase.rpc('apply_audio_template', {
        p_stream_id:   streamId,
        p_template_id: templateId, // null to clear
      });
      if (error || !data?.success) {
        Alert.alert('Could not apply', data?.message || error?.message || 'Try again');
        return;
      }
      onApplied?.(templateId);
      onClose?.();
    } finally {
      setBusyId(null);
    }
  };

  const handleTap = async (template) => {
    const isFree    = Number(template.diamond_cost) === 0;
    const isOwned   = ownedSet.has(template.id);

    if (isFree || isOwned) {
      applyTemplate(template.id);
      return;
    }

    // Paid + not owned → confirmation.
    if ((diamonds || 0) < template.diamond_cost) {
      Alert.alert(
        'Not enough diamonds',
        `You need ${template.diamond_cost.toLocaleString()} 💎 to unlock "${template.name}". Top up first.`,
      );
      return;
    }

    Alert.alert(
      'Buy template?',
      `Unlock "${template.name}" for ${template.diamond_cost.toLocaleString()} 💎? This is a one-time purchase — you'll own it forever.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Buy + Apply',
          style: 'default',
          onPress: async () => {
            setBusyId(template.id);
            try {
              const res = await purchaseAudioTemplate(template.id);
              if (!res?.success) {
                Alert.alert('Purchase failed', res?.message || 'Try again');
                return;
              }
              // Realtime sub will refresh myOwnedTemplates; apply
              // immediately so the host doesn't have to tap twice.
              await applyTemplate(template.id);
            } finally {
              setBusyId(null);
            }
          },
        },
      ],
    );
  };

  const renderCard = ({ item }) => {
    const isFree   = Number(item.diamond_cost) === 0;
    const isOwned  = ownedSet.has(item.id);
    const isActive = activeTemplateId && item.id === activeTemplateId;
    const thumb    = item.preview_url || item.background_url;
    const busy     = busyId === item.id;

    return (
      <TouchableOpacity
        style={[styles.card, isActive && styles.cardActive]}
        onPress={() => handleTap(item)}
        disabled={busy}
        activeOpacity={0.85}
      >
        <View style={styles.cardImageWrap}>
          {thumb ? (
            <Image source={{ uri: thumb }} style={styles.cardImage} resizeMode="cover" />
          ) : (
            <View style={styles.cardImageFallback}>
              <Ionicons name="image-outline" size={32} color="rgba(255,255,255,0.25)" />
            </View>
          )}
          {isActive && (
            <View style={styles.activeChip}>
              <Ionicons name="checkmark-circle" size={12} color="#FFF" />
              <Text style={styles.activeChipText}>ACTIVE</Text>
            </View>
          )}
          {busy && (
            <View style={styles.busyOverlay}>
              <ActivityIndicator color="#FFF" />
            </View>
          )}
        </View>
        <Text style={styles.cardName} numberOfLines={1}>{item.name}</Text>
        {isFree ? (
          <View style={[styles.pricePill, styles.pricePillFree]}>
            <Text style={styles.pricePillTextFree}>FREE</Text>
          </View>
        ) : isOwned ? (
          <View style={[styles.pricePill, styles.pricePillOwned]}>
            <Text style={styles.pricePillTextOwned}>OWNED</Text>
          </View>
        ) : (
          <View style={[styles.pricePill, styles.pricePillPaid]}>
            <Ionicons name="diamond" size={10} color="#FBBF24" />
            <Text style={styles.pricePillTextPaid}>{Number(item.diamond_cost).toLocaleString()}</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <View style={styles.sheet} onStartShouldSetResponder={() => true}>
          <View style={styles.handle} />

          <View style={styles.headerRow}>
            <Text style={styles.title}>Room Background</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close" size={20} color="rgba(255,255,255,0.7)" />
            </TouchableOpacity>
          </View>

          {/* Clear button — quick reset to no background */}
          <TouchableOpacity
            style={[
              styles.clearBtn,
              !activeTemplateId && styles.clearBtnActive,
            ]}
            onPress={() => applyTemplate(null)}
            disabled={busyId === 'clear'}
          >
            {busyId === 'clear'
              ? <ActivityIndicator size="small" color="#FFF" />
              : <>
                  <Ionicons
                    name={activeTemplateId ? 'close-circle-outline' : 'checkmark-circle'}
                    size={14}
                    color={activeTemplateId ? 'rgba(255,255,255,0.8)' : '#4ADE80'}
                  />
                  <Text style={styles.clearBtnText}>
                    {activeTemplateId ? 'Clear background' : 'No background (default)'}
                  </Text>
                </>}
          </TouchableOpacity>

          {/* Tabs */}
          <View style={styles.tabRow}>
            {[
              { id: 'free',    label: `Free (${free.length})` },
              { id: 'premium', label: `Premium (${premium.length})` },
            ].map((t) => {
              const active = tab === t.id;
              return (
                <TouchableOpacity
                  key={t.id}
                  style={[styles.tabBtn, active && styles.tabBtnActive]}
                  onPress={() => setTab(t.id)}
                >
                  <Text style={[styles.tabText, active && styles.tabTextActive]}>{t.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {list.length === 0 ? (
            <View style={styles.emptyBox}>
              <Ionicons name="image-outline" size={36} color="rgba(255,255,255,0.2)" />
              <Text style={styles.emptyText}>No {tab} templates yet</Text>
              <Text style={styles.emptySub}>Check back soon — admin uploads land in real-time.</Text>
            </View>
          ) : (
            <FlatList
              data={list}
              keyExtractor={(t) => t.id}
              renderItem={renderCard}
              numColumns={2}
              columnWrapperStyle={styles.row}
              contentContainerStyle={{ paddingBottom: 24 }}
              showsVerticalScrollIndicator={false}
            />
          )}
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: BRAND.splashBg,
    borderTopLeftRadius:  28,
    borderTopRightRadius: 28,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 24,
    maxHeight: '80%',
  },
  handle: {
    width: 40, height: 5, borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignSelf: 'center', marginBottom: 12,
  },
  headerRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 12,
  },
  title: { color: '#FFF', fontSize: 18, fontWeight: '900' },
  closeBtn: { padding: 4 },

  clearBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 10,
    paddingVertical: 8,
    marginBottom: 12,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  clearBtnActive: { borderColor: 'rgba(74,222,128,0.4)' },
  clearBtnText: { color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '700' },

  tabRow: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12,
    padding: 4,
    marginBottom: 12,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 10,
    alignItems: 'center',
  },
  tabBtnActive: { backgroundColor: BRAND.primary },
  tabText: { color: '#9CA3AF', fontSize: 12, fontWeight: '700' },
  tabTextActive: { color: '#FFF' },

  row: { gap: 12, marginBottom: 12 },

  card: {
    width: CARD_W,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
  },
  cardActive: { borderColor: '#4ADE80', borderWidth: 2 },
  cardImageWrap: {
    width: '100%',
    aspectRatio: 3 / 4,
    backgroundColor: 'rgba(0,0,0,0.3)',
    position: 'relative',
  },
  cardImage: { width: '100%', height: '100%' },
  cardImageFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  activeChip: {
    position: 'absolute', top: 8, left: 8,
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: 'rgba(74,222,128,0.85)',
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
  },
  activeChipText: { color: '#FFF', fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
  },
  cardName: {
    color: '#FFF', fontSize: 13, fontWeight: '700',
    paddingHorizontal: 10, paddingTop: 8,
  },
  pricePill: {
    margin: 10,
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 6,
    alignSelf: 'flex-start',
    flexDirection: 'row', alignItems: 'center', gap: 3,
  },
  pricePillFree:  { backgroundColor: 'rgba(74,222,128,0.18)' },
  pricePillOwned: { backgroundColor: 'rgba(56,189,248,0.18)' },
  pricePillPaid:  { backgroundColor: 'rgba(251,191,36,0.18)' },
  pricePillTextFree:  { color: '#4ADE80', fontSize: 10, fontWeight: '900', letterSpacing: 0.4 },
  pricePillTextOwned: { color: '#38BDF8', fontSize: 10, fontWeight: '900', letterSpacing: 0.4 },
  pricePillTextPaid:  { color: '#FCD34D', fontSize: 10, fontWeight: '900', letterSpacing: 0.4 },

  emptyBox: { alignItems: 'center', paddingVertical: 48 },
  emptyText: { color: 'rgba(255,255,255,0.65)', fontSize: 14, fontWeight: '700', marginTop: 12 },
  emptySub:  { color: 'rgba(255,255,255,0.35)', fontSize: 11, marginTop: 4, paddingHorizontal: 24, textAlign: 'center' },
});
