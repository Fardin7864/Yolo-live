import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { logCrash } from '../utils/crashReport';
import { BRAND } from '../theme/brand';

/**
 * Top-level React error boundary. Anything that throws inside its
 * children gets caught here, the user sees a friendly "Something went
 * wrong" screen instead of a blank white box, and the error is
 * reported to public.error_logs via logCrash().
 *
 * On retry we clear the error state — the tree re-mounts so a transient
 * failure (network blip during initial fetch) can recover without a
 * full app restart.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Fire-and-forget — logCrash never throws.
    logCrash(error, {
      screen: this.props.name || 'ErrorBoundary',
      context: { componentStack: info?.componentStack || null },
    });
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <View style={s.container}>
        <View style={s.iconWrap}>
          <Ionicons name="warning" size={40} color="#FFF" />
        </View>
        <Text style={s.title}>Something went wrong</Text>
        <Text style={s.body}>
          We hit an unexpected error and the screen couldn't render. The
          team has been notified.
        </Text>
        {__DEV__ && this.state.error?.message ? (
          <Text style={s.dev}>{this.state.error.message}</Text>
        ) : null}
        <TouchableOpacity style={s.btn} onPress={this.reset}>
          <Ionicons name="refresh" size={16} color="#FFF" />
          <Text style={s.btnText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0E111E', alignItems: 'center', justifyContent: 'center', padding: 28 },
  iconWrap: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: '#F43F5E',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 18,
    shadowColor: '#F43F5E', shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 8 },
  },
  title: { color: '#FFF', fontSize: 20, fontWeight: '900', marginBottom: 8 },
  body:  { color: 'rgba(255,255,255,0.65)', fontSize: 13, textAlign: 'center', lineHeight: 19, marginBottom: 18 },
  dev:   { color: '#FBBF24', fontSize: 11, marginBottom: 18, textAlign: 'center', fontFamily: 'monospace' },
  btn:   { flexDirection: 'row', gap: 8, alignItems: 'center', backgroundColor: BRAND.primary, paddingVertical: 11, paddingHorizontal: 22, borderRadius: 12 },
  btnText: { color: '#FFF', fontWeight: '700' },
});