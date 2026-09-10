import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Image, TextInput, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';

import { supabase } from '../../src/api/supabase';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import CountryModal from '../../src/components/auth/CountryModal';

const MAX_AVATAR_IMAGE_KB = 300;
const AVATAR_BUCKET = 'avatars';

const mimeForExtension = (extension) => {
  const ext = String(extension || '').toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
};

const extensionForMime = (mimeType) => {
  const type = String(mimeType || '').toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  return 'jpg';
};

const estimateBase64SizeKb = (base64) => Math.round((String(base64 || '').length * 3 / 4) / 1024);

const base64ToArrayBuffer = (base64) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = {};
  for (let i = 0; i < chars.length; i += 1) lookup[chars[i]] = i;

  const clean = String(base64 || '').replace(/=+$/, '');
  const bytes = [];
  for (let i = 0; i < clean.length; i += 4) {
    const a = lookup[clean[i]] ?? 0;
    const b = lookup[clean[i + 1]] ?? 0;
    const c = lookup[clean[i + 2]] ?? 0;
    const d = lookup[clean[i + 3]] ?? 0;
    const triplet = (a << 18) | (b << 12) | (c << 6) | d;

    bytes.push((triplet >> 16) & 255);
    if (i + 2 < clean.length) bytes.push((triplet >> 8) & 255);
    if (i + 3 < clean.length) bytes.push(triplet & 255);
  }
  return new Uint8Array(bytes).buffer;
};

