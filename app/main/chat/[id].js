import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, TextInput, Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useGlobalState } from '../../../src/context/GlobalStateContext';
import { supabase } from '../../../src/api/supabase';
import { showCuteAlert } from '../../../src/components/CuteAlert';
import LogoLoader from '../../../src/components/LogoLoader';
import { BRAND } from '../../../src/theme/brand';

const DM_MESSAGE_COST = 1;

const buildConvId = (a, b) => (a < b ? `${a}__${b}` : `${b}__${a}`);

const formatTime = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function ChatScreen() {
  const router = useRouter();
  const { id: otherUserId, name } = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const { user, diamonds } = useGlobalState();

  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inputText, setInputText] = useState('');
  const [otherProfile, setOtherProfile] = useState(null);
  const listRef = useRef(null);

  const convId = user?.id && otherUserId ? buildConvId(user.id, otherUserId) : null;
  const chatName = otherProfile?.full_name || name || 'User';
  // Support channels (admin / super_admin recipients) bypass the 1-💎 fee
  // and the upfront balance guard — operators shouldn't pay to respond
  // to bulk-stock requests.
  const isSupportChannel = otherProfile?.role === 'admin' || otherProfile?.role === 'super_admin';

  // Load conversation
  const loadMessages = useCallback(async () => {
    if (!convId) return;
    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true })
      .limit(200);
    // chat fetch fires on every screen focus + every realtime tick — keep
    // the warn in dev only so prod logs stay clean.
    if (error && __DEV__) console.warn('chat fetch:', error.message);
    setMessages(data || []);
    setLoading(false);

    // Mark received messages as read via the SECURITY DEFINER RPC.
    // The previous raw UPDATE silently failed under RLS because the
    // chat_messages table only had SELECT + INSERT policies — no UPDATE
    // policy. Result: the Messages tab badge never decremented and
    // users saw "8 unread" forever even after opening the chat. The
    // RPC (migration 68) bypasses RLS safely while still verifying the
    // caller is the receiver.
    const unreadIds = (data || []).filter((m) => m.receiver_id === user.id && !m.is_read).map((m) => m.id);
    if (unreadIds.length > 0) {
      const { error: readErr } = await supabase
        .rpc('mark_chat_messages_read', { p_message_ids: unreadIds });
      if (readErr && __DEV__) console.warn('chat read-receipt:', readErr.message);
    }
  }, [convId, user?.id]);

  // Fetch other user's profile + initial messages
  useEffect(() => {
    if (!otherUserId) return;
    (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url, role')
        .eq('id', otherUserId)
        .maybeSingle();
      setOtherProfile(data);
    })();
    loadMessages();
  }, [otherUserId, loadMessages]);

  // Realtime — append new messages live + reflect is_read updates so
  // the sender sees a ✓✓ when the receiver opens the chat.
  useEffect(() => {
    if (!convId) return;
    const ch = supabase
      .channel(`chat-${convId}-${Date.now()}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `conversation_id=eq.${convId}` },
        (payload) => {
          setMessages((prev) => {
            // Replace any optimistic temp row from the sender with the real
            // row. Match by sender + content (same content twice in <1s is
            // vanishingly rare in DM chat).
            const tempIdx = prev.findIndex((m) =>
              String(m.id).startsWith('temp-') &&
              m.sender_id === payload.new.sender_id &&
              m.content === payload.new.content
            );
            if (tempIdx >= 0) {
              const next = prev.slice();
              next[tempIdx] = payload.new;
              return next;
            }
            // Dedupe by real id — INSERT echo arrives twice in some edge cases.
            if (prev.some((m) => m.id === payload.new.id)) return prev;
            return [...prev, payload.new];
          });
          if (payload.new.receiver_id === user?.id) {
            // Same RPC as the initial-load read-receipt path so a
            // message that arrives while the chat is already open
            // gets marked read without hitting the same RLS dead-end.
            supabase.rpc('mark_chat_messages_read', { p_message_ids: [payload.new.id] });
          }
        }
      )
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'chat_messages', filter: `conversation_id=eq.${convId}` },
        (payload) => {
          // Mainly catches is_read flipping so the sender's ✓ becomes ✓✓.
          setMessages((prev) => prev.map((m) => (m.id === payload.new.id ? payload.new : m)));
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [convId, user?.id]);

  // Auto-scroll to latest message
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }, [messages.length]);

  const sendMessage = async () => {
    const text = inputText.trim();
    if (!text || !convId || !user?.id) return;

    // Upfront balance guard — skipped for support channels (admin/super_admin
    // recipients) so resellers can always reach support even at 0 💎.
    if (!isSupportChannel && (diamonds || 0) < DM_MESSAGE_COST) {
      showCuteAlert(
        'Out of diamonds',
        `You need ${DM_MESSAGE_COST} diamond to send a message. Top up to continue.`
      );
      return;
    }

    setInputText('');
    // Optimistic insert — real row arrives via the realtime INSERT listener
    // and replaces this temp via the dedupe logic above.
    const tempId = `temp-${Date.now()}`;
    setMessages((prev) => [...prev, {
      id: tempId,
      conversation_id: convId,
      sender_id: user.id,
      receiver_id: otherUserId,
      content: text,
      type: 'text',
      is_read: false,
      created_at: new Date().toISOString(),
    }]);

    const { data, error } = await supabase.rpc('send_chat_message', {
      p_receiver_id: otherUserId,
      p_content:     text,
      p_type:        'text',
    });

    const ok = !error && data?.success;
    if (!ok) {
      const msg = data?.message || error?.message || 'Send failed. Try again.';
      showCuteAlert('Message failed', msg);
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setInputText(text);
    }
  };

  const renderMessage = ({ item }) => {
    const isMe = item.sender_id === user?.id;
    return (
      <View style={[styles.messageWrapper, isMe ? styles.messageWrapperMe : styles.messageWrapperThem]}>
        {!isMe && (
          <Image
            source={{ uri: otherProfile?.avatar_url || `https://i.pravatar.cc/150?u=${otherUserId}` }}
            style={styles.msgAvatar}
          />
        )}
        <View style={isMe ? styles.messageBubbleMe : styles.messageBubbleThem}>
          <Text style={styles.messageText}>{item.content}</Text>
          <View style={styles.messageMetaRow}>
            <Text style={[styles.messageTime, isMe && { color: 'rgba(255,255,255,0.75)' }]}>
              {formatTime(item.created_at)}
            </Text>
            {isMe && !String(item.id).startsWith('temp-') && (
              <View style={styles.readReceipt}>
                <Ionicons
                  name={item.is_read ? 'checkmark-done' : 'checkmark'}
                  size={16}
                  color={item.is_read ? '#38BDF8' : 'rgba(255,255,255,0.6)'}
                />
                {item.is_read && (
                  <Text style={styles.seenLabel}>Seen</Text>
                )}
              </View>
            )}
          </View>
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior="padding"
        keyboardVerticalOffset={0}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.headerInfo}
            onPress={() => router.push(`/main/user/${otherUserId}`)}
          >
            <Image
              source={{ uri: otherProfile?.avatar_url || `https://i.pravatar.cc/150?u=${otherUserId}` }}
              style={styles.headerAvatar}
            />
            <Text style={styles.headerName}>{chatName}</Text>
          </TouchableOpacity>
          <View style={styles.headerActions}>
            <View style={styles.balanceBadge}>
              <Ionicons name="diamond" size={14} color="#00E5FF" />
              <Text style={styles.balanceText}>{diamonds}</Text>
            </View>
          </View>
        </View>

        {/* Chat Area */}
        {loading ? (
          <View style={styles.centerBox}><LogoLoader size="medium" /></View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={renderMessage}
            contentContainerStyle={messages.length === 0 ? styles.emptyList : styles.chatList}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={
              <View style={styles.emptyBox}>
                <Ionicons name="chatbubble-ellipses-outline" size={48} color="rgba(255,255,255,0.2)" />
                <Text style={styles.emptyText}>Start the conversation</Text>
              </View>
            }
          />
        )}

        {/* Input */}
        <View style={styles.inputContainer}>
          <TextInput
            style={styles.inputField}
            placeholder="Type a message..."
            placeholderTextColor="#6B7280"
            value={inputText}
            onChangeText={setInputText}
            multiline
          />
          {isSupportChannel ? (
            <View style={styles.supportHint}>
              <Ionicons name="shield-checkmark" size={10} color="#FBBF24" />
              <Text style={styles.supportHintText}>Free</Text>
            </View>
          ) : (
            <View style={styles.costHint}>
              <Ionicons name="diamond" size={10} color="#38BDF8" />
              <Text style={styles.costHintText}>{DM_MESSAGE_COST}/msg</Text>
            </View>
          )}
          <TouchableOpacity
            style={[styles.sendBtn, inputText.trim().length > 0 && styles.sendBtnActive]}
            onPress={sendMessage}
            disabled={inputText.trim().length === 0}
          >
            <Ionicons name="send" size={20} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0E111E' },
  keyboardView: { flex: 1 },
  centerBox: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: '#1E1A34', borderBottomWidth: 1, borderBottomColor: '#251B45',
  },
  backBtn: { padding: 4, marginRight: 8 },
  headerInfo: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  headerAvatar: { width: 36, height: 36, borderRadius: 18, marginRight: 12 },
  headerName: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  balanceBadge: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(0, 229, 255, 0.1)',
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, gap: 4,
  },
  balanceText: { color: '#00E5FF', fontSize: 13, fontWeight: 'bold' },

  chatList: { paddingHorizontal: 16, paddingVertical: 20 },
  emptyList: { flexGrow: 1, justifyContent: 'center' },
  emptyBox: { alignItems: 'center', padding: 40 },
  emptyText: { color: 'rgba(255,255,255,0.5)', marginTop: 14, fontSize: 14 },
  messageWrapper: { flexDirection: 'row', width: '100%', marginBottom: 12 },
  messageWrapperMe: { justifyContent: 'flex-end' },
  messageWrapperThem: { justifyContent: 'flex-start' },
  msgAvatar: { width: 32, height: 32, borderRadius: 16, marginRight: 8, alignSelf: 'flex-end' },
  messageBubbleThem: {
    backgroundColor: '#1E1A34', padding: 12, borderRadius: 16,
    borderBottomLeftRadius: 4, maxWidth: '75%',
  },
  messageBubbleMe: {
    backgroundColor: BRAND.primary, padding: 12, borderRadius: 16,
    borderBottomRightRadius: 4, maxWidth: '75%',
  },
  messageText: { color: '#FFFFFF', fontSize: 15, lineHeight: 22 },
  messageMetaRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end', marginTop: 4 },
  messageTime: { fontSize: 10, color: '#9CA3AF' },
  readReceipt: { flexDirection: 'row', alignItems: 'center', marginLeft: 6, gap: 3 },
  seenLabel: { color: '#38BDF8', fontSize: 9, fontWeight: '700', letterSpacing: 0.3 },
  costHint: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(56,189,248,0.10)', borderWidth: 1, borderColor: 'rgba(56,189,248,0.35)', borderRadius: 10, paddingHorizontal: 6, paddingVertical: 3, marginRight: 6, gap: 3 },
  costHintText: { color: '#38BDF8', fontSize: 10, fontWeight: '700' },
  supportHint: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(251,191,36,0.12)', borderWidth: 1, borderColor: 'rgba(251,191,36,0.5)', borderRadius: 10, paddingHorizontal: 6, paddingVertical: 3, marginRight: 6, gap: 3 },
  supportHintText: { color: '#FBBF24', fontSize: 10, fontWeight: '700' },

  inputContainer: {
    flexDirection: 'row', alignItems: 'flex-end', padding: 12,
    backgroundColor: '#1E1A34', borderTopWidth: 1, borderTopColor: '#251B45',
  },
  inputField: {
    flex: 1, backgroundColor: '#0E111E', color: '#FFFFFF', borderRadius: 20,
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12,
    minHeight: 45, maxHeight: 100, fontSize: 15,
    borderWidth: 1, borderColor: '#374151', marginRight: 8,
  },
  sendBtn: {
    width: 45, height: 45, borderRadius: 22.5,
    backgroundColor: '#374151', justifyContent: 'center', alignItems: 'center',
  },
  sendBtnActive: { backgroundColor: BRAND.primary },
});