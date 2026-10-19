import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PDFDocument } from 'pdf-lib';

import { buildReceiptPdf } from './receipt.ts';

test('a payment receipt is a one-page PDF with the Mycroscope mark', async () => {
  const bytes = await buildReceiptPdf({
    number: 'INV-001001',
    issued_at: '2026-10-19T16:30:00Z',
    organization_name: 'Northwind',
    plan_name: 'Work activity',
    description: 'Work activity, 1 seat, one year, with VAT',
    seats: 1,
    net_cents: 120000,
    vat_cents: 18000,
    gross_cents: 138000,
    vat_rate: 0.15,
    vat_enabled: true,
    business_name: 'Mycroscope',
    business_vat_number: '4123456789',
    business_address: 'Cape Town, South Africa',
    payment_reference: 'p_test_payment',
    customer_name: 'Northwind Owner',
    customer_email: 'owner@northwind.example',
  });
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), '%PDF-');
  assert.match(Buffer.from(bytes).toString('latin1'), /\/Subtype \/Image/);
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
  assert.equal(doc.getTitle(), 'Mycroscope receipt INV-001001');
});
