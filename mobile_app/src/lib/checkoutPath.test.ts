import assert from 'node:assert/strict';
import test from 'node:test';

import { safeCheckoutPath } from './checkoutPath.ts';

test('checkout return stays on the checkout page', () => {
  assert.equal(safeCheckoutPath('/checkout?plan=work_activity'), '/checkout?plan=work_activity');
  assert.equal(safeCheckoutPath('/checkout'), '/checkout');
  assert.equal(safeCheckoutPath('https://mycroscope.netlify.app/checkout?plan=productivity'), '/checkout?plan=productivity');
  assert.equal(safeCheckoutPath('/checkout?plan=work_activity&seats=4'), '/checkout?plan=work_activity&seats=4');
});

test('checkout return rejects other destinations', () => {
  assert.equal(safeCheckoutPath('https://evil.example/checkout'), null);
  assert.equal(safeCheckoutPath('//evil.example/checkout'), null);
  assert.equal(safeCheckoutPath('/checkout?plan=work_activity&next=https://evil.example'), null);
  assert.equal(safeCheckoutPath('/overview'), null);
  assert.equal(safeCheckoutPath('/checkout?plan=nope'), null);
  assert.equal(safeCheckoutPath('/checkout?plan=work_activity&seats=0'), null);
  assert.equal(safeCheckoutPath('/checkout?seats=2'), null);
});
