import React, { useMemo, useState } from 'react';
import {
  Image, ImageBackground, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { VideoView } from 'expo-video';
import { useRouter } from 'expo-router';
import LogoLoader from '../../src/components/LogoLoader';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import { supabase } from '../../src/api/supabase';
import { showCuteAlert, confirmCuteAlert } from '../../src/components/CuteAlert';
import { useOneShotIntroPlayer } from '../../src/hooks/useOneShotIntroPlayer';

const PAGE_BACKGROUND = require('../../assets/backgrounds/neon-space.webp');
const DEFAULT_INTRO_THUMB = require('../../assets/mall/intro/blue-roses.webp');
const DEFAULT_INTRO_VIDEO = require('../../assets/mall/intro/blue-roses.m4v');

const BUNDLED_FRAMES = {
  'heart-fantasy': require('../../assets/mall/frames/heart-fantasy.webp'),
  'angel-wing': require('../../assets/mall/frames/angel-wing.webp'),
  'royal-gold': require('../../assets/mall/frames/royal-gold.webp'),
};

const BUNDLED_INTROS = {
  'football-cup.webp': require('../../assets/mall/intro/football-cup.webp'),
  'football-cup.m4v': require('../../assets/mall/intro/football-cup.m4v'),
  'blue-roses.webp': require('../../assets/mall/intro/blue-roses.webp'),
  'blue-roses.m4v': require('../../assets/mall/intro/blue-roses.m4v'),
};

const FALLBACK_PACKAGES = [
  {
    id: 'svip-royal-duo',
    name: 'Royal Duo SVIP',
    price: 120000,
    duration_days: 30,
    features: ['SVIP tag on name', 'Premium entry banner', '2 SVIP-only frames', '2 SVIP-only intros'],
    intro_name: 'Football Champions Cup',
    intro_thumbnail_url: 'bundled://football-cup.webp',
    intro_video_url: 'bundled://football-cup.m4v',
    intro2_name: 'Blue Rose Bouquet',
    intro2_thumbnail_url: 'bundled://blue-roses.webp',
    intro2_video_url: 'bundled://blue-roses.m4v',
    frame_name: 'Royal Gold',
    frame_url: 'bundled://royal-gold',
    frame2_name: 'Angel Wing',
    frame2_url: 'bundled://angel-wing',
    accent_color: '#FBBF24',
  },
  {
    id: 'svip-fantasy-star',
    name: 'Fantasy Star SVIP',
    price: 95000,
    duration_days: 30,
    features: ['SVIP name tag', 'Priority room entrance', '2 exclusive frames', '2 exclusive intros'],
    intro_name: 'Blue Rose Bouquet',
    intro_thumbnail_url: 'bundled://blue-roses.webp',
    intro_video_url: 'bundled://blue-roses.m4v',
    intro2_name: 'Football Champions Cup',
    intro2_thumbnail_url: 'bundled://football-cup.webp',
    intro2_video_url: 'bundled://football-cup.m4v',
    frame_name: 'Heart Fantasy',
    frame_url: 'bundled://heart-fantasy',
    frame2_name: 'Royal Gold',
    frame2_url: 'bundled://royal-gold',
    accent_color: '#38BDF8',
  },
];

const formatNumber = (value) => Number(value || 0).toLocaleString();

const formatDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

const bundledKey = (url) => (typeof url === 'string' && url.startsWith('bundled://') ? url.replace('bundled://', '') : null);

const introSource = (url) => {
  const key = bundledKey(url);
  if (key) return BUNDLED_INTROS[key] || null;
  return url ? { uri: url } : null;
};

const frameSource = (url) => {
  const key = bundledKey(url);
  if (key) return BUNDLED_FRAMES[key] || null;
  return url ? { uri: url } : null;
};

function AvatarPreview({ user, frameUrl }) {
  const initial = String(user?.name || 'U').trim().charAt(0).toUpperCase() || 'U';
  const source = frameSource(frameUrl);
  const hasAvatar = Boolean(user?.avatar && !user.avatar.includes('api.dicebear.com'));

  return (
    <View style={styles.avatarPreview}>
      {hasAvatar ? (
        <Image source={{ uri: user.avatar }} style={styles.previewAvatar} />
      ) : (
        <LinearGradient colors={['#8D37EE', '#F23AB7']} style={[styles.previewAvatar, styles.initialAvatar]}>
          <Text style={styles.initialText}>{initial}</Text>
        </LinearGradient>
      )}
      {source ? <Image source={source} style={styles.previewFrame} resizeMode="contain" /> : null}
    </View>
  );
}

function IntroPreviewModal({ item, onClose }) {
  const source = useMemo(() => introSource(item?.videoUrl) || DEFAULT_INTRO_VIDEO, [item?.videoUrl]);
  const { player, ready, finish } = useOneShotIntroPlayer(source, onClose);

  return (
    <Modal visible={!!item} transparent animationType="fade" statusBarTranslucent onRequestClose={finish}>
      <View style={styles.previewBackdrop}>
        <TouchableOpacity activeOpacity={1} style={styles.previewTapArea} onPress={finish}>
          <VideoView
            player={player}
            style={[styles.previewVideo, !ready && styles.previewVideoHidden]}
            nativeControls={false}
            contentFit="contain"
            pointerEvents="none"
          />
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

function FeaturePill({ text }) {
  return (
    <View style={styles.featurePill}>
      <Ionicons name="checkmark" size={12} color="#B5F5FF" />
      <Text style={styles.featureText} numberOfLines={1}>{text}</Text>
    </View>
  );
}

function SvipPackageCard({
  item, user, busy, selected, owned, onPreview, onBuy, onUse,
}) {
  const accent = item.accent_color || '#FBBF24';
  const features = Array.isArray(item.features) ? item.features : [];
  const thumbSource = introSource(item.intro_thumbnail_url) || DEFAULT_INTRO_THUMB;
  const thumb2Source = introSource(item.intro2_thumbnail_url) || DEFAULT_INTRO_THUMB;
  const buttonText = selected ? 'Used' : owned ? 'Use' : 'Activate Package';
  const buttonIcon = selected ? 'checkmark-circle' : owned ? 'color-wand' : 'ribbon';
  const disabled = busy || selected;

  return (
    <View style={[styles.packageCard, selected && { borderColor: accent }]}>
      <LinearGradient colors={[`${accent}33`, 'rgba(13,16,50,.94)']} style={styles.packageTop}>
        <View style={styles.packageBadge}>
          <Ionicons name="diamond" size={13} color="#FFFFFF" />
          <Text style={styles.packageBadgeText}>{item.duration_days || 30}d SVIP</Text>
        </View>
        <Text style={styles.packageName} numberOfLines={1}>{item.name}</Text>
        <Text style={styles.packagePrice}>{formatNumber(item.price)} 💎</Text>
      </LinearGradient>

      <View style={styles.packageMediaRow}>
        <View style={styles.mediaBlock}>
          <Text style={styles.mediaLabel}>Frame 1</Text>
          <AvatarPreview user={user} frameUrl={item.frame_url} />
          <Text style={styles.mediaName} numberOfLines={1}>{item.frame_name || 'SVIP Frame'}</Text>
        </View>
        <View style={styles.mediaBlock}>
          <Text style={styles.mediaLabel}>Frame 2</Text>
          <AvatarPreview user={user} frameUrl={item.frame2_url} />
          <Text style={styles.mediaName} numberOfLines={1}>{item.frame2_name || 'SVIP Frame'}</Text>
        </View>
      </View>

      <View style={styles.packageMediaRow}>
        <TouchableOpacity
          activeOpacity={0.86}
          style={styles.mediaBlock}
          onPress={() => onPreview({ videoUrl: item.intro_video_url })}
        >
          <Text style={styles.mediaLabel}>Intro 1</Text>
          <View style={styles.introThumbWrap}>
            <Image source={thumbSource} style={styles.introThumb} />
            <View style={styles.playButton}><Ionicons name="play" size={15} color="#FFFFFF" /></View>
          </View>
          <Text style={styles.mediaName} numberOfLines={1}>{item.intro_name || 'SVIP Intro'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          activeOpacity={0.86}
          style={styles.mediaBlock}
          onPress={() => onPreview({ videoUrl: item.intro2_video_url })}
        >
          <Text style={styles.mediaLabel}>Intro 2</Text>
          <View style={styles.introThumbWrap}>
            <Image source={thumb2Source} style={styles.introThumb} />
            <View style={styles.playButton}><Ionicons name="play" size={15} color="#FFFFFF" /></View>
          </View>
          <Text style={styles.mediaName} numberOfLines={1}>{item.intro2_name || 'SVIP Intro'}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.featuresGrid}>
        {features.slice(0, 4).map((feature) => <FeaturePill key={feature} text={feature} />)}
      </View>

      <TouchableOpacity disabled={disabled} activeOpacity={0.88} onPress={() => (owned ? onUse(item) : onBuy(item))}>
        <LinearGradient
          colors={selected
            ? ['#1CBB8C', '#168A79']
            : busy
              ? ['#57546E', '#3D3A56']
              : owned
                ? ['#38BDF8', '#8D37EE']
                : [accent, '#F237A5']}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={[styles.activateButton, disabled && !selected && { opacity: 0.7 }]}
        >
          {busy ? <LogoLoader size={28} /> : (
            <>
              <Ionicons name={buttonIcon} size={18} color="#FFFFFF" />
              <Text style={styles.activateText}>{buttonText}</Text>
            </>
          )}
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
}

export default function SvipScreen() {
  const router = useRouter();
  const { user, diamonds, refreshUser, svipSubscriptions } = useGlobalState();
  const [busyId, setBusyId] = useState(null);
  const [previewPackage, setPreviewPackage] = useState(null);
  const packages = svipSubscriptions?.length ? svipSubscriptions : FALLBACK_PACKAGES;

  const isVipActive = user?.vipType && user?.vipExpiresAt && new Date(user.vipExpiresAt) > new Date();

  const getPackageState = (item) => {
    const frameId = `svip:${item.id}:frame:1`;
    const frame2Id = `svip:${item.id}:frame:2`;
    const introId = `svip:${item.id}:intro:1`;
    const intro2Id = `svip:${item.id}:intro:2`;
    const owned = Boolean(
      user?.ownedProfileFrames?.includes(frameId)
      || user?.ownedProfileFrames?.includes(frame2Id)
      || user?.ownedMallIntros?.includes(introId)
      || user?.ownedMallIntros?.includes(intro2Id)
      || user?.selectedProfileFrame === frameId
      || user?.selectedProfileFrame === frame2Id
      || user?.selectedMallIntro === introId
      || user?.selectedMallIntro === intro2Id
    );
    const selected = Boolean(
      user?.selectedProfileFrame === frameId
      || user?.selectedProfileFrame === frame2Id
      || user?.selectedMallIntro === introId
      || user?.selectedMallIntro === intro2Id
      || (owned && user?.selectedProfileFrameUrl === item.frame_url)
      || (owned && user?.selectedProfileFrameUrl === item.frame2_url)
      || (owned && user?.selectedMallIntroVideoUrl === item.intro_video_url)
      || (owned && user?.selectedMallIntroVideoUrl === item.intro2_video_url)
    );
    return { owned, selected };
  };

  const handlePurchase = async (item) => {
    if (busyId) return;
    const ok = await confirmCuteAlert(
      'Activate SVIP Package',
      `${item.name} includes SVIP for ${item.duration_days || 30} days, two SVIP-only frames, two SVIP-only intros, and SVIP name tag for ${formatNumber(item.price)} 💎.`,
      { confirmText: 'Activate', cancelText: 'Not now' },
    );
    if (!ok) return;

    setBusyId(item.id);
    const { data, error } = await supabase.rpc('purchase_svip_subscription', {
      p_subscription_id: item.id,
    });
    if (!error) {
      try { await refreshUser?.(); } catch (_) {}
    }
    setBusyId(null);

    if (error) {
      showCuteAlert('Purchase failed', error.message);
      return;
    }

    showCuteAlert(
      'SVIP Activated',
      `${item.name} is active until ${formatDate(data?.expires_at)}. Your SVIP tag, primary frame, and primary intro are selected now.`,
      [{ text: 'Nice' }],
    );
  };

  const handleUse = async (item) => {
    if (busyId) return;
    setBusyId(item.id);
    const { error } = await supabase.rpc('use_svip_subscription', {
      p_subscription_id: item.id,
    });
    if (!error) {
      try { await refreshUser?.(); } catch (_) {}
    }
    setBusyId(null);

    if (error) {
      showCuteAlert('Could not use package', error.message);
      return;
    }

    showCuteAlert('Package selected', `${item.name} primary frame and intro are now active.`, [{ text: 'OK' }]);
  };

  return (
    <ImageBackground source={PAGE_BACKGROUND} style={styles.background} resizeMode="cover">
      <View style={styles.tint} />
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={27} color="#FFFFFF" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>SVIP Center</Text>
          <TouchableOpacity style={styles.walletBtn} onPress={() => router.push('/main/wallet')}>
            <Ionicons name="diamond" size={16} color="#8FE8FF" />
            <Text style={styles.walletText}>{formatNumber(diamonds)}</Text>
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          <View style={styles.hero}>
            <LinearGradient colors={['rgba(255,183,59,.88)', 'rgba(237,42,158,.82)']} style={styles.heroIcon}>
              <Ionicons name="ribbon" size={31} color="#FFFFFF" />
            </LinearGradient>
            <View style={styles.heroCopy}>
              <Text style={styles.heroTitle}>SVIP Packages</Text>
              <Text style={styles.heroSub}>SVIP tag, two frames, two intros, and premium room presence.</Text>
              {user?.vipType ? (
                <View style={styles.statusChip}>
                  <Ionicons name={isVipActive ? 'checkmark-circle' : 'time'} size={13} color="#FFFFFF" />
                  <Text style={styles.statusChipText} numberOfLines={1}>
                    {isVipActive
                      ? `${user.vipType} active · ${formatDate(user.vipExpiresAt)}`
                      : `${user.vipType} expired`}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>

          {packages.map((item) => {
            const { owned, selected } = getPackageState(item);
            return (
              <SvipPackageCard
                key={item.id}
                item={item}
                user={user}
                owned={owned}
                selected={selected}
                busy={busyId === item.id}
                onPreview={setPreviewPackage}
                onBuy={handlePurchase}
                onUse={handleUse}
              />
            );
          })}

          <View style={{ height: 28 }} />
        </ScrollView>
        {previewPackage ? <IntroPreviewModal item={previewPackage} onClose={() => setPreviewPackage(null)} /> : null}
      </SafeAreaView>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  background: { flex: 1, backgroundColor: '#07091F' },
  tint: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(3,5,24,.42)' },
  safe: { flex: 1 },
  header: { height: 58, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  backBtn: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: 'rgba(255,255,255,.18)', backgroundColor: 'rgba(13,16,50,.62)', alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '900' },
  walletBtn: { height: 38, minWidth: 92, paddingHorizontal: 11, borderRadius: 19, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(13,16,50,.7)', borderWidth: 1, borderColor: 'rgba(143,232,255,.28)' },
  walletText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  content: { paddingHorizontal: 16, paddingBottom: 24 },
  hero: { minHeight: 118, borderRadius: 18, padding: 15, marginTop: 4, marginBottom: 13, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(14,18,57,.72)', borderWidth: 1, borderColor: 'rgba(255,255,255,.16)' },
  heroIcon: { width: 64, height: 64, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginRight: 13 },
  heroCopy: { flex: 1, minWidth: 0 },
  heroTitle: { color: '#FFFFFF', fontSize: 25, fontWeight: '900' },
  heroSub: { color: 'rgba(255,255,255,.72)', fontSize: 12, lineHeight: 17, marginTop: 4 },
  statusChip: { alignSelf: 'flex-start', maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 12, marginTop: 9, backgroundColor: 'rgba(255,255,255,.12)' },
  statusChipText: { color: '#FFFFFF', fontSize: 10.5, fontWeight: '800' },
  packageCard: { borderRadius: 16, overflow: 'hidden', marginBottom: 14, borderWidth: 1, borderColor: 'rgba(151,75,255,.42)', backgroundColor: 'rgba(13,16,50,.94)' },
  packageTop: { paddingHorizontal: 14, paddingTop: 13, paddingBottom: 12 },
  packageBadge: { alignSelf: 'flex-start', height: 25, borderRadius: 13, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(255,255,255,.15)' },
  packageBadgeText: { color: '#FFFFFF', fontSize: 10.5, fontWeight: '900' },
  packageName: { color: '#FFFFFF', fontSize: 20, fontWeight: '900', marginTop: 9 },
  packagePrice: { color: '#DDFBFF', fontSize: 13, fontWeight: '900', marginTop: 3 },
  packageMediaRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 12, paddingTop: 12 },
  mediaBlock: { flex: 1, minWidth: 0, borderRadius: 13, padding: 10, alignItems: 'center', backgroundColor: 'rgba(255,255,255,.055)', borderWidth: 1, borderColor: 'rgba(255,255,255,.08)' },
  mediaLabel: { color: 'rgba(255,255,255,.55)', fontSize: 10, fontWeight: '900', textTransform: 'uppercase', marginBottom: 6 },
  mediaName: { color: '#FFFFFF', fontSize: 11, fontWeight: '800', marginTop: 6, textAlign: 'center' },
  avatarPreview: { width: 92, height: 92, alignItems: 'center', justifyContent: 'center' },
  previewAvatar: { position: 'absolute', width: 62, height: 62, borderRadius: 31, resizeMode: 'cover' },
  initialAvatar: { alignItems: 'center', justifyContent: 'center' },
  initialText: { color: '#FFFFFF', fontSize: 24, fontWeight: '900' },
  previewFrame: { width: 92, height: 92 },
  introThumbWrap: { width: '100%', aspectRatio: 1, borderRadius: 11, overflow: 'hidden', backgroundColor: '#080A26' },
  introThumb: { width: '100%', height: '100%', resizeMode: 'cover' },
  playButton: { position: 'absolute', left: '50%', top: '50%', width: 34, height: 34, marginLeft: -17, marginTop: -17, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,.52)', borderWidth: 1, borderColor: 'rgba(255,255,255,.35)' },
  featuresGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, paddingHorizontal: 12, paddingTop: 11 },
  featurePill: { maxWidth: '48%', height: 27, borderRadius: 14, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(77,211,255,.12)', borderWidth: 1, borderColor: 'rgba(77,211,255,.18)' },
  featureText: { flex: 1, minWidth: 0, color: '#EAF9FF', fontSize: 10.5, fontWeight: '700' },
  activateButton: { height: 48, margin: 12, borderRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  activateText: { color: '#FFFFFF', fontSize: 14, fontWeight: '900' },
  previewBackdrop: { flex: 1, backgroundColor: 'rgba(4, 5, 22, 0.74)', alignItems: 'center', justifyContent: 'center' },
  previewTapArea: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center' },
  previewVideo: { width: '100%', maxHeight: '92%', aspectRatio: 9 / 16, backgroundColor: 'transparent' },
  previewVideoHidden: { opacity: 0 },
});
