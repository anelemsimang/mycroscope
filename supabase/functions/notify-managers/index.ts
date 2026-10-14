// Weekly digest and alert emails, plus Slack / Teams / webhook alerts; called by pg_cron. Deploy with --no-verify-jwt.
// Secrets: CRON_SECRET, RESEND_API_KEY, EMAIL_FROM (e.g. "Mycroscope <alerts@mail.example.co.za>"), APP_URL.
// Channels are posted to even when email is not configured.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { type ChannelAlert, deliver } from '../_shared/alerts.ts';
import { timingSafeEqual } from '../_shared/billing.ts';
import { type AlertRow, type DigestRow, type Email, renderAlert, renderDigest } from '../_shared/email.ts';
import { env, json } from '../_shared/http.ts';

const BATCH = 100;

interface ChannelBatchRow {
  channel_id: string;
  kind: 'slack' | 'teams' | 'webhook';
  url: string;
  signing_secret: string | null;
  organization_name: string;
  timezone: string;
  alerts: ChannelAlert[] | null;
}

async function send(emails: Email[], apiKey: string, from: string): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < emails.length; i += BATCH) {
    const chunk = emails.slice(i, i + BATCH);
    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk.map((e) => ({ from, to: [e.to], subject: e.subject, text: e.text, html: e.html }))),
    });
    if (res.ok) {
      sent += chunk.length;
    } else {
      failed += chunk.length;
      console.error('Resend batch failed', res.status, await res.text().catch(() => ''));
    }
  }
  return { sent, failed };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const cronSecret = env('CRON_SECRET');
  const given = req.headers.get('x-cron-secret') ?? '';
  if (!cronSecret || !timingSafeEqual(given, cronSecret)) return json({ error: 'Forbidden' }, 403);

  const apiKey = env('RESEND_API_KEY');
  const from = env('EMAIL_FROM');
  const appUrl = (env('APP_URL') ?? '').replace(/\/+$/, '');

  let kind: unknown;
  try {
    kind = (await req.json())?.kind;
  } catch {
    kind = undefined;
  }
  if (kind !== 'digest' && kind !== 'alerts') return json({ error: 'kind must be "digest" or "alerts"' }, 400);
  if (kind === 'digest' && (!apiKey || !from)) {
    return json({ error: 'Email is not configured (RESEND_API_KEY, EMAIL_FROM)' }, 503);
  }

  const admin = createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: since, error: claimError } = await admin.rpc('claim_email_window', {
    p_kind: kind, p_default: kind === 'digest' ? '7 days' : '1 hour',
  });
  if (claimError) return json({ error: claimError.message }, 500);

  let emails: Email[];
  if (kind === 'digest') {
    const { data, error } = await admin.rpc('email_digest_batch');
    if (error) return json({ error: error.message }, 500);
    emails = ((data ?? []) as DigestRow[]).map((r) => renderDigest(r, appUrl));
  } else {
    const { data, error } = await admin.rpc('email_alert_batch', { p_since: since });
    if (error) return json({ error: error.message }, 500);
    emails = ((data ?? []) as AlertRow[]).map((r) => renderAlert(r, appUrl));
  }
  const result = apiKey && from ? await send(emails, apiKey, from) : { sent: 0, failed: 0, email: 'not configured' };

  const channels = { posted: 0, failed: 0 };
  if (kind === 'alerts') {
    const { data, error } = await admin.rpc('channel_alert_batch', { p_since: since });
    if (error) {
      console.error('channel_alert_batch failed', error.message);
    } else {
      for (const c of (data ?? []) as ChannelBatchRow[]) {
        if (!c.alerts?.length) continue;
        const failure = await deliver(c, c.alerts, appUrl);
        await admin.rpc('record_channel_result', { p_id: c.channel_id, p_error: failure });
        if (failure) {
          channels.failed++;
          console.error('Channel delivery failed', c.channel_id, failure);
        } else {
          channels.posted++;
        }
      }
    }
  }
  return json({ kind, since, recipients: emails.length, ...result, channels });
});
