// Weekly digest and integrity-alert emails, called by pg_cron. Deploy with --no-verify-jwt.
// Secrets: CRON_SECRET, RESEND_API_KEY, EMAIL_FROM (e.g. "Mycroscope <alerts@mail.example.co.za>"), APP_URL.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { timingSafeEqual } from '../_shared/billing.ts';
import { type AlertRow, type DigestRow, type Email, renderAlert, renderDigest } from '../_shared/email.ts';
import { env, json } from '../_shared/http.ts';

const BATCH = 100;

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
  if (!apiKey || !from) return json({ error: 'Email is not configured (RESEND_API_KEY, EMAIL_FROM)' }, 503);
  const appUrl = (env('APP_URL') ?? '').replace(/\/+$/, '');

  let kind: unknown;
  try {
    kind = (await req.json())?.kind;
  } catch {
    kind = undefined;
  }
  if (kind !== 'digest' && kind !== 'alerts') return json({ error: 'kind must be "digest" or "alerts"' }, 400);

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
  const result = await send(emails, apiKey, from);
  return json({ kind, since, recipients: emails.length, ...result });
});
