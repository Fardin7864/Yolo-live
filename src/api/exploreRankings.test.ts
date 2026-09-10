import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fetchExploreRanking, normalizeExploreRankingRows } from './exploreRankings';

test('normalizes host and gifter RPC shapes to one Explore contract', () => {
  assert.deepEqual(normalizeExploreRankingRows([{
    broadcaster_id: 'host-1',
    full_name: 'Host',
    total_diamonds: '12000',
    gift_count: '4',
  }], 'host')[0], {
    profile_id: 'host-1', full_name: 'Host', avatar_url: null, display_id: null,
    vip_type: null, total_diamonds: 12000, gift_count: 4,
  });
  assert.equal(normalizeExploreRankingRows([{
    sender_id: 'gifter-1', sender_name: 'Gifter', total_diamonds: 9000, gift_count: 3,
  }], 'gifter')[0].profile_id, 'gifter-1');
});

test('uses the uniform ranking RPC with bounded arguments', async () => {
  const calls: any[] = [];
  const client = { rpc: async (name: string, args: unknown) => {
    calls.push([name, args]);
    return { data: [{ profile_id: 'host-1', total_diamonds: 5 }], error: null };
  } };
  const rows = await fetchExploreRanking({ kind: 'host', period: 'daily', limit: 999, client: client as any });
  assert.equal(rows[0].profile_id, 'host-1');
  assert.deepEqual(calls, [['get_explore_ranking', { p_kind: 'host', p_period: 'daily', p_limit: 100 }]]);
});

test('falls back only when an RPC is missing and preserves real errors', async () => {
  const calls: string[] = [];
  const fallbackClient = { rpc: async (name: string) => {
    calls.push(name);
    if (name === 'get_explore_ranking') return { data: null, error: { code: 'PGRST202', message: 'not in schema cache' } };
    return { data: [{ sender_id: 'gifter-1', total_diamonds: 1000, gift_count: 1 }], error: null };
  } };
  const rows = await fetchExploreRanking({ kind: 'gifter', client: fallbackClient as any });
  assert.equal(rows[0].profile_id, 'gifter-1');
  assert.deepEqual(calls, ['get_explore_ranking', 'get_top_gifters']);

  const denied = { code: '42501', message: 'permission denied' };
  const deniedClient = { rpc: async () => ({ data: null, error: denied }) };
  await assert.rejects(
    fetchExploreRanking({ kind: 'host', client: deniedClient as any }),
    (error: any) => error === denied,
  );
});

test('ranking migration uses Dhaka calendar windows and batch-safe totals', () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'supabase/migrations/20260825043000_explore_rankings.sql'),
    'utf8',
  );
  assert.match(sql, /AT TIME ZONE 'Asia\/Dhaka'/);
  assert.match(sql, /SUM\(gift_row\.diamond_cost\)::BIGINT/);
  assert.doesNotMatch(sql, /diamond_cost\s*\*\s*(?:COALESCE|GREATEST|gift_row\.count)/i);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.get_explore_ranking\(TEXT, TEXT, INT\) TO authenticated/);
});

test('host ranking excludes gift recipients that have never broadcast a live', () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'supabase/migrations/20260825043000_explore_rankings.sql'),
    'utf8',
  );
  assert.match(
    sql,
    /EXISTS\s*\([\s\S]*FROM public\.live_streams AS broadcaster_stream[\s\S]*broadcaster_stream\.broadcaster_id = gift_row\.receiver_id[\s\S]*\)/i,
  );
});
