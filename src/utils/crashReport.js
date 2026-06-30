import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { supabase } from '../api/supabase';

/**
 * Self-hosted crash reporting helper.
 *
 *   logCrash(err, { screen, context })
 *     - Fires-and-forgets a row into public.error_logs via the
 *       SECURITY DEFINER `log_app_error` RPC (migration 56).
 *     - Never throws; if the network is dead the report is lost.
 *       That's fine — we'd rather the user app stay up than crash a
 *       second time trying to report the first crash.
 *
 *   installGlobalErrorHandler()
 *     - Wires the bridge-level ErrorUtils.setGlobalHandler so red-box
 *       crashes in dev AND silent JS errors in production both hit
 *       logCrash before the engine carries on. Calls the previous
 *       handler last so the dev red box still shows in __DEV__.
 *
 * In production logCrash should keep going even if the SDK is in a
 * broken state, so every call is wrapped in try/catch.
 */

const APP_VERSION = Constants.expoConfig?.version
  ?? Constants.manifest?.version
  ?? '0.0.0';

export async function logCrash(err, opts = {}) {
  try {
    const message = (err && (err.message || String(err))) || 'unknown';
    const stack   = (err && err.stack) || null;
    await supabase.rpc('log_app_error', {
      p_message:     message,
      p_stack:       stack,
      p_screen:      opts.screen   || null,
      p_platform:    Platform.OS,
      p_app_version: APP_VERSION,
      p_context:     opts.context || null,
    });
  } catch (_) {
    // Swallow — we're already in an error path; don't recurse.
  }
}

let installed = false;
export function installGlobalErrorHandler() {
  if (installed) return;
  installed = true;

  try {
    const prev = (global).ErrorUtils?.getGlobalHandler?.();
    (global).ErrorUtils?.setGlobalHandler?.((err, isFatal) => {
      logCrash(err, { screen: 'global', context: { isFatal: !!isFatal } });
      if (typeof prev === 'function') {
        try { prev(err, isFatal); } catch (_) {}
      }
    });
  } catch (_) {}

  // Unhandled promise rejections in dev → log them too. In RN the
  // rejection-tracking module is what surfaces these; we lean on the
  // global event the runtime emits.
  try {
    const g = global;
    if (g.HermesInternal && typeof g.process?.on === 'function') {
      g.process.on('unhandledRejection', (reason) => {
        logCrash(reason instanceof Error ? reason : new Error(String(reason)),
          { screen: 'unhandledRejection' });
      });
    }
  } catch (_) {}
}