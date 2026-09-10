import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('new live viewers receive only activity broadcast after they join', async () => {
  const roomSource = await fs.readFile(path.join(process.cwd(), 'app/broadcast/[id].js'), 'utf8');
  const migration = await fs.readFile(path.join(
    process.cwd(),
    'supabase/migrations/20260910111000_disable_live_room_history_replay.sql',
  ), 'utf8');

  assert.doesNotMatch(roomSource, /get_live_room_event_history|append_live_room_event|data\.recent_gifts/);
  assert.match(roomSource, /\.on\('broadcast', \{ event: 'chat' \}/);
  assert.match(migration, /DROP TABLE IF EXISTS public\.live_room_events/i);
  assert.match(migration, /'recent_gifts', '\[\]'::JSONB/i);
  assert.match(migration, /'total_gifts', COALESCE\(v_stream\.total_gifts, 0\)/i);
  assert.match(migration, /'total_earnings', COALESCE\(v_stream\.total_earnings, 0\)/i);
});
