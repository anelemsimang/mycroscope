// Starts a Yoco checkout for the signed-in organisation owner, and confirms it with the secret key.
// Yoco's Checkout screen has a public key and a secret key. The public key is not used here:
// the card form is on Yoco's page. The secret key creates the checkout and reads it back.
// A return to this site is not proof of payment. A completed checkout with a payment id is.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { safeReturnUrl } from '../_shared/billing.ts';
import { CORS, env, json, jwtClaim } from '../_shared/http.ts';

const NOT_SET_UP = 'Online payment is not set up yet.';
const INTENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function withIntent(url: string | undefined, intentId: string): string | undefined {
  if (!url) return undefined;
  const next = new URL(url);
  next.searchParams.set('intent', intentId);
  return next.toString();
}

interface Quote {
  kind?: string;
  gross_cents?: number;
  intent_id?: string;
  message?: string;
  plan?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const secret = env('YOCO_SECRET_KEY');
  const url = env('SUPABASE_URL');
  const anon = env('SUPABASE_ANON_KEY');
  const service = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anon || !service) return json({ error: NOT_SET_UP }, 503);

  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const user = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: me, error: meError } = await user.auth.getUser();
  if (meError || !me.user?.email) return json({ error: 'Please sign in again.' }, 401);

  let body: { plan?: unknown; seats?: unknown; when?: unknown; return_url?: unknown; cancel_url?: unknown; failure_url?: unknown; confirm?: unknown; intent?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Choose a plan.' }, 400);
  }

  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: employee } = await admin.from('employees')
    .select('organization_id, role, is_active').eq('auth_user_id', me.user.id).maybeSingle();
  if (!employee?.is_active || employee.role !== 'owner') return json({ error: 'Only the organisation owner can pay.' }, 403);
  const { data: settings } = await admin.from('organization_settings')
    .select('require_mfa').eq('organization_id', employee.organization_id).maybeSingle();
  if (settings?.require_mfa && jwtClaim(token, 'aal') !== 'aal2') {
    return json({ error: 'Your organisation requires two-factor login. Sign in with your code first.' }, 403);
  }

  if (body.confirm === true) {
    if (!secret) return json({ error: NOT_SET_UP }, 503);
    if (typeof body.intent !== 'string' || !INTENT.test(body.intent)) return json({ error: 'This payment could not be found.' }, 400);
    const { data: intent } = await admin.from('checkout_intents')
      .select('id, status, gross_cents, yoco_checkout_id')
      .eq('id', body.intent).eq('organization_id', employee.organization_id).maybeSingle();
    if (!intent) return json({ error: 'This payment could not be found.' }, 404);
    if (intent.status === 'paid') return json({ confirmed: true });
    if (!intent.yoco_checkout_id) return json({ confirmed: false, pending: true });
    const lookup = await fetch(`https://payments.yoco.com/api/checkouts/${intent.yoco_checkout_id}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const checkout = await lookup.json().catch(() => null);
    if (secret.startsWith('sk_live_') && checkout?.processingMode === 'test') {
      return json({ error: 'A test payment cannot be applied to the live account.' }, 400);
    }
    const paid = lookup.ok && checkout?.status === 'completed' && typeof checkout.paymentId === 'string' && checkout.paymentId;
    if (!paid) return json({ confirmed: false, pending: checkout?.status === 'created' || checkout?.status === 'started' || checkout?.status === 'processing' });
    const { error: applyError } = await admin.rpc('apply_checkout_payment', {
      p_intent: intent.id,
      p_reference: checkout.paymentId,
      p_amount: checkout.amount,
      p_currency: checkout.currency ?? 'ZAR',
      p_raw: checkout,
    });
    if (applyError) return json({ error: applyError.message }, 409);
    return json({ confirmed: true });
  }
  if (typeof body.plan !== 'string' || !body.plan) return json({ error: 'Choose a plan.' }, 400);

  const seats = typeof body.seats === 'number' && Number.isInteger(body.seats) ? body.seats : null;
  const when = body.when === 'end' ? 'end' : 'now';
  const { data, error } = await user.rpc('quote_plan_change', {
    p_plan: body.plan, p_commit: true, p_seats: seats, p_when: when,
  });
  if (error) return json({ error: error.message }, 400);
  const quote = (data ?? {}) as Quote;
  if (!quote.gross_cents) {
    return json({ redirect_url: null, amount_cents: 0, kind: quote.kind ?? 'current', message: quote.message ?? 'No payment is due.' });
  }
  if (!secret) return json({ error: NOT_SET_UP }, 503);
  if (!quote.intent_id) return json({ error: 'The payment could not be prepared.' }, 500);

  const successUrl = withIntent(safeReturnUrl(body.return_url, env('APP_URL')), quote.intent_id);
  const cancelUrl = withIntent(safeReturnUrl(body.cancel_url, env('APP_URL')) ?? successUrl, quote.intent_id);
  const failureUrl = withIntent(safeReturnUrl(body.failure_url, env('APP_URL')) ?? successUrl, quote.intent_id);
  const checkout = await fetch('https://payments.yoco.com/api/checkouts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': quote.intent_id,
    },
    body: JSON.stringify({
      amount: quote.gross_cents,
      currency: 'ZAR',
      ...(successUrl ? { successUrl, cancelUrl, failureUrl } : {}),
      externalId: quote.intent_id,
      clientReferenceId: quote.intent_id,
      metadata: { intentId: quote.intent_id, organizationId: employee.organization_id },
    }),
  });
  const created = await checkout.json().catch(() => null);
  if (!checkout.ok || typeof created?.redirectUrl !== 'string' || typeof created?.id !== 'string') {
    return json({ error: 'The payment could not be started.' }, 502);
  }
  const { error: attachError } = await admin.rpc('attach_yoco_checkout', {
    p_intent: quote.intent_id, p_checkout_id: created.id,
  });
  if (attachError) return json({ error: attachError.message }, 500);
  return json({
    redirect_url: created.redirectUrl,
    amount_cents: quote.gross_cents,
    reference: quote.intent_id,
    kind: quote.kind,
  });
});
