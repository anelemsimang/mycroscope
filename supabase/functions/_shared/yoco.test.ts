// Node runs this directly: node --test --experimental-strip-types supabase/functions/_shared/yoco.test.ts
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { featuresFor, historyWindow, planIncludes, seatDecision } from './entitlements.ts';
import { enforceMinimumCharge, splitVat, upgradeChargeCents, verifyYocoSignature } from './yoco.ts';

const SECRET_BYTES = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const SECRET = `whsec_${Buffer.from(SECRET_BYTES).toString('base64')}`;

function sign(id: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', SECRET_BYTES).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${mac}`;
}

test('a lower plan cannot use a higher plan feature', () => {
  assert.deepEqual(featuresFor('free'), []);
  assert.equal(planIncludes('free', 'time_tracking'), false);
  assert.equal(planIncludes('work_activity', 'coaching'), false);
  assert.equal(planIncludes('work_activity', 'time_tracking'), true);
  assert.equal(planIncludes('workforce', 'channels'), true);
  assert.equal(planIncludes('workforce', 'api'), false);
  assert.equal(planIncludes('productivity', 'api'), true);
  assert.equal(planIncludes('productivity', 'real_time_visibility'), true);
});

test('a downgrade pauses extra people and never drops them from the list', () => {
  const people = [
    { id: 'owner', role: 'owner', lastSeenAt: 1, createdAt: 1 },
    { id: 'recent', role: 'employee', lastSeenAt: 50, createdAt: 2 },
    { id: 'quiet', role: 'employee', lastSeenAt: 10, createdAt: 3 },
    { id: 'newest', role: 'employee', lastSeenAt: null, createdAt: 40 },
  ];
  const decision = seatDecision(people, 3);
  assert.deepEqual(decision.active, ['owner', 'recent', 'newest']);
  assert.deepEqual(decision.paused, ['quiet']);
  assert.equal(decision.active.length + decision.paused.length, people.length);
  assert.deepEqual(seatDecision(people, null).paused, []);
});

test('hidden history is kept until the longest plan, unless the company chose a shorter limit', () => {
  const day = 86_400_000;
  const now = Date.UTC(2026, 9, 15);
  const kept = historyWindow({
    planCutoffMs: now - 30 * day,
    ownerCutoffMs: now - 90 * day,
    longestCutoffMs: now - 365 * day,
    keepDowngraded: true,
  });
  assert.equal(kept.visibleFrom, now - 30 * day);
  assert.equal(kept.purgeBefore, now - 90 * day);
  assert.ok(kept.purgeBefore < kept.visibleFrom);
  const wiped = historyWindow({
    planCutoffMs: now - 30 * day,
    ownerCutoffMs: now - 90 * day,
    longestCutoffMs: now - 365 * day,
    keepDowngraded: false,
  });
  assert.equal(wiped.purgeBefore, wiped.visibleFrom);
});

test('upgrade charges the difference for the days left, and never less than R2', () => {
  assert.equal(upgradeChargeCents({
    oldPerSeat: 17250, newPerSeat: 26450, seats: 2, cycleSeconds: 30, leftSeconds: 10,
  }), 6133);
  assert.equal(upgradeChargeCents({
    oldPerSeat: 10000, newPerSeat: 10100, seats: 1, cycleSeconds: 30, leftSeconds: 10,
  }), 200);
  assert.equal(enforceMinimumCharge(0), 0);
  assert.equal(upgradeChargeCents({
    oldPerSeat: 0, newPerSeat: 17250, seats: 3, cycleSeconds: 0, leftSeconds: 0,
  }), 51750);
});

test('VAT splits so net plus VAT equals the amount Yoco charges', () => {
  const split = splitVat(17250, 0.15, true);
  assert.equal(split.net, 15000);
  assert.equal(split.vat, 2250);
  assert.equal(split.net + split.vat, split.gross);
  assert.deepEqual(splitVat(17250, 0.15, false), { net: 17250, vat: 0, gross: 17250 });
});

test('Yoco webhook signatures', async () => {
  const body = '{"type":"payment.succeeded"}';
  const now = 1_700_000_000_000;
  const timestamp = String(Math.floor(now / 1000));
  const headers = new Headers({
    'webhook-id': 'msg_1',
    'webhook-timestamp': timestamp,
    'webhook-signature': sign('msg_1', timestamp, body),
  });
  assert.equal(await verifyYocoSignature(SECRET, body, headers, now), true);
  assert.equal(await verifyYocoSignature(SECRET, body + ' ', headers, now), false);
  assert.equal(await verifyYocoSignature('whsec_' + Buffer.from('nope').toString('base64'), body, headers, now), false);
  assert.equal(await verifyYocoSignature(SECRET, body, headers, now + 10 * 60 * 1000), false);
});
