// Runs the Mycroscope migration inside PGlite (in-process Postgres) with a minimal
// stand-in for Supabase's auth schema, then exercises security and reporting rules.
// Usage: npm test   (from supabase/tests)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, '..', 'migrations');

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    raw_user_meta_data jsonb,
    email_confirmed_at timestamptz,
    created_at timestamptz default now()
  );
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
  create publication supabase_realtime;
`;

let db;

async function asRole(role, uid, fn, aal = 'aal1') {
  await db.exec(`set role ${role}`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, aal })]);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}
const asUser = (uid, sql, params = []) => asRole('authenticated', uid, () => db.query(sql, params));
const asUser2fa = (uid, sql, params = []) => asRole('authenticated', uid, () => db.query(sql, params), 'aal2');
const asAnon = (sql, params = []) => asRole('anon', null, () => db.query(sql, params));

async function signUp(email, meta) {
  const id = randomUUID();
  await db.query(
    'insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)',
    [id, email, JSON.stringify(meta)]);
  return id;
}

async function rejects(promise, pattern) {
  await assert.rejects(promise, (err) => {
    if (pattern && !pattern.test(err.message)) {
      throw new Error(`expected error matching ${pattern}, got: ${err.message}`);
    }
    return true;
  });
}

const ctx = {};

before(async () => {
  db = new PGlite({ extensions: { pgcrypto, btree_gist } });
  await db.exec(SUPABASE_STUB);
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
});

test('owner sign-up creates organisation, settings, owner and first notice', async () => {
  ctx.ownerAuth = await signUp('owner@acme.co.za', {
    signup_type: 'owner', organization_name: 'Acme Logistics', full_name: 'Thandi Owner' });

  const { rows } = await asUser(ctx.ownerAuth,
    'select e.id, e.role, e.organization_id, o.timezone from employees e join organizations o on o.id = e.organization_id');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'owner');
  assert.equal(rows[0].timezone, 'Africa/Johannesburg');
  ctx.ownerId = rows[0].id;
  ctx.orgId = rows[0].organization_id;

  const policy = await asUser(ctx.ownerAuth, 'select * from get_my_policy_status()');
  assert.equal(policy.rows[0].version, 1);
  assert.match(policy.rows[0].notice_text, /Acme Logistics/);
  assert.match(policy.rows[0].notice_text, /Full web addresses/);
  assert.equal(policy.rows[0].acknowledged, false);
});

test('sign-up without a valid flow is rejected', async () => {
  await rejects(signUp('random@example.com', {}), /not open/);
  await rejects(signUp('owner@acme.co.za', {
    signup_type: 'owner', organization_name: 'Dup', full_name: 'Dup' }), /already registered|duplicate/);
});

test('owner adds an employee and receives an activation code', async () => {
  const { rows } = await asUser(ctx.ownerAuth,
    `select * from create_employee('Sipho Worker', 'Sipho@Acme.co.za')`);
  assert.equal(rows.length, 1);
  assert.match(rows[0].activation_code, /^[A-Z2-9]{10}$/);
  ctx.empId = rows[0].employee_id;
  ctx.empCode = rows[0].employee_code;
  ctx.activationCode = rows[0].activation_code;
  assert.match(ctx.empCode, /^AL\d{4}$/);
});

test('anon can resolve a login email but cannot read tables', async () => {
  const resolved = await asAnon('select resolve_login_email($1) as email', [ctx.empCode]);
  assert.equal(resolved.rows[0].email, 'sipho@acme.co.za');
  await rejects(asAnon('select * from employees'), /permission denied/);
  await rejects(asAnon('select * from activity_segments'), /permission denied/);
});

test('activation requires the right code and consumes it', async () => {
  await rejects(signUp('sipho@acme.co.za', {
    signup_type: 'employee_activation', employee_code: ctx.empCode, activation_code: 'WRONGCODE2' }), /Invalid or expired/);
  await rejects(signUp('other@acme.co.za', {
    signup_type: 'employee_activation', employee_code: ctx.empCode, activation_code: ctx.activationCode }), /Invalid activation/);

  ctx.empAuth = await signUp('sipho@acme.co.za', {
    signup_type: 'employee_activation', employee_code: ctx.empCode, activation_code: ctx.activationCode.toLowerCase() });

  const user = await db.query('select email_confirmed_at, raw_user_meta_data from auth.users where id = $1', [ctx.empAuth]);
  assert.ok(user.rows[0].email_confirmed_at, 'activated employee should be email-confirmed');
  assert.equal(user.rows[0].raw_user_meta_data.activation_code, undefined, 'code must not be stored');
  const left = await db.query('select count(*)::int as n from employee_activations');
  assert.equal(left.rows[0].n, 0);
});

test('employees cannot write to protected tables or escalate', async () => {
  await rejects(asUser(ctx.empAuth, `update employees set role = 'owner' where id = $1`, [ctx.empId]), /permission denied/);
  await rejects(asUser(ctx.empAuth, `insert into audit_log (action) values ('x')`), /permission denied/);
  await rejects(asUser(ctx.empAuth, `select * from create_employee('X', 'x@acme.co.za')`), /Not allowed/);
  const settings = await asUser(ctx.empAuth, `update organization_settings set track_full_urls = false returning *`);
  assert.equal(settings.rows.length, 0, 'employee settings update must affect no rows');
});

test('activity is rejected until the employee acknowledges the notice', async () => {
  ctx.deviceId = randomUUID();
  await asUser(ctx.empAuth,
    'insert into devices (id, organization_id, employee_id, hostname) values ($1, $2, $3, $4)',
    [ctx.deviceId, ctx.orgId, ctx.empId, 'LAPTOP-01']);

  const seg = segment({ start: minutesAgo(30), end: minutesAgo(25) });
  await rejects(insertSegment(ctx.empAuth, seg), /row-level security/);

  const policy = await asUser(ctx.empAuth, 'select policy_id from get_my_policy_status()');
  await asUser(ctx.empAuth,
    'insert into consents (organization_id, employee_id, policy_id, device_id) values ($1, $2, $3, $4)',
    [ctx.orgId, ctx.empId, policy.rows[0].policy_id, ctx.deviceId]);

  // Activity from before the acknowledgement is still refused.
  await rejects(insertSegment(ctx.empAuth, seg), /row-level security/);
  await rejects(asUser(ctx.empAuth,
    `insert into consents (organization_id, employee_id, policy_id, acknowledged_at) values ($1, $2, $3, now() - interval '1 day')`,
    [ctx.orgId, ctx.empId, policy.rows[0].policy_id]), /row-level security|duplicate/);

  // Pretend the acknowledgement happened yesterday so the remaining tests can use recent timestamps.
  await db.query(`update consents set acknowledged_at = now() - interval '1 day' where employee_id = $1`, [ctx.empId]);
  await insertSegment(ctx.empAuth, seg);
  const { rows } = await asUser(ctx.empAuth, 'select count(*)::int as n from activity_segments');
  assert.equal(rows[0].n, 1);
});

function minutesAgo(m) {
  return new Date(Date.now() - m * 60_000).toISOString();
}

function segment({ start, end, state = 'active', app = 'Microsoft Excel', domain = null, id = randomUUID() }) {
  return { id, start, end, state, app, domain };
}

function insertSegment(auth, s) {
  return asUser(auth, `
    insert into activity_segments (id, organization_id, employee_id, device_id, state, started_at, ended_at, app_name, domain)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    on conflict (id) do update set ended_at = excluded.ended_at, state = excluded.state`,
    [s.id, ctx.orgId, ctx.empId, ctx.deviceId, s.state, s.start, s.end, s.app, s.domain]);
}

test('re-uploading a segment updates it instead of duplicating', async () => {
  const s = segment({ start: minutesAgo(20), end: minutesAgo(19) });
  await insertSegment(ctx.empAuth, s);
  await insertSegment(ctx.empAuth, { ...s, end: minutesAgo(18) });
  await insertSegment(ctx.empAuth, { ...s, end: minutesAgo(18) });
  const { rows } = await asUser(ctx.empAuth,
    'select count(*)::int as n, max(duration_seconds) as d from activity_segments where id = $1', [s.id]);
  assert.equal(rows[0].n, 1);
  assert.ok(rows[0].d >= 119 && rows[0].d <= 121);
});

test('overlapping, future and foreign segments are rejected', async () => {
  await rejects(insertSegment(ctx.empAuth, segment({ start: minutesAgo(29), end: minutesAgo(27) })), /no_overlap|exclusion/);
  await rejects(insertSegment(ctx.empAuth,
    segment({ start: new Date(Date.now() + 3600_000).toISOString(), end: new Date(Date.now() + 3700_000).toISOString() })),
    /not_future|row-level security/);
  await rejects(insertSegment(ctx.empAuth,
    segment({ start: minutesAgo(60 * 24 * 20), end: minutesAgo(60 * 24 * 20 - 1) })), /row-level security/);
  await rejects(asUser(ctx.empAuth, `
    insert into activity_segments (id, organization_id, employee_id, device_id, state, started_at, ended_at)
    values ($1, $2, $3, $4, 'active', now() - interval '3 minutes', now() - interval '2 minutes')`,
    [randomUUID(), ctx.orgId, ctx.ownerId, ctx.deviceId]), /row-level security/);
});

test('organisations are isolated from each other', async () => {
  ctx.otherOwnerAuth = await signUp('boss@other.co.za', {
    signup_type: 'owner', organization_name: 'Other Co', full_name: 'Other Boss' });
  const seen = await asUser(ctx.otherOwnerAuth, 'select count(*)::int as n from activity_segments');
  assert.equal(seen.rows[0].n, 0);
  const emps = await asUser(ctx.otherOwnerAuth, 'select count(*)::int as n from employees');
  assert.equal(emps.rows[0].n, 1);
  const overview = await asUser(ctx.otherOwnerAuth, 'select * from get_team_overview()');
  assert.ok(overview.rows.every((r) => r.employee_id !== ctx.empId));
  await rejects(asUser(ctx.otherOwnerAuth, 'select * from update_employee($1, $2)', [ctx.empId, 'Hacked']), /Not allowed/);
});

test('daily totals split at midnight in the organisation timezone (SAST)', async () => {
  // 21:30Z-22:30Z on 1 Oct = 23:30-00:30 SAST, so 30 minutes on each local day.
  await db.query(
    `insert into activity_segments (id, organization_id, employee_id, device_id, state, started_at, ended_at, app_name, updated_at)
     values ($1, $2, $3, $4, 'active', '2026-10-01T21:30:00Z', '2026-10-01T22:30:00Z', 'Outlook', '2026-10-01T22:30:00Z')`,
    [randomUUID(), ctx.orgId, ctx.empId, ctx.deviceId]);
  const { rows } = await asUser(ctx.ownerAuth,
    `select day::text, active_seconds::int from get_daily_totals($1, '2026-10-01', '2026-10-02')`, [ctx.empId]);
  assert.deepEqual(rows, [
    { day: '2026-10-01', active_seconds: 1800 },
    { day: '2026-10-02', active_seconds: 1800 },
  ]);

  const apps = await asUser(ctx.ownerAuth,
    `select app_name, active_seconds::int from get_app_totals($1, '2026-10-02', '2026-10-02')`, [ctx.empId]);
  assert.deepEqual(apps.rows, [{ app_name: 'Outlook', active_seconds: 1800 }]);
});

test('employees see only themselves; managers see their team', async () => {
  const empView = await asUser(ctx.empAuth, 'select count(*)::int as n from employees');
  assert.equal(empView.rows[0].n, 1);
  const empOverview = await asUser(ctx.empAuth, 'select * from get_team_overview()');
  assert.equal(empOverview.rows.length, 0);

  await asUser(ctx.empAuth, `
    insert into agent_status (employee_id, organization_id, device_id, state, app_name, last_seen_at)
    values ($1, $2, $3, 'active', 'Microsoft Excel', now())`, [ctx.empId, ctx.orgId, ctx.deviceId]);

  const overview = await asUser(ctx.ownerAuth, 'select * from get_team_overview()');
  const sipho = overview.rows.find((r) => r.employee_id === ctx.empId);
  assert.ok(sipho);
  assert.equal(sipho.is_online, true);
  assert.equal(sipho.current_app, 'Microsoft Excel');
  assert.ok(Number(sipho.active_seconds) >= 400, `expected today's active time, got ${sipho.active_seconds}`);
  assert.equal(sipho.needs_acknowledgement, false);
});

