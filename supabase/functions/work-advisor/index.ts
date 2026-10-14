// Manager questions and the weekly coaching note.
// Deploy with --no-verify-jwt. A signed-in manager's token is checked here, and the weekly job
// sends the same x-cron-secret as notify-managers. The model is called only when OPENAI_API_KEY is set.
// Names are replaced before the call. Pay figures are removed. The model cannot write SQL.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { type PersonLabel, pseudonymize, restoreNames, scrubQuestion } from '../_shared/advisor.ts';
import { timingSafeEqual } from '../_shared/billing.ts';
import { CORS, env, json } from '../_shared/http.ts';

const SYSTEM = [
  'You advise one company using only figures you are given or that a tool returns.',
  'Every number in your answer must appear in those figures. If you were not given a figure, say you do not have it.',
  'People are labeled Person N. Use those labels. Do not invent names, web addresses, or pay.',
  'Durations are in hours. Keep the answer under 180 words.',
].join(' ');

const TOOLS = [
  tool('trends', 'Daily, weekly or monthly totals of active and productive hours.', {
    from: { type: 'string' }, to: { type: 'string' }, granularity: { type: 'string', enum: ['day', 'week', 'month'] },
    team: { type: 'string' },
  }, ['from', 'to']),
  tool('workload', 'Per person: days worked, productive hours, and whether they are under, healthy, or over their goal.', {
    from: { type: 'string' }, to: { type: 'string' }, team: { type: 'string' },
  }, ['from', 'to']),
  tool('capacity', 'Per team: people, productive hours, and the gap against the goal. Pay is not included.', {
    from: { type: 'string' }, to: { type: 'string' },
  }, ['from', 'to']),
  tool('software', 'Apps or websites: hours open and how many people used them.', {
    from: { type: 'string' }, to: { type: 'string' }, kind: { type: 'string', enum: ['app', 'domain'] },
    team: { type: 'string' },
  }, ['from', 'to']),
];

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function period(from: unknown, to: unknown): { from: string; to: string } | string {
  if (typeof from !== 'string' || typeof to !== 'string' || !YMD.test(from) || !YMD.test(to) || to < from) {
    return 'Use dates as YYYY-MM-DD, with the end on or after the start.';
  }
  const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (span > 90) return 'Choose a period of at most 90 days.';
  return { from, to };
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

  let body: { question?: unknown; from?: unknown; to?: unknown; team?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Send a question and a period.' }, 400);
  }
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (question.length < 3 || question.length > 800) return json({ error: 'Ask a question of up to 800 characters.' }, 400);
  const dates = period(body.from, body.to);
  if (typeof dates === 'string') return json({ error: dates }, 400);
  const team = typeof body.team === 'string' && body.team ? body.team : null;

  const { data: directory, error: dirError } = await user.rpc('advisor_directory', { p_team: team });
  if (dirError) return json({ error: dirError.message }, 400);
  const people = (directory ?? []) as PersonLabel[];
  try {
    const answer = await answerQuestion(user, scrubQuestion(question, people), dates, team, people);
    const shown = restoreNames(answer, people).slice(0, 8000);
    const { error: saveError } = await user.rpc('save_advisor_question', {
      p_question: question, p_answer: shown, p_team: team,
    });
    if (saveError) return json({ error: saveError.message }, 400);
    return json({ answer: shown });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'The advice service did not answer';
    const status = message.includes('OPENAI_API_KEY') ? 503 : 502;
    return json({ error: message }, status);
  }
});

