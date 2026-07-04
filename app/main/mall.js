import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Animated, Image, ImageBackground, Modal, RefreshControl, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View, useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { VideoView } from 'expo-video';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import { supabase } from '../../src/api/supabase';
import LogoLoader from '../../src/components/LogoLoader';
import { useOneShotIntroPlayer } from '../../src/hooks/useOneShotIntroPlayer';

const BANNER = require('../../assets/mall/unique-props-banner.webp');

const CATEGORIES = ['Intro', 'Frame'];

const BUNDLED_INTRO_ASSETS = {
  'football-cup.webp': require('../../assets/mall/intro/football-cup.webp'),
  'football-cup.m4v': require('../../assets/mall/intro/football-cup.m4v'),
  'blue-roses.webp': require('../../assets/mall/intro/blue-roses.webp'),
  'blue-roses.m4v': require('../../assets/mall/intro/blue-roses.m4v'),
};

const FALLBACK_INTRO_ITEMS = [
  {
    id: 'football-cup',
    name: 'Football Champions Cup',
    diamond_cost: 90000,
    thumbnail_url: 'bundled://football-cup.webp',
    video_url: 'bundled://football-cup.m4v',
  },
  {
    id: 'blue-roses',
    name: 'Blue Rose Bouquet',
    diamond_cost: 75000,
    thumbnail_url: 'bundled://blue-roses.webp',
    video_url: 'bundled://blue-roses.m4v',
  },
];

const mediaSource = (url) => {
  if (typeof url === 'number') return url;
  if (url?.startsWith?.('bundled://')) return BUNDLED_INTRO_ASSETS[url.replace('bundled://', '')];
  return url ? { uri: url } : null;
};

const FRAME_ITEMS = [
  { id: 'heart-fantasy', name: 'Heart Fantasy', price: 0, image: require('../../assets/mall/frames/heart-fantasy.webp') },
  { id: 'angel-wing', name: 'Angel Wings', price: 0, image: require('../../assets/mall/frames/angel-wing.webp') },
  { id: 'royal-gold', name: 'Royal Gold', price: 0, image: require('../../assets/mall/frames/royal-gold.webp') },
];

const BUNDLED_FRAME_ASSETS = Object.fromEntries(FRAME_ITEMS.map((item) => [item.id, item.image]));
const frameSource = (item) => {
  if (item?.frame_url?.startsWith('bundled://')) {
    return BUNDLED_FRAME_ASSETS[item.id];
  }
  return item?.frame_url ? { uri: item.frame_url } : item?.image;
};

const CATALOG = [
  { id: 'phoenix-wings', name: 'Phoenix Wings', category: 'Dress Up', price: 300000, icon: 'flame', colors: ['#FF7A16', '#D3154F'], duration: '7d' },
  { id: 'golden-city', name: 'Golden City', category: 'Room Frame', price: 30000000, icon: 'business', colors: ['#FFBA29', '#6D26D9'], duration: '7d' },
  { id: 'golden-diva', name: 'Golden Diva', category: 'Car', price: 150000, icon: 'car-sport', colors: ['#F4A32A', '#8A209A'], duration: '7d' },
  { id: 'warrior', name: 'Warrior', category: 'Dress Up', price: 150000, icon: 'shield', colors: ['#FF6033', '#3447AD'], duration: '7d' },
  { id: 'fiery-tiger', name: 'Fiery Tiger', category: 'Frame', price: 150000, icon: 'paw', colors: ['#FF8D20', '#C71D19'], duration: '7d' },
  { id: 'dual-dragons', name: 'Dual Dragons', category: 'Frame', price: 150000, icon: 'infinite', colors: ['#E51E3E', '#08A8DC'], duration: '7d' },
  { id: 'demon-bull', name: 'Demon Bull', category: 'Dress Up', price: 150000, icon: 'skull', colors: ['#E6311E', '#491288'], duration: '7d' },
  { id: 'inferno-wolf', name: 'Inferno Wolf', category: 'Business Card', price: 150000, icon: 'bonfire', colors: ['#FF3A19', '#4A0A56'], duration: '7d' },
  { id: 'royal-lion', name: 'Royal Lion', category: 'Business Card', price: 150000, icon: 'ribbon', colors: ['#FFB51E', '#78401B'], duration: '7d' },
];

const formatNumber = (value) => Number(value || 0).toLocaleString();

function BalanceChip({ icon, value, color }) {
  return (
    <View style={styles.balanceChip}>
      <Ionicons name={icon} size={16} color={color} />
      <Text style={styles.balanceValue}>{formatNumber(value)}</Text>
      <View style={styles.plusButton}><Ionicons name="add" size={18} color="#C9CAFF" /></View>
    </View>
  );
}