test('changing tracking settings publishes a new notice and requires re-acknowledgement', async () => {
  const upd = await asUser(ctx.ownerAuth,
    'update organization_settings set track_full_urls = false where organization_id = $1 returning *', [ctx.orgId]);
  assert.equal(upd.rows.length, 1);

  const status = await asUser(ctx.empAuth, 'select version, notice_text, acknowledged from get_my_policy_status()');
  assert.equal(status.rows[0].version, 2);
  assert.doesNotMatch(status.rows[0].notice_text, /Full web addresses/);
  assert.equal(status.rows[0].acknowledged, false);

  const overview = await asUser(ctx.ownerAuth, 'select needs_acknowledgement from get_team_overview() where employee_id = $1', [ctx.empId]);
  assert.equal(overview.rows[0].needs_acknowledgement, true);

  const audit = await asUser(ctx.ownerAuth, `select action from audit_log order by id`);
  const actions = audit.rows.map((r) => r.action);
  for (const a of ['organization_created', 'policy_published', 'employee_created', 'activation_code_issued',
                   'employee_activated', 'settings_updated']) {
    assert.ok(actions.includes(a), `audit log should contain ${a}`);
  }
  const empAudit = await asUser(ctx.empAuth, 'select count(*)::int as n from audit_log');
  assert.equal(empAudit.rows[0].n, 0, 'employees must not read the audit log');
});