async function answerQuestion(
  user: SupabaseClient, question: string, dates: { from: string; to: string }, team: string | null, people: PersonLabel[],
): Promise<string> {
  const messages: Record<string, unknown>[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Period ${dates.from} to ${dates.to}. ${question}` },
  ];
  for (let round = 0; round < 4; round++) {
    const message = await complete(messages, TOOLS);
    messages.push(message);
    const calls = (message.tool_calls ?? []) as { id: string; function: { name: string; arguments: string } }[];
    if (!calls.length) return String(message.content ?? '').trim() || 'No answer was returned.';
    for (const call of calls.slice(0, 4)) {
      messages.push({
        role: 'tool', tool_call_id: call.id,
        content: JSON.stringify(await runTool(user, call.function.name, call.function.arguments, dates, team, people)),
      });
    }
  }
  return 'I could not finish an answer from the reports in the allowed steps.';
}

async function runTool(
  user: SupabaseClient, name: string, raw: string, fallback: { from: string; to: string },
  team: string | null, people: PersonLabel[],
): Promise<unknown> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    args = {};
  }
  const dates = period(args.from ?? fallback.from, args.to ?? fallback.to);
  if (typeof dates === 'string') return { error: dates };
  const chosen = typeof args.team === 'string' && args.team ? args.team : team;
  if (name === 'trends') {
    const grain = args.granularity === 'week' || args.granularity === 'month' ? args.granularity : 'day';
    return call(user, 'get_trend', { p_from: dates.from, p_to: dates.to, p_granularity: grain, p_team: chosen, p_employee: null }, people);
  }
  if (name === 'workload') {
    return call(user, 'get_workload', { p_from: dates.from, p_to: dates.to, p_team: chosen }, people);
  }
  if (name === 'capacity') return call(user, 'get_capacity', { p_from: dates.from, p_to: dates.to }, people);
  if (name === 'software') {
    const kind = args.kind === 'domain' ? 'domain' : 'app';
    return call(user, 'get_software_usage', { p_from: dates.from, p_to: dates.to, p_kind: kind, p_team: chosen }, people);
  }
  return { error: 'Unknown report' };
}

async function call(user: SupabaseClient, fn: string, args: Record<string, unknown>, people: PersonLabel[]): Promise<unknown> {
  const { data, error } = await user.rpc(fn, args);
  if (error) return { error: error.message };
  return pseudonymize(data, people);
}

async function complete(messages: Record<string, unknown>[], tools: unknown): Promise<Record<string, unknown>> {
  const key = env('OPENAI_API_KEY');
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env('OPENAI_MODEL') ?? 'gpt-4.1-mini', temperature: 0.2, messages, tools }),
  });
  if (!res.ok) {
    console.error('OpenAI request failed', res.status);
    throw new Error('The advice service did not answer');
  }
  const body = await res.json();
  const message = body?.choices?.[0]?.message;
  if (!message) throw new Error('The advice service did not answer');
  return message;
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
    if (packError || !pack?.model) {
      console.error('advisor pack failed', row.organization_id, packError?.message);
      continue;
    }
    const people = (pack.names ?? []) as { person: string; name: string }[];
    const labels = people.map((p) => ({ pseudo: p.person, name: p.name }));
    let note: string;
    try {
      const message = await complete([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Write the weekly coaching note for ${row.team_name ?? 'the whole company'} from these figures only:\n${JSON.stringify(pack.model)}` },
      ], undefined);
      note = restoreNames(String(message.content ?? '').trim(), labels);
    } catch (e) {
      console.error('weekly note failed', e instanceof Error ? e.message : 'error');
      break;
    }
    if (!note) continue;
    const { error: saveError } = await admin.rpc('save_coaching_note', {
      p_org: row.organization_id, p_team: row.team_id, p_week: row.week_start, p_body: note.slice(0, 8000),
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
  const subject = `Weekly coaching note${row.team_name ? `: ${row.team_name}` : ''}`;
  const text = `${note}\n\nThis note was written from Mycroscope figures. Names were restored after the draft was produced.`;
  const res = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify((data as { email: string }[]).slice(0, 50).map((r) => ({
      from, to: [r.email], subject, text,
    }))),
  });
  if (!res.ok) {
    console.error('Coaching email failed', res.status);
    return 0;
  }
  return (data as unknown[]).length;
}

interface QueueRow {
  organization_id: string; team_id: string | null; team_name: string | null;
  week_start: string; week_end: string; send_email: boolean;
}
