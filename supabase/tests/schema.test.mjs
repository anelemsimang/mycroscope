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

async function asRole(role, uid, fn) {
  await db.exec(`set role ${role}`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}
const asUser = (uid, sql, params = []) => asRole('authenticated', uid, () => db.query(sql, params));
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

test('role rules: only the owner manages managers and roles', async () => {
  const mgr = await asUser(ctx.ownerAuth, `select * from create_employee('Mary Manager', 'mary@acme.co.za', 'manager')`);
  const mgrAuth = await signUp('mary@acme.co.za', {
    signup_type: 'employee_activation', employee_code: mgr.rows[0].employee_code, activation_code: mgr.rows[0].activation_code });
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

test('deleting an employee removes their data and is audited', async () => {
  await rejects(asUser(ctx.ownerAuth, 'select delete_employee($1, $2)', [ctx.ownerId, 'x']), /owner account/);
  await asUser(ctx.ownerAuth, 'select delete_employee($1, $2)', [ctx.empId, 'Left the company']);
  const left = await db.query('select count(*)::int as n from activity_segments where employee_id = $1', [ctx.empId]);
  assert.equal(left.rows[0].n, 0);
  const audit = await asUser(ctx.ownerAuth, `select details from audit_log where action = 'employee_deleted'`);
  assert.equal(audit.rows[0].details.reason, 'Left the company');
});
