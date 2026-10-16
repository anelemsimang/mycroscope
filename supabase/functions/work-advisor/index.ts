// Written reports filled from figures already stored in Mycroscope. No outside service is called.
// Deploy with --no-verify-jwt. A signed-in manager's token is checked here, and the weekly job
// sends the same x-cron-secret as notify-managers. Reports use that manager's own sign-in, so a
// team manager only sees their teams. Pay figures are left out.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

import {
  type CapacityFigure, type ReportFigures, type ReportTemplate, REPORT_TITLES, type SoftwareFigure,
  type TrendPoint, type WorkloadFigure, writeAllReports, writeReport,
} from '../_shared/advisor.ts';
import { timingSafeEqual } from '../_shared/billing.ts';
import { CORS, env, json } from '../_shared/http.ts';

const TEMPLATES = new Set<ReportTemplate>(['week', 'workload', 'software', 'capacity', 'trend']);
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function opt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = num(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hoursOf(seconds: unknown): number {
  return Math.round(num(seconds) / 360) / 10;
}

function period(from: unknown, to: unknown): { from: string; to: string } | string {
  if (typeof from !== 'string' || typeof to !== 'string' || !YMD.test(from) || !YMD.test(to) || to < from) {
    return 'Use dates as YYYY-MM-DD, with the end on or after the start.';
  }
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 90) return 'Choose a period of at most 90 days.';
  return { from, to };
}

function blank(scope: string, from: string, to: string): ReportFigures {
  return {
    scope, from, to, personDays: 0, productiveHours: 0, awayHours: 0,
    trend: [], workload: [], software: [], capacity: [],
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const admin = createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const cronSecret = env('CRON_SECRET');
  const given = req.headers.get('x-cron-secret') ?? '';
  if (cronSecret && timingSafeEqual(given, cronSecret)) return weekly(admin);

  const header = req.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return json({ error: 'Not signed in' }, 401);
  const user = createClient(env('SUPABASE_URL')!, env('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: header } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: who, error: whoError } = await user.auth.getUser(header.slice(7));
  if (whoError || !who.user) return json({ error: 'Not signed in' }, 401);

  let body: { template?: unknown; from?: unknown; to?: unknown; team?: unknown; scope?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Choose a report and a period.' }, 400);
  }
  const template = body.template;
  const bundle = template === 'all';
  if (!bundle && !TEMPLATES.has(template as ReportTemplate)) return json({ error: 'Choose a report.' }, 400);
  const dates = period(body.from, body.to);
  if (typeof dates === 'string') return json({ error: dates }, 400);
  const team = typeof body.team === 'string' && body.team ? body.team : null;
  const scope = typeof body.scope === 'string' && body.scope.trim()
    ? body.scope.trim().slice(0, 80)
    : team ? 'This team' : 'The whole company';

  const { error: dirError } = await user.rpc('advisor_directory', { p_team: team });
  if (dirError) return json({ error: dirError.message }, 400);

  try {
    const figures = await loadFigures(user, bundle ? 'week' : template as ReportTemplate, dates, team, scope);
    if (bundle) {
      return json({
        sections: writeAllReports(figures).map((section) => ({
          title: section.title,
          answer: section.answer.slice(0, 8000),
        })),
      });
    }
    const chosen = template as ReportTemplate;
    const answer = writeReport(chosen, figures).slice(0, 8000);
    const { error: saveError } = await user.rpc('save_advisor_question', {
      p_question: REPORT_TITLES[chosen], p_answer: answer, p_team: team,
    });
    if (saveError) return json({ error: saveError.message }, 400);
    return json({ answer });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'The report could not be written' }, 400);
  }
});

async function loadFigures(
  user: SupabaseClient, template: ReportTemplate, dates: { from: string; to: string },
  team: string | null, scope: string,
): Promise<ReportFigures> {
  const figures = blank(scope, dates.from, dates.to);
  const args = { p_from: dates.from, p_to: dates.to, p_team: team };
  if (template === 'week' || template === 'trend') {
    const rows = await rowsOf(user, 'get_trend', { ...args, p_granularity: 'day', p_employee: null });
    applyTrend(figures, rows);
  }
  if (template === 'week' || template === 'workload') {
    figures.workload = (await rowsOf(user, 'get_workload', args)).map(workloadFromRpc);
  }
  if (template === 'week' || template === 'software') {
    figures.software = (await rowsOf(user, 'get_software_usage', { ...args, p_kind: 'app' })).map(softwareFromRpc);
  }
  if (template === 'week' || template === 'capacity') {
    const rows = await rowsOf(user, 'get_capacity', { p_from: dates.from, p_to: dates.to });
    figures.capacity = rows
      .filter((row) => !team || String(row.team_id) === team)
      .map(capacityFromRpc);
  }
  return figures;
}

async function rowsOf(user: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const { data, error } = await user.rpc(fn, args);
  if (error) throw new Error(error.message);
  return (data ?? []) as Record<string, unknown>[];
}

