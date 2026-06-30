import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Modal, View, Text, TouchableOpacity, Animated, StyleSheet, BackHandler } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BRAND } from '../theme/brand';

// Single global slot — only one cute alert can show at a time. New calls
// replace the current one (same UX as native Alert.alert).
let setOptionsRef = null;

/**
 * Drop-in replacement for React Native's Alert.alert.
 * Same signature: showCuteAlert(title, message, buttons?, options?).
 * `buttons` is the same `[{ text, onPress, style }]` shape.
 *
 * Returns a promise that resolves to the pressed button's text (or null
 * if dismissed without a button).
 */
export function showCuteAlert(title, message, buttons, options) {
  if (!setOptionsRef) {
    console.warn('CuteAlertHost not mounted yet — falling back to no-op.');
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    setOptionsRef({
      open: true,
      title: title || '',
      message: message || '',
      buttons: Array.isArray(buttons) && buttons.length > 0
        ? buttons
        : [{ text: 'OK' }],
      cancelable: options?.cancelable !== false,
      _resolve: resolve,
    });
  });
}

/**
 * Convenience helper for confirm-style dialogs.
 * Returns a promise that resolves to true if confirmed, false otherwise.
 */
export function confirmCuteAlert(title, message, { confirmText = 'Confirm', cancelText = 'Cancel', destructive = false } = {}) {
  return new Promise((resolve) => {
    showCuteAlert(title, message, [
      { text: cancelText, style: 'cancel', onPress: () => resolve(false) },
      { text: confirmText, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ]);
  });
}

// Detect intent from the title so we can pick an appropriate icon + color
// without each caller having to specify one.
function detectIntent(title = '', buttons = []) {
  const t = title.toLowerCase();
  const hasDestructive = buttons.some((b) => b?.style === 'destructive');
  if (/(failed|error|cannot|denied)/.test(t)) return 'error';
  if (/(reported|followed|success|saved|sent|unblocked|🎉|won)/.test(t)) return 'success';
  if (/(blocked|kicked|removed|banned|kick out|delete)/.test(t)) return 'destructive';
  if (hasDestructive || /(confirm|are you sure|sure\?)/.test(t)) return 'warning';
  return 'info';
}

const INTENT_THEMES = {
  info:        { icon: 'sparkles',           color: BRAND.primary, bg: `${BRAND.primary}26` },
  success:     { icon: 'checkmark-circle',   color: '#4ADE80', bg: 'rgba(74,222,128,0.15)' },
  warning:     { icon: 'alert-circle',       color: '#FBBF24', bg: 'rgba(251,191,36,0.15)' },
  error:       { icon: 'close-circle',       color: '#EF4444', bg: 'rgba(239,68,68,0.15)' },
  destructive: { icon: 'warning',            color: '#EF4444', bg: 'rgba(239,68,68,0.15)' },
};

export function CuteAlertHost() {
  const [opts, setOpts] = useState({
    open: false, title: '', message: '', buttons: [], cancelable: true, _resolve: null,
  });

  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Expose the setter through a module-level ref so the imperative
    // `showCuteAlert` helper can drive this host without prop-drilling.
    setOptionsRef = setOpts;
    return () => { if (setOptionsRef === setOpts) setOptionsRef = null; };
  }, []);

  // Run the in / out animation when opacity changes.
  useEffect(() => {
    Animated.spring(anim, {
      toValue: opts.open ? 1 : 0,
      useNativeDriver: true,
      friction: 8,
      tension: 90,
    }).start();
  }, [opts.open]);

  // Hardware back button on Android cancels if cancelable.
  useEffect(() => {
    if (!opts.open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (opts.cancelable) {
        close(null);
        return true;
      }
      return true; // block back from leaving the screen while a dialog is open
    });
    return () => sub.remove();
  }, [opts.open, opts.cancelable]);

  const close = useCallback((resultText) => {
    const resolve = opts._resolve;
    setOpts((prev) => ({ ...prev, open: false, _resolve: null }));
    if (resolve) resolve(resultText);
  }, [opts._resolve]);

  const onPressBtn = (btn) => {
    close(btn.text);
    // Fire the caller's onPress AFTER closing so callers can themselves
    // open another alert without a flicker.
    setTimeout(() => { try { btn.onPress?.(); } catch (e) { console.warn(e); } }, 0);
  };

  const intent = detectIntent(opts.title, opts.buttons);
  const theme = INTENT_THEMES[intent] || INTENT_THEMES.info;
  const stackButtons = (opts.buttons?.length || 0) > 2;

  return (
    <Modal
      visible={opts.open}
      transparent
      statusBarTranslucent
      animationType="none"
      onRequestClose={() => { if (opts.cancelable) close(null); }}
    >
      <TouchableOpacity
        style={styles.backdrop}
        activeOpacity={1}
        onPress={() => { if (opts.cancelable) close(null); }}
      >
        <Animated.View
          pointerEvents="box-none"
          style={{
            opacity: anim,
            transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }],
          }}
        >
          <TouchableOpacity activeOpacity={1} onPress={() => { /* swallow taps */ }}>
            <View style={[styles.card, { shadowColor: theme.color, borderColor: 'rgba(255,255,255,0.08)' }]}>
              <LinearGradient
                colors={['#1F1638', '#2A1B45', BRAND.splashBg]}
                style={styles.cardGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
              >
                <View style={[styles.iconCircle, { backgroundColor: theme.bg }]}>
                  <Ionicons name={theme.icon} size={26} color={theme.color} />
                </View>
                {!!opts.title && <Text style={styles.title}>{opts.title}</Text>}
                {!!opts.message && <Text style={styles.message}>{opts.message}</Text>}

                <View style={[styles.buttonRow, stackButtons && styles.buttonStack]}>
                  {opts.buttons.map((b, i) => {
                    const isCancel = b.style === 'cancel';
                    const isDestructive = b.style === 'destructive';
                    const isLast = i === opts.buttons.length - 1;
                    return (
                      <TouchableOpacity
                        key={b.text + i}
                        style={[
                          stackButtons ? styles.btnStacked : styles.btnInline,
                          isCancel ? styles.btnCancel
                            : isDestructive ? styles.btnDestructive
                            : styles.btnPrimary,
                          !stackButtons && !isLast && { marginRight: 8 },
                          stackButtons && !isLast && { marginBottom: 8 },
                        ]}
                        onPress={() => onPressBtn(b)}
                      >
                        <Text
                          style={[
                            styles.btnText,
                            isCancel && { color: 'rgba(255,255,255,0.85)' },
                            isDestructive && { color: '#FFF' },
                          ]}
                        >
                          {b.text}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </LinearGradient>
            </View>
          </TouchableOpacity>
        </Animated.View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 28,
  },
  card: {
    width: 290,
    borderRadius: 24,
    borderWidth: 1,
    overflow: 'hidden',
    shadowOpacity: 0.5,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 6 },
    elevation: 16,
  },
  cardGradient: {
    paddingVertical: 22,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  iconCircle: {
    width: 48, height: 48, borderRadius: 24,
    justifyContent: 'center', alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 6,
  },
  message: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginBottom: 16,
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    justifyContent: 'center',
  },
  buttonStack: {
    flexDirection: 'column',
  },
  btnInline: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnStacked: {
    width: '100%',
    paddingVertical: 11,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPrimary: {
    backgroundColor: BRAND.primary,
  },
  btnCancel: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  btnDestructive: {
    backgroundColor: '#EF4444',
  },
  btnText: {
    color: '#FFF',
    fontSize: 13.5,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
});

export default CuteAlertHost;