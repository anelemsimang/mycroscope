// Starts a prepaid Paystack payment for the signed-in organisation owner.
// The per-seat amount is the catalogue gross price of the lowest paid plan.
// Secrets: PAYSTACK_SECRET_KEY. Optional: ANNUAL_DISCOUNT_PERCENT, APP_URL.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { quote, safeReturnUrl, signTerms } from '../_shared/billing.ts';
import { CORS, env, json, jwtClaim } from '../_shared/http.ts';

const NOT_SET_UP = 'Online payment is not set up yet.';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const secret = env('PAYSTACK_SECRET_KEY');
  if (!secret) return json({ error: NOT_SET_UP }, 503);

  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const admin = createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth } = await admin.auth.getUser(token);
  const user = auth?.user;
  if (!user?.email) return json({ error: 'Please sign in again.' }, 401);

  const { data: me } = await admin.from('employees')
    .select('organization_id, role, is_active').eq('auth_user_id', user.id).maybeSingle();
  if (!me?.is_active || me.role !== 'owner') return json({ error: 'Only the organisation owner can pay.' }, 403);
  const org: string = me.organization_id;

  const [{ data: settings }, { data: sub }, { data: catalogue }, { count: activeCount }] = await Promise.all([
    admin.from('organization_settings').select('require_mfa').eq('organization_id', org).maybeSingle(),
    admin.from('subscriptions').select('currency').eq('organization_id', org).maybeSingle(),
    admin.rpc('get_plan_catalogue'),
    admin.from('employees').select('id', { count: 'exact', head: true }).eq('organization_id', org).eq('is_active', true),
  ]);
  if (settings?.require_mfa && jwtClaim(token, 'aal') !== 'aal2') {
    return json({ error: 'Your organisation requires two-factor login. Sign in with your code first.' }, 403);
  }
  if (!sub) return json({ error: 'Subscription not found. Contact Mycroscope support.' }, 404);

  let body: { seats?: unknown; months?: unknown; return_url?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  const seats = Number(body.seats);
  const months = Number(body.months);
  if (Number.isInteger(seats) && seats < (activeCount ?? 0)) {
    return json({ error: `You have ${activeCount} active people. Choose at least that many seats or deactivate someone first.` }, 400);
  }
  const paid = ((catalogue ?? []) as { rank: number; net_price_cents: number; gross_price_cents: number }[])
    .filter((p) => Number(p.net_price_cents) > 0)
    .sort((a, b) => Number(a.rank) - Number(b.rank))[0];
  const gross = Number(paid?.gross_price_cents);
  if (!paid || !Number.isInteger(gross) || gross < 1) {
    return json({ error: NOT_SET_UP }, 503);
  }
  let q;
  try {
    q = quote(seats, months, gross, Number(env('ANNUAL_DISCOUNT_PERCENT') ?? 0));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }

  const currency: string = sub.currency ?? 'ZAR';
  const reference = `myc_${crypto.randomUUID().replace(/-/g, '')}`;
  const terms = { reference, organization_id: org, seats: q.seats, months: q.months, amount_cents: q.amount_cents, currency };
  const sig = await signTerms(secret, terms);
  const callbackUrl = safeReturnUrl(body.return_url, env('APP_URL'));

  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: user.email,
      amount: q.amount_cents,
      currency,
      reference,
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
      metadata: {
        organization_id: org, seats: q.seats, months: q.months, amount_cents: q.amount_cents, currency, sig,
        custom_fields: [
          { display_name: 'Seats', variable_name: 'seats', value: String(q.seats) },
          { display_name: 'Months', variable_name: 'months', value: String(q.months) },
        ],
      },
    }),
  });
  const result = await res.json().catch(() => null);
  if (!res.ok || !result?.status || !result.data?.authorization_url) {
    console.error('Paystack initialize failed', res.status, result?.message);
    return json({ error: 'Paystack could not start the payment. Please try again in a few minutes.' }, 502);
  }
  return json({ authorization_url: result.data.authorization_url, reference, amount_cents: q.amount_cents, currency });
});
