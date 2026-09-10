import { supabase } from './supabase';

const VALID_KINDS = new Set(['host', 'gifter']);
const VALID_PERIODS = new Set(['daily', 'monthly']);

const isMissingRpcError = (error) => {
  const code = String(error?.code || '');
  const message = String(error?.message || '').toLowerCase();
  return code === 'PGRST202'
    || code === '42883'
    || (message.includes('function') && message.includes('schema cache'));
};

export const normalizeExploreRankingRows = (rows, kind) => (Array.isArray(rows) ? rows : [])
  .map((row) => ({
    profile_id: row.profile_id || (kind === 'host' ? row.broadcaster_id : row.sender_id),
    full_name: row.full_name || row.sender_name || null,
    avatar_url: row.avatar_url || row.sender_avatar || null,
    display_id: row.display_id ?? null,
    vip_type: row.vip_type || null,
    total_diamonds: Number(row.total_diamonds || 0),
    gift_count: Number(row.gift_count || 0),
  }))
  .filter((row) => row.profile_id && row.total_diamonds > 0);

export async function fetchExploreRanking({
  kind,
  period = 'daily',
  limit = 20,
  client = supabase,
}) {
  if (!VALID_KINDS.has(kind)) throw new Error(`Unsupported Explore ranking kind: ${kind}`);
  if (!VALID_PERIODS.has(period)) throw new Error(`Unsupported Explore ranking period: ${period}`);

  const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 20)));
  const primary = await client.rpc('get_explore_ranking', {
    p_kind: kind,
    p_period: period,
    p_limit: safeLimit,
  });

  if (!primary.error) return normalizeExploreRankingRows(primary.data, kind);
  if (!isMissingRpcError(primary.error)) throw primary.error;

  // Compatibility while the dedicated migration rolls through environments.
  // These functions retain their legacy column names, normalized above.
  if (kind === 'host' && period !== 'daily') throw primary.error;

  const fallback = kind === 'host'
    ? await client.rpc('get_top_broadcasters_daily', { limit_n: safeLimit })
    : await client.rpc('get_top_gifters', { period_key: period, limit_n: safeLimit });

  if (!fallback.error) return normalizeExploreRankingRows(fallback.data, kind);

  // Older installations have only the trailing-24-hour host RPC. It is better
  // to show current host activity than a false empty state until migration.
  if (kind === 'host' && isMissingRpcError(fallback.error)) {
    const legacy = await client.rpc('get_top_broadcasters_24h', { limit_n: safeLimit });
    if (!legacy.error) return normalizeExploreRankingRows(legacy.data, kind);
    throw legacy.error;
  }

  throw fallback.error;
}
