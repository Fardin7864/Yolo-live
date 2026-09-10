import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { config } from './config.js';

export type JsonRow = Record<string, any>;
// `ws` implements the browser-compatible constructor Supabase uses at runtime;
// its Node typings include extra constructor overloads that are narrower than
// Supabase's structural type, so bridge that harmless typing difference here.
const nodeRealtime = { transport: WebSocket as any };
export const serviceDb = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: nodeRealtime,
});
export function userDb(accessToken: string): SupabaseClient {
  return createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    realtime: nodeRealtime,
  });
}
export async function rpc<T = JsonRow>(db: SupabaseClient, name: string, args: JsonRow = {}): Promise<T> {
  const { data, error } = await db.rpc(name, args); if (error) throw error; return data as T;
}
export async function authenticate(accessToken: string) {
  const db = userDb(accessToken); const { data, error } = await db.auth.getUser(accessToken);
  if (error || !data.user) throw new Error('UNAUTHORIZED'); return { user: data.user, db };
}
