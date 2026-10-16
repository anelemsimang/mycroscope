// Emails owners when a paid month has ended and the grace window is open.
// Deploy with --no-verify-jwt. Secrets: CRON_SECRET, and for the payment link YOCO_SECRET_KEY.
// Email needs RESEND_API_KEY, EMAIL_FROM, and APP_URL. The nightly database job still moves
// a company to Free after the grace window even if this function is not called.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { timingSafeEqual } from '../_shared/billing.ts';
import { env, json } from '../_shared/http.ts';

interface RenewalRow {
  intent_id: string;
  organization_id: string;
  gross_cents: number;
  period_end: string;
  owner_email: string | null;
  owner_name: string | null;
  plan_name: string;
  yoco_checkout_id: string | null;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const cronSecret = env('CRON_SECRET');
  const given = req.headers.get('x-cron-secret') ?? '';
  if (!cronSecret || !timingSafeEqual(given, cronSecret)) return json({ error: 'Forbidden' }, 403);

  const admin = createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.rpc('list_renewal_work');
  if (error) return json({ error: error.message }, 500);
  const rows = (data ?? []) as RenewalRow[];

  const apiKey = env('RESEND_API_KEY');
  const from = env('EMAIL_FROM');
  const appUrl = (env('APP_URL') ?? '').replace(/\/+$/, '');
  const yocoKey = env('YOCO_SECRET_KEY');
  if (!apiKey || !from) return json({ due: rows.length, emailed: 0, note: 'Email is not configured' });

  let emailed = 0;
  for (const row of rows) {
    let payUrl = appUrl ? `${appUrl}/checkout` : '';
    const successUrl = appUrl ? `${appUrl}/checkout-received` : '';
    const cancelUrl = appUrl ? `${appUrl}/checkout-cancelled` : '';
    const failureUrl = appUrl ? `${appUrl}/checkout-failed` : '';
    if (yocoKey && !row.yoco_checkout_id) {
      const checkout = await fetch('https://payments.yoco.com/api/checkouts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${yocoKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': row.intent_id,
        },
        body: JSON.stringify({
          amount: row.gross_cents,
          currency: 'ZAR',
          ...(successUrl ? { successUrl, cancelUrl, failureUrl } : {}),
          metadata: { intentId: row.intent_id, organizationId: row.organization_id },
        }),
      });
      const created = await checkout.json().catch(() => null);
      if (checkout.ok && typeof created?.redirectUrl === 'string' && typeof created?.id === 'string') {
        payUrl = created.redirectUrl;
        await admin.rpc('attach_yoco_checkout', { p_intent: row.intent_id, p_checkout_id: created.id });
      }
    }
    if (!row.owner_email) {
      await admin.rpc('mark_billing_notice', { p_org: row.organization_id, p_period: row.period_end });
      continue;
    }
    const rands = (row.gross_cents / 100).toFixed(2);
    const text = [
      `Hello ${row.owner_name ?? 'there'},`,
      '',
      `Your Mycroscope ${row.plan_name} year has ended. The plan stays available for a few more days.`,
      `The amount due is R${rands}.`,
      payUrl ? `Pay here: ${payUrl}` : 'Open the billing page in Mycroscope to pay.',
      '',
      'If the payment is not made, the account moves to the Free plan. People and history are not deleted.',
    ].join('\n');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to: [row.owner_email], subject: 'Mycroscope payment due', text,
      }),
    });
    if (res.ok) {
      emailed += 1;
      await admin.rpc('mark_billing_notice', { p_org: row.organization_id, p_period: row.period_end });
    }
  }
  return json({ due: rows.length, emailed });
});
