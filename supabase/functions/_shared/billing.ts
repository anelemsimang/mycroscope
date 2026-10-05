// Pricing and signature helpers shared by the Paystack functions. Web Crypto only, so it runs in Deno and Node.

export const MAX_SEATS = 10000;
export const ALLOWED_MONTHS = [1, 12] as const;

export interface Quote {
  seats: number;
  months: number;
  per_seat_cents: number;
  discount_percent: number;
  amount_cents: number;
}

/** Prepaid price: seats x months x per-seat price, with an optional discount for 12 months. */
export function quote(seats: number, months: number, perSeatCents: number, annualDiscountPercent = 0): Quote {
  if (!Number.isInteger(seats) || seats < 1 || seats > MAX_SEATS) throw new RangeError(`Seats must be 1 to ${MAX_SEATS}`);
  if (!(ALLOWED_MONTHS as readonly number[]).includes(months)) throw new RangeError('Months must be 1 or 12');
  if (!Number.isInteger(perSeatCents) || perSeatCents < 1) throw new RangeError('Invalid per-seat price');
  const discount = months === 12 ? Math.min(Math.max(annualDiscountPercent, 0), 50) : 0;
  const gross = seats * months * perSeatCents;
  return {
    seats, months, per_seat_cents: perSeatCents, discount_percent: discount,
    amount_cents: Math.round(gross * (100 - discount) / 100),
  };
}

const encoder = new TextEncoder();

async function hmacHex(hash: 'SHA-256' | 'SHA-512', key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(data)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Paystack signs the raw webhook body with HMAC-SHA512 using the secret key (header x-paystack-signature). */
export async function verifyPaystackSignature(secretKey: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  return timingSafeEqual(await hmacHex('SHA-512', secretKey, rawBody), header.trim().toLowerCase());
}

export interface CheckoutTerms {
  reference: string;
  organization_id: string;
  seats: number;
  months: number;
  amount_cents: number;
  currency: string;
}

const termsString = (t: CheckoutTerms) =>
  `mycroscope-checkout:${t.reference}|${t.organization_id}|${t.seats}|${t.months}|${t.amount_cents}|${t.currency}`;

/**
 * Anyone holding the public key can start a Paystack transaction with made-up metadata, so the checkout function
 * signs the terms it priced and the webhook only applies payments whose terms carry a valid signature.
 */
export function signTerms(secretKey: string, terms: CheckoutTerms): Promise<string> {
  return hmacHex('SHA-256', secretKey, termsString(terms));
}

export async function verifyTerms(secretKey: string, terms: CheckoutTerms, sig: unknown): Promise<boolean> {
  return typeof sig === 'string' && timingSafeEqual(await signTerms(secretKey, terms), sig);
}

/** Reads the terms back from a verified Paystack transaction; null if anything is missing or malformed. */
export function termsFromTransaction(tx: { reference?: unknown; metadata?: unknown }): (CheckoutTerms & { sig: unknown }) | null {
  let meta = tx.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { return null; }
  }
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as Record<string, unknown>;
  const terms = {
    reference: tx.reference, organization_id: m.organization_id, seats: m.seats, months: m.months,
    amount_cents: m.amount_cents, currency: m.currency, sig: m.sig,
  };
  if (typeof terms.reference !== 'string' || typeof terms.organization_id !== 'string' || typeof terms.currency !== 'string'
      || !Number.isInteger(terms.seats) || !Number.isInteger(terms.months) || !Number.isInteger(terms.amount_cents)) {
    return null;
  }
  return terms as CheckoutTerms & { sig: unknown };
}

/** Only send the payer back to our own app (no open redirects through Paystack). */
export function safeReturnUrl(requested: unknown, appUrl: string | undefined): string | undefined {
  if (typeof requested !== 'string' || !requested) return appUrl ? `${appUrl.replace(/\/+$/, '')}/billing` : undefined;
  try {
    const url = new URL(requested);
    const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (url.protocol !== 'https:' && !local) return undefined;
    if (appUrl && url.origin !== new URL(appUrl).origin && !local) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