function applyTrend(figures: ReportFigures, rows: Record<string, unknown>[]) {
  figures.personDays = rows.reduce((sum, row) => sum + num(row.person_days), 0);
  figures.productiveHours = rows.reduce((sum, row) => sum + hoursOf(row.productive_seconds), 0);
  figures.awayHours = rows.reduce((sum, row) => sum + hoursOf(row.productive_offline_seconds), 0);
  figures.trend = rows.map((row): TrendPoint => ({
    productiveHours: hoursOf(row.productive_seconds),
    awayHours: hoursOf(row.productive_offline_seconds),
  }));
}

function workloadFromRpc(row: Record<string, unknown>): WorkloadFigure {
  return {
    name: String(row.name ?? 'Someone'),
    days: num(row.days_worked),
    productiveHours: hoursOf(row.productive_seconds),
    utilisation: opt(row.utilisation),
    status: String(row.status ?? 'no_data'),
  };
}

function softwareFromRpc(row: Record<string, unknown>): SoftwareFigure {
  return { name: String(row.name ?? 'Unknown'), users: num(row.users), hours: hoursOf(row.active_seconds) };
}

function capacityFromRpc(row: Record<string, unknown>): CapacityFigure {
  return {
    team: String(row.team_name ?? 'No team'),
    people: num(row.people),
    avgHours: opt(row.avg_productive_hours),
    gapHours: opt(row.gap_hours),
  };
}

function figuresFromPack(pack: { model?: PackModel; names?: { person: string; name: string }[] }, scope: string, from: string, to: string): ReportFigures {
  const figures = blank(scope, from, to);
  const model = pack.model ?? {};
  const names = new Map((pack.names ?? []).map((entry) => [entry.person, entry.name]));
  const trend = model.trend ?? [];
  figures.personDays = trend.reduce((sum, row) => sum + num(row.people), 0);
  figures.productiveHours = trend.reduce((sum, row) => sum + num(row.productive_hours), 0);
  figures.awayHours = trend.reduce((sum, row) => sum + num(row.productive_away_hours), 0);
  figures.trend = trend.map((row) => ({ productiveHours: num(row.productive_hours), awayHours: num(row.productive_away_hours) }));
  figures.workload = (model.workload ?? []).map((row) => ({
    name: names.get(String(row.person)) ?? String(row.person ?? 'Someone'),
    days: num(row.days),
    productiveHours: num(row.productive_hours),
    utilisation: opt(row.utilisation),
    status: String(row.status ?? 'no_data'),
  }));
  figures.software = (model.software ?? []).map((row) => ({
    name: String(row.name ?? 'Unknown'), users: num(row.users), hours: num(row.hours),
  }));
  return figures;
}

async function weekly(admin: SupabaseClient): Promise<Response> {
  const { data, error } = await admin.rpc('coaching_queue');
  if (error) return json({ error: error.message }, 500);
  let written = 0;
  let mailed = 0;
  for (const row of (data ?? []) as QueueRow[]) {
    const { data: pack, error: packError } = await admin.rpc('advisor_pack', {
      p_org: row.organization_id, p_team: row.team_id, p_from: row.week_start, p_to: row.week_end,
    });
    if (packError || !pack) {
      console.error('advisor pack failed', row.organization_id, packError?.message);
      continue;
    }
    const note = writeReport('week', figuresFromPack(
      pack, row.team_name ?? 'The whole company', row.week_start, row.week_end,
    )).slice(0, 8000);
    const { error: saveError } = await admin.rpc('save_coaching_note', {
      p_org: row.organization_id, p_team: row.team_id, p_week: row.week_start, p_body: note,
    });
    if (saveError) {
      console.error('save coaching note failed', saveError.message);
      continue;
    }
    written++;
    if (row.send_email) mailed += await emailNote(admin, row, note);
  }
  return json({ written, mailed });
}

async function emailNote(admin: SupabaseClient, row: QueueRow, note: string): Promise<number> {
  const apiKey = env('RESEND_API_KEY');
  const from = env('EMAIL_FROM');
  if (!apiKey || !from) return 0;
  const { data, error } = await admin.rpc('coaching_recipients', { p_org: row.organization_id, p_team: row.team_id });
  if (error || !data?.length) return 0;
  const subject = `Weekly report${row.team_name ? `: ${row.team_name}` : ''}`;
  const text = `${note}\n\nThis report was written by Mycroscope from the figures it already stores.`;
  const res = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify((data as { email: string }[]).slice(0, 50).map((recipient) => ({
      from, to: [recipient.email], subject, text,
    }))),
  });
  if (!res.ok) {
    console.error('Report email failed', res.status);
    return 0;
  }
  return (data as unknown[]).length;
}

interface QueueRow {
  organization_id: string; team_id: string | null; team_name: string | null;
  week_start: string; week_end: string; send_email: boolean;
}

interface PackModel {
  trend?: { people?: unknown; productive_hours?: unknown; productive_away_hours?: unknown }[];
  workload?: { person?: unknown; days?: unknown; productive_hours?: unknown; utilisation?: unknown; status?: unknown }[];
  software?: { name?: unknown; users?: unknown; hours?: unknown }[];
}
