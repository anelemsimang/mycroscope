// Sends a test message to one Slack / Teams / webhook channel for an owner or company-wide manager.
// The permission check runs as the signed-in user; the channel address is then read with the service role,
// so it is never sent to the app.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { type Channel, deliver } from '../_shared/alerts.ts';
import { CORS, env, json } from '../_shared/http.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authorization = req.headers.get('Authorization') ?? '';
  let channelId: unknown;
  try {
    channelId = (await req.json())?.channel_id;
  } catch {
    channelId = undefined;
  }
  if (typeof channelId !== 'string' || !/^[0-9a-f-]{36}$/i.test(channelId)) return json({ error: 'Invalid request' }, 400);

  const asUser = createClient(env('SUPABASE_URL')!, env('SUPABASE_ANON_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
  const { error: denied } = await asUser.rpc('request_channel_test', { p_id: channelId });
  if (denied) return json({ error: denied.message }, 403);

  const admin = createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.rpc('channel_delivery_info', { p_id: channelId });
  const channel = (data as Channel[] | null)?.[0];
  if (error || !channel) return json({ error: 'Channel not found' }, 404);

  const failure = await deliver(channel, [], (env('APP_URL') ?? '').replace(/\/+$/, ''), true);
  await admin.rpc('record_channel_result', { p_id: channelId, p_error: failure });
  return failure ? json({ error: `The channel did not accept the message (${failure}).` }, 502) : json({ ok: true });
});