const COMPLIANCE_SQL = 'select * from save_compliance_settings($1, $2, $3)';
const settingsArgs = (s, name = null, email = null) => [JSON.stringify(s), name, email];
const LAPTOP_POLICY = {
  track_apps: true, track_window_titles: false, track_web_domains: true, track_full_urls: false,
  idle_threshold_seconds: 600, allow_pause: false, retention_days: 60, summary_retention_days: 365,
  notice_custom_text: 'Applies to company laptops.',
};

test('saving settings and the Information Officer together publishes one notice version', async () => {
  const before = await asUser(ctx.ownerAuth, 'select max(version)::int as v from monitoring_policies');
  const saved = await asUser(ctx.ownerAuth, COMPLIANCE_SQL,
    settingsArgs(LAPTOP_POLICY, 'Lerato Officer', 'privacy@acme.co.za'));
  assert.equal(saved.rows[0].version, before.rows[0].v + 1);
  assert.match(saved.rows[0].notice_text, /Lerato Officer \(privacy@acme\.co\.za\)/);
  assert.match(saved.rows[0].notice_text, /Applies to company laptops\./);
  assert.match(saved.rows[0].notice_text, /deleted after 60 days/);
  assert.match(saved.rows[0].notice_text, /cannot be paused/);
  assert.doesNotMatch(saved.rows[0].notice_text, /Window titles/);
  const published = await asUser(ctx.ownerAuth,
    `select count(*)::int as n from audit_log where action = 'policy_published' and details->>'version' = $1`,
    [String(saved.rows[0].version)]);
  assert.equal(published.rows[0].n, 1);

  const again = await asUser(ctx.ownerAuth, COMPLIANCE_SQL,
    settingsArgs(LAPTOP_POLICY, 'Lerato Officer', 'privacy@acme.co.za'));
  assert.equal(again.rows[0].version, saved.rows[0].version, 'saving without changes must not publish');
});

test('compliance settings are validated and limited to managers', async () => {
  await rejects(asUser(ctx.empAuth, COMPLIANCE_SQL, settingsArgs({ track_apps: true })), /Not allowed/);
  await rejects(asUser(ctx.ownerAuth, COMPLIANCE_SQL,
    settingsArgs({ track_web_domains: false, track_full_urls: true })), /only be recorded when websites/);
  await rejects(asUser(ctx.ownerAuth, COMPLIANCE_SQL, settingsArgs({}, 'X', 'not-an-email')), /not valid/);
  await rejects(asUser(ctx.ownerAuth, COMPLIANCE_SQL, settingsArgs({ retention_days: 3 })), /check constraint/);
  await rejects(asUser(ctx.ownerAuth, COMPLIANCE_SQL, settingsArgs({ tracking_schedule: 'sometimes' })), /check constraint/);
});

test('reports can be filtered by project', async () => {
  const proj = await asUser(ctx.empAuth,
    `insert into projects (organization_id, name, created_by) values ($1, 'Client A', $2) returning id`,
    [ctx.orgId, ctx.empId]);
  ctx.projectId = proj.rows[0].id;
  for (const [start, end, app, domain, project] of [
    ['2026-10-03T08:00:00Z', '2026-10-03T08:20:00Z', 'Chrome', 'clienta.com', ctx.projectId],
    ['2026-10-03T09:00:00Z', '2026-10-03T09:10:00Z', 'Excel', null, null],
  ]) {
    await db.query(
      `insert into activity_segments (id, organization_id, employee_id, device_id, project_id, state, started_at, ended_at, app_name, domain, updated_at)
       values ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $7)`,
      [randomUUID(), ctx.orgId, ctx.empId, ctx.deviceId, project, start, end, app, domain]);
  }

  const all = await asUser(ctx.ownerAuth,
    `select active_seconds::int from get_daily_totals($1, '2026-10-03', '2026-10-03')`, [ctx.empId]);
  assert.equal(all.rows[0].active_seconds, 1800);
  const filtered = await asUser(ctx.ownerAuth,
    `select active_seconds::int from get_daily_totals($1, '2026-10-03', '2026-10-03', $2)`, [ctx.empId, ctx.projectId]);
  assert.equal(filtered.rows[0].active_seconds, 1200);
  const apps = await asUser(ctx.ownerAuth,
    `select app_name from get_app_totals($1, '2026-10-03', '2026-10-03', $2)`, [ctx.empId, ctx.projectId]);
  assert.deepEqual(apps.rows, [{ app_name: 'Chrome' }]);
  const domains = await asUser(ctx.ownerAuth,
    `select domain from get_domain_totals($1, '2026-10-03', '2026-10-03', $2)`, [ctx.empId, ctx.projectId]);
  assert.deepEqual(domains.rows, [{ domain: 'clienta.com' }]);
  const timeline = await asUser(ctx.ownerAuth,
    `select project_name from get_timeline($1, '2026-10-03', $2)`, [ctx.empId, ctx.projectId]);
  assert.deepEqual(timeline.rows, [{ project_name: 'Client A' }]);
  await rejects(asAnon(`select * from get_app_totals($1, '2026-10-03', '2026-10-03')`, [ctx.empId]), /permission denied/);
});

