// Node runs this directly: node --test --experimental-strip-types supabase/functions/_shared/shared.test.ts
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import {
  quote, safeReturnUrl, signTerms, termsFromTransaction, verifyPaystackSignature, verifyTerms,
} from './billing.ts';
import { renderAlert, renderDigest } from './email.ts';

const SECRET = 'sk_test_example';

test('prepaid quotes', () => {
  assert.equal(quote(30, 1, 9900).amount_cents, 297000);
  assert.equal(quote(10, 12, 9900, 15).amount_cents, Math.round(10 * 12 * 9900 * 0.85));
  assert.equal(quote(10, 1, 9900, 15).discount_percent, 0, 'the discount only applies to 12 months');
  assert.equal(quote(1, 12, 100, 90).discount_percent, 50, 'discounts are capped');
  assert.throws(() => quote(0, 1, 9900), RangeError);
  assert.throws(() => quote(1.5, 1, 9900), RangeError);
  assert.throws(() => quote(5, 3, 9900), RangeError);
  assert.throws(() => quote(5, 1, 0), RangeError);
});

test('Paystack webhook signatures', async () => {
  const body = '{"event":"charge.success","data":{"reference":"myc_1"}}';
  const good = createHmac('sha512', SECRET).update(body).digest('hex');
  assert.equal(await verifyPaystackSignature(SECRET, body, good), true);
  assert.equal(await verifyPaystackSignature(SECRET, body + ' ', good), false);
  assert.equal(await verifyPaystackSignature('sk_test_other', body, good), false);
  assert.equal(await verifyPaystackSignature(SECRET, body, null), false);
});

test('only terms signed by checkout are accepted', async () => {
  const terms = { reference: 'myc_abc', organization_id: 'org-1', seats: 30, months: 1, amount_cents: 297000, currency: 'ZAR' };
  const sig = await signTerms(SECRET, terms);
  const tx = { reference: 'myc_abc', metadata: JSON.stringify({ ...terms, sig }) };
  const read = termsFromTransaction(tx)!;
  assert.equal(await verifyTerms(SECRET, read, read.sig), true);
  assert.equal(await verifyTerms(SECRET, { ...read, seats: 3000 }, read.sig), false, 'seats cannot be changed');
  assert.equal(await verifyTerms(SECRET, { ...read, amount_cents: 1 }, read.sig), false, 'the amount cannot be changed');
  assert.equal(await verifyTerms(SECRET, { ...read, reference: 'myc_other' }, read.sig), false, 'a signature cannot be reused');
  assert.equal(await verifyTerms(SECRET, read, undefined), false);
  assert.equal(termsFromTransaction({ reference: 'x', metadata: '{"seats":"30"}' }), null);
  assert.equal(termsFromTransaction({ reference: 'x', metadata: 'not json' }), null);
});

test('payment return addresses stay on our app', () => {
  const app = 'https://app.mycroscope.co.za';
  assert.equal(safeReturnUrl('https://app.mycroscope.co.za/billing', app), 'https://app.mycroscope.co.za/billing');
  assert.equal(safeReturnUrl('https://evil.example/billing', app), undefined);
  assert.equal(safeReturnUrl('javascript:alert(1)', app), undefined);
  assert.equal(safeReturnUrl('http://app.mycroscope.co.za/billing', app), undefined);
  assert.equal(safeReturnUrl('http://localhost:8081/billing', app), 'http://localhost:8081/billing');
  assert.equal(safeReturnUrl('', app), 'https://app.mycroscope.co.za/billing');
  assert.equal(safeReturnUrl('', undefined), undefined);
});

test('emails contain counts only and escape organisation names', () => {
  const digest = renderDigest({
    recipient_email: 'owner@acme.co.za', recipient_name: 'Thandi Owner', role: 'owner',
    organization_name: 'Acme <script>\r\nBcc: x@evil', week_start: '2026-09-28', week_end: '2026-10-04',
    people: 12, activated: 10, active_seconds: 12 * 3600 * 30, idle_seconds: 3600 * 20, person_days: 55,
    integrity_alerts: 3, high_alerts: 1, open_requests: 1,
  }, 'https://app.mycroscope.co.za');
  assert.ok(!digest.subject.includes('\n') && !digest.subject.includes('\r'));
  assert.ok(!digest.html.includes('<script>'));
  assert.match(digest.text, /Hi Thandi/);
  assert.match(digest.text, /Integrity alerts: 3 \(1 high\)/);
  assert.match(digest.text, /2 people have not activated/);
  assert.match(digest.text, /privacy requests/);

  const alert = renderAlert({
    recipient_email: 'mary@acme.co.za', recipient_name: 'Mary', organization_name: 'Acme', alerts: 1, high_alerts: 0,
  }, 'https://app.mycroscope.co.za');
  assert.equal(alert.subject, 'Mycroscope: 1 new integrity alert at Acme');
  assert.match(alert.text, /not proof of wrongdoing/);
  assert.match(alert.html, /https:\/\/app\.mycroscope\.co\.za\/alerts/);
});
