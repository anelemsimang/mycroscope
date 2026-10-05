// Receives Paystack events and applies confirmed payments exactly once. Deploy with --no-verify-jwt.
// Secret: PAYSTACK_SECRET_KEY.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { termsFromTransaction, verifyPaystackSignature, verifyTerms } from '../_shared/billing.ts';
import { env, json } from '../_shared/http.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const secret = env('PAYSTACK_SECRET_KEY');
  if (!secret) return json({ error: 'Not configured' }, 503);

  const raw = await req.text();
  if (!(await verifyPaystackSignature(secret, raw, req.headers.get('x-paystack-signature')))) {
    return json({ error: 'Invalid signature' }, 401);
  }
  let event: { event?: string; data?: { reference?: string } };
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid body' }, 400);
  }
  if (event.event !== 'charge.success' || typeof event.data?.reference !== 'string') return json({ ignored: true });

  // Trust Paystack's API, not the event body, for the amount and status.
  const verify = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(event.data.reference)}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const verified = await verify.json().catch(() => null);
  if (!verify.ok || !verified?.status) {
    console.error('Paystack verify failed', verify.status, verified?.message);
    return json({ error: 'Verification failed' }, 502);
  }
  const tx = verified.data;
  if (tx?.status !== 'success') return json({ ignored: 'not successful' });

  const terms = termsFromTransaction(tx);
  if (!terms || !(await verifyTerms(secret, terms, terms.sig))) {
    console.error('Payment without valid Mycroscope terms', tx?.reference);
    return json({ ignored: 'unknown payment' });
  }
  if (tx.amount !== terms.amount_cents || String(tx.currency).toUpperCase() !== terms.currency.toUpperCase()) {
    console.error('Amount mismatch', tx.reference, tx.amount, tx.currency, terms.amount_cents, terms.currency);
    return json({ ignored: 'amount mismatch' });
  }

  const admin = createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: applied, error } = await admin.rpc('apply_payment', {
    p_org: terms.organization_id,
    p_reference: terms.reference,
    p_amount_cents: terms.amount_cents,
    p_currency: terms.currency,
    p_seats: terms.seats,
    p_months: terms.months,
    p_customer_code: tx.customer?.customer_code ?? null,
    p_raw: { id: tx.id, paid_at: tx.paid_at, channel: tx.channel, gateway_response: tx.gateway_response },
  });
  if (error) {
    console.error('apply_payment failed', terms.reference, error.message);
    return json({ error: 'Could not record payment' }, 500);
  }
  return json({ applied });
});