test('role rules: only the owner manages managers and roles', async () => {
  const mgr = await asUser(ctx.ownerAuth, `select * from create_employee('Mary Manager', 'mary@acme.co.za', 'manager')`);
  const mgrAuth = await signUp('mary@acme.co.za', {
    signup_type: 'employee_activation', employee_code: mgr.rows[0].employee_code, activation_code: mgr.rows[0].activation_code });
  ctx.mgrAuth = mgrAuth;
  ctx.mgrId = mgr.rows[0].employee_id;
  await rejects(asUser(mgrAuth, `select * from create_employee('X', 'x2@acme.co.za', 'manager')`), /Only the owner/);
  await rejects(asUser(mgrAuth, `select * from update_employee($1, null, 'manager')`, [ctx.empId]), /Only the owner/);
  await rejects(asUser(mgrAuth, `select * from update_employee($1, 'Owner Renamed')`, [ctx.ownerId]), /Only the owner/);
  const ok = await asUser(mgrAuth, `select name from update_employee($1, 'Sipho M. Worker')`, [ctx.empId]);
  assert.equal(ok.rows[0].name, 'Sipho M. Worker');
});

test('deleting activity requires a reason and is audited', async () => {
  await rejects(asUser(ctx.ownerAuth,
    `select delete_activity($1, now() - interval '1 day', now(), '')`, [ctx.empId]), /reason/);
  const res = await asUser(ctx.ownerAuth,
    `select delete_activity($1, now() - interval '1 hour', now(), 'Employee request') as n`, [ctx.empId]);
  assert.ok(res.rows[0].n >= 1);
  const audit = await asUser(ctx.ownerAuth, `select details from audit_log where action = 'activity_deleted'`);
  assert.equal(audit.rows[0].details.reason, 'Employee request');
});

test('nightly maintenance builds summaries and purges expired data', async () => {
  await db.query(
    `insert into activity_segments (id, organization_id, employee_id, device_id, state, started_at, ended_at, app_name, updated_at)
     values ($1, $2, $3, $4, 'active', now() - interval '200 days', now() - interval '200 days' + interval '10 minutes', 'Old', now() - interval '200 days')`,
    [randomUUID(), ctx.orgId, ctx.empId, ctx.deviceId]);
  await db.query('select run_nightly_maintenance()');
  await db.query(`select refresh_daily_summaries($1, '2026-10-02')`, [ctx.orgId]);

  const old = await db.query(`select count(*)::int as n from activity_segments where app_name = 'Old'`);
  assert.equal(old.rows[0].n, 0);
  const summary = await asUser(ctx.ownerAuth,
    `select active_seconds, top_apps from daily_summaries where employee_id = $1 and day = '2026-10-02'`, [ctx.empId]);
  assert.equal(summary.rows[0].active_seconds, 1800);
  assert.equal(summary.rows[0].top_apps[0].app_name, 'Outlook');
  const purge = await db.query(`select details from audit_log where action = 'retention_purge'`);
  assert.ok(purge.rows.length >= 1);
});

// ---------------------------------------------------------------------------
// SaaS platform
// ---------------------------------------------------------------------------
test('new organisations start a 14-day trial with seat counts', async () => {
  const s = await asUser(ctx.ownerAuth, 'select * from get_my_service_status()');
  assert.equal(s.rows[0].level, 'full');
  assert.equal(s.rows[0].status, 'trialing');
  assert.equal(s.rows[0].seats, 25);
  assert.equal(s.rows[0].seats_used, 3);
  const days = (new Date(s.rows[0].trial_ends_at) - Date.now()) / 86_400_000;
  assert.ok(days > 13.9 && days <= 14.01);
  await rejects(asUser(ctx.ownerAuth, 'update subscriptions set seats = 999'), /permission denied/);
  const empView = await asUser(ctx.empAuth, 'select count(*)::int as n from subscriptions');
  assert.equal(empView.rows[0].n, 0, 'employees must not see billing');
});

test('seat limits block new employees and reactivation', async () => {
  await db.query('update subscriptions set seats = 3 where organization_id = $1', [ctx.orgId]);
  await rejects(asUser(ctx.ownerAuth, `select * from create_employee('Extra', 'extra@acme.co.za')`), /seats on your plan/);
  await db.query('update subscriptions set seats = 25 where organization_id = $1', [ctx.orgId]);
});

test('an expired trial makes the organisation read-only', async () => {
  await db.query(`update subscriptions set trial_ends_at = now() - interval '1 hour' where organization_id = $1`, [ctx.orgId]);
  const s = await asUser(ctx.ownerAuth, 'select level from get_my_service_status()');
  assert.equal(s.rows[0].level, 'read_only');
  await rejects(insertSegment(ctx.empAuth, segment({ start: minutesAgo(9), end: minutesAgo(8) })), /row-level security/);
  await rejects(asUser(ctx.ownerAuth, `select * from create_employee('Late', 'late@acme.co.za')`), /subscription is not active/);
  const still = await asUser(ctx.ownerAuth, 'select count(*)::int as n from activity_segments');
  assert.ok(still.rows[0].n > 0, 'existing data stays readable');

  await db.query(`update subscriptions set status = 'active', current_period_end = now() - interval '3 days'
                  where organization_id = $1`, [ctx.orgId]);
  const grace = await asUser(ctx.ownerAuth, 'select level, grace_until from get_my_service_status()');
  assert.equal(grace.rows[0].level, 'full', 'paid organisations keep working during the grace period');
  await insertSegment(ctx.empAuth, segment({ start: minutesAgo(9), end: minutesAgo(8) }));
});

