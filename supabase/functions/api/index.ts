// Read-only REST API for one company, authenticated with an API key created in the manager app.
// Deploy with --no-verify-jwt. Send the key as "Authorization: Bearer myc_..." or "X-Api-Key: myc_...".
//   GET /api/v1/employees
//   GET /api/v1/daily-totals?from=YYYY-MM-DD&to=YYYY-MM-DD   (at most 93 days)
//   GET /api/v1/usage?from=YYYY-MM-DD&to=YYYY-MM-DD          (apps and websites per person per day)
//   GET /api/v1/alerts?since=ISO-8601 time                   (within the last 93 days)
// File names, window titles and full web addresses are never returned.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { env } from '../_shared/http.ts';

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-api-key',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const DAY = /^\d{4}-\d{2}-\d{2}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: HEADERS });
  if (req.method !== 'GET') return reply({ error: 'Only GET is supported' }, 405);

  const key = (req.headers.get('x-api-key') ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '').trim();
  if (!key) return reply({ error: 'Send your API key in the Authorization header: Bearer myc_...' }, 401);

  const admin = createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: org, error: authError } = await admin.rpc('api_authenticate', { p_key: key });
  if (authError) return reply({ error: 'Temporarily unavailable' }, 503);
  if (!org) return reply({ error: 'Invalid or revoked API key, or your plan does not include API access' }, 401);

  const url = new URL(req.url);
  const route = url.pathname.match(/\/v1\/(employees|daily-totals|usage|alerts)\/?$/)?.[1];
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  const needsPeriod = route === 'daily-totals' || route === 'usage';
  if (needsPeriod && (!DAY.test(from) || !DAY.test(to))) {
    return reply({ error: 'from and to are required, as YYYY-MM-DD' }, 400);
  }

  let call;
  switch (route) {
    case 'employees':
      call = admin.rpc('api_employees', { p_org: org });
      break;
    case 'daily-totals':
      call = admin.rpc('api_daily_totals', { p_org: org, p_from: from, p_to: to });
      break;
    case 'usage':
      call = admin.rpc('api_usage', { p_org: org, p_from: from, p_to: to });
      break;
    case 'alerts': {
      const since = url.searchParams.get('since') ?? new Date(Date.now() - 86_400_000).toISOString();
      if (Number.isNaN(Date.parse(since))) return reply({ error: 'since must be an ISO-8601 time' }, 400);
      call = admin.rpc('api_alerts', { p_org: org, p_since: since });
      break;
    }
    default:
      return reply({ error: 'Unknown endpoint. Use /v1/employees, /v1/daily-totals, /v1/usage or /v1/alerts' }, 404);
  }
  const { data, error } = await call;
  if (error) {
    const known = /at most 93 days|must be|from and to/.test(error.message);
    return reply({ error: known ? error.message : 'Request failed' }, known ? 400 : 500);
  }
  return reply({ data: data ?? [] });
});
