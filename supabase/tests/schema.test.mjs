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
  assert.match(policy.rows[0].notice_text, /SIGN-IN REMINDERS\n.*every 2 minutes.*15 minutes in a row/s);
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

test('an expired trial becomes the free plan and keeps recording', async () => {
  await db.query(`update subscriptions set trial_ends_at = now() - interval '1 hour' where organization_id = $1`, [ctx.orgId]);
  const s = await asUser(ctx.ownerAuth, 'select level from get_my_service_status()');
  assert.equal(s.rows[0].level, 'full');
  assert.deepEqual((await asUser(ctx.ownerAuth, 'select get_my_features() as f')).rows[0].f, []);
  await insertSegment(ctx.empAuth, segment({ start: minutesAgo(20), end: minutesAgo(19) }));
  await rejects(asUser(ctx.ownerAuth, `select * from create_employee('Late', 'late@acme.co.za')`), /free plan includes 3 people/);
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

test('plans decide which features an organisation gets; trials get everything', async () => {
  const plan = (await db.query('select plan from subscriptions where organization_id = $1', [ctx.orgId])).rows[0].plan;
  const features = async () => (await asUser(ctx.ownerAuth, 'select get_my_features() as f')).rows[0].f;
  await db.query(`update subscriptions set plan = 'trial' where organization_id = $1`, [ctx.orgId]);
  assert.ok((await features()).includes('goals'));
  await db.query(`update subscriptions set plan = 'standard' where organization_id = $1`, [ctx.orgId]);
  assert.deepEqual(await features(), ['team_categories', 'team_schedules', 'trends', 'alert_rules', 'channels', 'work_location']);
  await rejects(asUser(ctx.ownerAuth, 'select save_goal(null, 6, 80, 120)'), /not included in your plan/);
  await db.query('update subscriptions set plan = $2 where organization_id = $1', [ctx.orgId, plan]);
  await rejects(asAnon('select get_my_features()'), /permission denied/);
  await rejects(asUser(ctx.ownerAuth, `select org_has_feature($1, 'goals')`, [ctx.orgId]), /permission denied/);
});

test('team category rules override company rules for that team only', async () => {
  ctx.salesTeamId = (await asUser(ctx.ownerAuth, `select id from save_team(null, 'Sales')`)).rows[0].id;
  await asUser(ctx.mgrAuth, `select set_app_category('domain', 'youtube.com', 'productive', $1)`, [ctx.teamId]);
  await rejects(asUser(ctx.mgrAuth, `select set_app_category('domain', 'youtube.com', 'neutral', $1)`, [ctx.salesTeamId]),
    /Not allowed/, 'a team manager cannot set rules for other teams');
  const salesRule = (await asUser(ctx.ownerAuth,
    `select id from set_app_category('app', 'Microsoft Excel', 'neutral', $1)`, [ctx.salesTeamId])).rows[0].id;
  await rejects(asUser(ctx.mgrAuth, 'select delete_app_category($1)', [salesRule]), /Not allowed/);

  const rules = await asUser(ctx.ownerAuth, `select team_id from app_categories where pattern = 'youtube.com' order by team_id nulls first`);
  assert.deepEqual(rules.rows.map((r) => r.team_id), [null, ctx.teamId], 'company and team rules live side by side');

  const cat = async (team, app, domain) =>
    (await asUser(ctx.ownerAuth, 'select category_of($1, $2::uuid, $3, $4) as c', [ctx.orgId, team, app, domain])).rows[0].c;
  assert.equal(await cat(ctx.teamId, 'Google Chrome', 'm.youtube.com'), 'productive');
  assert.equal(await cat(null, 'Google Chrome', 'm.youtube.com'), 'unproductive');
  assert.equal(await cat(ctx.salesTeamId, 'Google Chrome', 'm.youtube.com'), 'unproductive', 'Sales follows the company rule');
  assert.equal(await cat(ctx.salesTeamId, 'Microsoft Excel', null), 'neutral');
  assert.equal(await cat(ctx.teamId, 'Microsoft Excel', null), 'productive');

  const device = randomUUID();
  await db.query('insert into devices (id, organization_id, employee_id, hostname) values ($1, $2, $3, $4)',
    [device, ctx.orgId, ctx.empId, 'LAPTOP-02']);
  await db.query(
    `insert into activity_segments (id, organization_id, employee_id, device_id, state, started_at, ended_at, app_name, domain, updated_at)
     values ($1, $2, $3, $4, 'active', '2026-10-04T08:00:00Z', '2026-10-04T08:30:00Z', 'Google Chrome', 'youtube.com', '2026-10-04T08:30:00Z')`,
    [randomUUID(), ctx.orgId, ctx.empId, device]);
  const totals = await asUser(ctx.ownerAuth,
    `select category, active_seconds::int from get_category_totals($1, '2026-10-04', '2026-10-04')`, [ctx.empId]);
  assert.deepEqual(totals.rows, [{ category: 'productive', active_seconds: 1800 }], "the employee's team rule applies");
});

test('daily usage is filled nightly, scoped like activity, and removed with deleted activity', async () => {
  await db.query(`select refresh_daily_usage($1, '2026-10-04')`, [ctx.orgId]);
  const usage = await asUser(ctx.ownerAuth,
    `select app_name, domain, active_seconds from daily_usage where employee_id = $1 and day = '2026-10-04'`, [ctx.empId]);
  assert.deepEqual(usage.rows, [{ app_name: 'Google Chrome', domain: 'youtube.com', active_seconds: 1800 }]);
  const other = await asUser(ctx.otherOwnerAuth, 'select count(*)::int as n from daily_usage');
  assert.equal(other.rows[0].n, 0, 'other organisations see nothing');
  await rejects(asUser(ctx.ownerAuth, `delete from daily_usage`), /permission denied/);
  await rejects(asAnon('select * from daily_usage'), /permission denied/);
  await rejects(asUser(ctx.ownerAuth, `select refresh_daily_usage($1, '2026-10-04')`, [ctx.orgId]), /permission denied/);

  await asUser(ctx.ownerAuth, `select delete_activity($1, '2026-10-04T07:00:00Z', '2026-10-04T09:00:00Z', 'Test clean-up')`, [ctx.empId]);
  const left = await db.query(`select count(*)::int as n from daily_usage where employee_id = $1 and day = '2026-10-04'`, [ctx.empId]);
  assert.equal(left.rows[0].n, 0);
});

test('working hours per team or person: notice, policy snapshot and alerts', async () => {
  await db.query(`update organization_settings set tracking_schedule = 'work_hours', work_days = '{1,2,3,4,5}',
                  work_start = '08:00', work_end = '17:00' where organization_id = $1`, [ctx.orgId]);
  const version = async () => (await asUser(ctx.ownerAuth, 'select max(version)::int as v from monitoring_policies')).rows[0].v;
  const v0 = await version();

  const saved = await asUser(ctx.mgrAuth, `select version from save_work_schedule($1, null, '{1,2,3,4,5,6}', '06:00', '14:00')`, [ctx.teamId]);
  assert.equal(saved.rows[0].version, v0 + 1, 'new hours publish a new notice');
  let status = (await asUser(ctx.empAuth, 'select notice_text, settings, team_id from get_my_policy_status()')).rows[0];
  assert.match(status.notice_text,
    /Different working hours apply to these teams: Dispatch: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, 06:00 to 14:00\./);
  assert.equal(status.team_id, ctx.teamId);
  assert.deepEqual(status.settings.schedules, [
    { team_id: ctx.teamId, employee_id: null, work_days: [1, 2, 3, 4, 5, 6], work_start: '06:00:00', work_end: '14:00:00' }]);

  await rejects(asUser(ctx.mgrAuth, `select save_work_schedule($1, null, '{1}', '08:00', '12:00')`, [ctx.salesTeamId]), /Not allowed/);
  await rejects(asUser(ctx.mgrAuth, `select save_work_schedule(null, $1, '{1}', '08:00', '12:00')`, [ctx.ownerId]), /Not allowed/);
  await rejects(asUser(ctx.empAuth, `select save_work_schedule($1, null, '{1}', '08:00', '12:00')`, [ctx.teamId]), /Not allowed/);
  await rejects(asUser(ctx.ownerAuth, `select save_work_schedule($1, null, '{}', '08:00', '12:00')`, [ctx.teamId]), /at least one working day/);
  await rejects(asUser(ctx.ownerAuth, `select save_work_schedule($1, null, '{1}', '08:00', '08:00')`, [ctx.teamId]), /different times/);
  await rejects(asUser(ctx.ownerAuth, `select save_work_schedule($1, $2, '{1}', '08:00', '12:00')`, [ctx.teamId, ctx.empId]), /either a team or a person/);

  await asUser(ctx.ownerAuth, `select save_work_schedule(null, $1, '{1,2,3}', '09:00', '13:00')`, [ctx.empId]);
  status = (await asUser(ctx.empAuth, 'select notice_text, settings from get_my_policy_status()')).rows[0];
  assert.match(status.notice_text, /individual working hours agreed with them/);
  assert.equal(status.settings.schedules.length, 2);
  assert.equal((await asUser(ctx.empAuth, 'select count(*)::int as n from work_schedules')).rows[0].n, 0,
    'employees read their hours from the notice snapshot, not the table');

  const at = async (iso) => (await db.query('select is_employee_work_time($1, $2) as w', [ctx.empId, iso])).rows[0].w;
  assert.equal(await at('2026-10-05T08:00:00Z'), true, 'Monday 10:00: individual hours');
  assert.equal(await at('2026-10-05T11:30:00Z'), false, 'Monday 13:30: after individual hours');
  assert.equal(await at('2026-10-08T08:00:00Z'), false, 'Thursday is not an individual work day');
  await asUser(ctx.ownerAuth, 'select delete_work_schedule(null, $1)', [ctx.empId]);
  assert.equal(await at('2026-10-10T05:00:00Z'), true, 'Saturday 07:00: team hours apply again');
  assert.equal(await at('2026-10-05T13:00:00Z'), false, 'Monday 15:00: after team hours');
  assert.equal((await db.query('select is_employee_work_time($1, $2) as w', [ctx.ownerId, '2026-10-05T13:00:00Z'])).rows[0].w,
    true, 'people outside the team keep company hours');

  const v1 = await version();
  await asUser(ctx.ownerAuth, `select save_team($1, 'Dispatch & Courier')`, [ctx.teamId]);
  assert.equal(await version(), v1 + 1, 'renaming a team with its own hours republishes the notice');
  assert.match((await asUser(ctx.empAuth, 'select notice_text from get_my_policy_status()')).rows[0].notice_text, /Dispatch & Courier: Monday/);
  await asUser(ctx.ownerAuth, `select save_team($1, 'Dispatch')`, [ctx.teamId]);

  await db.query(`update organization_settings set tracking_schedule = 'always' where organization_id = $1`, [ctx.orgId]);
  const v2 = await version();
  await asUser(ctx.ownerAuth, `select save_work_schedule($1, null, '{1,2,3,4,5}', '07:00', '15:00')`, [ctx.teamId]);
  assert.equal(await version(), v2, 'hours do not apply while monitoring runs whenever signed in, so no new notice');
  await asUser(ctx.ownerAuth, 'select delete_work_schedule($1, null)', [ctx.teamId]);
  await db.query(`update organization_settings set tracking_schedule = 'work_hours' where organization_id = $1`, [ctx.orgId]);
  assert.equal((await asUser(ctx.empAuth, 'select settings from get_my_policy_status()')).rows[0].settings.schedules.length, 0);
});

test('productivity goals per company or team, limited to the right managers', async () => {
  const plan = (await db.query('select plan from subscriptions where organization_id = $1', [ctx.orgId])).rows[0].plan;
  await db.query(`update subscriptions set plan = 'business' where organization_id = $1`, [ctx.orgId]);
  await asUser(ctx.ownerAuth, 'select save_goal(null, 6, 80, 120)');
  await rejects(asUser(ctx.mgrAuth, 'select save_goal(null, 5, 80, 120)'), /Not allowed/, 'team managers cannot set the company goal');
  await asUser(ctx.mgrAuth, 'select save_goal($1, 5.5, 70, 130)', [ctx.teamId]);
  await rejects(asUser(ctx.mgrAuth, 'select save_goal($1, 5, 80, 120)', [ctx.salesTeamId]), /Not allowed/);
  await rejects(asUser(ctx.ownerAuth, 'select save_goal(null, 20, 80, 120)'), /between 0.5 and 16 hours/);
  await rejects(asUser(ctx.ownerAuth, 'select save_goal(null, 6, 100, 120)'), /under-utilised/);
  await rejects(asUser(ctx.ownerAuth, 'select save_goal(null, 6, 80, 100)'), /over-utilised/);
  await asUser(ctx.ownerAuth, 'select save_goal(null, 6.5, 80, 120)');
  assert.equal((await asUser(ctx.ownerAuth, 'select count(*)::int as n from productivity_goals')).rows[0].n, 2, 'saving again updates');

  const goal = async (auth) => (await asUser(auth, 'select productive_hours::float as h, team_id from goal_for_employee($1)', [ctx.empId])).rows;
  assert.deepEqual(await goal(ctx.ownerAuth), [{ h: 5.5, team_id: ctx.teamId }], "the team's goal wins");
  assert.deepEqual(await goal(ctx.empAuth), [], 'employees do not see goals');
  assert.equal((await asUser(ctx.empAuth, 'select count(*)::int as n from productivity_goals')).rows[0].n, 0);
  await asUser(ctx.mgrAuth, 'select delete_goal($1)', [ctx.teamId]);
  assert.deepEqual(await goal(ctx.ownerAuth), [{ h: 6.5, team_id: null }], 'then the company goal applies');
  await rejects(asUser(ctx.ownerAuth, 'update productivity_goals set productive_hours = 1'), /permission denied/);
  const audit = await asUser(ctx.ownerAuth, `select count(*)::int as n from audit_log where action in ('goal_saved', 'goal_removed')`);
  assert.equal(audit.rows[0].n, 4);
  await db.query('update subscriptions set plan = $2 where organization_id = $1', [ctx.orgId, plan]);
});

test('analytics: trends, workload, capacity and software usage', async () => {
  const plan = (await db.query('select plan from subscriptions where organization_id = $1', [ctx.orgId])).rows[0].plan;
  await db.query(`update subscriptions set plan = 'business' where organization_id = $1`, [ctx.orgId]);
  await asUser(ctx.ownerAuth, `select set_app_category('domain', 'facebook.com', 'unproductive')`);
  const device = randomUUID();
  await db.query('insert into devices (id, organization_id, employee_id, hostname) values ($1, $2, $3, $4)',
    [device, ctx.orgId, ctx.empId, 'LAPTOP-03']);
  // Tuesday 6 Oct: 4 h in Excel (productive), 1 h on Facebook (unproductive). Segments are at most an hour long.
  for (const [start, end, app, domain] of [
    ['06:00', '07:00', 'Microsoft Excel', null], ['07:00', '08:00', 'Microsoft Excel', null],
    ['08:00', '09:00', 'Microsoft Excel', null], ['09:00', '10:00', 'Microsoft Excel', null],
    ['10:00', '11:00', 'Google Chrome', 'facebook.com']]) {
    await db.query(
      `insert into activity_segments (id, organization_id, employee_id, device_id, state, started_at, ended_at, app_name, domain, updated_at)
       values ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $6)`,
      [randomUUID(), ctx.orgId, ctx.empId, device, `2026-10-06T${start}:00Z`, `2026-10-06T${end}:00Z`, app, domain]);
  }
  await db.query(`select refresh_daily_usage($1, '2026-10-06')`, [ctx.orgId]);

  const days = await asUser(ctx.ownerAuth, `select period_start::text as d, people, person_days, active_seconds::int as a,
    productive_seconds::int as p, unproductive_seconds::int as u from get_trend('2026-10-05', '2026-10-11', 'day')`);
  assert.equal(days.rows.length, 7);
  assert.deepEqual(days.rows.find((r) => r.d === '2026-10-06'), { d: '2026-10-06', people: 1, person_days: 1, a: 18000, p: 14400, u: 3600 });
  assert.equal(days.rows.filter((r) => r.a > 0).length, 1);
  const weeks = await asUser(ctx.ownerAuth, `select period_start::text as d, active_seconds::int as a from get_trend('2026-10-05', '2026-10-11', 'week')`);
  assert.deepEqual(weeks.rows, [{ d: '2026-10-05', a: 18000 }]);
  const ownerOnly = await asUser(ctx.ownerAuth, `select sum(active_seconds)::int as a from get_trend('2026-10-05', '2026-10-11', 'day', null, $1)`, [ctx.ownerId]);
  assert.equal(ownerOnly.rows[0].a, 0);
  const today = await asUser(ctx.ownerAuth, `select active_seconds::int as a from get_trend(
    (now() at time zone 'Africa/Johannesburg')::date, (now() at time zone 'Africa/Johannesburg')::date)`);
  assert.ok(today.rows[0].a > 0, 'today is read live, before the nightly job');

  const workload = await asUser(ctx.ownerAuth, `select employee_id, days_worked, productive_seconds::int as p, goal_hours::float as g,
    utilisation::float as util, status from get_workload('2026-10-06', '2026-10-06')`);
  assert.deepEqual(workload.rows.find((r) => r.employee_id === ctx.empId),
    { employee_id: ctx.empId, days_worked: 1, p: 14400, g: 6.5, util: 61.5, status: 'under' });
  assert.equal(workload.rows.find((r) => r.employee_id === ctx.ownerId).status, 'no_data');
  const mary = await asUser(ctx.mgrAuth, `select employee_id from get_workload('2026-10-06', '2026-10-06')`);
  assert.ok(mary.rows.every((r) => [ctx.empId, ctx.mgrId].includes(r.employee_id)), 'team managers see their team only');

  await asUser(ctx.ownerAuth, 'select set_workforce_cost(null, 390000)');
  const cap = await asUser(ctx.ownerAuth, `select team_id, people, goal_hours::float as goal, avg_productive_hours::float as avg,
    gap_hours::float as gap, fte_gap::float as fte, annual_cost::float as annual, monthly_cost::float as monthly
    from get_capacity('2026-10-06', '2026-10-06')`);
  assert.deepEqual(cap.rows, [{ team_id: ctx.teamId, people: 1, goal: 6.5, avg: 4, gap: 2.5, fte: 0.38, annual: 150000, monthly: 12500 }]);
  const maryCap = await asUser(ctx.mgrAuth, `select annual_salary, annual_cost from get_capacity('2026-10-06', '2026-10-06')`);
  assert.deepEqual(maryCap.rows, [{ annual_salary: null, annual_cost: null }], 'salary figures are for owners and company-wide managers');
  await rejects(asUser(ctx.mgrAuth, 'select set_workforce_cost(null, 1)'), /Not allowed/);
  assert.equal((await asUser(ctx.mgrAuth, 'select count(*)::int as n from workforce_costs')).rows[0].n, 0);
  await rejects(asUser(ctx.mgrAuth, 'select * from get_workforce_costs()'), /Not allowed/);
  const costs = await asUser(ctx.ownerAuth, 'select team_id, annual_salary::float as s from get_workforce_costs()');
  assert.deepEqual(costs.rows, [{ team_id: null, s: 390000 }]);

  await asUser(ctx.ownerAuth, `select set_software_licence('app', 'Microsoft Excel', 10, 250)`);
  await asUser(ctx.ownerAuth, `select set_software_licence('app', 'Adobe Photoshop', 5, null)`);
  await rejects(asUser(ctx.mgrAuth, `select set_software_licence('app', 'Slack', 5, null)`), /Not allowed/);
  const apps = await asUser(ctx.ownerAuth, `select name, active_seconds::int as a, users, category, licence_seats as seats
    from get_software_usage('2026-10-06', '2026-10-06', 'app')`);
  assert.deepEqual(apps.rows, [
    { name: 'Microsoft Excel', a: 14400, users: 1, category: 'productive', seats: 10 },
    { name: 'Google Chrome', a: 3600, users: 1, category: 'uncategorised', seats: null },
    { name: 'adobe photoshop', a: 0, users: 0, category: 'uncategorised', seats: 5 },
  ]);
  const teamApps = await asUser(ctx.ownerAuth, `select name, category from get_software_usage('2026-10-06', '2026-10-06', 'app', $1)`,
    [ctx.salesTeamId]);
  assert.deepEqual(teamApps.rows, [], 'unused licences are only listed company-wide');
  const sites = await asUser(ctx.ownerAuth, `select name, active_seconds::int as a, category, people
    from get_software_usage('2026-10-06', '2026-10-06', 'domain')`);
  assert.equal(sites.rows[0].name, 'facebook.com');
  assert.equal(sites.rows[0].category, 'unproductive');
  assert.ok(sites.rows[0].people >= 3);

  await rejects(asUser(ctx.empAuth, `select * from get_trend('2026-10-05', '2026-10-11')`), /Not allowed/);
  await rejects(asAnon(`select * from get_trend('2026-10-05', '2026-10-11')`), /permission denied/);
  await rejects(asUser(ctx.ownerAuth, `select * from get_trend('2025-01-01', '2026-10-11')`), /at most 400 days/);
  await rejects(asUser(ctx.ownerAuth, `select * from person_days($1, null, null, '2026-10-06', '2026-10-06')`, [ctx.orgId]), /permission denied/);
  await db.query(`update subscriptions set plan = 'standard' where organization_id = $1`, [ctx.orgId]);
  await asUser(ctx.ownerAuth, `select * from get_trend('2026-10-05', '2026-10-11')`);
  await rejects(asUser(ctx.ownerAuth, `select * from get_workload('2026-10-05', '2026-10-11')`), /not included in your plan/);
  await db.query('update subscriptions set plan = $2 where organization_id = $1', [ctx.orgId, plan]);
});

test('alert rules raise policy alarms from incoming activity', async () => {
  const plan = (await db.query('select plan from subscriptions where organization_id = $1', [ctx.orgId])).rows[0].plan;
  await db.query(`update subscriptions set plan = 'business' where organization_id = $1`, [ctx.orgId]);
  await rejects(asUser(ctx.mgrAuth, `select save_alert_rule(null, 'X', 'domain', 'x.com', 'low', false, true)`), /Not allowed/);
  await rejects(asUser(ctx.empAuth, `select add_alert_rule_pack('file_sharing')`), /Not allowed/);

  const added = (await asUser(ctx.ownerAuth, `select add_alert_rule_pack('file_sharing') as n`)).rows[0].n;
  assert.equal(added, 20);
  assert.equal((await asUser(ctx.ownerAuth, `select add_alert_rule_pack('file_sharing') as n`)).rows[0].n, 0, 'adding a list twice adds nothing');
  await asUser(ctx.ownerAuth, `select add_alert_rule_pack('bluetooth')`);
  const bet = (await asUser(ctx.ownerAuth,
    `select * from save_alert_rule(null, 'Betting', 'domain', 'https://www.Bet.co.za/sports?x=1', 'high', false, true)`)).rows[0];
  assert.equal(bet.pattern, 'bet.co.za');
  await rejects(asUser(ctx.ownerAuth, `select save_alert_rule(null, 'Again', 'domain', 'bet.co.za', 'low', false, true)`), /already a rule/);
  const torrent = (await asUser(ctx.ownerAuth,
    `select * from save_alert_rule(null, 'Torrents', 'app', '*torrent*', 'high', true, true)`)).rows[0];
  assert.equal((await asUser(ctx.empAuth, 'select count(*)::int as n from alert_rules')).rows[0].n, 0, 'employees do not see the rules');
  assert.ok((await asUser(ctx.mgrAuth, 'select count(*)::int as n from alert_rules')).rows[0].n > 20, 'managers see them');

  const device = randomUUID();
  await db.query('insert into devices (id, organization_id, employee_id, hostname) values ($1, $2, $3, $4)',
    [device, ctx.orgId, ctx.empId, 'LAPTOP-04']);
  const seg = async (from, to, app, process, domain) => {
    const id = randomUUID();
    await db.query(
      `insert into activity_segments (id, organization_id, employee_id, device_id, state, started_at, ended_at, app_name,
         process_name, domain, updated_at)
       values ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $6)`,
      [id, ctx.orgId, ctx.empId, device, minutesAgo(from), minutesAgo(to), app, process, domain]);
    return id;
  };
  const betSeg = await seg(40, 39, 'Google Chrome', 'chrome.exe', 'sports.bet.co.za');
  await seg(39, 38, 'Google Chrome', 'chrome.exe', 'wetransfer.com');
  await seg(38, 37, 'uTorrent', 'uTorrent.exe', null);
  await seg(37, 36, 'Bluetooth File Transfer', 'fsquirt.exe', null);
  await seg(36, 35, 'Google Chrome', 'chrome.exe', 'notbet.co.za');

  const alerts = async () => (await asUser(ctx.ownerAuth,
    `select kind, severity, details from get_integrity_alerts(now() - interval '1 hour') where kind = 'policy_violation'`)).rows;
  const byRule = Object.fromEntries((await alerts()).map((a) => [a.details.rule, a]));
  assert.equal(byRule.Betting.severity, 'high');
  assert.deepEqual(byRule.Betting.details.matched, ['sports.bet.co.za']);
  assert.equal(byRule.Betting.details.seconds, 60);
  assert.equal(byRule['File sharing: WeTransfer'].severity, 'medium');
  assert.equal(byRule['Bluetooth file transfer'].severity, 'medium');
  assert.equal(Object.keys(byRule).filter((r) => r === 'Betting').length, 1, 'notbet.co.za is not bet.co.za');
  const workTime = (await db.query('select is_employee_work_time($1, $2) as w', [ctx.empId, minutesAgo(38)])).rows[0].w;
  assert.equal(Boolean(byRule.Torrents), workTime, 'work-hours-only rules follow the person\'s working hours');

  await db.query(`update activity_segments set state = 'idle' where id = $1`, [betSeg]);
  assert.ok(!(await alerts()).some((a) => a.details.rule === 'Betting'), 'time relabelled idle is not a violation');
  await asUser(ctx.ownerAuth, `select save_alert_rule($1, 'Torrents', 'app', '*torrent*', 'high', false, false)`, [torrent.id]);
  await seg(30, 29, 'qBittorrent', 'qbittorrent.exe', null);
  assert.ok(!(await alerts()).some((a) => a.details.rule === 'Torrents' && a.details.matched.includes('qBittorrent')),
    'disabled rules do not match');
  assert.equal((await asUser(ctx.empAuth, `select count(*)::int as n from get_integrity_alerts(now() - interval '1 hour')`)).rows[0].n, 0);
  await rejects(asUser(ctx.ownerAuth, `select org_alerts($1, now(), false)`, [ctx.orgId]), /permission denied/);
  await asUser(ctx.ownerAuth, 'select delete_alert_rule($1)', [torrent.id]);
  await db.query('update subscriptions set plan = $2 where organization_id = $1', [ctx.orgId, plan]);
});

test('file activity: plan, notice, uploads, audited viewing, alerts and retention', async () => {
  const plan = (await db.query('select plan from subscriptions where organization_id = $1', [ctx.orgId])).rows[0].plan;
  const save = (uid, settings) => asUser(uid, `select version from save_compliance_settings($1, 'Thandi Owner', 'privacy@acme.co.za')`,
    [JSON.stringify(settings)]);
  await db.query(`update subscriptions set plan = 'standard' where organization_id = $1`, [ctx.orgId]);
  await rejects(save(ctx.ownerAuth, { detect_removable_media: true }), /not included in your plan/);
  await db.query(`update subscriptions set plan = 'business' where organization_id = $1`, [ctx.orgId]);

  const device = (await db.query(`select id from devices where hostname = 'LAPTOP-04'`)).rows[0].id;
  const upload = (row) => asUser(ctx.empAuth,
    `insert into file_events (id, organization_id, employee_id, device_id, occurred_at, event_type, destination, label,
       file_name, file_count, size_bytes) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [randomUUID(), ctx.orgId, ctx.empId, device, row.at ?? minutesAgo(5), row.type, row.dest, row.label ?? null,
     row.file ?? null, row.count ?? 1, row.size ?? null]);
  await rejects(upload({ type: 'drive_connected', dest: 'removable', label: 'KINGSTON' }), /row-level security/,
    'nothing is accepted while detection is off');

  await save(ctx.ownerAuth, { detect_removable_media: true, detect_cloud_sync: true, file_retention_days: 14 });
  const notice = (await asUser(ctx.empAuth, 'select notice_text, settings from get_my_policy_status()')).rows[0];
  assert.match(notice.notice_text, /USB drive, external disk or phone is connected/);
  assert.match(notice.notice_text, /new files in OneDrive, Dropbox and Google Drive folders/);
  assert.doesNotMatch(notice.notice_text, /copy to network drives/);
  assert.match(notice.notice_text, /Names and sizes of copied files are deleted after 14 days\./);
  assert.equal(notice.settings.detect_removable_media, true);
  assert.equal(notice.settings.detect_network_drives, false);

  await upload({ type: 'drive_connected', dest: 'removable', label: 'KINGSTON' });
  await upload({ type: 'file_copied', dest: 'removable', label: 'KINGSTON', file: 'Q3 payroll.xlsx', size: 2048 });
  await upload({ type: 'file_copied', dest: 'cloud', label: 'OneDrive', file: 'notes.docx', size: 100 });
  await upload({ type: 'phone_connected', dest: 'phone', label: 'Galaxy A52' });
  await rejects(upload({ type: 'file_copied', dest: 'network', label: '\\\\srv\\share', file: 'a.txt' }), /row-level security/,
    'network drives are off');
  await rejects(upload({ type: 'file_copied', dest: 'phone', file: 'a.txt' }), /check constraint|violates/);
  await rejects(asUser(ctx.empAuth, 'select * from file_events'), /permission denied/);
  await rejects(asUser(ctx.ownerAuth, 'select * from file_events'), /permission denied/);

  const auditCount = async () => (await db.query(
    `select count(*)::int as n from audit_log where action = 'file_activity_viewed' and target_id = $1`, [ctx.empId])).rows[0].n;
  const audits = await auditCount();
  const viewed = await asUser(ctx.ownerAuth,
    `select event_type, file_name, hostname from get_file_activity($1, now() - interval '1 day', now() + interval '1 hour')`, [ctx.empId]);
  assert.equal(viewed.rows.length, 4);
  assert.ok(viewed.rows.some((r) => r.file_name === 'Q3 payroll.xlsx' && r.hostname === 'LAPTOP-04'));
  assert.equal(await auditCount(), audits + 1, 'each view is recorded in the audit log');
  await asUser(ctx.empAuth, `select * from get_file_activity($1, now() - interval '1 day', now())`, [ctx.empId]);
  assert.equal(await auditCount(), audits + 1, 'people looking at their own activity are not audited');
  await asUser(ctx.mgrAuth, `select * from get_file_activity($1, now() - interval '1 day', now())`, [ctx.empId]);
  await rejects(asUser(ctx.otherOwnerAuth, `select * from get_file_activity($1, now() - interval '1 day', now())`, [ctx.empId]), /Not allowed/);
  await rejects(asUser(ctx.ownerAuth, `select * from get_file_activity($1, now() - interval '200 days', now())`, [ctx.empId]), /at most 93 days/);

  const fileAlerts = async () => (await asUser(ctx.ownerAuth,
    `select kind, severity, details from get_integrity_alerts(now() - interval '1 hour')
     where kind in ('device_connected', 'files_copied') order by kind, severity`)).rows;
  let rows = await fileAlerts();
  assert.deepEqual(rows.map((r) => [r.kind, r.severity, r.details.destination]).sort(), [
    ['device_connected', 'medium', 'removable'], ['device_connected', 'medium', 'phone'], ['files_copied', 'medium', 'removable'],
  ].sort(), 'one cloud file is not an alert');
  await upload({ type: 'file_copied', dest: 'removable', label: 'KINGSTON', count: 60, size: 10_000_000 });
  rows = await fileAlerts();
  const copied = rows.find((r) => r.kind === 'files_copied');
  assert.equal(copied.severity, 'high');
  assert.equal(copied.details.files, 61);

  await db.query(
    `insert into file_events (id, organization_id, employee_id, device_id, occurred_at, event_type, destination, label)
     values ($1, $2, $3, $4, now() - interval '20 days', 'drive_connected', 'removable', 'OLD')`,
    [randomUUID(), ctx.orgId, ctx.empId, device]);
  await db.query('select run_nightly_maintenance()');
  assert.equal((await db.query(`select count(*)::int as n from file_events where label = 'OLD'`)).rows[0].n, 0,
    'file activity is kept for file_retention_days');
  assert.equal((await db.query(`select count(*)::int as n from file_events where label = 'KINGSTON'`)).rows[0].n, 3);

  await save(ctx.ownerAuth, { detect_removable_media: false, detect_cloud_sync: false });
  await db.query('update subscriptions set plan = $2 where organization_id = $1', [ctx.orgId, plan]);
});

test('Slack, Teams and webhook channels; read-only API keys', async () => {
  const plan = (await db.query('select plan from subscriptions where organization_id = $1', [ctx.orgId])).rows[0].plan;
  await db.query(`update subscriptions set plan = 'business' where organization_id = $1`, [ctx.orgId]);
  const svc = (sql, params = []) => asRole('service_role', null, () => db.query(sql, params));
  const add = (uid, kind, url, sev = 'medium') =>
    asUser(uid, `select * from add_notification_channel($1, $2, $3, $4)`, [kind, `${kind} alerts`, url, sev]);

  await rejects(add(ctx.mgrAuth, 'slack', 'https://hooks.slack.com/services/T0/B0/x'), /Not allowed/);
  await rejects(add(ctx.ownerAuth, 'slack', 'https://evil.example.com/services/x'), /Slack incoming webhook/);
  await rejects(add(ctx.ownerAuth, 'teams', 'https://hooks.slack.com/services/x'), /Teams/);
  for (const bad of ['http://example.com/hook', 'https://10.0.0.1/hook', 'https://localhost/hook', 'https://nas.local/hook',
    'https://user@example.com/hook']) {
    await rejects(add(ctx.ownerAuth, 'webhook', bad), /public https address/, bad);
  }
  const slack = (await add(ctx.ownerAuth, 'slack', 'https://hooks.slack.com/services/T000/B000/SECRETPART')).rows[0];
  assert.equal(slack.signing_secret, null);
  await add(ctx.ownerAuth, 'teams', 'https://prod-01.westeurope.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x', 'high');
  const hook = (await add(ctx.ownerAuth, 'webhook', 'https://example.com/mycroscope')).rows[0];
  assert.match(hook.signing_secret, /^whsec_[0-9a-f]{48}$/);

  const listed = (await asUser(ctx.ownerAuth, 'select * from list_notification_channels()')).rows;
  assert.equal(listed.length, 3);
  assert.ok(!JSON.stringify(listed).includes('SECRETPART'), 'saved addresses are not shown again');
  assert.equal(listed[0].url_hint, 'hooks.slack.com/…PART');
  await rejects(asUser(ctx.ownerAuth, 'select * from notification_channels'), /permission denied/);
  await rejects(asUser(ctx.mgrAuth, 'select * from list_notification_channels()'), /Not allowed/);
  assert.equal((await asUser(ctx.ownerAuth, 'select request_channel_test($1) as ok', [slack.id])).rows[0].ok, true);
  await rejects(asUser(ctx.mgrAuth, 'select request_channel_test($1)', [slack.id]), /Not allowed/);

  const batch = (await svc(`select * from channel_alert_batch(now() - interval '1 hour')`)).rows;
  assert.equal(batch.length, 3);
  const slackBatch = batch.find((b) => b.kind === 'slack');
  assert.equal(slackBatch.url, 'https://hooks.slack.com/services/T000/B000/SECRETPART');
  assert.ok(slackBatch.alerts.every((a) => ['medium', 'high'].includes(a.severity)));
  assert.ok(batch.find((b) => b.kind === 'teams').alerts?.every((a) => a.severity === 'high') ?? true);
  assert.equal(batch.find((b) => b.kind === 'webhook').signing_secret, hook.signing_secret);
  await rejects(asUser(ctx.ownerAuth, `select * from channel_alert_batch(now())`), /permission denied/);
  await svc('select record_channel_result($1, $2)', [slack.id, 'HTTP 404']);
  assert.equal((await asUser(ctx.ownerAuth, 'select last_error from list_notification_channels() where id = $1', [slack.id])).rows[0].last_error, 'HTTP 404');
  await asUser(ctx.ownerAuth, `select update_notification_channel($1, 'Slack', 'high', false)`, [slack.id]);
  assert.equal((await svc(`select count(*)::int as n from channel_alert_batch(now() - interval '1 hour')`)).rows[0].n, 2,
    'switched-off channels get nothing');

  await rejects(asUser(ctx.mgrAuth, `select * from create_api_key('Power BI')`), /Not allowed/);
  const key = (await asUser(ctx.ownerAuth, `select * from create_api_key('Power BI')`)).rows[0];
  assert.match(key.api_key, /^myc_[0-9a-f]{48}$/);
  const keys = (await asUser(ctx.ownerAuth, 'select * from list_api_keys()')).rows;
  assert.equal(keys[0].key_prefix, key.api_key.slice(0, 12));
  assert.ok(!JSON.stringify(keys).includes(key.api_key), 'the key is shown only once');
  await rejects(asUser(ctx.ownerAuth, 'select * from api_keys'), /permission denied/);
  await rejects(asUser(ctx.ownerAuth, 'select api_authenticate($1)', [key.api_key]), /permission denied/);
  assert.equal((await svc('select api_authenticate($1) as org', [key.api_key])).rows[0].org, ctx.orgId);
  assert.equal((await svc('select api_authenticate($1) as org', [`myc_${'0'.repeat(48)}`])).rows[0].org, null);
  const totals = (await svc(`select * from api_daily_totals($1, '2026-10-06', '2026-10-06')`, [ctx.orgId])).rows;
  assert.equal(Number(totals.find((r) => r.employee_id === ctx.empId).productive_seconds), 14400);
  await rejects(svc(`select * from api_usage($1, '2026-01-01', '2026-10-06')`, [ctx.orgId]), /at most 93 days/);
  assert.ok((await svc(`select count(*)::int as n from api_employees($1)`, [ctx.orgId])).rows[0].n >= 3);

  await db.query(`update subscriptions set plan = 'standard' where organization_id = $1`, [ctx.orgId]);
  assert.equal((await svc('select api_authenticate($1) as org', [key.api_key])).rows[0].org, null, 'the plan must include the API');
  await rejects(asUser(ctx.ownerAuth, `select * from create_api_key('Excel')`), /not included in your plan/);
  await db.query(`update subscriptions set plan = 'business' where organization_id = $1`, [ctx.orgId]);
  await asUser(ctx.ownerAuth, 'select revoke_api_key($1)', [key.id]);
  assert.equal((await svc('select api_authenticate($1) as org', [key.api_key])).rows[0].org, null, 'revoked keys stop working');
  await db.query('update subscriptions set plan = $2 where organization_id = $1', [ctx.orgId, plan]);
});

test('time away from the computer: notice, answers, reports and deletion', async () => {
  const plan = (await db.query('select plan from subscriptions where organization_id = $1', [ctx.orgId])).rows[0].plan;
  const save = (settings) => asUser(ctx.ownerAuth,
    `select version from save_compliance_settings($1, 'Thandi Owner', 'privacy@acme.co.za')`, [JSON.stringify(settings)]);
  const upload = (row) => asUser(ctx.empAuth,
    `insert into offline_entries (id, organization_id, employee_id, device_id, started_at, ended_at, reason, note)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [randomUUID(), ctx.orgId, ctx.empId, ctx.deviceId, row.start, row.end, row.reason, row.note ?? null]);

  await db.query(`update subscriptions set plan = 'standard' where organization_id = $1`, [ctx.orgId]);
  await rejects(upload({ start: minutesAgo(40), end: minutesAgo(10), reason: 'meeting' }), /row-level security/,
    'nothing is accepted while the question is off');
  await save({ ask_offline_reason: true, offline_prompt_minutes: 10, productive_offline_reasons: ['meeting', 'call'] });
  const notice = (await asUser(ctx.empAuth, 'select notice_text, settings from get_my_policy_status()')).rows[0];
  assert.match(notice.notice_text, /asks what you were doing/);
  assert.match(notice.notice_text, /10 minutes or more/);
  assert.match(notice.notice_text, /Counted as productive time: meetings, calls\./);
  assert.equal(notice.settings.ask_offline_reason, true);
  await rejects(save({ offline_prompt_minutes: 0 }), /1 and 120/);
  await rejects(save({ productive_offline_reasons: ['lunch'] }), /Unknown reason/);

  const meeting = { start: minutesAgo(40), end: minutesAgo(10), reason: 'meeting', note: 'Client workshop' };
  const brk = { start: minutesAgo(90), end: minutesAgo(70), reason: 'break', note: null };
  await upload(meeting);
  await upload(brk);
  await rejects(upload({ start: minutesAgo(30), end: minutesAgo(20), reason: 'call' }), /overlap|exclusion|23P01/);
  await rejects(upload({ start: minutesAgo(15), end: minutesAgo(14), reason: 'other', note: 'x'.repeat(201) }), /check|constraint/);
  await rejects(asUser(ctx.empAuth, 'select * from offline_entries'), /permission denied/);
  await rejects(asUser(ctx.ownerAuth, 'select * from offline_entries'), /permission denied/);
  await rejects(asAnon(
    `insert into offline_entries (id, organization_id, employee_id, device_id, started_at, ended_at, reason)
     values ($1, $2, $3, $4, now() - interval '20 minutes', now() - interval '10 minutes', 'meeting')`,
    [randomUUID(), ctx.orgId, ctx.empId, ctx.deviceId]), /permission denied/);

  const seen = await asUser(ctx.ownerAuth,
    `select reason, note, hostname from get_offline_entries($1, now() - interval '1 day', now() + interval '1 hour') order by started_at`,
    [ctx.empId]);
  assert.deepEqual(seen.rows.map((r) => r.reason), ['break', 'meeting']);
  assert.equal(seen.rows[1].note, 'Client workshop');
  assert.equal(seen.rows[1].hostname, 'LAPTOP-01');
  await asUser(ctx.empAuth,
    `select reason from get_offline_entries($1, now() - interval '1 day', now())`, [ctx.empId]);
  await asUser(ctx.mgrAuth,
    `select reason from get_offline_entries($1, now() - interval '1 day', now())`, [ctx.empId]);
  await rejects(asUser(ctx.otherOwnerAuth,
    `select reason from get_offline_entries($1, now() - interval '1 day', now())`, [ctx.empId]), /Not allowed/);
  await rejects(asUser(ctx.ownerAuth,
    `select * from get_offline_entries($1, now() - interval '200 days', now())`, [ctx.empId]), /at most 93 days/);

  const totals = (await asUser(ctx.ownerAuth, `select
      coalesce(sum(meeting_seconds), 0)::int as meeting, coalesce(sum(break_seconds), 0)::int as break,
      coalesce(sum(productive_offline_seconds), 0)::int as productive
    from get_daily_totals($1, ((now() at time zone 'Africa/Johannesburg')::date - 1),
                              (now() at time zone 'Africa/Johannesburg')::date)`, [ctx.empId])).rows[0];
  assert.equal(Number(totals.meeting), 1800);
  assert.equal(Number(totals.break), 1200);
  assert.equal(Number(totals.productive), 1800, 'breaks are not productive unless the company says so');
  const byProject = (await asUser(ctx.ownerAuth, `select coalesce(sum(meeting_seconds), 0)::int as meeting
    from get_daily_totals($1, ((now() at time zone 'Africa/Johannesburg')::date - 1),
                              (now() at time zone 'Africa/Johannesburg')::date, $2)`,
    [ctx.empId, ctx.projectId])).rows[0];
  assert.equal(Number(byProject.meeting), 0, 'a project report leaves time away out');

  await db.query(`update subscriptions set plan = 'business' where organization_id = $1`, [ctx.orgId]);
  const from = `(now() at time zone 'Africa/Johannesburg')::date - 1`;
  const to = `(now() at time zone 'Africa/Johannesburg')::date`;
  const trend = (await asUser(ctx.ownerAuth, `select
      coalesce(sum(productive_seconds), 0)::int as computer, coalesce(sum(offline_seconds), 0)::int as off,
      coalesce(sum(productive_offline_seconds), 0)::int as prod_off
    from get_trend(${from}, ${to}, 'day', null, $1)`, [ctx.empId])).rows[0];
  assert.equal(Number(trend.off), 3000);
  assert.equal(Number(trend.prod_off), 1800);
  const load = (await asUser(ctx.ownerAuth, `select productive_seconds::int as p, offline_seconds::int as off
    from get_workload(${from}, ${to}) where employee_id = $1`, [ctx.empId])).rows[0];
  assert.equal(Number(load.off), 3000);
  assert.equal(Number(load.p), Number(trend.computer) + 1800, 'the goal comparison includes the meeting');
  const apiRow = (await asRole('service_role', null, () => db.query(
    `select coalesce(sum(offline_seconds), 0)::int as off, coalesce(sum(productive_offline_seconds), 0)::int as prod
     from api_daily_totals($1, ${from}, ${to}) where employee_id = $2`, [ctx.orgId, ctx.empId]))).rows[0];
  assert.equal(Number(apiRow.off), 3000);
  assert.equal(Number(apiRow.prod), 1800);

  await asUser(ctx.ownerAuth, `select delete_activity($1, now() - interval '3 hours', now(), 'Removing test answers')`, [ctx.empId]);
  const left = (await db.query('select count(*)::int as n from offline_entries where employee_id = $1', [ctx.empId])).rows[0];
  assert.equal(left.n, 0);
  const audit = (await db.query(
    `select details from audit_log where action = 'activity_deleted' and target_id = $1 order by id desc limit 1`,
    [ctx.empId])).rows[0];
  assert.equal(Number(audit.details.offline_entries), 2);

  await save({ ask_offline_reason: false });
  const off = (await asUser(ctx.empAuth, 'select notice_text from get_my_policy_status()')).rows[0];
  assert.doesNotMatch(off.notice_text, /asks what you were doing/);
  await db.query('update subscriptions set plan = $2 where organization_id = $1', [ctx.orgId, plan]);
});

test('office and remote days: notice, one result per day, and the weekly target', async () => {
  const plan = (await db.query('select plan from subscriptions where organization_id = $1', [ctx.orgId])).rows[0].plan;
  await db.query(`update subscriptions set plan = 'standard' where organization_id = $1`, [ctx.orgId]);
  const save = (settings) => asUser(ctx.ownerAuth, 'select save_compliance_settings($1, null, null)', [JSON.stringify(settings)]);

  await rejects(asUser(ctx.mgrAuth,
    `select save_office_network(null, 'Cape Town', array['41.13.0.0/24'], array['HQ'])`), /Not allowed/);
  await rejects(asUser(ctx.ownerAuth,
    `select save_office_network(null, 'Cape Town', array['192.168.0.0/24'], array[]::text[])`), /public IP/);
  await rejects(asUser(ctx.ownerAuth,
    `select save_office_network(null, 'Everywhere', array['0.0.0.0/0'], array[]::text[])`), /public IP/);
  const office = (await asUser(ctx.ownerAuth,
    `select id from save_office_network(null, 'Cape Town', array['41.13.0.0/24'], array['HQ Wi-Fi'])`)).rows[0].id;

  await save({ track_work_location: true, office_days_per_week: 3 });
  const notice = (await asUser(ctx.empAuth, 'select notice_text, settings from get_my_policy_status()')).rows[0];
  assert.match(notice.notice_text, /home network are not stored/);
  assert.match(notice.notice_text, /Cape Town/);
  assert.match(notice.notice_text, /3 office days/);
  assert.equal(notice.settings.track_work_location, true);
  assert.equal(notice.settings.office_networks[0].wifi_names[0], 'HQ Wi-Fi');

  const today = `(now() at time zone 'Africa/Johannesburg')::date`;
  await rejects(asUser(ctx.empAuth,
    `select record_work_location(${today}, '00000000-0000-0000-0000-000000000000')`), /Unknown office/);
  assert.equal((await asUser(ctx.empAuth, `select record_work_location(${today}, null) as l`)).rows[0].l, 'remote');
  assert.equal((await asUser(ctx.empAuth, `select record_work_location(${today}, $1) as l`, [office])).rows[0].l, 'mixed');
  await rejects(asUser(ctx.empAuth, 'select * from work_location_days'), /permission denied/);
  await rejects(asAnon(`select record_work_location(${today}, null)`), /permission denied/);

  const mine = (await asUser(ctx.empAuth,
    `select location, office_name from get_work_locations($1, ${today}, ${today})`, [ctx.empId])).rows[0];
  assert.equal(mine.location, 'mixed');
  assert.equal(mine.office_name, 'Cape Town');
  await rejects(asUser(ctx.otherOwnerAuth,
    `select * from get_work_locations($1, ${today}, ${today})`, [ctx.empId]), /Not allowed/);

  await db.query(`insert into work_location_days
      (organization_id, employee_id, day, saw_office, saw_remote, office_id, location) values
      ($1, $2, '2026-10-05', true, false, $3, 'office'),
      ($1, $2, '2026-10-06', true, false, $3, 'office'),
      ($1, $2, '2026-10-07', true, false, $3, 'office')`, [ctx.orgId, ctx.empId, office]);
  const week = (await asUser(ctx.ownerAuth, `select office_days, remote_days, target_per_week, weeks_judged, weeks_met
      from get_office_adherence('2026-10-05', '2026-10-11', null) where employee_id = $1`, [ctx.empId])).rows[0];
  assert.equal(Number(week.office_days), 3);
  assert.equal(Number(week.remote_days), 0);
  assert.equal(Number(week.target_per_week), 3);
  assert.equal(Number(week.weeks_judged), 1);
  assert.equal(Number(week.weeks_met), 1);

  await asUser(ctx.ownerAuth, 'select set_team_office_days($1, 4)', [ctx.teamId]);
  const teamTarget = (await asUser(ctx.ownerAuth, `select target_per_week from get_office_adherence('2026-10-05', '2026-10-11', null)
      where employee_id = $1`, [ctx.empId])).rows[0];
  assert.equal(Number(teamTarget.target_per_week), 4);
  await rejects(asUser(ctx.mgrAuth, 'select set_team_office_days($1, 2)', [ctx.salesTeamId]), /Not allowed/);

  await asUser(ctx.ownerAuth, `select delete_activity($1, now() - interval '3 hours', now(), 'test')`, [ctx.empId]);
  const leftToday = (await db.query(`select count(*)::int as n from work_location_days
      where employee_id = $1 and day = (now() at time zone 'Africa/Johannesburg')::date`, [ctx.empId])).rows[0];
  assert.equal(Number(leftToday.n), 0);

  await db.query('delete from work_location_days where employee_id = $1', [ctx.empId]);
  await asUser(ctx.ownerAuth, 'select set_team_office_days($1, null)', [ctx.teamId]);
  await asUser(ctx.ownerAuth, 'select delete_office_network($1)', [office]);
  await save({ track_work_location: false, office_days_per_week: null });
  const quiet = (await asUser(ctx.empAuth, 'select notice_text from get_my_policy_status()')).rows[0];
  assert.doesNotMatch(quiet.notice_text, /home network are not stored/);
  await db.query('update subscriptions set plan = $2 where organization_id = $1', [ctx.orgId, plan]);
});

test('AI tools: operator list, adoption, and an alert when a tool is not approved', async () => {
  const plan = (await db.query('select plan from subscriptions where organization_id = $1', [ctx.orgId])).rows[0].plan;
  await db.query(`update subscriptions set plan = 'standard' where organization_id = $1`, [ctx.orgId]);
  const chatgpt = (await db.query(`select id from ai_tools where name = 'ChatGPT'`)).rows[0].id;
  await rejects(asUser(ctx.ownerAuth, `select set_ai_tool_approval($1, 'unapproved')`, [chatgpt]), /not included/);
  await db.query(`update subscriptions set plan = 'business' where organization_id = $1`, [ctx.orgId]);
  await rejects(asUser(ctx.mgrAuth, `select set_ai_tool_approval($1, 'unapproved')`, [chatgpt]), /Not allowed/);
  await rejects(asUser(ctx.ownerAuth,
    `select op_save_ai_tool(null, 'TestAI', array['testai.example'], array[]::text[], true)`), /Not allowed/);
  await asUser2fa(ctx.opAuth,
    `select op_save_ai_tool(null, 'TestAI', array['testai.example'], array[]::text[], true)`);
  await rejects(asUser(ctx.ownerAuth, 'select * from ai_tools'), /permission denied/);

  const today = `(now() at time zone 'Africa/Johannesburg')::date`;
  await db.query(`insert into daily_usage (employee_id, day, app_name, domain, organization_id, active_seconds) values
      ($1, ${today}, 'Google Chrome', 'chat.openai.com', $2, 600),
      ($1, ${today}, 'Google Chrome', 'a.claude.ai', $2, 300)
    on conflict (employee_id, day, app_name, domain) do update set active_seconds = excluded.active_seconds`,
    [ctx.empId, ctx.orgId]);
  await asUser(ctx.ownerAuth, `select set_ai_tool_approval($1, 'unapproved')`, [chatgpt]);
  await asUser(ctx.ownerAuth, 'select save_compliance_settings($1, null, null)', [JSON.stringify({ alert_unapproved_ai: true })]);
  const notice = (await asUser(ctx.empAuth, 'select notice_text from get_my_policy_status()')).rows[0];
  assert.match(notice.notice_text, /marked as not approved/);

  const chat = (await asUser(ctx.ownerAuth, `select people_using, approved from get_ai_adoption(${today}, ${today}, null)
      where tool_name = 'ChatGPT'`)).rows[0];
  assert.equal(Number(chat.people_using), 1);
  assert.equal(chat.approved, false);
  const claude = (await asUser(ctx.ownerAuth, `select people_using from get_ai_adoption(${today}, ${today}, null)
      where tool_name = 'Claude'`)).rows[0];
  assert.equal(Number(claude.people_using), 1, 'a subdomain counts as the tool');
  const person = (await asUser(ctx.ownerAuth, `select level, days_used, before_hours from get_ai_person_usage(${today} - 13, ${today}, null)
      where employee_id = $1 and tool_name = 'ChatGPT'`, [ctx.empId])).rows[0];
  assert.equal(person.level, 'occasional');
  assert.equal(Number(person.days_used), 1);
  assert.equal(person.before_hours, null, 'a comparison needs history on both sides');

  const alerts = (await asUser(ctx.ownerAuth, `select details from get_integrity_alerts(now() - interval '2 days')
      where kind = 'unapproved_ai'`)).rows;
  assert.ok(alerts.some((r) => r.details.tool === 'ChatGPT'));
  await asUser(ctx.ownerAuth, `select set_ai_tool_approval($1, 'approved')`, [chatgpt]);
  const after = (await asUser(ctx.ownerAuth, `select details from get_integrity_alerts(now() - interval '2 days')
      where kind = 'unapproved_ai'`)).rows;
  assert.ok(!after.some((r) => r.details.tool === 'ChatGPT'));

  await db.query(`delete from daily_usage where employee_id = $1 and domain in ('chat.openai.com', 'a.claude.ai')`, [ctx.empId]);
  await asUser(ctx.ownerAuth, `select set_ai_tool_approval($1, 'unset')`, [chatgpt]);
  await asUser(ctx.ownerAuth, 'select save_compliance_settings($1, null, null)', [JSON.stringify({ alert_unapproved_ai: false })]);
  await db.query(`delete from ai_tools where name = 'TestAI'`);
  const quiet = (await asUser(ctx.empAuth, 'select notice_text from get_my_policy_status()')).rows[0];
  assert.doesNotMatch(quiet.notice_text, /marked as not approved/);
  await db.query('update subscriptions set plan = $2 where organization_id = $1', [ctx.orgId, plan]);
});

test('written advice: off until switched on, and the weekly pack hides names', async () => {
  const plan = (await db.query('select plan from subscriptions where organization_id = $1', [ctx.orgId])).rows[0].plan;
  await db.query(`update subscriptions set plan = 'standard' where organization_id = $1`, [ctx.orgId]);
  await rejects(asUser(ctx.ownerAuth, 'select save_compliance_settings($1, null, null)',
    [JSON.stringify({ advisor_enabled: true })]), /not included/);
  await db.query(`update subscriptions set plan = 'business' where organization_id = $1`, [ctx.orgId]);
  await asUser(ctx.ownerAuth, 'select save_compliance_settings($1, null, null)',
    [JSON.stringify({ advisor_enabled: true })]);
  const notice = (await asUser(ctx.empAuth, 'select notice_text from get_my_policy_status()')).rows[0];
  assert.match(notice.notice_text, /written inside Mycroscope/);
  assert.doesNotMatch(notice.notice_text, /OpenAI/);
  await rejects(asUser(ctx.empAuth, `select save_advisor_question('How is the week?', 'Fine.', null)`), /Not allowed/);
  await rejects(asUser(ctx.ownerAuth, 'select advisor_pack($1, null, current_date - 3, current_date)', [ctx.orgId]),
    /permission denied/);

  const day = `(now() at time zone 'Africa/Johannesburg')::date - 3`;
  await db.query(`insert into daily_usage (employee_id, day, app_name, domain, organization_id, active_seconds)
    values ($1, ${day}, 'Google Chrome', '', $2, 3600)
    on conflict (employee_id, day, app_name, domain) do update set active_seconds = excluded.active_seconds`,
    [ctx.empId, ctx.orgId]);
  const pack = (await asRole('service_role', null, () => db.query(
    `select advisor_pack($1, null, ${day}, ${day}) as pack`, [ctx.orgId]))).rows[0].pack;
  assert.doesNotMatch(JSON.stringify(pack.model), /Sipho|Thandi|Mary/);
  assert.match(JSON.stringify(pack.names), /Sipho/);
  assert.equal(pack.model.software[0].name, 'Google Chrome');

  const id = (await asUser(ctx.ownerAuth,
    `select save_advisor_question('How is the week?', 'Person 1 worked 1 hour.', null) as id`)).rows[0].id;
  const mine = (await asUser(ctx.ownerAuth, 'select question from list_advisor_questions()')).rows;
  assert.ok(mine.some((r) => r.question === 'How is the week?'));
  const mary = (await asUser(ctx.mgrAuth, 'select id from list_advisor_questions()')).rows;
  assert.ok(!mary.some((r) => r.id === id));
  await asRole('service_role', null, () => db.query(
    `select save_coaching_note($1, null, ${day}, 'A short note.')`, [ctx.orgId]));
  const notes = (await asUser(ctx.ownerAuth, 'select body from list_coaching_notes()')).rows;
  assert.ok(notes.some((r) => r.body === 'A short note.'));
  await rejects(asAnon('select list_coaching_notes()'), /permission denied/);

  await db.query('delete from advisor_questions where organization_id = $1', [ctx.orgId]);
  await db.query('delete from coaching_notes where organization_id = $1', [ctx.orgId]);
  await db.query(`delete from daily_usage where employee_id = $1 and day = ${day} and app_name = 'Google Chrome' and domain = ''`,
    [ctx.empId]);
  await asUser(ctx.ownerAuth, 'select save_compliance_settings($1, null, null)',
    [JSON.stringify({ advisor_enabled: false })]);
  const quiet = (await asUser(ctx.empAuth, 'select notice_text from get_my_policy_status()')).rows[0];
  assert.doesNotMatch(quiet.notice_text, /written inside Mycroscope/);
  await db.query('update subscriptions set plan = $2 where organization_id = $1', [ctx.orgId, plan]);
});

test('the nightly job records an ended trial as the free plan, and payment moves it to Standard', async () => {
  const before = (await db.query(
    'select plan, status, seats, trial_ends_at, current_period_end from subscriptions where organization_id = $1',
    [ctx.orgId])).rows[0];
  const retention = (await db.query(
    'select retention_days from organization_settings where organization_id = $1', [ctx.orgId])).rows[0].retention_days;
  await db.query(`update subscriptions set plan = 'trial', status = 'trialing', seats = 25,
      trial_ends_at = now() + interval '1 day', current_period_end = null where organization_id = $1`, [ctx.orgId]);
  await db.query('update organization_settings set retention_days = 90 where organization_id = $1', [ctx.orgId]);
  const extra = (await asUser(ctx.ownerAuth, `select employee_id from create_employee('Extra Free', 'extra-free@acme.co.za')`)).rows[0];
  await db.query('update employees set is_active = false where id = $1', [extra.employee_id]);
  await db.query(`update subscriptions set trial_ends_at = now() - interval '1 hour' where organization_id = $1`, [ctx.orgId]);
  const n = (await db.query('select convert_expired_trials() as n')).rows[0].n;
  assert.ok(Number(n) >= 1);
  const after = (await db.query('select plan, status, seats from subscriptions where organization_id = $1', [ctx.orgId])).rows[0];
  assert.equal(after.plan, 'free');
  assert.equal(after.status, 'active');
  assert.equal(after.seats, 3);
  assert.equal((await db.query('select retention_days from organization_settings where organization_id = $1',
    [ctx.orgId])).rows[0].retention_days, 30);
  await rejects(asUser(ctx.ownerAuth, 'select save_compliance_settings($1, null, null)',
    [JSON.stringify({ retention_days: 90 })]), /30 days/);
  await rejects(asUser(ctx.ownerAuth, 'select update_employee($1, null, null, true)', [extra.employee_id]),
    /free plan includes 3 people/);
  await asUser(ctx.ownerAuth, `select delete_employee($1, 'test cleanup')`, [extra.employee_id]);
  assert.equal((await db.query(
    `select apply_payment($1, 'free-upgrade-test', 100, 'ZAR', 5, 1, null, '{}'::jsonb) as ok`, [ctx.orgId])).rows[0].ok, true);
  const paid = (await db.query('select plan, seats from subscriptions where organization_id = $1', [ctx.orgId])).rows[0];
  assert.equal(paid.plan, 'standard');
  assert.equal(paid.seats, 5);

  await db.query(`update subscriptions set plan = $2, status = $3, seats = $4, trial_ends_at = $5, current_period_end = $6
      where organization_id = $1`,
    [ctx.orgId, before.plan, before.status, before.seats, before.trial_ends_at, before.current_period_end]);
  await db.query('update organization_settings set retention_days = $2 where organization_id = $1', [ctx.orgId, retention]);
  await db.query(`delete from payments where reference = 'free-upgrade-test'`);
  await db.query(`delete from audit_log where organization_id = $1 and action = 'payment_received'
      and details ->> 'reference' = 'free-upgrade-test'`, [ctx.orgId]);
});

test('a restricted program is named in the notice, and a restricted website is refused in Chrome and Edge', async () => {
  const steam = (await asUser(ctx.ownerAuth,
    `select id from save_alert_rule(null, 'Steam', 'app', 'Steam', 'high', false, true, 'restrict')`)).rows[0];
  const notice = (await asUser(ctx.empAuth, 'select notice_text, settings from get_my_policy_status()')).rows[0];
  assert.match(notice.notice_text, /minimises it/);
  assert.match(notice.notice_text, /steam/);
  assert.ok((notice.settings.restrictions ?? []).some((rule) => rule.pattern === 'steam' && rule.kind === 'app'));
  const site = (await asUser(ctx.ownerAuth,
    `select id from save_alert_rule(null, 'Facebook', 'domain', 'facebook.com', 'medium', true, true, 'restrict')`)).rows[0];
  const named = (await asUser(ctx.empAuth, 'select notice_text from get_my_policy_status()')).rows[0];
  assert.match(named.notice_text, /facebook\.com/);
  assert.match(named.notice_text, /the whole time you are signed in/);
  assert.doesNotMatch(named.notice_text, /facebook\.com \(working hours only\)/);
  assert.doesNotMatch(named.notice_text, /does not block the website/);
  await rejects(asUser(ctx.ownerAuth,
    `select save_alert_rule(null, 'Bad', 'app', 'nope.exe', 'low', false, true, 'block')`), /Alert or restrict/);
  await asUser(ctx.ownerAuth, 'select delete_alert_rule($1)', [steam.id]);
  await asUser(ctx.ownerAuth, 'select delete_alert_rule($1)', [site.id]);
  const quiet = (await asUser(ctx.empAuth, 'select notice_text from get_my_policy_status()')).rows[0];
  assert.doesNotMatch(quiet.notice_text, /minimises it/);
});

test('the sign-in reminder migration republishes every notice without changing settings', async () => {
  const before = (await asUser(ctx.ownerAuth, 'select version, settings_snapshot from monitoring_policies order by version desc limit 1')).rows[0];
  await db.exec(readFileSync(path.join(migrationsDir, '20261010090000_notice_sign_in_reminders.sql'), 'utf8'));
  const after = (await asUser(ctx.ownerAuth, 'select version, settings_snapshot, notice_text from monitoring_policies order by version desc limit 1')).rows[0];
  assert.equal(after.version, before.version + 1);
  const { updated_at: _a, ...afterSettings } = after.settings_snapshot;
  const { updated_at: _b, ...beforeSettings } = before.settings_snapshot;
  assert.deepEqual(afterSettings, beforeSettings);
  assert.match(after.notice_text, /SIGN-IN REMINDERS/);
  const status = (await asUser(ctx.empAuth, 'select acknowledged from get_my_policy_status()')).rows[0];
  assert.equal(status.acknowledged, false, 'employees are asked to acknowledge the new version');
});

test('install key: shown to managers, verified anonymously, rotated by the owner', async () => {
  const key = (await asUser(ctx.ownerAuth, 'select get_install_key() as k')).rows[0].k;
  assert.match(key, /^MYC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const mgrKey = (await asUser(ctx.mgrAuth, 'select get_install_key() as k')).rows[0].k;
  assert.equal(mgrKey, key, 'managers see the same key');
  const empKey = (await asUser(ctx.empAuth, 'select get_install_key() as k')).rows[0].k;
  assert.equal(empKey, null, 'employees do not get the install key');
  await rejects(asAnon('select get_install_key()'), /permission denied/);

  const verified = (await asAnon('select * from verify_install_key($1)', [key.toLowerCase()])).rows;
  assert.equal(verified.length, 1, 'the key is accepted case-insensitively');
  assert.equal(verified[0].organization_name, 'Acme Logistics');
  assert.equal((await asAnon('select * from verify_install_key($1)', ['MYC-WRON-GKEY-0000-0000'])).rows.length, 0);

  await rejects(asUser(ctx.mgrAuth, 'select rotate_install_key()'), /Only the owner/);
  const newKey = (await asUser(ctx.ownerAuth, 'select rotate_install_key() as k')).rows[0].k;
  assert.notEqual(newKey, key);
  assert.equal((await asAnon('select * from verify_install_key($1)', [key])).rows.length, 0, 'the old key stops working');
  assert.equal((await asAnon('select * from verify_install_key($1)', [newKey])).rows.length, 1);
});

test('uninstalling and starting late raise manager alerts', async () => {
  const reportKey = 'u'.repeat(43);
  await asUser(ctx.empAuth, 'select set_device_report_key($1, $2)', [ctx.deviceId, reportKey]);

  assert.equal((await asAnon('select report_uninstalled($1, $2) as ok', [ctx.deviceId, 'wrong-key'])).rows[0].ok, false);
  assert.equal((await asAnon('select report_uninstalled($1, $2) as ok', [ctx.deviceId, reportKey])).rows[0].ok, true);
  assert.equal((await asAnon('select report_uninstalled($1, $2) as ok', [ctx.deviceId, reportKey])).rows[0].ok, true);
  const events = await db.query(
    `select count(*)::int as n from agent_events where device_id = $1 and event_type = 'agent_uninstalled'`, [ctx.deviceId]);
  assert.equal(events.rows[0].n, 1, 'repeat reports within 10 minutes do not pile up');

  await asUser(ctx.empAuth, `
    insert into agent_events (id, organization_id, employee_id, device_id, occurred_at, event_type, details)
    values ($1, $2, $3, $4, now() - interval '2 minutes', 'tracking_late', '{"minutes": 90}')`,
    [randomUUID(), ctx.orgId, ctx.empId, ctx.deviceId]);

  const alerts = await asUser(ctx.ownerAuth, `select kind, severity from get_integrity_alerts(now() - interval '1 day')
                                              where kind in ('agent_uninstalled', 'tracking_late') order by kind`);
  assert.deepEqual(alerts.rows, [
    { kind: 'agent_uninstalled', severity: 'high' },
    { kind: 'tracking_late', severity: 'medium' },
  ]);
  const emailed = await asRole('service_role', null, () => db.query(
    `select coalesce(sum(alerts), 0)::int as a, coalesce(sum(high_alerts), 0)::int as h
     from email_alert_batch(now() - interval '1 day') where organization_name = 'Acme Logistics'`));
  assert.ok(emailed.rows[0].a >= 2, 'both appear in the alert email batch');
  assert.ok(emailed.rows[0].h >= 1, 'the uninstall counts as a high alert');
});

test('deleting an employee removes their data and is audited', async () => {
  await rejects(asUser(ctx.ownerAuth, 'select delete_employee($1, $2)', [ctx.ownerId, 'x']), /owner account/);
  await asUser(ctx.ownerAuth, 'select delete_employee($1, $2)', [ctx.empId, 'Left the company']);
  const left = await db.query('select count(*)::int as n from activity_segments where employee_id = $1', [ctx.empId]);
  assert.equal(left.rows[0].n, 0);
  const audit = await asUser(ctx.ownerAuth, `select details from audit_log where action = 'employee_deleted'`);
  assert.ok(audit.rows.some((row) => row.details.reason === 'Left the company'));
});