export default function EditProfileScreen() {
  const router = useRouter();
  const { user, setUser, fetchProfile } = useGlobalState();

  const [avatar, setAvatar] = useState(user?.avatar || 'https://picsum.photos/seed/myprofile/200/200');
  const [gender, setGender] = useState(user?.gender || 'female');
  const [nickname, setNickname] = useState(user?.name || '');
  const [requestedNickname, setRequestedNickname] = useState(user?.nickname || '');
  const [nicknameApplication, setNicknameApplication] = useState(null);
  const [bio, setBio] = useState(user?.bio || '');
  // Country is free-form text in DB (migration 92), but we keep the
  // picker in lock-step with the auth CountryModal so a user's chosen
  // country always matches one of the supported markets.
  const [country, setCountry] = useState(user?.country || '');
  const [countryModalVisible, setCountryModalVisible] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    supabase.from('nickname_applications')
      .select('id,requested_nickname,status,review_note,created_at')
      .eq('user_id', user.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => setNicknameApplication(data || null));
  }, [user?.id]);

  const applyForNickname = async () => {
    const value = requestedNickname.trim();
    const { data, error } = await supabase.rpc('submit_nickname_application', { p_nickname: value });
    if (error || !data?.success) {
      Alert.alert('Could not apply', data?.message || error?.message || 'Please try again.');
      return;
    }
    const { data: latest } = await supabase.from('nickname_applications')
      .select('id,requested_nickname,status,review_note,created_at').eq('user_id', user.id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    setNicknameApplication(latest || null);
    Alert.alert('Application sent', 'An admin will review your nickname.');
  };

  const pickImage = async () => {
    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.45,
      base64: true,
    });

    if (!result.canceled) {
      setLoading(true);
      try {
        const file = result.assets[0];
        if (!file?.base64) {
          throw new Error('Could not read this image. Please choose another photo.');
        }
        const sizeKb = file.fileSize
          ? Math.round(file.fileSize / 1024)
          : estimateBase64SizeKb(file.base64);
        if (sizeKb > MAX_AVATAR_IMAGE_KB) {
          Alert.alert(
            'Image too large',
            `This image is ${sizeKb} KB. Please pick a smaller image or crop it tighter.`
          );
          return;
        }
        const guessedExt = (file.fileName || file.uri || '').split('.').pop()?.split('?')[0]?.toLowerCase();
        const contentType = file.mimeType || mimeForExtension(guessedExt);
        const fileExt = extensionForMime(contentType);
        const objectPath = `${user.id}/${Date.now()}.${fileExt}`;
        const fileBytes = base64ToArrayBuffer(file.base64);

        const { data, error } = await supabase.storage
          .from(AVATAR_BUCKET)
          .upload(objectPath, fileBytes, {
            cacheControl: '3600',
            contentType,
            upsert: true,
          });

        if (error) throw error;

        // getPublicUrl is synchronous in supabase-js v2 — keep the call
        // sync but defensive: null-check the result and bail with a
        // clear error if the bucket isn't public. Old code dereferenced
        // urlData.publicUrl unconditionally and crashed if the SDK ever
        // returned an empty data envelope.
        const { data: urlData } = supabase.storage
          .from(AVATAR_BUCKET)
          .getPublicUrl(data?.path || objectPath);

        const publicUrl = urlData?.publicUrl;
        if (!publicUrl) {
          throw new Error('Upload succeeded but the public URL could not be resolved. Check that the avatars bucket is public.');
        }

        // Persist the avatar as part of the upload itself. Previously the new
        // URL only lived in this screen until the user pressed Save, so every
        // other screen continued showing the previous profile picture.
        const { error: profileUpdateError } = await supabase
          .from('profiles')
          .update({ avatar_url: publicUrl })
          .eq('id', user.id);

        if (profileUpdateError) throw profileUpdateError;

        setAvatar(publicUrl);
        setUser((currentUser) => currentUser
          ? { ...currentUser, avatar: publicUrl }
          : currentUser);
        Alert.alert("Success", "Profile picture updated!");
      } catch (err) {
        console.error("Upload Error Details:", err);
        Alert.alert("Upload Error", err?.message || "Network request failed. Please check your internet or Supabase storage settings.");
      } finally {
        setLoading(false);
      }
    }
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({
          full_name: nickname,
          bio: bio,
          gender: gender,
          avatar_url: avatar,
          country: country || null,
        })
        .eq('id', user.id);

      if (error) throw error;

      await fetchProfile(user.id);
      Alert.alert("Success", "Profile updated successfully!", [
        { text: "OK", onPress: () => router.back() }
      ]);
    } catch (err) {
      Alert.alert("Error", err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Edit Profile</Text>
        <TouchableOpacity onPress={handleSave}>
          <Text style={styles.saveHeaderBtn}>Save</Text>
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        
        {/* Avatar Edit Section */}
        <View style={styles.avatarContainer}>
          <View style={styles.avatarWrapper}>
            <Image 
              source={{ uri: avatar }} 
              style={styles.avatar} 
            />
            <TouchableOpacity style={styles.cameraBtn} onPress={pickImage}>
              <Ionicons name="camera" size={20} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
        </View>

        {/* Form Fields */}
        <View style={styles.formGroup}>
          <Text style={styles.label}>Full Name</Text>
          <TextInput 
            style={styles.input}
            value={nickname}
            onChangeText={setNickname}
            placeholderTextColor="#6B7280"
          />
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.label}>Nickname Badge</Text>
          <TextInput
            style={styles.input}
            value={requestedNickname}
            onChangeText={setRequestedNickname}
            placeholder="2–24 characters, emoji allowed"
            placeholderTextColor="#6B7280"
            maxLength={24}
            editable={nicknameApplication?.status !== 'pending'}
          />
          {user?.nickname ? <Text style={styles.charCount}>Active: {user.nickname}</Text> : null}
          {nicknameApplication ? (
            <Text style={[styles.charCount, nicknameApplication.status === 'rejected' && { color: '#FB7185' }]}>Last request: {nicknameApplication.status}{nicknameApplication.review_note ? ` · ${nicknameApplication.review_note}` : ''}</Text>
          ) : null}
          <TouchableOpacity
            style={[styles.saveButton, { marginTop: 10 }, nicknameApplication?.status === 'pending' && { opacity: 0.5 }]}
            disabled={nicknameApplication?.status === 'pending'}
            onPress={applyForNickname}
          >
            <Text style={styles.saveButtonText}>{nicknameApplication?.status === 'pending' ? 'Awaiting Admin Review' : 'Apply for Nickname'}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.label}>Tagline / Bio</Text>
          <TextInput 
            style={[styles.input, styles.textArea]}
            value={bio}
            onChangeText={setBio}
            placeholderTextColor="#6B7280"
            multiline
            maxLength={100}
          />
          <Text style={styles.charCount}>{bio.length}/100</Text>
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.label}>Gender</Text>
          <View style={styles.genderRow}>
            <TouchableOpacity 
              style={[styles.genderBtn, gender === 'female' && styles.genderBtnActive]}
              onPress={() => setGender('female')}
            >
              <Ionicons name="female" size={16} color={gender === 'female' ? "#FFFFFF" : "#9CA3AF"} style={{marginRight: 6}} />
              <Text style={gender === 'female' ? styles.genderTextActive : styles.genderText}>Female</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.genderBtn, gender === 'male' && styles.genderBtnActive]}
              onPress={() => setGender('male')}
            >
              <Ionicons name="male" size={16} color={gender === 'male' ? "#FFFFFF" : "#9CA3AF"} style={{marginRight: 6}} />
              <Text style={gender === 'male' ? styles.genderTextActive : styles.genderText}>Male</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.label}>Country</Text>
          <TouchableOpacity
            style={styles.countrySelect}
            onPress={() => setCountryModalVisible(true)}
            activeOpacity={0.8}
          >
            <Ionicons name="location-outline" size={18} color={country ? '#FFFFFF' : '#6B7280'} style={{ marginRight: 10 }} />
            <Text style={country ? styles.countrySelectText : styles.countrySelectPlaceholder}>
              {country || 'Select your country'}
            </Text>
            <Ionicons name="chevron-down" size={18} color="#9CA3AF" />
          </TouchableOpacity>
        </View>

        {/* Huge Save Button */}
        <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
          <Text style={styles.saveBtnText}>Save Changes</Text>
        </TouchableOpacity>

      </ScrollView>

      <CountryModal
        visible={countryModalVisible}
        onClose={() => setCountryModalVisible(false)}
        onSelect={(item) => setCountry(item.name)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0E111E' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#251B45' },
  backBtn: { padding: 4 },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },
  saveHeaderBtn: { color: '#00E5FF', fontSize: 16, fontWeight: 'bold', padding: 4 },
  
  content: { padding: 24 },
  
  avatarContainer: { alignItems: 'center', marginBottom: 32 },
  avatarWrapper: { position: 'relative' },
  avatar: { width: 100, height: 100, borderRadius: 50, borderWidth: 2, borderColor: '#374151' },
  cameraBtn: { position: 'absolute', bottom: 0, right: 0, backgroundColor: '#F43F5E', width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center', borderWidth: 3, borderColor: '#0E111E' },
  
  formGroup: { marginBottom: 24 },
  label: { color: '#9CA3AF', fontSize: 12, fontWeight: 'bold', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 },
  input: { backgroundColor: '#1E1A34', color: '#FFFFFF', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 16, fontSize: 16, borderWidth: 1, borderColor: '#374151' },
  textArea: { height: 100, textAlignVertical: 'top' },
  charCount: { color: '#6B7280', fontSize: 12, textAlign: 'right', marginTop: 4 },
  saveButton: { minHeight: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#8B5CF6', paddingHorizontal: 16 },
  saveButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  
  genderRow: { flexDirection: 'row', gap: 12 },
  genderBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#1E1A34', paddingVertical: 14, borderRadius: 12, borderWidth: 1, borderColor: '#374151' },
  genderBtnActive: { backgroundColor: '#F43F5E', borderColor: '#F43F5E' },
  genderText: { color: '#9CA3AF', fontWeight: 'bold' },
  genderTextActive: { color: '#FFFFFF', fontWeight: 'bold' },

  countrySelect: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E1A34', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 16, borderWidth: 1, borderColor: '#374151' },
  countrySelectText: { color: '#FFFFFF', fontSize: 16, flex: 1 },
  countrySelectPlaceholder: { color: '#6B7280', fontSize: 16, flex: 1 },

  saveBtn: { backgroundColor: '#00E5FF', paddingVertical: 16, borderRadius: 16, alignItems: 'center', marginTop: 20 },
  saveBtnText: { color: '#1E1B4B', fontSize: 16, fontWeight: 'bold' }
});
