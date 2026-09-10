import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  isAudioLiveRewardTask,
  isRetiredHostLiveRewardTask,
  isTaskCenterRewardEligible,
} from './rewardPolicy';

const migrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20260825042000_strict_video_live_reward_policy.sql',
);
const finalPolicyMigrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20260825230000_video_reward_and_valid_day_stats.sql',
);
const dhakaMinuteMigrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20260825231000_dhaka_video_minute_windows.sql',
);

test('task center excludes audio and legacy host live-duration rewards', () => {
  assert.equal(isAudioLiveRewardTask({ action: 'audio_live' }), true);
  assert.equal(isAudioLiveRewardTask({ title: 'Audio Live Reward' }), true);
  assert.equal(isRetiredHostLiveRewardTask({ action: 'live', audience: 'host' }), true);
  assert.equal(isTaskCenterRewardEligible({ action: 'watch', audience: 'viewer' }), true);
  assert.equal(isTaskCenterRewardEligible({ action: 'gift', audience: 'viewer' }), true);
});

test('migration makes video reward server-authoritative, continuous, and once daily', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.match(sql, /FOR UPDATE/i);
  assert.match(sql, /v_stream_type <> 'video'/i);
  assert.match(sql, /v_delta_seconds > 45/i);
  assert.match(sql, /v_delta_seconds = 0/i);
  assert.match(sql, /v_seconds >= 3600/i);
  assert.match(sql, /PRIMARY KEY\s*\(user_id,\s*reward_date\)/i);
  assert.match(sql, /rewarded_at IS NULL/i);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.live_stream_heartbeat/i);
});

test('Dhaka midnight preserves an unfinished uninterrupted attempt but starts a new window after payment', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.match(sql, /v_day_start TIMESTAMPTZ.*Asia\/Dhaka/i);
  assert.match(sql, /v_stream\.reward_progress_date IS DISTINCT FROM v_reward_date/i);
  assert.match(sql, /previous_reward\.rewarded_at IS NOT NULL/i);
  assert.match(sql, /v_stream\.reward_continuous_seconds \+ v_delta_seconds/i);
  assert.match(sql, /v_now - GREATEST\(v_stream\.reward_last_heartbeat_at, v_day_start\)/i);
  assert.doesNotMatch(
    sql,
    /IF v_stream\.reward_progress_date IS DISTINCT FROM v_reward_date\s+OR[\s\S]{0,100}reward_last_heartbeat_at IS NULL THEN\s+v_seconds := 0/i,
  );
});

test('migration retires claimable host live tasks and blocks their direct claim path', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.match(sql, /UPDATE public\.tasks[\s\S]*SET is_active = FALSE/i);
  assert.match(sql, /Audio live and live-duration task rewards are disabled/i);
  assert.match(sql, /DROP TRIGGER IF EXISTS trg_live_task_progress/i);
});

test('final policy fixes the reward at 5,000 and excludes audio from all live-time totals', () => {
  const sql = fs.readFileSync(finalPolicyMigrationPath, 'utf8');
  assert.match(sql, /v_beans CONSTANT BIGINT := 5000/i);
  assert.match(sql, /v_stream_type <> 'video'/i);
  assert.match(sql, /v_seconds >= 3600/i);
  assert.match(sql, /reward_date = v_reward_date[\s\S]*rewarded_at IS NULL/i);
  assert.match(sql, /SUM\(session_row\.minutes\) FILTER \(WHERE session_row\.type = 'video'\)/i);
  assert.match(sql, /video_minutes >= 35/i);
  assert.match(sql, /LOWER\(BTRIM\(COALESCE\(stream_row\.type, ''\)\)\) = 'video'/i);
  assert.match(sql, /CASE WHEN COALESCE\(video_row\.minutes, 0\) >= 35 THEN 1 ELSE 0 END/i);
  assert.doesNotMatch(sql, /v_cfg->>'beans'/i);
});

test('host period minutes use Dhaka video-day slices instead of stream start dates', () => {
  const sql = fs.readFileSync(dhakaMinuteMigrationPath, 'utf8');
  assert.match(sql, /AT TIME ZONE 'Asia\/Dhaka'/i);
  assert.match(sql, /WHERE session_row\.type = 'video'/i);
  assert.match(sql, /SELECT SUM\(video_minutes\) FROM video_day_minutes/i);
  assert.match(sql, /video_minutes >= 35/i);
  assert.doesNotMatch(sql, /SUM\(session_row\.minutes\) FILTER/i);
});
