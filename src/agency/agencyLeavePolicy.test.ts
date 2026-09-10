import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const migration = fs.readFileSync(path.join(
  process.cwd(),
  'supabase/migrations/20260825232000_super_admin_agency_leave_approval.sql',
), 'utf8');
const dashboardReviewMigration = fs.readFileSync(path.join(
  process.cwd(),
  'supabase/migrations/20260826170000_agency_leave_dashboard_reviews.sql',
), 'utf8');

function functionBody(name: string) {
  const match = migration.match(new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`,
    'i',
  ));
  assert.ok(match, `${name} must exist in the migration`);
  return match[1];
}

test('submitting agency leave creates only a pending request', () => {
  const sql = functionBody('leave_agency');
  assert.match(sql, /INSERT INTO public\.agency_leave_requests/i);
  assert.match(sql, /status', 'pending'/i);
  assert.match(sql, /penalty_charged', FALSE/i);
  assert.doesNotMatch(sql, /UPDATE public\.profiles/i);
  assert.doesNotMatch(sql, /UPDATE public\.agency_members/i);
  assert.doesNotMatch(sql, /INSERT INTO public\.transactions/i);
});

function latestFunctionBody(name: string) {
  const match = dashboardReviewMigration.match(new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`,
    'i',
  ));
  assert.ok(match, `${name} must exist in the dashboard review migration`);
  return match[1];
}

test('admin or owning agency approval releases membership and charges the penalty', () => {
  const sql = latestFunctionBody('approve_leave_request');
  assert.match(sql, /public\.can_review_agency_leave\(v_request\.agency_id, me\)/i);
  assert.match(sql, /FOR UPDATE/i);
  assert.match(sql, /v_balance_after := v_diamonds - v_request\.penalty_amount/i);
  assert.match(sql, /SET status = 'released'/i);
  assert.match(sql, /SET status = 'approved'/i);
  assert.match(sql, /'agency_leave_penalty'/i);
  assert.match(sql, /'approve_agency_leave'/i);
});

test('agency leave requests are readable by host, admin, and agency owner', () => {
  assert.match(dashboardReviewMigration, /CREATE OR REPLACE FUNCTION public\.can_review_agency_leave/i);
  assert.match(dashboardReviewMigration, /public\.is_admin\(p_user_id\)/i);
  assert.match(dashboardReviewMigration, /agency_row\.owner_id = p_user_id/i);
  assert.match(dashboardReviewMigration, /CREATE POLICY agency_leave_requests_read/i);
  assert.match(dashboardReviewMigration, /host_id = auth\.uid\(\)/i);
  assert.match(dashboardReviewMigration, /public\.can_review_agency_leave\(agency_id, auth\.uid\(\)\)/i);
});

test('legacy pending statuses are restored to active membership', () => {
  assert.match(migration, /WHERE member_row\.status = 'leave_pending'/i);
  assert.match(migration, /SET status = 'active', released_at = NULL[\s\S]*WHERE status = 'leave_pending'/i);
  assert.match(migration, /DROP FUNCTION IF EXISTS public\.approve_leave_request\(UUID\)/i);
  assert.match(migration, /Only a Super Admin can release agency hosts/i);
});