function CatalogCard({ item, width, onPress }) {
  return (
    <TouchableOpacity activeOpacity={0.87} style={[styles.productCard, { width }]} onPress={onPress}>
      <LinearGradient colors={['#202349', '#151735']} style={styles.productFill}>
        <LinearGradient colors={item.colors} style={styles.productArtwork}>
          <Ionicons name={item.icon} size={45} color="#FFFFFF" />
          <View style={styles.artGlow} />
        </LinearGradient>
        <View style={styles.favoriteCorner}><Ionicons name="sparkles" size={11} color="#FFFFFF" /></View>
        <Text style={styles.productName} numberOfLines={1}>{item.name}</Text>
        <View style={styles.priceRow}>
          <Ionicons name="diamond" size={11} color="#72A9FF" />
          <Text style={styles.priceText} numberOfLines={1}>{formatNumber(item.price)}</Text>
          <Text style={styles.durationText}>/{item.duration}</Text>
        </View>
      </LinearGradient>
    </TouchableOpacity>
  );
}

function OwnedCard({ item, width, onPress }) {
  return (
    <TouchableOpacity activeOpacity={0.87} style={[styles.productCard, { width }]} onPress={onPress}>
      <LinearGradient colors={['#24264B', '#151735']} style={styles.productFill}>
        <View style={styles.ownedArtwork}>
          {item.icon_url ? (
            <Image source={{ uri: item.icon_url }} style={styles.ownedImage} />
          ) : (
            <Ionicons name="sparkles" size={43} color="#B97AFF" />
          )}
          <View style={styles.quantityBadge}><Text style={styles.quantityText}>x{item.quantity}</Text></View>
        </View>
        <Text style={styles.productName} numberOfLines={1}>{item.name}</Text>
        <Text style={styles.ownedType} numberOfLines={1}>{item.item_type || 'Prop'}</Text>
      </LinearGradient>
    </TouchableOpacity>
  );
}

function IntroCard({ item, width, selected, owned, active, onPress }) {
  const statusLabel = active ? 'Using' : owned ? 'Use' : null;

  return (
    <TouchableOpacity
      activeOpacity={0.88}
      style={[styles.introCard, { width }, selected && styles.introCardSelected]}
      onPress={onPress}
    >
      <Image source={mediaSource(item.thumbnail_url) || item.thumbnail} style={styles.introThumbnail} />
      <LinearGradient colors={['transparent', 'rgba(5,6,28,.96)']} style={styles.introShade} />
      <View style={styles.previewPill}>
        <Ionicons name="play" size={12} color="#FFFFFF" />
        <Text style={styles.previewPillText}>Preview</Text>
      </View>
      {selected ? (
        <View style={styles.selectedBadge}><Ionicons name="checkmark" size={14} color="#FFFFFF" /></View>
      ) : null}
      <Text style={styles.introName} numberOfLines={2}>{item.name}</Text>
      {statusLabel ? (
        <View style={[styles.introStatusPill, active && styles.introStatusPillActive]}>
          <Text style={styles.introStatusText}>{statusLabel}</Text>
        </View>
      ) : (
        <View style={styles.introPriceRow}>
          <Ionicons name="diamond" size={12} color="#72A9FF" />
          <Text style={styles.introPrice}>{formatNumber(item.diamond_cost ?? item.price)}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

function ProfileAvatar({ user, style }) {
  const initial = String(user?.name || 'U').trim().charAt(0).toUpperCase() || 'U';
  const hasUploadedAvatar = Boolean(user?.avatar && !user.avatar.includes('api.dicebear.com'));
  return hasUploadedAvatar ? (
    <Image source={{ uri: user.avatar }} style={style} />
  ) : (
    <LinearGradient colors={['#8D37EE', '#F23AB7']} style={[style, styles.initialAvatar]}>
      <Text style={styles.initialText}>{initial}</Text>
    </LinearGradient>
  );
}

function FrameCard({ item, width, user, selected, onPress }) {
  return (
    <TouchableOpacity
      activeOpacity={0.88}
      style={[styles.frameCard, { width }, selected && styles.frameCardSelected]}
      onPress={onPress}
    >
      <View style={styles.frameCardPreview}>
        <ProfileAvatar user={user} style={styles.frameCardAvatar} />
        <Image source={frameSource(item)} style={styles.frameCardArtwork} />
        {selected ? (
          <View style={styles.selectedBadge}><Ionicons name="checkmark" size={14} color="#FFFFFF" /></View>
        ) : null}
      </View>
      <Text style={styles.frameName} numberOfLines={1}>{item.name}</Text>
      <View style={styles.introPriceRow}>
        <Ionicons name="diamond" size={12} color="#72A9FF" />
        <Text style={styles.introPrice}>{formatNumber(item.diamond_cost ?? item.price)}</Text>
      </View>
    </TouchableOpacity>
  );
}

function AnimationPreview({ item, onClose }) {
  const introSource = useMemo(() => mediaSource(item.video_url) || item.video, [item]);
  const { player, ready, finish } = useOneShotIntroPlayer(introSource, onClose);

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={finish}>
      <View style={styles.previewBackdrop}>
        <TouchableOpacity activeOpacity={1} style={styles.previewTapArea} onPress={finish}>
          <VideoView
            player={player}
            style={[styles.previewVideo, !ready && styles.introVideoHidden]}
            nativeControls={false}
            contentFit="contain"
            pointerEvents="none"
          />
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

function IntroActions({ item, primaryLabel = 'Buy', primaryDisabled = false, onBuy, onSend }) {
  const pulse = React.useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse]);

  const animatedStyle = {
    transform: [{
      scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.025] }),
    }],
  };

  return (
    <View style={styles.introActions}>
      <Text style={styles.selectedIntroLabel} numberOfLines={1}>{item.name}</Text>
      <View style={styles.introActionRow}>
        <Animated.View style={[styles.introActionWrap, animatedStyle]}>
          <TouchableOpacity activeOpacity={0.86} onPress={onBuy} disabled={primaryDisabled}>
            <LinearGradient
              colors={primaryDisabled ? ['#5B5875', '#3B3954'] : primaryLabel === 'Use' ? ['#16B6C8', '#6A43F5'] : ['#FF3BBE', '#8D35F1']}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={[styles.introActionButton, primaryDisabled && styles.introActionButtonDisabled]}
            >
              <Ionicons name={primaryLabel === 'Buy' ? 'bag-check' : 'checkmark-circle'} size={19} color="#FFFFFF" />
              <Text style={styles.introActionText}>{primaryLabel}</Text>
            </LinearGradient>
          </TouchableOpacity>
        </Animated.View>
        <Animated.View style={[styles.introActionWrap, animatedStyle]}>
          <TouchableOpacity activeOpacity={0.86} onPress={onSend}>
            <LinearGradient
              colors={['#6A43F5', '#12BCEB']}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={styles.introActionButton}
            >
              <Ionicons name="paper-plane" size={18} color="#FFFFFF" />
              <Text style={styles.introActionText}>Send</Text>
            </LinearGradient>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </View>
  );
}

