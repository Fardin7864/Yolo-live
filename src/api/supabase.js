import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TENANT_CONFIG } from '../../tenant.config';

// =====================================================================
// Supabase client — reads URL + anon key from tenant.config.js.
// To deploy this codebase for a new SaaS tenant, edit ONLY
// tenant.config.js (supabase.url + supabase.anonKey) and rebuild.
// =====================================================================
const supabaseUrl     = TENANT_CONFIG.supabase.url;
const supabaseAnonKey = TENANT_CONFIG.supabase.anonKey;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
