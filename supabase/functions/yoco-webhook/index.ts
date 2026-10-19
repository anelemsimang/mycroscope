// Receives Yoco payment events and applies a confirmed payment exactly once.
// Deploy with --no-verify-jwt. Secret: YOCO_WEBHOOK_SECRET (whsec_...). Optional: YOCO_SECRET_KEY, to refuse test events on a live key.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { env, json } from '../_shared/http.ts';
import { verifyYocoSignature } from '../_shared/yoco.ts';

interface YocoEvent {
  id?: string;
  type?: string;
  payload?: {
    id?: string;
    amount?: number;
    currency?: string;
    status?: string;
    mode?: string;
    metadata?: Record<string, unknown>;
  };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const secret = env('YOCO_WEBHOOK_SECRET');
  if (!secret) return json({ error: 'Not configured' }, 503);

  const raw = await req.text();
  if (!(await verifyYocoSignature(secret, raw, req.headers))) return json({ error: 'Invalid signature' }, 401);

  let event: YocoEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid body' }, 400);
  }
  if (event.type !== 'payment.succeeded') return json({ ignored: true });

  const payment = event.payload;
  const reference = payment?.id;
  if (typeof reference !== 'string' || typeof payment?.amount !== 'number') {
    return json({ error: 'The payment is missing its checkout details' }, 400);
  }
  const metadata = payment.metadata ?? {};
  let intentId = typeof metadata.intentId === 'string' ? metadata.intentId : '';
  const liveKey = env('YOCO_SECRET_KEY') ?? '';
  if (liveKey.startsWith('sk_live_') && payment.mode === 'test') {
    return json({ error: 'A test payment cannot be applied to the live account' }, 400);
  }

  const admin = createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  if (!intentId && typeof metadata.checkoutId === 'string') {
    const { data: intent } = await admin.from('checkout_intents')
      .select('id').eq('yoco_checkout_id', metadata.checkoutId).maybeSingle();
    if (intent?.id) intentId = intent.id;
  }
  if (!intentId) return json({ error: 'The payment is missing its checkout details' }, 400);
  const { data, error } = await admin.rpc('apply_checkout_payment', {
    p_intent: intentId,
    p_reference: reference,
    p_amount: payment.amount,
    p_currency: payment.currency ?? 'ZAR',
    p_raw: event,
  });
  if (error) return json({ error: error.message }, 409);
  return json({ applied: data === true });
});
