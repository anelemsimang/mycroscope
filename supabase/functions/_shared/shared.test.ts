// Node runs this directly: node --test --experimental-strip-types supabase/functions/_shared/shared.test.ts
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import {
  quote, safeReturnUrl, signTerms, termsFromTransaction, verifyPaystackSignature, verifyTerms,
} from './billing.ts';
import { renderAlert, renderDigest } from './email.ts';
import {
  type ChannelAlert, deliver, describeAlert, formatBytes, signWebhook, slackMessage, teamsMessage, webhookBody,
} from './alerts.ts';
import { createServer } from 'node:http';

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
  assert.equal(alert.subject, 'Mycroscope: 1 new alert at Acme');
  assert.match(alert.text, /not proof of wrongdoing/);
  assert.match(alert.html, /https:\/\/app\.mycroscope\.co\.za\/alerts/);
});

const ALERTS: ChannelAlert[] = [
  { employee_id: 'e1', employee_name: 'Sipho <Worker>', occurred_at: '2026-10-14T08:05:00Z', kind: 'policy_violation',
    severity: 'high', details: { rule: 'Betting', matched: ['sports.bet.co.za'], seconds: 600 } },
  { employee_id: 'e1', employee_name: 'Sipho <Worker>', occurred_at: '2026-10-14T09:00:00Z', kind: 'files_copied',
    severity: 'medium', details: { destination: 'removable', label: 'KINGSTON', files: 3, bytes: 5 * 1024 * 1024 } },
];

test('alert descriptions for channels never need file names', () => {
  assert.equal(describeAlert(ALERTS[0]), 'Betting: sports.bet.co.za for 10 min.');
  assert.equal(describeAlert(ALERTS[1]), '3 files (5.0 MB) copied to a USB drive or external disk ("KINGSTON").');
  assert.equal(describeAlert({ kind: 'device_connected', details: { destination: 'phone', label: 'Galaxy' } }),
    'A phone ("Galaxy") was connected to the PC.');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(20 * 1024 ** 3), '20 GB');
});

test('Slack and Teams messages', () => {
  const slack = slackMessage('Acme', ALERTS, 'Africa/Johannesburg', 'https://app.example');
  assert.match(slack.text, /^\*Mycroscope: 2 new alerts at Acme\*/);
  assert.match(slack.text, /Sipho &lt;Worker&gt;/, 'Slack control characters are escaped');
  assert.match(slack.text, /11:00/, 'times are in the company time zone');
  assert.ok(slack.text.indexOf('Files copied') < slack.text.indexOf('Alert rule'), 'newest first');
  assert.match(slack.text, /<https:\/\/app\.example\/alerts\|Open Mycroscope>/);
  const many = slackMessage('Acme', Array.from({ length: 25 }, () => ALERTS[0]), 'UTC', '');
  assert.match(many.text, /…and 5 more in the app\./);

  const teams = teamsMessage('Acme', ALERTS, 'UTC', 'https://app.example') as {
    attachments: { contentType: string; content: { body: { text: string }[]; actions: { url: string }[] } }[];
  };
  assert.equal(teams.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(teams.attachments[0].content.body.length, 3);
  assert.equal(teams.attachments[0].content.actions[0].url, 'https://app.example/alerts');
});

test('webhooks are signed over the timestamp and body', async () => {
  const body = webhookBody('Acme', ALERTS, '2026-10-14T10:00:00Z');
  const parsed = JSON.parse(body);
  assert.equal(parsed.event, 'alerts');
  assert.equal(parsed.alerts[0].title, 'Alert rule');
  const sig = await signWebhook('whsec_test', body, 1760436000);
  const expected = createHmac('sha256', 'whsec_test').update(`1760436000.${body}`).digest('hex');
  assert.equal(sig, `t=1760436000,v1=${expected}`);
});

test('deliver posts to the channel and reports failures', async () => {
  const received: { headers: Record<string, unknown>; body: string }[] = [];
  let status = 200;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(status).end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  const channel = { kind: 'webhook' as const, url: `http://127.0.0.1:${port}/hook`, signing_secret: 'whsec_x',
    organization_name: 'Acme', timezone: 'UTC' };
  try {
    assert.equal(await deliver(channel, ALERTS, ''), null);
    const [t, v1] = String(received[0].headers['x-mycroscope-signature']).split(',');
    const ts = t.slice(2);
    assert.equal(v1.slice(3), createHmac('sha256', 'whsec_x').update(`${ts}.${received[0].body}`).digest('hex'));
    assert.equal(JSON.parse(received[0].body).alerts.length, 2);

    assert.equal(await deliver({ ...channel, kind: 'slack' }, [], '', true), null);
    assert.match(JSON.parse(received[1].body).text, /test message/);

    status = 404;
    assert.equal(await deliver(channel, ALERTS, ''), 'HTTP 404');
    status = 302;
    assert.equal(await deliver(channel, ALERTS, ''), 'HTTP 302', 'redirects are not followed');
    assert.equal(await deliver({ ...channel, signing_secret: null }, ALERTS, ''), 'This webhook has no signing secret');
  } finally {
    server.close();
  }
  assert.equal(await deliver({ ...channel, url: `http://127.0.0.1:${port}/hook` }, ALERTS, ''), 'Could not connect');
});