export default function MallScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { width } = useWindowDimensions();
  const { diamonds, beans, user, refreshUser } = useGlobalState();
  const [mode, setMode] = useState(params.tab === 'props' ? 'props' : 'mall');
  const [category, setCategory] = useState('Intro');
  const [ownedItems, setOwnedItems] = useState([]);
  const [loadingProps, setLoadingProps] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedIntro, setSelectedIntro] = useState(null);
  const [previewIntro, setPreviewIntro] = useState(null);
  const [availableIntros, setAvailableIntros] = useState(FALLBACK_INTRO_ITEMS);
  const [buyingIntro, setBuyingIntro] = useState(false);
  const [sendIntroTarget, setSendIntroTarget] = useState(null);
  const [recipientDisplayId, setRecipientDisplayId] = useState('');
  const [sendingIntro, setSendingIntro] = useState(false);
  const [selectedFrame, setSelectedFrame] = useState(FRAME_ITEMS[0]);
  const [availableFrames, setAvailableFrames] = useState(FRAME_ITEMS);
  const [buyingFrame, setBuyingFrame] = useState(false);
  const refreshUserRef = useRef(refreshUser);
  const ownedIntroIds = useMemo(
    () => new Set(Array.isArray(user?.ownedMallIntros) ? user.ownedMallIntros : []),
    [user?.ownedMallIntros],
  );

  useEffect(() => {
    setMode(params.tab === 'props' ? 'props' : 'mall');
  }, [params.tab]);

  useEffect(() => {
    refreshUserRef.current = refreshUser;
  }, [refreshUser]);

  const loadIntros = useCallback(async () => {
    const { data, error } = await supabase.from('mall_intro_items').select('*')
      .eq('is_active', true).order('display_order').order('created_at');
    if (!error && Array.isArray(data)) {
      const nextIntros = data.length ? data : FALLBACK_INTRO_ITEMS;
      setAvailableIntros(nextIntros);
      setSelectedIntro((current) => {
        if (current) {
          return nextIntros.find((item) => item.id === current.id)
            || nextIntros.find((item) => item.id === user?.selectedMallIntro)
            || nextIntros[0]
            || null;
        }
        return nextIntros.find((item) => item.id === user?.selectedMallIntro) || nextIntros[0] || null;
      });
    }
  }, [user?.selectedMallIntro]);

  useEffect(() => {
    loadIntros();
    const channel = supabase.channel(`mall-intros-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mall_intro_items' }, loadIntros)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') loadIntros();
      });
    return () => { supabase.removeChannel(channel); };
  }, [loadIntros]);

  const loadFrames = useCallback(async () => {
    const { data, error } = await supabase.from('profile_frames').select('*')
      .eq('is_active', true).order('display_order').order('created_at');
    if (!error && Array.isArray(data)) {
      const nextFrames = data.length ? data : FRAME_ITEMS;
      setAvailableFrames(nextFrames);
      const active = nextFrames.find((item) => item.id === user?.selectedProfileFrame);
      if (active) setSelectedFrame(active);
      else setSelectedFrame((current) => nextFrames.find((item) => item.id === current?.id) || nextFrames[0]);
    }
  }, [user?.selectedProfileFrame]);

  useEffect(() => {
    const activeFrame = availableFrames.find((item) => item.id === user?.selectedProfileFrame);
    if (activeFrame) setSelectedFrame(activeFrame);
  }, [availableFrames, user?.selectedProfileFrame]);

  useEffect(() => {
    loadFrames();
    const channel = supabase.channel(`mall-profile-frames-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profile_frames' }, () => {
        loadFrames();
        refreshUserRef.current?.();
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') loadFrames();
      });
    return () => { supabase.removeChannel(channel); };
  }, [loadFrames]);

  const loadProps = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoadingProps(true);
    const { data, error } = await supabase.rpc('get_my_bag');
    if (error) {
      Alert.alert('My Props', error.message);
      setOwnedItems([]);
    } else {
      setOwnedItems(Array.isArray(data) ? data : []);
    }
    setLoadingProps(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    if (mode === 'props') loadProps();
  }, [mode, loadProps]);

  const products = useMemo(
    () => CATALOG.filter((item) => item.category === category),
    [category],
  );
  const horizontalPadding = 16;
  const gap = 8;
  const contentWidth = Math.min(width, 560) - horizontalPadding * 2;
  const cardWidth = (contentWidth - gap * 2) / 3;

  const openProps = () => {
    setMode('props');
    router.setParams({ tab: 'props' });
  };

  const openMall = () => {
    setMode('mall');
    router.setParams({ tab: undefined });
  };

  const buySelectedFrame = async () => {
    if (!selectedFrame || buyingFrame) return;
    setBuyingFrame(true);
    const { data, error } = await supabase.rpc('purchase_profile_frame', { p_frame_id: selectedFrame.id });
    if (!error && data?.success) await refreshUser();
    setBuyingFrame(false);
    if (error) {
      Alert.alert('Purchase failed', error.message);
      return;
    }
    Alert.alert('Frame selected', `${selectedFrame.name} is now your permanent profile frame.`);
  };

  const buySelectedIntro = async () => {
    if (!selectedIntro || buyingIntro) return;
    const isOwned = ownedIntroIds.has(selectedIntro.id);
    const isActive = user?.selectedMallIntro === selectedIntro.id;
    if (isOwned && isActive) return;

    setBuyingIntro(true);
    const { data, error } = await supabase.rpc('purchase_mall_intro', { p_intro_id: selectedIntro.id });
    if (!error && data?.success) await refreshUser();
    setBuyingIntro(false);
    if (error) {
      Alert.alert('Purchase failed', error.message);
      return;
    }
    Alert.alert(isOwned ? 'Intro selected' : 'Intro purchased', `${selectedIntro.name} will play when you join a live room.`);
  };

  const openSendIntro = (intro) => {
    if (!intro) return;
    setSendIntroTarget(intro);
    setRecipientDisplayId('');
  };

  const sendSelectedIntro = async () => {
    const displayId = Number(recipientDisplayId);
    if (!sendIntroTarget || sendingIntro || !Number.isFinite(displayId)) {
      Alert.alert('Recipient ID required', 'Enter the user ID shown on their profile.');
      return;
    }
    setSendingIntro(true);
    const { data, error } = await supabase.rpc('gift_mall_intro', {
      p_intro_id: sendIntroTarget.id,
      p_recipient_display_id: displayId,
    });
    if (!error && data?.success) await refreshUser();
    setSendingIntro(false);
    if (error) {
      Alert.alert('Send failed', error.message);
      return;
    }
    setSendIntroTarget(null);
    Alert.alert('Intro sent', `${sendIntroTarget.name} was sent successfully.`);
  };

  const hasBottomActions = mode === 'mall' && (
    (category === 'Intro' && selectedIntro) ||
    (category === 'Frame' && selectedFrame)
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={[styles.page, { maxWidth: 560 }]}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.headerCircle} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={25} color="#FFFFFF" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{mode === 'props' ? 'My Props' : 'Store'}</Text>
          <TouchableOpacity style={styles.propsButton} onPress={mode === 'props' ? openMall : openProps}>
            <Ionicons name={mode === 'props' ? 'storefront-outline' : 'bag-handle-outline'} size={17} color="#FFFFFF" />
            <Text style={styles.propsButtonText}>{mode === 'props' ? 'Store' : 'My Props'}</Text>
          </TouchableOpacity>
        </View>

        {mode === 'mall' ? (
          <>
            <ScrollView
              horizontal
              style={styles.tabsScroll}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.tabs}
            >
              {CATEGORIES.map((item) => (
                <TouchableOpacity key={item} onPress={() => setCategory(item)}>
                  {category === item ? (
                    <LinearGradient colors={['#2953D7', '#6526C8']} style={styles.activeTab}>
                      <Text style={styles.activeTabText}>{item}</Text>
                    </LinearGradient>
                  ) : (
                    <View style={styles.tab}><Text style={styles.tabText}>{item}</Text></View>
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>

            {category !== 'Frame' ? (
              <View style={styles.balanceRow}>
                <BalanceChip icon="star" value={beans} color="#FFC726" />
                <BalanceChip icon="diamond" value={diamonds} color="#6FA5FF" />
              </View>
            ) : null}

            {category === 'Frame' ? (
              <View style={styles.profileFrameShowcase}>
                <ProfileAvatar user={user} style={styles.showcaseAvatar} />
                <Image source={frameSource(selectedFrame)} style={styles.showcaseFrame} />
                <View style={styles.showcaseCaption}>
                  <Text style={styles.showcaseName}>{user?.name || 'Your Profile'}</Text>
                  <Text style={styles.showcaseFrameName}>{selectedFrame.name}</Text>
                </View>
              </View>
            ) : (
              <TouchableOpacity activeOpacity={0.9} style={styles.bannerTouch}>
                <ImageBackground source={BANNER} style={styles.banner} imageStyle={styles.bannerImage} resizeMode="cover" />
              </TouchableOpacity>
            )}
          </>
        ) : null}

        <ScrollView
          style={[
            styles.productScroll,
            hasBottomActions && styles.productScrollWithActions,
          ]}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          refreshControl={mode === 'props' ? <RefreshControl refreshing={refreshing} tintColor="#A34BFF" onRefresh={() => loadProps(true)} /> : undefined}
        >
          {mode === 'mall' ? (
            <>
              <View style={styles.sectionHeader}>
                <View style={styles.sectionTitleRow}>
                  <Ionicons name="sparkles" size={21} color="#9E51FF" />
                  <Text style={styles.sectionTitle}>{category === 'Intro' ? 'Popular Props' : category}</Text>
                </View>
                <TouchableOpacity onPress={() => setCategory('Intro')} style={styles.seeAll}>
                  <Text style={styles.seeAllText}>See All</Text>
                  <Ionicons name="chevron-forward" size={14} color="#989AB6" />
                </TouchableOpacity>
              </View>
              <View style={styles.grid}>
                {category === 'Intro' ? availableIntros.map((item) => (
                  <IntroCard
                    key={item.id}
                    item={item}
                    width={cardWidth}
                    selected={selectedIntro?.id === item.id}
                    owned={ownedIntroIds.has(item.id)}
                    active={user?.selectedMallIntro === item.id}
                    onPress={() => {
                      setSelectedIntro(item);
                      setPreviewIntro(item);
                    }}
                  />
                )) : category === 'Frame' ? availableFrames.map((item) => (
                  <FrameCard
                    key={item.id}
                    item={item}
                    width={cardWidth}
                    user={user}
                    selected={selectedFrame.id === item.id}
                    onPress={() => setSelectedFrame(item)}
                  />
                )) : products.map((item) => (
                  <CatalogCard
                    key={item.id}
                    item={item}
                    width={cardWidth}
                    onPress={() => Alert.alert(item.name, `${formatNumber(item.price)} diamonds for ${item.duration}. Purchasing will be available when the Store catalog is connected.`)}
                  />
                ))}
              </View>
            </>
          ) : loadingProps ? (
            <View style={styles.loader}><LogoLoader size="medium" /></View>
          ) : ownedItems.length ? (
            <>
              <View style={styles.sectionHeader}>
                <View style={styles.sectionTitleRow}>
                  <Ionicons name="bag-handle" size={20} color="#B866FF" />
                  <Text style={styles.sectionTitle}>My Collection</Text>
                </View>
                <Text style={styles.itemCount}>{ownedItems.length} items</Text>
              </View>
              <View style={styles.grid}>
                {ownedItems.map((item) => (
                  <OwnedCard
                    key={item.item_id}
                    item={item}
                    width={cardWidth}
                    onPress={() => router.push('/main/bag')}
                  />
                ))}
              </View>
            </>
          ) : (
            <View style={styles.emptyState}>
              <Ionicons name="bag-handle-outline" size={54} color="rgba(174,91,255,.45)" />
              <Text style={styles.emptyTitle}>No props yet</Text>
              <Text style={styles.emptyCopy}>Explore the Store and collect something uniquely yours.</Text>
              <TouchableOpacity onPress={openMall}>
                <LinearGradient colors={['#275CFF', '#A229ED']} style={styles.exploreButton}>
                  <Text style={styles.exploreButtonText}>Explore Store</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}
          <View style={{ height: 26 }} />
        </ScrollView>
        {mode === 'mall' && category === 'Intro' && selectedIntro ? (
          <IntroActions
            item={selectedIntro}
            primaryLabel={user?.selectedMallIntro === selectedIntro.id ? 'Using' : ownedIntroIds.has(selectedIntro.id) ? 'Use' : 'Buy'}
            primaryDisabled={user?.selectedMallIntro === selectedIntro.id}
            onBuy={buySelectedIntro}
            onSend={() => openSendIntro(selectedIntro)}
          />
        ) : mode === 'mall' && category === 'Frame' && selectedFrame ? (
          <IntroActions
            item={selectedFrame}
            onBuy={buySelectedFrame}
            onSend={() => Alert.alert('Send Frame', `${selectedFrame.name} is selected. Choose-a-friend gifting will be connected here.`)}
          />
        ) : null}
      </View>
      {previewIntro ? <AnimationPreview item={previewIntro} onClose={() => setPreviewIntro(null)} /> : null}
      <Modal visible={!!sendIntroTarget} transparent animationType="fade" onRequestClose={() => setSendIntroTarget(null)}>
        <View style={styles.sendIntroOverlay}>
          <View style={styles.sendIntroCard}>
            <Text style={styles.sendIntroTitle}>Send Intro</Text>
            <Text style={styles.sendIntroSubtitle} numberOfLines={2}>
              Send {sendIntroTarget?.name} to a user by profile ID.
            </Text>
            <TextInput
              value={recipientDisplayId}
              onChangeText={(text) => setRecipientDisplayId(text.replace(/[^0-9]/g, '').slice(0, 12))}
              keyboardType="number-pad"
              placeholder="Recipient ID"
              placeholderTextColor="rgba(255,255,255,0.45)"
              style={styles.sendIntroInput}
            />
            <View style={styles.sendIntroActions}>
              <TouchableOpacity style={styles.sendIntroCancel} onPress={() => setSendIntroTarget(null)} disabled={sendingIntro}>
                <Text style={styles.sendIntroCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.sendIntroSubmit, sendingIntro && { opacity: 0.55 }]} onPress={sendSelectedIntro} disabled={sendingIntro}>
                <LinearGradient colors={['#6A43F5', '#12BCEB']} style={styles.sendIntroSubmitGradient}>
                  <Text style={styles.sendIntroSubmitText}>{sendingIntro ? 'Sending…' : 'Send'}</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#07091F' },
  page: { flex: 1, width: '100%', alignSelf: 'center' },
  header: { height: 58, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerCircle: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: 'rgba(120,106,210,.25)', backgroundColor: 'rgba(19,20,55,.72)', alignItems: 'center', justifyContent: 'center' },
  headerTitle: { position: 'absolute', left: 80, right: 80, textAlign: 'center', color: '#FFFFFF', fontSize: 20, fontWeight: '700' },
  propsButton: { minWidth: 92, height: 38, paddingHorizontal: 11, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(111,101,191,.28)', backgroundColor: 'rgba(18,20,54,.76)', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  propsButtonText: { color: '#E7E5F4', fontSize: 12 },
  tabsScroll: { height: 37, flexGrow: 0, flexShrink: 0 },
  tabs: { height: 37, paddingHorizontal: 16, gap: 8, alignItems: 'center', paddingBottom: 3 },
  activeTab: { height: 34, paddingHorizontal: 19, borderRadius: 17, justifyContent: 'center', borderWidth: 1, borderColor: '#6F6CFF' },
  activeTabText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  tab: { height: 34, paddingHorizontal: 10, justifyContent: 'center' },
  tabText: { color: '#BCBDD0', fontSize: 12 },
  balanceRow: { height: 43, paddingHorizontal: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  balanceChip: { height: 34, minWidth: 94, borderRadius: 17, borderWidth: 1, borderColor: '#323A83', backgroundColor: '#111431', paddingLeft: 10, paddingRight: 5, flexDirection: 'row', alignItems: 'center', gap: 6 },
  balanceValue: { color: '#FFFFFF', fontSize: 12, flex: 1 },
  plusButton: { width: 23, height: 23, borderRadius: 6, backgroundColor: '#28316F', alignItems: 'center', justifyContent: 'center' },
  productScroll: { flex: 1 },
  productScrollWithActions: { marginBottom: 112 },
  scrollContent: { paddingHorizontal: 16 },
  bannerTouch: { height: 155, borderRadius: 13, overflow: 'hidden', marginTop: 0, marginHorizontal: 16 },
  banner: { flex: 1 },
  bannerImage: { borderRadius: 13 },
  sectionHeader: { height: 59, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { color: '#F6F4FF', fontSize: 16, fontWeight: '700' },
  seeAll: { flexDirection: 'row', alignItems: 'center' },
  seeAllText: { color: '#989AB6', fontSize: 11 },
  itemCount: { color: '#989AB6', fontSize: 11 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  productCard: { height: 190, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: '#32365E' },
  productFill: { flex: 1, padding: 7 },
  productArtwork: { height: 117, borderRadius: 8, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  artGlow: { position: 'absolute', width: 82, height: 82, borderRadius: 41, backgroundColor: 'rgba(255,255,255,.12)' },
  favoriteCorner: { position: 'absolute', top: 0, right: 0, width: 23, height: 29, backgroundColor: '#7549EF', borderBottomLeftRadius: 8, alignItems: 'center', justifyContent: 'center' },
  productName: { color: '#F6F5FB', fontSize: 11.5, textAlign: 'center', marginTop: 8 },
  priceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 5 },
  priceText: { color: '#A25CFF', fontSize: 10.5, fontWeight: '700', maxWidth: '70%' },
  durationText: { color: '#8F91A9', fontSize: 8.5 },
  ownedArtwork: { height: 117, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#11132E' },
  ownedImage: { width: '88%', height: '88%', resizeMode: 'contain' },
  quantityBadge: { position: 'absolute', right: 5, bottom: 5, minWidth: 25, height: 19, borderRadius: 10, paddingHorizontal: 5, backgroundColor: '#7C3AED', alignItems: 'center', justifyContent: 'center' },
  quantityText: { color: '#FFFFFF', fontSize: 9, fontWeight: '800' },
  ownedType: { color: '#9A73E8', fontSize: 9.5, textAlign: 'center', marginTop: 4, textTransform: 'capitalize' },
  introCard: { height: 190, borderRadius: 11, overflow: 'hidden', borderWidth: 1, borderColor: '#34385F', backgroundColor: '#151735' },
  introCardSelected: { borderWidth: 2, borderColor: '#A858FF', shadowColor: '#A858FF', shadowOpacity: .75, shadowRadius: 10, elevation: 8 },
  introThumbnail: { width: '100%', height: '100%', resizeMode: 'cover' },
  introShade: { ...StyleSheet.absoluteFillObject, top: '48%' },
  previewPill: { position: 'absolute', top: 8, left: 8, height: 24, borderRadius: 12, paddingHorizontal: 9, backgroundColor: 'rgba(67,35,161,.84)', flexDirection: 'row', alignItems: 'center', gap: 4 },
  previewPillText: { color: '#FFFFFF', fontSize: 9.5, fontWeight: '700' },
  selectedBadge: { position: 'absolute', top: 7, right: 7, width: 25, height: 25, borderRadius: 13, backgroundColor: '#8C40F3', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#D8B8FF' },
  introName: { position: 'absolute', left: 8, right: 8, bottom: 28, color: '#FFFFFF', fontSize: 11.5, lineHeight: 15, textAlign: 'center', fontWeight: '700' },
  introPriceRow: { position: 'absolute', left: 8, right: 8, bottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  introPrice: { color: '#A96BFF', fontSize: 11, fontWeight: '900' },
  introStatusPill: { position: 'absolute', left: 8, right: 8, bottom: 8, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(27, 186, 202, 0.86)', borderWidth: 1, borderColor: 'rgba(255,255,255,.3)' },
  introStatusPillActive: { backgroundColor: 'rgba(140, 64, 243, 0.9)' },
  introStatusText: { color: '#FFFFFF', fontSize: 10.5, fontWeight: '900' },
  initialAvatar: { alignItems: 'center', justifyContent: 'center' },
  initialText: { color: '#FFFFFF', fontSize: 34, fontWeight: '900' },
  profileFrameShowcase: { height: 155, marginHorizontal: 16, borderRadius: 14, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: '#101333', borderWidth: 1, borderColor: 'rgba(122,72,226,.5)' },
  showcaseAvatar: { position: 'absolute', width: 104, height: 104, borderRadius: 52, resizeMode: 'cover' },
  showcaseFrame: { width: 145, height: 145, resizeMode: 'contain' },
  showcaseCaption: { position: 'absolute', left: 10, bottom: 9, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 10, backgroundColor: 'rgba(5,6,28,.72)' },
  showcaseName: { color: '#FFFFFF', fontSize: 11, fontWeight: '800' },
  showcaseFrameName: { color: '#BE91FF', fontSize: 8.5, marginTop: 1 },
  frameCard: { height: 190, borderRadius: 11, overflow: 'hidden', borderWidth: 1, borderColor: '#34385F', backgroundColor: '#151735', padding: 6 },
  frameCardSelected: { borderWidth: 2, borderColor: '#A858FF', shadowColor: '#A858FF', shadowOpacity: .75, shadowRadius: 10, elevation: 8 },
  frameCardPreview: { height: 127, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#10122E', overflow: 'hidden' },
  frameCardAvatar: { position: 'absolute', width: 71, height: 71, borderRadius: 36, resizeMode: 'cover' },
  frameCardArtwork: { width: 112, height: 112, resizeMode: 'contain' },
  frameName: { color: '#FFFFFF', fontSize: 10.5, fontWeight: '700', textAlign: 'center', marginTop: 6 },
  introActions: { position: 'absolute', left: 16, right: 16, bottom: 12, zIndex: 10, padding: 11, borderRadius: 15, borderWidth: 1, borderColor: 'rgba(151,75,255,.55)', backgroundColor: 'rgba(24,18,62,.96)', shadowColor: '#812DDE', shadowOpacity: .38, shadowRadius: 14, elevation: 12 },
  selectedIntroLabel: { color: '#EDE9FF', fontSize: 11.5, fontWeight: '700', textAlign: 'center', marginBottom: 9 },
  introActionRow: { flexDirection: 'row', gap: 10 },
  introActionWrap: { flex: 1, borderRadius: 22, shadowColor: '#B645FF', shadowOpacity: .55, shadowRadius: 10, elevation: 7 },
  introActionButton: { height: 44, borderRadius: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,.38)' },
  introActionButtonDisabled: { opacity: 0.88 },
  introActionText: { color: '#FFFFFF', fontSize: 14, fontWeight: '900' },
  previewBackdrop: { flex: 1, backgroundColor: 'rgba(4, 5, 22, 0.72)', alignItems: 'center', justifyContent: 'center' },
  previewTapArea: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center' },
  previewVideo: { width: '100%', maxHeight: '92%', aspectRatio: 9 / 16, backgroundColor: 'transparent' },
  introVideoHidden: { opacity: 0 },
  sendIntroOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', alignItems: 'center', justifyContent: 'center', padding: 22 },
  sendIntroCard: { width: '100%', maxWidth: 360, borderRadius: 24, padding: 20, backgroundColor: '#111431', borderWidth: 1, borderColor: 'rgba(151,75,255,.45)' },
  sendIntroTitle: { color: '#FFF', fontSize: 20, fontWeight: '900', textAlign: 'center' },
  sendIntroSubtitle: { color: 'rgba(255,255,255,0.66)', fontSize: 12, textAlign: 'center', lineHeight: 17, marginTop: 8 },
  sendIntroInput: { height: 50, borderRadius: 16, marginTop: 18, paddingHorizontal: 15, color: '#FFF', fontSize: 16, fontWeight: '800', backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)' },
  sendIntroActions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  sendIntroCancel: { flex: 1, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)' },
  sendIntroCancelText: { color: '#EDE9FF', fontSize: 14, fontWeight: '800' },
  sendIntroSubmit: { flex: 1, height: 46, borderRadius: 23, overflow: 'hidden' },
  sendIntroSubmitGradient: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  sendIntroSubmitText: { color: '#FFF', fontSize: 14, fontWeight: '900' },
  loader: { height: 350, alignItems: 'center', justifyContent: 'center' },
  emptyState: { minHeight: 410, paddingHorizontal: 35, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: '#FFFFFF', fontSize: 19, fontWeight: '800', marginTop: 14 },
  emptyCopy: { color: '#9697B0', fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 7, marginBottom: 19 },
  exploreButton: { height: 40, borderRadius: 20, paddingHorizontal: 22, alignItems: 'center', justifyContent: 'center' },
  exploreButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
});