test('working hours appear in the notice and is_work_time handles overnight shifts', async () => {
  await asUser(ctx.ownerAuth, COMPLIANCE_SQL, settingsArgs({
    tracking_schedule: 'work_hours', work_days: [1, 2, 3, 4, 5], work_start: '08:00', work_end: '17:00',
    flag_after_hours_use: true }, 'Lerato Officer', 'privacy@acme.co.za'));
  const notice = await asUser(ctx.empAuth, 'select notice_text, settings from get_my_policy_status()');
  assert.match(notice.rows[0].notice_text, /Monday, Tuesday, Wednesday, Thursday, Friday, 08:00 to 17:00 \(Africa\/Johannesburg/);
  assert.match(notice.rows[0].notice_text, /computer was in use \(not what it was used for\)/);
  assert.match(notice.rows[0].notice_text, /INTEGRITY CHECKS/);
  assert.equal(notice.rows[0].settings.tracking_schedule, 'work_hours');

  // 2026-10-05 is a Monday. 10:00 SAST = 08:00Z.
  const at = async (iso) => (await db.query('select is_work_time($1, $2) as w', [ctx.orgId, iso])).rows[0].w;
  assert.equal(await at('2026-10-05T08:00:00Z'), true);
  assert.equal(await at('2026-10-05T16:00:00Z'), false);
  assert.equal(await at('2026-10-04T08:00:00Z'), false, 'Sunday');
  await db.query(`update organization_settings set work_start = '22:00', work_end = '06:00' where organization_id = $1`, [ctx.orgId]);
  assert.equal(await at('2026-10-05T21:00:00Z'), true, 'Monday 23:00 starts the night shift');
  assert.equal(await at('2026-10-06T02:00:00Z'), true, 'Tuesday 04:00 belongs to Monday night');
  assert.equal(await at('2026-10-05T02:00:00Z'), false, 'Monday 04:00 belongs to Sunday night, not a work day');
  await db.query(`update organization_settings set work_start = '08:00', work_end = '17:00' where organization_id = $1`, [ctx.orgId]);
});

test('requiring two-factor login limits managers without it, without a new notice', async () => {
  const before = await asUser(ctx.ownerAuth, 'select max(version)::int as v from monitoring_policies');
  await asUser(ctx.ownerAuth, COMPLIANCE_SQL, settingsArgs({ require_mfa: true }, 'Lerato Officer', 'privacy@acme.co.za'));
  const after = await asUser(ctx.ownerAuth, 'select max(version)::int as v from monitoring_policies');
  assert.equal(after.rows[0].v, before.rows[0].v, 'the two-factor setting must not need re-acknowledgement');

  const without = await asUser(ctx.ownerAuth, 'select count(*)::int as n from get_team_overview()');
  assert.equal(without.rows[0].n, 0);
  const own = await asUser(ctx.ownerAuth, 'select count(*)::int as n from employees');
  assert.equal(own.rows[0].n, 1, 'without a second factor the owner sees only themselves');
  const withMfa = await asUser2fa(ctx.ownerAuth, 'select count(*)::int as n from get_team_overview()');
  assert.ok(withMfa.rows[0].n >= 3);
  await rejects(asUser2fa(ctx.mgrAuth, COMPLIANCE_SQL, settingsArgs({ require_mfa: false })), /Only the owner/);
  await asUser2fa(ctx.ownerAuth, COMPLIANCE_SQL, settingsArgs({ require_mfa: false }, 'Lerato Officer', 'privacy@acme.co.za'));
});

test('team managers see only their teams', async () => {
  const team = await asUser(ctx.ownerAuth, `select id from save_team(null, 'Dispatch')`);
  ctx.teamId = team.rows[0].id;
  await asUser(ctx.ownerAuth, 'select set_team_managers($1, $2)', [ctx.teamId, [ctx.mgrId]]);
  const none = await asUser(ctx.mgrAuth, 'select employee_id from get_team_overview()');
  assert.deepEqual(none.rows.map((r) => r.employee_id), [ctx.mgrId], 'the team is empty, so only herself');
  await rejects(asUser(ctx.mgrAuth, `select delete_activity($1, now() - interval '1 hour', now(), 'x')`, [ctx.empId]), /Not allowed/);

  await asUser(ctx.ownerAuth, 'select set_employee_team($1, $2)', [ctx.empId, ctx.teamId]);
  const some = await asUser(ctx.mgrAuth, 'select employee_id, team_name from get_team_overview() where employee_id = $1', [ctx.empId]);
  assert.equal(some.rows[0].team_name, 'Dispatch');
  await rejects(asUser(ctx.mgrAuth, `select save_team(null, 'Mine')`), /Only the owner/);
  const added = await asUser(ctx.mgrAuth, `select * from create_employee('Team Member', 'member@acme.co.za')`);
  const member = await db.query('select team_id from employees where id = $1', [added.rows[0].employee_id]);
  assert.equal(member.rows[0].team_id, ctx.teamId, 'a team manager adds people to their own team');
});

test('productivity categories classify apps and websites (including subdomains)', async () => {
  await asUser(ctx.ownerAuth, `select set_app_category('domain', 'https://www.YouTube.com/watch', 'unproductive')`);
  await asUser(ctx.ownerAuth, `select set_app_category('app', 'Microsoft Excel', 'productive')`);
  await rejects(asUser(ctx.empAuth, `select set_app_category('app', 'Solitaire', 'productive')`), /Not allowed/);
  const pattern = await asUser(ctx.ownerAuth, `select pattern from app_categories where kind = 'domain'`);
  assert.equal(pattern.rows[0].pattern, 'youtube.com');
  const cat = async (app, domain) =>
    (await asUser(ctx.ownerAuth, 'select category_of($1, $2, $3) as c', [ctx.orgId, app, domain])).rows[0].c;
  assert.equal(await cat('Google Chrome', 'm.youtube.com'), 'unproductive');
  assert.equal(await cat('Google Chrome', 'notyoutube.com'), 'uncategorised');
  assert.equal(await cat('microsoft excel', null), 'productive');

  const totals = await asUser(ctx.ownerAuth,
    `select category, active_seconds::int from get_category_totals($1, '2026-10-03', '2026-10-03')`, [ctx.empId]);
  assert.deepEqual(totals.rows, [{ category: 'uncategorised', active_seconds: 1800 }]);
});

test('employees send POPIA requests and managers respond', async () => {
  const req = await asUser(ctx.empAuth, `select * from submit_data_request('access', 'Please send me my data')`);
  const id = req.rows[0].id;
  await rejects(asUser(ctx.empAuth, `select respond_data_request($1, 'completed', 'done')`, [id]), /Not allowed/);
  await rejects(asUser(ctx.ownerAuth, `select respond_data_request($1, 'completed', '')`, [id]), /Write a response/);
  await asUser(ctx.ownerAuth, `select respond_data_request($1, 'completed', 'Export attached by email')`, [id]);
  const mine = await asUser(ctx.empAuth, 'select status, response from data_requests');
  assert.deepEqual(mine.rows, [{ status: 'completed', response: 'Export attached by email' }]);
  const other = await asUser(ctx.otherOwnerAuth, 'select count(*)::int as n from data_requests');
  assert.equal(other.rows[0].n, 0);
});

test('integrity events reach managers as alerts', async () => {
  await asUser(ctx.empAuth, `
    insert into agent_events (id, organization_id, employee_id, device_id, occurred_at, event_type, details)
    values ($1, $2, $3, $4, now() - interval '5 minutes', 'agent_gap', '{"minutes": 25}')`,
    [randomUUID(), ctx.orgId, ctx.empId, ctx.deviceId]);
  const alerts = await asUser(ctx.ownerAuth, `select kind, severity from get_integrity_alerts(now() - interval '1 day')
                                              where kind = 'agent_gap'`);
  assert.deepEqual(alerts.rows, [{ kind: 'agent_gap', severity: 'high' }]);
  const empAlerts = await asUser(ctx.empAuth, `select count(*)::int as n from get_integrity_alerts(now() - interval '1 day')`);
  assert.equal(empAlerts.rows[0].n, 0);
});

test('operators manage subscriptions but need customer approval for support access', async () => {
  await db.query(`insert into platform_admin_invites (email) values ('ops@mycroscope.co.za')`);
  ctx.opAuth = await signUp('ops@mycroscope.co.za', {});
  const me = await asUser(ctx.opAuth, 'select am_i_platform_admin() as op');
  assert.equal(me.rows[0].op, true);
  await rejects(asUser(ctx.opAuth, 'select * from op_organizations()'), /Two-factor/);
  await rejects(asUser(ctx.ownerAuth, 'select * from op_organizations()'), /Not allowed/);

  const orgs = await asUser2fa(ctx.opAuth, 'select name, owner_email, active_employees from op_organizations()');
  assert.ok(orgs.rows.some((o) => o.name === 'Acme Logistics' && o.owner_email === 'owner@acme.co.za'));
  const seen = await asUser2fa(ctx.opAuth, 'select count(*)::int as n from activity_segments');
  assert.equal(seen.rows[0].n, 0, 'operators cannot read activity');

  await rejects(asUser2fa(ctx.opAuth, `select op_update_subscription($1, 'standard', 'active', 30, null, now() + interval '30 days', '')`,
    [ctx.orgId]), /note/);
  await asUser2fa(ctx.opAuth, `select op_update_subscription($1, 'standard', 'active', 30, null, now() + interval '30 days', 'Paid by EFT')`,
    [ctx.orgId]);
  const customerAudit = await asUser(ctx.ownerAuth, `select details from audit_log where action = 'subscription_changed_by_provider'`);
  assert.equal(customerAudit.rows[0].details.note, 'Paid by EFT');

  await rejects(asUser2fa(ctx.opAuth, 'select * from op_support_snapshot($1)', [ctx.orgId]), /not granted support access/);
  await rejects(asUser(ctx.mgrAuth, `select grant_support_access(4, 'help')`), /Only the owner/);
  await asUser(ctx.ownerAuth, `select grant_support_access(4, 'Agent not reporting on LAPTOP-01')`);
  const snap = await asUser2fa(ctx.opAuth, 'select name, hostname from op_support_snapshot($1)', [ctx.orgId]);
  assert.ok(snap.rows.some((r) => r.hostname === 'LAPTOP-01'));
  const used = await asUser(ctx.ownerAuth, `select count(*)::int as n from audit_log where action = 'support_access_used'`);
  assert.equal(used.rows[0].n, 1);
  await asUser(ctx.ownerAuth, 'select revoke_support_access()');
  await rejects(asUser2fa(ctx.opAuth, 'select * from op_support_snapshot($1)', [ctx.orgId]), /not granted/);

  const health = await asUser2fa(ctx.opAuth, 'select organizations, open_data_requests from op_system_health()');
  assert.ok(health.rows[0].organizations >= 2);
  const opLog = await asUser2fa(ctx.opAuth, 'select action from op_operator_audit(10)');
  assert.ok(opLog.rows.some((r) => r.action === 'subscription_updated'));
});

test('operators can delete only cancelled organisations, with the name typed', async () => {
  const otherOrg = (await db.query(`select id from organizations where name = 'Other Co'`)).rows[0].id;
  await rejects(asUser2fa(ctx.opAuth, `select op_delete_organization($1, 'Other Co')`, [otherOrg]), /Only cancelled/);
  await asUser2fa(ctx.opAuth, `select op_update_subscription($1, null, 'cancelled', null, null, null, 'Customer left')`, [otherOrg]);
  await rejects(asUser2fa(ctx.opAuth, `select op_delete_organization($1, 'other co')`, [otherOrg]), /exactly/);
  await asUser2fa(ctx.opAuth, `select op_delete_organization($1, 'Other Co')`, [otherOrg]);
  const gone = await db.query('select count(*)::int as n from organizations where id = $1', [otherOrg]);
  assert.equal(gone.rows[0].n, 0);
  const user = await db.query(`select count(*)::int as n from auth.users where email = 'boss@other.co.za'`);
  assert.equal(user.rows[0].n, 0);
});

test('payments apply once and extend the paid period', async () => {
  await db.query(`update subscriptions set status = 'trialing', plan = 'trial', current_period_end = null where organization_id = $1`, [ctx.orgId]);
  const pay = (ref) => asRole('service_role', null, () => db.query(
    `select apply_payment($1, $2, 297000, 'ZAR', 30, 1, 'CUS_x', '{}') as applied`, [ctx.orgId, ref]));
  assert.equal((await pay('ref-1')).rows[0].applied, true);
  assert.equal((await pay('ref-1')).rows[0].applied, false, 'a retried webhook must not extend twice');
  const sub = await db.query('select status, plan, seats, current_period_end from subscriptions where organization_id = $1', [ctx.orgId]);
  assert.equal(sub.rows[0].status, 'active');
  assert.equal(sub.rows[0].plan, 'standard');
  assert.equal(sub.rows[0].seats, 30);
  const days = (new Date(sub.rows[0].current_period_end) - Date.now()) / 86_400_000;
  assert.ok(days > 27 && days < 32);
  await pay('ref-2');
  const twice = await db.query('select current_period_end from subscriptions where organization_id = $1', [ctx.orgId]);
  assert.ok((new Date(twice.rows[0].current_period_end) - Date.now()) / 86_400_000 > 56, 'paying early adds to the end');

  await rejects(asUser(ctx.ownerAuth, `select apply_payment($1, 'ref-3', 1, 'ZAR', 1, 1, null, '{}')`, [ctx.orgId]), /permission denied/);
  const seen = await asUser(ctx.ownerAuth, 'select count(*)::int as n from payments');
  assert.equal(seen.rows[0].n, 2);
  const empSeen = await asUser(ctx.empAuth, 'select count(*)::int as n from payments');
  assert.equal(empSeen.rows[0].n, 0);
  const audit = await asUser(ctx.ownerAuth, `select count(*)::int as n from audit_log where action = 'payment_received'`);
  assert.equal(audit.rows[0].n, 2);
});

test('case studies: free for the agreed months, then the 14-day trial', async () => {
  const op = (sql, params = []) => asUser2fa(ctx.opAuth, sql, params);
  const days = (iso) => (new Date(iso) - Date.now()) / 86_400_000;
  await rejects(asUser2fa(ctx.ownerAuth, `select op_invite_case_study('pilot@study.co.za', 12, 'Pilot')`), /Not allowed/);
  await rejects(op(`select op_invite_case_study('owner@acme.co.za', 12, 'Pilot')`), /already registered/);
  await rejects(op(`select op_invite_case_study('pilot@study.co.za', 30, 'Pilot')`), /between 1 and 24/);
  await rejects(op(`select op_invite_case_study('pilot@study.co.za', 12, ' ')`), /note/);
  await op(`select op_invite_case_study(' Pilot@Study.co.za ', 12, '2027 case study')`);
  assert.equal((await op('select count(*)::int as n from op_case_study_invites()')).rows[0].n, 1);

  const pilotAuth = await signUp('pilot@study.co.za', {
    signup_type: 'owner', organization_name: 'Pilot Study Co', full_name: 'Pat Pilot' });
  const status = (await asUser(pilotAuth, 'select * from get_my_service_status()')).rows[0];
  assert.equal(status.status, 'trialing');
  assert.equal(status.level, 'full');
  assert.ok(days(status.case_study_until) > 360 && days(status.case_study_until) < 370);
  assert.equal(Math.round((new Date(status.trial_ends_at) - new Date(status.case_study_until)) / 86_400_000), 14,
    'the normal 14-day trial follows the case study');
  assert.equal((await op('select count(*)::int as n from op_case_study_invites()')).rows[0].n, 0, 'the invite is used up');
  const pilotOrg = (await asUser(pilotAuth, 'select organization_id from employees')).rows[0].organization_id;
  const seen = await op('select case_study_until from op_organizations() where organization_id = $1', [pilotOrg]);
  assert.ok(seen.rows[0].case_study_until);

  const ended = (await op(`select * from op_set_case_study($1, 0, 'Pilot finished early')`, [pilotOrg])).rows[0];
  assert.ok(days(ended.trial_ends_at) > 13 && days(ended.trial_ends_at) < 15);
  await rejects(op(`select op_set_case_study($1, 0, 'again')`, [pilotOrg]), /No case study/);
  const restarted = (await op(`select * from op_set_case_study($1, 6, 'Extended')`, [pilotOrg])).rows[0];
  assert.ok(days(restarted.case_study_until) > 175);
  await rejects(op(`select op_set_case_study($1, 12, 'x')`, [ctx.orgId]), /paying customer/);

  const audit = await op(`select action from op_operator_audit(50) where action like 'case_study%'`);
  assert.ok(audit.rows.length >= 4);
  const customerAudit = await asUser(pilotAuth, `select count(*)::int as n from audit_log where action like 'case_study%'`);
  assert.equal(customerAudit.rows[0].n, 3, 'the customer can see when the provider changed their case study');
  await rejects(asUser(pilotAuth, 'select * from case_study_invites'), /permission denied/);
  await rejects(asUser(pilotAuth, `select start_case_study($1, 24)`, [pilotOrg]), /permission denied/);
});

test('email batches follow team scope and preferences, and only the service role can run them', async () => {
  const svc = (sql, params = []) => asRole('service_role', null, () => db.query(sql, params));
  const first = (await svc(`select claim_email_window('alerts', interval '1 day') as since`)).rows[0].since;
  assert.ok(Date.now() - new Date(first) > 23 * 3_600_000, 'the first run looks back by the default interval');
  const second = (await svc(`select claim_email_window('alerts', interval '1 day') as since`)).rows[0].since;
  assert.ok(Date.now() - new Date(second) < 60_000, 'later runs start where the previous one ended');

  const alerts = async () => Object.fromEntries((await svc('select * from email_alert_batch($1)', [first])).rows
    .map((r) => [r.recipient_email.toLowerCase(), r]));
  let rows = await alerts();
  assert.equal(rows['owner@acme.co.za'].high_alerts, 1);
  assert.equal(rows['mary@acme.co.za'].alerts, 1, 'the employee is in the team Mary manages');
  assert.equal(rows['boss@other.co.za'], undefined, 'other organisations are not told');

  await asUser(ctx.mgrAuth, 'select set_my_notification_preferences(true, false)');
  const prefs = await asUser(ctx.mgrAuth, 'select * from get_my_notification_preferences()');
  assert.deepEqual(prefs.rows, [{ weekly_digest: true, alert_emails: false }]);
  rows = await alerts();
  assert.equal(rows['mary@acme.co.za'], undefined, 'alert emails can be turned off');

  const digest = await svc('select * from email_digest_batch()');
  const owner = digest.rows.find((r) => r.recipient_email === 'owner@acme.co.za');
  assert.ok(owner.people >= 3 && owner.integrity_alerts >= 1);
  assert.ok(digest.rows.some((r) => r.recipient_email === 'mary@acme.co.za'));

  await rejects(asUser(ctx.ownerAuth, 'select * from email_digest_batch()'), /permission denied/);
  await rejects(asUser(ctx.ownerAuth, `select claim_email_window('alerts', interval '1 day')`), /permission denied/);
  await rejects(asUser(ctx.ownerAuth, 'select * from notification_preferences'), /permission denied/);
});

test('managers can save all settings without touching the two-factor rule', async () => {
  const status = await asUser(ctx.mgrAuth, 'select require_mfa from get_my_service_status()');
  assert.equal(status.rows[0].require_mfa, false);
  await asUser(ctx.mgrAuth, COMPLIANCE_SQL, settingsArgs({ require_mfa: false, allow_pause: false }, 'Lerato Officer', 'privacy@acme.co.za'));
  await rejects(asUser(ctx.mgrAuth, COMPLIANCE_SQL, settingsArgs({ require_mfa: true })), /Only the owner/);
});

test('nightly maintenance records its runs', async () => {
  await db.query('select run_nightly_maintenance()');
  const runs = await db.query('select count(*)::int as n from maintenance_runs');
  assert.ok(runs.rows[0].n >= 1);
});

test('anon cannot reach the new tables or functions', async () => {
  for (const t of ['subscriptions', 'teams', 'app_categories', 'data_requests', 'platform_admins']) {
    await rejects(asAnon(`select * from ${t}`), /permission denied/);
  }
  await rejects(asAnon('select * from get_my_service_status()'), /permission denied/);
  await rejects(asUser(ctx.empAuth, 'select * from platform_admin_invites'), /permission denied/);
});

test('a PC used while nobody is signed in alerts managers, using only the per-PC key', async () => {
  const key = 'k'.repeat(43);
  const report = async (minutes, k = key) =>
    (await asAnon('select report_unattended_use($1, $2, $3) as ok', [ctx.deviceId, k, minutes])).rows[0].ok;
  const events = () => db.query(
    `select details from agent_events where device_id = $1 and event_type = 'unattended_use' order by received_at`,
    [ctx.deviceId]);

  assert.equal(await report(15), false, 'no key registered yet');
  await rejects(asAnon('select set_device_report_key($1, $2)', [ctx.deviceId, key]), /permission denied/);
  await rejects(asUser(ctx.ownerAuth, 'select set_device_report_key($1, $2)', [ctx.deviceId, key]), /Not allowed/);
  await rejects(asUser(ctx.empAuth, 'select set_device_report_key($1, $2)', [ctx.deviceId, 'short']), /Invalid key/);
  await asUser(ctx.empAuth, 'select set_device_report_key($1, $2)', [ctx.deviceId, key]);

  const emailedSince = new Date(Date.now() - 60_000).toISOString();
  const emailed = async () => (await asRole('service_role', null, () => db.query(
    `select alerts from email_alert_batch($1) where recipient_email = 'owner@acme.co.za'`, [emailedSince]))).rows[0]?.alerts ?? 0;
  const emailedBefore = await emailed();

  assert.equal(await report(15, 'x'.repeat(43)), false, 'wrong key');
  assert.equal(await report(10), false, 'under 15 minutes');
  assert.equal(await report(15), true);
  assert.equal(await report(21), true);
  let rows = (await events()).rows;
  assert.equal(rows.length, 1, 'one alert per episode');
  assert.deepEqual(rows[0].details, { hostname: 'LAPTOP-01', minutes: 21 });

  const alerts = await asUser(ctx.ownerAuth, `select severity, details from get_integrity_alerts(now() - interval '1 day')
                                              where kind = 'unattended_use'`);
  assert.equal(alerts.rows.length, 1);
  assert.equal(alerts.rows[0].severity, 'medium');
  assert.equal(await emailed(), emailedBefore + 1, 'emailed by arrival time even though the event is back-dated');

  await db.query(`update device_report_keys set unattended_seen_at = now() - interval '20 minutes' where device_id = $1`,
    [ctx.deviceId]);
  await report(15);
  assert.equal((await events()).rows.length, 2, 'a break of over 10 minutes starts a new episode');

  await asUser(ctx.empAuth, 'select set_device_report_key($1, $2)', [ctx.deviceId, 'n'.repeat(43)]);
  assert.equal(await report(15), false, 'signing in again replaces the key');
  await rejects(asAnon('select * from device_report_keys'), /permission denied/);
  await rejects(asUser(ctx.ownerAuth, 'select * from device_report_keys'), /permission denied/);
});

test('deleting an employee removes their data and is audited', async () => {
  await rejects(asUser(ctx.ownerAuth, 'select delete_employee($1, $2)', [ctx.ownerId, 'x']), /owner account/);
  await asUser(ctx.ownerAuth, 'select delete_employee($1, $2)', [ctx.empId, 'Left the company']);
  const left = await db.query('select count(*)::int as n from activity_segments where employee_id = $1', [ctx.empId]);
  assert.equal(left.rows[0].n, 0);
  const audit = await asUser(ctx.ownerAuth, `select details from audit_log where action = 'employee_deleted'`);
  assert.equal(audit.rows[0].details.reason, 'Left the company');
});
