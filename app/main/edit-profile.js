import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Image, TextInput, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';

import { supabase } from '../../src/api/supabase';
import { useGlobalState } from '../../src/context/GlobalStateContext';
import CountryModal from '../../src/components/auth/CountryModal';

export default function EditProfileScreen() {
  const router = useRouter();
  const { user, fetchProfile } = useGlobalState();

  const [avatar, setAvatar] = useState(user?.avatar || 'https://picsum.photos/seed/myprofile/200/200');
  const [gender, setGender] = useState(user?.gender || 'female');
  const [nickname, setNickname] = useState(user?.name || '');
  const [bio, setBio] = useState(user?.bio || '');
  // Country is free-form text in DB (migration 92), but we keep the
  // picker in lock-step with the auth CountryModal so a user's chosen
  // country always matches one of the supported markets.
  const [country, setCountry] = useState(user?.country || '');
  const [countryModalVisible, setCountryModalVisible] = useState(false);
  const [loading, setLoading] = useState(false);

  const pickImage = async () => {
    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false, // Cropping বন্ধ করা হলো
      quality: 0.5,
    });

    if (!result.canceled) {
      setLoading(true);
      try {
        const file = result.assets[0];
        const fileExt = file.uri.split('.').pop().toLowerCase();
        const fileName = `${user.id}-${Date.now()}.${fileExt}`;
        
        // React Native-এ সবচেয়ে স্ট্যাবল পদ্ধতি হলো FormData ব্যবহার করা
        const formData = new FormData();
        formData.append('file', {
          uri: file.uri,
          name: fileName,
          type: `image/${fileExt}`,
        });

        const { data, error } = await supabase.storage
          .from('avatars')
          .upload(fileName, formData, {
            cacheControl: '3600',
            upsert: true
          });

        if (error) throw error;

        // getPublicUrl is synchronous in supabase-js v2 — keep the call
        // sync but defensive: null-check the result and bail with a
        // clear error if the bucket isn't public. Old code dereferenced
        // urlData.publicUrl unconditionally and crashed if the SDK ever
        // returned an empty data envelope.
        const { data: urlData } = supabase.storage
          .from('avatars')
          .getPublicUrl(fileName);

        const publicUrl = urlData?.publicUrl;
        if (!publicUrl) {
          throw new Error('Upload succeeded but the public URL could not be resolved. Check that the avatars bucket is public.');
        }

        setAvatar(publicUrl);
        Alert.alert("Success", "Profile picture uploaded!");
      } catch (err) {
        console.error("Upload Error Details:", err);
        Alert.alert("Upload Error", "Network request failed. Please check your internet or Supabase storage settings.");
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
          <Text style={styles.label}>Nickname</Text>
          <TextInput 
            style={styles.input}
            value={nickname}
            onChangeText={setNickname}
            placeholderTextColor="#6B7280"
          />
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
