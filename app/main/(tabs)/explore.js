import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, TextInput, ScrollView, Image, TouchableOpacity, Dimensions, Alert, RefreshControl, Modal, FlatList } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { useGlobalState } from '../../../src/context/GlobalStateContext';
import { supabase } from '../../../src/api/supabase';
import LogoLoader from '../../../src/components/LogoLoader';
import { showCuteAlert } from '../../../src/components/CuteAlert';
import { BRAND } from '../../../src/theme/brand';

const MAX_MOMENT_IMAGE_KB = 500;
const TIER_COLORS = { 1: '#FCD34D', 2: '#CBD5E1', 3: '#D97706' };
const TIER_ICONS  = {
  1: 'https://img.icons8.com/3d-fluency/94/crown.png',
  2: 'https://img.icons8.com/fluency/96/silver-medal.png',
  3: 'https://img.icons8.com/fluency/96/bronze-medal.png',
};

const relativeTime = (iso) => {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60)     return 'just now';
  if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)  return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
};

const { width } = Dimensions.get('window');



export default function ExploreScreen() {
  const router = useRouter();
  const { user } = useGlobalState();
  const [searchQuery, setSearchQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // User search
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showSearchResults, setShowSearchResults] = useState(false);
  
  // Post Creation States
  const [postText, setPostText] = useState('');
  const [postImage, setPostImage] = useState(null);
  const [selectedMood, setSelectedMood] = useState(null);
  const [moments, setMoments] = useState([]);
  const [loadingMoments, setLoadingMoments] = useState(true);
  const [showMoodModal, setShowMoodModal] = useState(false);
  const [likedMoments, setLikedMoments] = useState({}); // { id: boolean }
  const [posting, setPosting] = useState(false);

  // Daily top broadcasters
  const [topBroadcasters, setTopBroadcasters] = useState([]); // top 3 for the widget
  const [topAll, setTopAll]                   = useState([]); // top 20 for the sheet

  // Podium order is derived state — index swap so #1 sits in the centre.
  // Computed once per change to `topBroadcasters` instead of every render
  // of the parent (the old call site rebuilt the array inside the JSX
  // callback, which fed Image components a "new" prop reference each
  // pass and burned diff cycles on a budget device).
  const podiumOrder = useMemo(
    () => [topBroadcasters[1], topBroadcasters[0], topBroadcasters[2]].filter(Boolean),
    [topBroadcasters]
  );
  const broadcasterRankMap = useMemo(() => {
    const m = new Map();
    topBroadcasters.forEach((b, i) => m.set(b?.broadcaster_id, i + 1));
    return m;
  }, [topBroadcasters]);
  const [showTopAllSheet, setShowTopAllSheet] = useState(false);
  const [loadingTopAll, setLoadingTopAll]     = useState(false);

  const loadTopBroadcasters = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_top_broadcasters_24h', { limit_n: 3 });
    if (error) { console.warn('top broadcasters:', error.message); return; }
    setTopBroadcasters(Array.isArray(data) ? data : []);
  }, []);

  const loadTopAll = useCallback(async () => {
    setLoadingTopAll(true);
    const { data, error } = await supabase.rpc('get_top_broadcasters_24h', { limit_n: 20 });
    if (error) console.warn('top broadcasters all:', error.message);
    setTopAll(Array.isArray(data) ? data : []);
    setLoadingTopAll(false);
  }, []);

  useEffect(() => { loadTopBroadcasters(); }, [loadTopBroadcasters]);
  useEffect(() => { if (showTopAllSheet) loadTopAll(); }, [showTopAllSheet, loadTopAll]);

  // ----- Load moments from DB -----
  const loadMoments = useCallback(async () => {
    const { data, error } = await supabase
      .from('moments_posts')
      .select('id, user_id, content, image_url, mood, likes_count, comments_count, created_at, profiles:user_id(full_name, avatar_url)')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) console.warn('moments fetch:', error.message);

    const rows = (data || []).map((m) => ({
      id: m.id,
      user_id: m.user_id,
      user: m.profiles?.full_name || 'User',
      avatar: m.profiles?.avatar_url || `https://i.pravatar.cc/150?u=${m.user_id}`,
      time: relativeTime(m.created_at),
      text: m.content || '',
      image: m.image_url,
      mood: m.mood,
      likes: m.likes_count || 0,
      comments: m.comments_count || 0,
    }));
    setMoments(rows);
    setLoadingMoments(false);

    // Which ones did I like?
    if (user?.id && rows.length > 0) {
      const { data: likes } = await supabase
        .from('moments_likes')
        .select('post_id')
        .eq('user_id', user.id)
        .in('post_id', rows.map((r) => r.id));
      if (likes) {
        const map = {};
        likes.forEach((l) => { map[l.post_id] = true; });
        setLikedMoments(map);
      }
    }
  }, [user?.id]);

  useEffect(() => { loadMoments(); }, [loadMoments]);
  
  // Comment States
  const [isCommentModalVisible, setIsCommentModalVisible] = useState(false);
  const [activeMomentId, setActiveMomentId] = useState(null);
  const [commentText, setCommentText] = useState('');

  const moods = [
    { emoji: '😊', label: 'Happy' },
    { emoji: '🔥', label: 'Excited' },
    { emoji: '😇', label: 'Blessed' },
    { emoji: '😎', label: 'Cool' },
    { emoji: '😔', label: 'Sad' },
    { emoji: '🌟', label: 'Star' },
  ];

  const onRefresh = async () => {
    setRefreshing(true);
    await loadMoments();
    setRefreshing(false);
  };

  const pickImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,  // built-in cropper trims most large photos
      quality: 0.6,         // 60% JPEG keeps typical phone photos under ~500KB
    });
    if (result.canceled) return;

    const uri = result.assets[0].uri;
    // Reject anything still larger than 500 KB so storage stays cheap.
    try {
      const info = await FileSystem.getInfoAsync(uri, { size: true });
      const sizeKb = info?.size ? Math.round(info.size / 1024) : 0;
      if (sizeKb > MAX_MOMENT_IMAGE_KB) {
        showCuteAlert(
          'Image too large',
          `This image is ${sizeKb} KB. Please pick a smaller image (under ${MAX_MOMENT_IMAGE_KB} KB) or crop it tighter.`
        );
        return;
      }
    } catch (e) {
      console.warn('size check failed:', e?.message);
    }
    setPostImage(uri);
  };

  // Upload a local URI to Supabase Storage and return the public URL.
  const uploadMomentImage = async (localUri) => {
    if (!localUri || !user?.id) return null;
    const ext = (localUri.split('.').pop() || 'jpg').toLowerCase();
    const fileName = `${user.id}-${Date.now()}.${ext}`;
    const form = new FormData();
    form.append('file', { uri: localUri, name: fileName, type: `image/${ext}` });
    const { error } = await supabase.storage
      .from('moments')
      .upload(fileName, form, { cacheControl: '3600', upsert: true });
    if (error) {
      console.warn('moment image upload:', error.message);
      return null;
    }
    return supabase.storage.from('moments').getPublicUrl(fileName).data.publicUrl;
  };

  const handlePost = async () => {
    if (!postText.trim() && !postImage) {
      showCuteAlert("Empty Post", "Please add some text or an image.");
      return;
    }
    if (!user?.id) {
      showCuteAlert("Not signed in", "Please log in to post a moment.");
      return;
    }

    setPosting(true);
    let imageUrl = null;
    if (postImage) {
      imageUrl = await uploadMomentImage(postImage);
      if (postImage && !imageUrl) {
        setPosting(false);
        showCuteAlert("Image upload failed", "Try again or post without the image.");
        return;
      }
    }

    const { error } = await supabase.from('moments_posts').insert({
      user_id: user.id,
      content: postText.trim() || null,
      image_url: imageUrl,
      mood: selectedMood?.label || null,
    });

    setPosting(false);
    if (error) {
      showCuteAlert("Post failed", error.message);
      return;
    }

    setPostText('');
    setPostImage(null);
    setSelectedMood(null);
    await loadMoments();
  };

  const toggleLike = async (momentId) => {
    if (!user?.id) return;
    const wasLiked = !!likedMoments[momentId];

    // Optimistic UI
    setLikedMoments((prev) => ({ ...prev, [momentId]: !wasLiked }));
    setMoments((cur) => cur.map((m) => m.id === momentId
      ? { ...m, likes: Math.max(0, m.likes + (wasLiked ? -1 : 1)) }
      : m));

    if (wasLiked) {
      const { error } = await supabase
        .from('moments_likes')
        .delete()
        .eq('post_id', momentId)
        .eq('user_id', user.id);
      if (error) console.warn('unlike:', error.message);
    } else {
      const { error } = await supabase
        .from('moments_likes')
        .insert({ post_id: momentId, user_id: user.id });
      if (error && !error.message.includes('duplicate')) {
        console.warn('like:', error.message);
      }
    }
  };

  const handleCommentClick = (momentId) => {
    setActiveMomentId(momentId);
    setCommentText('');
    setIsCommentModalVisible(true);
  };

  const submitComment = async () => {
    const txt = commentText.trim();
    if (!txt || !user?.id || !activeMomentId) return;

    const { error } = await supabase.from('moments_comments').insert({
      post_id: activeMomentId,
      user_id: user.id,
      content: txt,
    });

    if (error) {
      showCuteAlert("Comment failed", error.message);
      return;
    }

    setMoments((cur) => cur.map((m) =>
      m.id === activeMomentId ? { ...m, comments: m.comments + 1 } : m
    ));
    setIsCommentModalVisible(false);
    setCommentText('');
  };

  const handleSearch = async () => {
    const q = searchQuery.trim();
    if (!q) return;

    setSearching(true);
    setShowSearchResults(true);

    const isNumeric = /^\d+$/.test(q);
    let query = supabase
      .from('profiles')
      .select('id, full_name, avatar_url, display_id, level')
      .limit(30);

    query = isNumeric
      ? query.eq('display_id', Number(q))
      : query.ilike('full_name', `%${q}%`);

    const { data, error } = await query;
    if (error) console.warn('user search:', error.message);
    setSearchResults(data || []);
    setSearching(false);
  };

  const openProfile = (profileId) => {
    setShowSearchResults(false);
    router.push(`/main/user/${profileId}`);
  };

  const handleAction = (type, title, target = null) => {
    if (type === "Leaderboard" && target) {
      router.push(`/main/user/${target}`);
    } else if (type === "Live Stream" && target) {
      router.push(`/broadcast/${target}`);
    } else {
      showCuteAlert(type, title);
    }
  };

  const renderSearchBar = () => (
    <View style={styles.searchContainer}>
      <Ionicons name="search" size={20} color="#9CA3AF" />
      <TextInput 
        style={styles.searchInput}
        placeholder="Search Broadcasters, Tags, or IDs"
        placeholderTextColor="#9CA3AF"
        value={searchQuery}
        onChangeText={setSearchQuery}
        onSubmitEditing={handleSearch}
        returnKeyType="search"
      />
    </View>
  );

  const renderLeaderboard = () => {
    // Podium order + rank lookup memoised at the top of the component
    // so renderLeaderboard doesn't rebuild them on every parent render.
    return (
      <View style={[styles.sectionContainer, { marginBottom: 16 }]}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitleSmall}>Daily Top Broadcasters 👑</Text>
          <TouchableOpacity onPress={() => setShowTopAllSheet(true)}>
            <Text style={styles.seeAllText}>View All</Text>
          </TouchableOpacity>
        </View>
        {podiumOrder.length === 0 ? (
          <View style={{ paddingVertical: 28, alignItems: 'center' }}>
            <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12 }}>
              No gifts in the last 24h yet — be the first contributor!
            </Text>
          </View>
        ) : (
          <View style={styles.leaderboardBox}>
            {podiumOrder.map((b) => {
              // figure out this row's rank position in the original (sorted) list
              const rank = broadcasterRankMap.get(b.broadcaster_id) || 0;
              const color   = TIER_COLORS[rank] || '#94A3B8';
              const iconObj = TIER_ICONS[rank];
              const avatar  = b.avatar_url || `https://i.pravatar.cc/150?u=${b.broadcaster_id}`;
              return (
                <TouchableOpacity
                  key={b.broadcaster_id}
                  style={[styles.rankItem, rank === 1 && styles.rankItemCenter]}
                  onPress={() => router.push(`/main/user/${b.broadcaster_id}`)}
                >
                  <View style={styles.crownContainer}>
                    {iconObj && (
                      <Image
                        source={{ uri: iconObj }}
                        style={rank === 1 ? styles.premiumCrown : styles.premiumMedal}
                      />
                    )}
                  </View>
                  <View style={[styles.avatarGlow, { shadowColor: color }]}>
                    <Image
                      source={{ uri: avatar }}
                      style={[
                        styles.rankAvatar,
                        rank === 1 ? styles.rankAvatarLarge : styles.rankAvatarSmall,
                        { borderColor: color },
                      ]}
                    />
                  </View>
                  <Text style={[styles.rankName, rank === 1 && styles.rankNameGold]} numberOfLines={1}>
                    {b.full_name || 'Streamer'}
                  </Text>
                  <Text style={{ color: '#38BDF8', fontSize: 10, fontWeight: '700', marginTop: 2 }}>
                    {Number(b.total_diamonds).toLocaleString()} 💎
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </View>
    );
  };

  const renderTopAllSheet = () => (
    <Modal visible={showTopAllSheet} transparent animationType="slide" onRequestClose={() => setShowTopAllSheet(false)}>
      <TouchableOpacity style={styles.topAllOverlay} activeOpacity={1} onPress={() => setShowTopAllSheet(false)}>
        <View style={styles.topAllSheet}>
          <View style={styles.modalHandleBar} />
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}>
            <Ionicons name="trophy" size={20} color="#FBBF24" />
            <Text style={{ color: '#FFF', fontSize: 16, fontWeight: 'bold', marginLeft: 8 }}>Top Broadcasters</Text>
          </View>
          <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, textAlign: 'center', marginBottom: 14 }}>
            Last 24 hours · ranked by diamonds received
          </Text>

          {loadingTopAll ? (
            <View style={{ paddingVertical: 40, alignItems: 'center' }}>
              <LogoLoader size="medium" />
            </View>
          ) : topAll.length === 0 ? (
            <Text style={{ color: 'rgba(255,255,255,0.4)', textAlign: 'center', paddingVertical: 28, fontSize: 12 }}>
              No activity in the last 24 hours.
            </Text>
          ) : (
            <FlatList
              data={topAll}
              keyExtractor={(item) => item.broadcaster_id}
              showsVerticalScrollIndicator={false}
              // Top-broadcasters list can be 100+ rows — virtualise so the
              // sheet doesn't mount every avatar on open.
              removeClippedSubviews
              initialNumToRender={12}
              maxToRenderPerBatch={12}
              windowSize={5}
              renderItem={({ item, index }) => {
                const rank = index + 1;
                const medal = TIER_COLORS[rank] || 'rgba(255,255,255,0.5)';
                return (
                  <TouchableOpacity
                    style={styles.topAllRow}
                    onPress={() => { setShowTopAllSheet(false); router.push(`/main/user/${item.broadcaster_id}`); }}
                  >
                    <View style={{ width: 30, alignItems: 'center' }}>
                      <Text style={{ color: medal, fontWeight: '800', fontSize: 14 }}>{rank}</Text>
                    </View>
                    <Image
                      source={{ uri: item.avatar_url || `https://i.pravatar.cc/100?u=${item.broadcaster_id}` }}
                      style={styles.topAllAvatar}
                    />
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={{ color: '#FFF', fontSize: 13, fontWeight: '600' }} numberOfLines={1}>
                        {item.full_name || 'Streamer'}
                      </Text>
                      <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10 }}>
                        {Number(item.gift_count).toLocaleString()} gift{Number(item.gift_count) === 1 ? '' : 's'}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Ionicons name="diamond" size={13} color="#38BDF8" />
                      <Text style={{ color: '#38BDF8', fontWeight: '700', marginLeft: 4, fontSize: 13 }}>
                        {Number(item.total_diamonds).toLocaleString()}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </View>
      </TouchableOpacity>
    </Modal>
  );

  const renderCreatePost = () => (
    <View style={styles.createPostCard}>
      <View style={styles.postInputRow}>
        <Image source={{ uri: user.avatar }} style={styles.postAvatar} />
        <TextInput 
          style={styles.postInput}
          placeholder="What's on your mind?"
          placeholderTextColor="rgba(255,255,255,0.4)"
          value={postText}
          onChangeText={setPostText}
          multiline
        />
      </View>
      
      {postImage && (
        <View style={styles.selectedImageContainer}>
          <Image source={{ uri: postImage }} style={styles.selectedImagePreview} />
          <TouchableOpacity style={styles.removeImageBtn} onPress={() => setPostImage(null)}>
            <Ionicons name="close-circle" size={24} color={BRAND.primary} />
          </TouchableOpacity>
        </View>
      )}

      {selectedMood && (
        <View style={styles.selectedMoodBadge}>
          <Text style={styles.moodBadgeText}>Feeling {selectedMood.emoji} {selectedMood.label}</Text>
          <TouchableOpacity onPress={() => setSelectedMood(null)}>
            <Ionicons name="close" size={14} color="rgba(255,255,255,0.6)" />
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.postActionsRow}>
        <View style={{ flexDirection: 'row', gap: 15 }}>
          <TouchableOpacity style={styles.postActionBtn} onPress={pickImage}>
            <Ionicons name="image" size={22} color="#4ADE80" />
            <Text style={styles.postActionText}>Image</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.postActionBtn} onPress={() => setShowMoodModal(true)}>
            <Ionicons name="happy" size={22} color="#FBBF24" />
            <Text style={styles.postActionText}>Mood</Text>
          </TouchableOpacity>
        </View>
        
        <TouchableOpacity 
          style={[styles.publishBtn, (!postText.trim() && !postImage) && { opacity: 0.5 }]} 
          onPress={handlePost}
          disabled={!postText.trim() && !postImage}
        >
          <LinearGradient colors={[BRAND.primary, BRAND.primaryAlt]} style={styles.publishGradient}>
            <Text style={styles.publishText}>Post</Text>
          </LinearGradient>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderMoodModal = () => (
    <Modal visible={showMoodModal} transparent animationType="fade" onRequestClose={() => setShowMoodModal(false)}>
      <View style={styles.modalOverlay}>
        <View style={styles.moodCard}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text style={styles.moodTitle}>How are you feeling?</Text>
            <TouchableOpacity onPress={() => setShowMoodModal(false)}>
              <Ionicons name="close" size={22} color="#9CA3AF" />
            </TouchableOpacity>
          </View>
          <View style={styles.moodGrid}>
            {moods.map((mood, i) => (
              <TouchableOpacity
                key={i}
                style={styles.moodItem}
                onPress={() => {
                  setSelectedMood(mood);
                  setShowMoodModal(false);
                }}
              >
                <Text style={styles.moodEmoji}>{mood.emoji}</Text>
                <Text style={styles.moodLabel}>{mood.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );

  const renderCommentModal = () => (
    <Modal visible={isCommentModalVisible} transparent animationType="slide" onRequestClose={() => setIsCommentModalVisible(false)}>
      <View style={styles.modalOverlay}>
        <View style={styles.commentModalBox}>
          <View style={styles.commentHeader}>
            <Text style={styles.commentTitle}>Write a Comment</Text>
            <TouchableOpacity onPress={() => setIsCommentModalVisible(false)}>
              <Ionicons name="close" size={24} color="#FFF" />
            </TouchableOpacity>
          </View>
          
          <TextInput
            style={styles.commentInput}
            placeholder="Share your thoughts..."
            placeholderTextColor="rgba(255,255,255,0.4)"
            value={commentText}
            onChangeText={setCommentText}
            multiline
            autoFocus
          />
          
          <TouchableOpacity 
            style={[styles.submitCommentBtn, !commentText.trim() && { opacity: 0.5 }]}
            onPress={submitComment}
            disabled={!commentText.trim()}
          >
            <LinearGradient colors={[BRAND.primary, BRAND.primaryAlt]} style={styles.submitGradient}>
              <Text style={styles.submitText}>Send Comment</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );

  const renderSearchModal = () => (
    <Modal visible={showSearchResults} transparent animationType="fade" onRequestClose={() => setShowSearchResults(false)}>
      <View style={styles.searchOverlay}>
        <SafeAreaView style={styles.searchModalBox} edges={['top']}>
          <View style={styles.commentHeader}>
            <Text style={styles.commentTitle}>Search Results</Text>
            <TouchableOpacity onPress={() => setShowSearchResults(false)}>
              <Ionicons name="close" size={24} color="#FFF" />
            </TouchableOpacity>
          </View>

          {searching ? (
            <LogoLoader size="medium" style={{ marginVertical: 30 }} />
          ) : searchResults.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 30 }}>
              <Ionicons name="search-outline" size={40} color="#374151" />
              <Text style={{ color: '#9CA3AF', marginTop: 12 }}>No users found.</Text>
            </View>
          ) : (
            <ScrollView style={{ maxHeight: 360 }} showsVerticalScrollIndicator={false}>
              {searchResults.map((u) => (
                <TouchableOpacity key={u.id} style={styles.searchResultRow} onPress={() => openProfile(u.id)}>
                  <Image
                    source={{ uri: u.avatar_url || `https://i.pravatar.cc/150?u=${u.id}` }}
                    style={styles.searchResultAvatar}
                  />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={styles.searchResultName} numberOfLines={1}>{u.full_name || 'User'}</Text>
                    <Text style={styles.searchResultId}>ID: {u.display_id || '—'}  ·  Lv. {u.level || 1}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color="#6B7280" />
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </SafeAreaView>
      </View>
    </Modal>
  );

  const renderMomentsFeed = () => (
    <View style={[styles.sectionContainer, { marginBottom: 120 }]}>
      <Text style={styles.sectionTitle}>Moments</Text>
      {moments.map((moment) => (
        <View key={moment.id} style={styles.momentCard}>
          <View style={styles.momentHeader}>
            <Image source={{ uri: moment.avatar }} style={styles.momentAvatar} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={styles.momentUser}>{moment.user}</Text>
                {moment.mood && (
                  <Text style={styles.momentMoodText}> is feeling {moment.mood.emoji}</Text>
                )}
              </View>
              <Text style={styles.momentTime}>{moment.time}</Text>
            </View>
            <TouchableOpacity>
              <Ionicons name="ellipsis-horizontal" size={20} color="rgba(255,255,255,0.4)" />
            </TouchableOpacity>
          </View>
          
          {moment.text ? <Text style={styles.momentText}>{moment.text}</Text> : null}
          
          {moment.image && (
            <Image source={{ uri: moment.image }} style={styles.momentImage} />
          )}
          
          <View style={styles.momentFooter}>
            <View style={styles.momentStatRow}>
              <TouchableOpacity 
                style={styles.momentStatItem} 
                onPress={() => toggleLike(moment.id)}
              >
                <Ionicons 
                  name={likedMoments[moment.id] ? "heart" : "heart-outline"} 
                  size={22} 
                  color={likedMoments[moment.id] ? BRAND.primary : "rgba(255,255,255,0.6)"}
                />
                <Text style={[
                  styles.momentStatText, 
                  likedMoments[moment.id] && { color: BRAND.primary }
                ]}>
                  {moment.likes.toLocaleString()}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={styles.momentStatItem}
                onPress={() => handleCommentClick(moment.id)}
              >
                <Ionicons name="chatbubble-outline" size={20} color="rgba(255,255,255,0.6)" />
                <Text style={styles.momentStatText}>{moment.comments.toLocaleString()}</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity>
              <Ionicons name="share-social-outline" size={20} color="rgba(255,255,255,0.6)" />
            </TouchableOpacity>
          </View>
        </View>
      ))}
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView 
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BRAND.primary} />
        }
      >
        {renderSearchBar()}
        <View style={{ height: 20 }} />
        {renderLeaderboard()}
        {renderCreatePost()}
        {renderMomentsFeed()}
        {renderMoodModal()}
        {renderCommentModal()}
        {renderSearchModal()}
      </ScrollView>
      {renderTopAllSheet()}
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  // Daily top broadcasters View-All sheet
  topAllOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  topAllSheet:   { backgroundColor: BRAND.splashBg, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 30, maxHeight: '75%' },
  modalHandleBar:{ width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.2)', alignSelf: 'center', marginBottom: 10 },
  topAllRow:     { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  topAllAvatar:  { width: 40, height: 40, borderRadius: 20 },

  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1E1A34',
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 48,
  },
  searchInput: {
    flex: 1,
    marginLeft: 8,
    color: '#FFFFFF',
    fontSize: 15,
  },
  bannerBtnText: {
    color: '#6B4EFF',
    fontWeight: 'bold',
    fontSize: 12,
  },

  sectionContainer: {
    marginBottom: 24,
  },
  sectionTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: 'bold',
    marginHorizontal: 16,
    marginBottom: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 12,
  },
  sectionTitleSmall: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
  seeAllText: {
    color: BRAND.primary,
    fontSize: 12,
    fontWeight: '600',
  },
  leaderboardBox: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'flex-end',
    backgroundColor: 'rgba(255,255,255,0.03)',
    marginHorizontal: 16,
    borderRadius: 20,
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  rankItem: {
    alignItems: 'center',
    width: (width - 64) / 3,
  },
  rankItemCenter: {
    marginBottom: 12,
    zIndex: 10,
  },
  crownContainer: {
    marginBottom: -12,
    zIndex: 10,
  },
  premiumCrown: {
    width: 32,
    height: 32,
    resizeMode: 'contain',
  },
  premiumMedal: {
    width: 24,
    height: 24,
    resizeMode: 'contain',
    marginTop: 8,
  },
  avatarGlow: {
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 5,
  },
  rankAvatar: {
    borderWidth: 3,
  },
  rankAvatarSmall: {
    width: 50,
    height: 50,
    borderRadius: 25,
  },
  rankAvatarLarge: {
    width: 65,
    height: 65,
    borderRadius: 32.5,
  },
  rankName: {
    color: '#E5E7EB',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 6,
    textAlign: 'center',
  },
  rankNameGold: {
    color: '#FCD34D',
    fontWeight: 'bold',
  },

  /* Create Post */
  createPostCard: {
    backgroundColor: '#1E1A34',
    marginHorizontal: 16,
    borderRadius: 16,
    padding: 16,
    marginBottom: 24,
  },
  postInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  postAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: BRAND.primary,
  },
  postInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 12,
    marginLeft: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: '#FFF',
    fontSize: 14,
    textAlignVertical: 'top',
  },
  selectedImageContainer: {
    width: '100%',
    height: 150,
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 16,
  },
  selectedImagePreview: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  removeImageBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 12,
  },
  selectedMoodBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(251,191,36,0.15)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    alignSelf: 'flex-start',
    marginBottom: 16,
    gap: 8,
  },
  moodBadgeText: {
    color: '#FBBF24',
    fontSize: 12,
    fontWeight: 'bold',
  },
  postActionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.05)',
    paddingTop: 12,
  },
  postActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  postActionText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    marginLeft: 6,
    fontWeight: '500',
  },
  publishBtn: {
    borderRadius: 20,
    overflow: 'hidden',
  },
  publishGradient: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  publishText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 14,
  },

  /* Mood Modal */
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  moodCard: {
    width: width * 0.85,
    backgroundColor: '#1E1A34',
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
  },
  moodTitle: {
    color: '#FFF',
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  moodGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 15,
  },
  moodItem: {
    width: (width * 0.85 - 80) / 3,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 16,
    padding: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  moodEmoji: {
    fontSize: 28,
    marginBottom: 6,
  },
  moodLabel: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 11,
    fontWeight: '600',
  },

  /* Moments Feed */
  momentCard: {
    backgroundColor: 'rgba(255,255,255,0.02)',
    marginHorizontal: 16,
    borderRadius: 20,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  momentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  momentAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  momentUser: {
    color: '#FFF',
    fontSize: 15,
    fontWeight: 'bold',
  },
  momentTime: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 11,
    marginTop: 2,
  },
  momentText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  momentImage: {
    width: '100%',
    height: 300,
    borderRadius: 16,
    marginBottom: 12,
    resizeMode: 'cover',
  },
  momentFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.05)',
    paddingTop: 12,
  },
  momentStatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
  },
  momentStatItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  momentStatText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    marginLeft: 6,
    fontWeight: '600',
  },

  /* Moments Feed additions */
  momentMoodText: {
    color: '#FBBF24',
    fontSize: 12,
    fontWeight: '600',
  },
  /* Comment Modal */
  commentModalBox: {
    width: '100%',
    backgroundColor: '#1E1A34',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    position: 'absolute',
    bottom: 0,
    minHeight: 250,
  },
  commentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  commentTitle: {
    color: '#FFF',
    fontSize: 18,
    fontWeight: 'bold',
  },
  commentInput: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 16,
    padding: 16,
    color: '#FFF',
    fontSize: 15,
    minHeight: 100,
    textAlignVertical: 'top',
    marginBottom: 20,
  },
  submitCommentBtn: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  submitGradient: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  submitText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: 'bold',
  },

  /* Search Results Modal */
  searchOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-start',
  },
  searchModalBox: {
    width: '100%',
    backgroundColor: '#1E1A34',
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
    paddingHorizontal: 20,
    paddingBottom: 20,
    maxHeight: '75%',
  },
  searchResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  searchResultAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1.5,
    borderColor: '#F43F5E',
  },
  searchResultName: {
    color: '#FFF',
    fontSize: 15,
    fontWeight: 'bold',
  },
  searchResultId: {
    color: '#9CA3AF',
    fontSize: 12,
    marginTop: 2,
  },
});
