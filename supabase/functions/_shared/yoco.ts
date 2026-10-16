// Yoco Checkout helpers. Web Crypto only, so the same file runs in Deno and Node.
// The charge amount is decided in SQL. These helpers only check the webhook and the price rules.

import { timingSafeEqual } from './billing.ts';

const encoder = new TextEncoder();

/** Rejects anything under the Yoco minimum (R2.00) and leaves a zero charge as zero. */
export function enforceMinimumCharge(cents: number, minChargeCents = 200): number {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError('Amount must be a whole number of cents');
  if (cents === 0) return 0;
  if (!Number.isInteger(minChargeCents) || minChargeCents < 200) throw new RangeError('The minimum charge is R2.00');
  return cents < minChargeCents ? minChargeCents : cents;
}

/**
 * Mid-cycle upgrade: (new price − old price) × people × days left ÷ days in the period.
 * A new month, or a change after the period has ended, is the full new price × people.
 */
export function upgradeChargeCents(input: {
  oldPerSeat: number;
  newPerSeat: number;
  seats: number;
  cycleSeconds: number;
  leftSeconds: number;
  minChargeCents?: number;
}): number {
  const min = input.minChargeCents ?? 200;
  const full = input.newPerSeat * input.seats;
  if (input.cycleSeconds <= 0 || input.leftSeconds <= 0) return enforceMinimumCharge(full, min);
  const raw = Math.round((input.leftSeconds / input.cycleSeconds) * (input.newPerSeat - input.oldPerSeat) * input.seats);
  return enforceMinimumCharge(Math.max(0, raw), min);
}

/** Splits a gross charge back into net and VAT so the invoice adds up. */
export function splitVat(grossCents: number, vatRate: number, vatEnabled: boolean): { net: number; vat: number; gross: number } {
  if (!vatEnabled || vatRate <= 0) return { net: grossCents, vat: 0, gross: grossCents };
  const net = Math.round(grossCents / (1 + vatRate));
  return { net, vat: grossCents - net, gross: grossCents };
}

function decodeSecret(secret: string): Uint8Array {
  const body = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Standard Webhooks, as used by Yoco.
 * Signed content is `${webhook-id}.${webhook-timestamp}.${raw body}`.
 * The secret is the part after whsec_, base64-decoded. The header is one or more `v1,<base64>` values.
 * Timestamps more than 3 minutes off are rejected.
 */
export async function verifyYocoSignature(
  secret: string, rawBody: string, headers: Headers, nowMs = Date.now(),
): Promise<boolean> {
  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signature = headers.get('webhook-signature');
  if (!id || !timestamp || !signature || !secret) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  if (Math.abs(nowMs / 1000 - seconds) > 180) return false;
  let keyBytes: Uint8Array;
  try {
    keyBytes = decodeSecret(secret);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, encoder.encode(`${id}.${timestamp}.${rawBody}`),
  ));
  const expected = bytesToBase64(mac);
  for (const part of signature.split(' ')) {
    const value = part.startsWith('v1,') ? part.slice(3) : '';
    if (value && timingSafeEqual(value, expected)) return true;
  }
  return false;
}
