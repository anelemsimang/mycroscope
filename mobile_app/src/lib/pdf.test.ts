import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PDFDocument } from 'pdf-lib';

import { buildPdf } from './pdf.ts';

const sections = [
  'Week in review', 'Workload', 'Where time went', 'Capacity', 'How the period changed',
].map((heading) => ({
  heading,
  paragraphs: [
    `${heading} for Dispatch, from 5 Oct 2026 to 11 Oct 2026. The main point is workload. Sipho Dlamini was over the goal.`,
    'Productive computer time came to 31 hours across 5 person-days.',
  ],
}));

test('a written report is a real PDF covering every section', async () => {
  const bytes = await buildPdf({
    kicker: 'Northwind',
    title: 'Written report',
    subtitle: 'Dispatch · 5 Oct 2026 to 11 Oct 2026',
    intro: 'This report is written from stored figures.',
    charts: [{
      title: 'Productive hours',
      unit: 'h',
      points: [
        { label: '6 Oct', value: 4, color: '#059669' },
        { label: '7 Oct', value: 6.5, color: '#059669' },
        { label: '8 Oct', value: 3, color: '#dc2626' },
      ],
    }],
    sections,
    notice: 'Contains personal information. Handle it under POPIA.',
  });
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), '%PDF-');
  assert.match(Buffer.from(bytes).toString('latin1'), /\/Subtype \/Image/);
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 2);
});

test('a long written report continues on the next page', async () => {
  const bytes = await buildPdf({
    title: 'Written report',
    sections: sections.map((section) => ({
      heading: section.heading,
      paragraphs: Array.from({ length: 8 }, (_, i) => `${section.paragraphs[0]} Paragraph ${i}.`),
    })),
  });
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 2);
});

test('an activity report is a real PDF with a table', async () => {
  const bytes = await buildPdf({
    kicker: 'Northwind',
    title: 'Activity report',
    subtitle: 'Team activity · This week',
    intro: 'Total: 40h active.',
    table: {
      headers: ['Employee', 'Active', 'Idle'],
      rows: [
        ['Sipho Dlamini', '30h', '2h'],
        ['Mary Nkosi', '10h', '1h'],
      ],
      numericFrom: 1,
    },
    notice: 'Contains personal information. Handle it under POPIA.',
  });
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), '%PDF-');
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
});
