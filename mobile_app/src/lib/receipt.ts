import type { PDFFont, PDFPage } from 'pdf-lib';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib/dist/pdf-lib.esm.js';

import { WORDMARK_PNG_BASE64 } from './wordmark.ts';

/** One paid invoice, as returned for the organisation owner. */
export interface ReceiptInvoice {
  number: string;
  issued_at: string;
  organization_name: string;
  plan_name: string;
  description: string;
  seats: number;
  net_cents: number;
  vat_cents: number;
  gross_cents: number;
  vat_rate: number;
  vat_enabled: boolean;
  business_name: string;
  business_vat_number: string | null;
  business_address: string;
  payment_reference?: string | null;
  customer_name?: string | null;
  customer_email?: string | null;
}

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;
const NAVY = rgb(0.118, 0.227, 0.541);
const INK = rgb(0.122, 0.161, 0.216);
const MUTED = rgb(0.42, 0.447, 0.502);
const LINE = rgb(0.886, 0.91, 0.941);
const PAPER = rgb(0.973, 0.98, 0.988);
const PAID = rgb(0.02, 0.471, 0.341);

function decodeBase64(value: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = value.replace(/\s/g, '');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((clean.length * 3) / 4 - pad);
  let written = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = alphabet.indexOf(clean[i]);
    const b = alphabet.indexOf(clean[i + 1]);
    const c = alphabet.indexOf(clean[i + 2]);
    const d = alphabet.indexOf(clean[i + 3]);
    const bits = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
    out[written++] = (bits >> 16) & 255;
    if (clean[i + 2] !== '=') out[written++] = (bits >> 8) & 255;
    if (clean[i + 3] !== '=') out[written++] = bits & 255;
  }
  return out;
}

function printable(font: PDFFont, value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\u00a0/g, ' ');
  let out = '';
  for (const ch of text) {
    try {
      font.widthOfTextAtSize(ch, 12);
      out += ch;
    } catch {
      out += '?';
    }
  }
  return out;
}

function rands(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}R ${whole}.${String(abs % 100).padStart(2, '0')}`;
}

function issuedOn(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'long', year: 'numeric',
  }).format(when);
}

function vatLabel(rate: number): string {
  const percent = Math.round(Number(rate) * 1000) / 10;
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

function party(page: PDFPage, font: PDFFont, bold: PDFFont, x: number, top: number, width: number, heading: string, lines: string[]): number {
  page.drawText(heading.toUpperCase(), { x, y: top, size: 8, font: bold, color: NAVY });
  let y = top - 16;
  for (const raw of lines) {
    const text = printable(font, raw);
    if (!text) continue;
    for (const line of wrap(font, text, 11, width)) {
      page.drawText(line, { x, y, size: 11, font, color: INK });
      y -= 15;
    }
  }
  return y;
}

function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const words = printable(font, text).split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** A one-page receipt the customer can keep. */
export async function buildReceiptPdf(invoice: ReceiptInvoice): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = await doc.embedPng(decodeBase64(WORDMARK_PNG_BASE64));
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const width = PAGE_W - MARGIN * 2;
  doc.setTitle(`Mycroscope receipt ${invoice.number}`);
  doc.setAuthor(invoice.business_name || 'Mycroscope');

  page.drawRectangle({ x: 0, y: PAGE_H - 8, width: PAGE_W, height: 8, color: NAVY });

  const logoH = 28;
  page.drawImage(logo, {
    x: MARGIN, y: PAGE_H - 58, width: logoH * (logo.width / logo.height), height: logoH,
  });

  const title = invoice.vat_enabled ? 'Tax invoice' : 'Receipt';
  const titleWidth = bold.widthOfTextAtSize(title, 18);
  page.drawText(title, { x: PAGE_W - MARGIN - titleWidth, y: PAGE_H - 46, size: 18, font: bold, color: NAVY });
  const paid = 'PAID';
  const paidWidth = bold.widthOfTextAtSize(paid, 9);
  page.drawText(paid, { x: PAGE_W - MARGIN - paidWidth, y: PAGE_H - 62, size: 9, font: bold, color: PAID });

  page.drawLine({
    start: { x: MARGIN, y: PAGE_H - 78 },
    end: { x: PAGE_W - MARGIN, y: PAGE_H - 78 },
    thickness: 1,
    color: NAVY,
  });

  let y = PAGE_H - 104;
  const column = (width - 24) / 2;
  y = party(page, font, bold, MARGIN, y, column, 'From', [
    invoice.business_name || 'Mycroscope',
    invoice.business_address,
    invoice.vat_enabled ? `VAT ${invoice.business_vat_number || 'number not on file'}` : '',
    'info@mycroscope.co.za',
    'mycroscope.co.za',
  ]);
  const billTo = party(page, font, bold, MARGIN + column + 24, PAGE_H - 104, column, 'Bill to', [
    invoice.organization_name,
    invoice.customer_name ?? '',
    invoice.customer_email ?? '',
  ]);
  y = Math.min(y, billTo);

  y -= 18;
  page.drawRectangle({ x: MARGIN, y: y - 78, width, height: 78, color: PAPER });
  const facts: [string, string][] = [
    ['Receipt number', invoice.number],
    ['Date', issuedOn(invoice.issued_at)],
    ['Payment reference', invoice.payment_reference || 'Confirmed by Yoco'],
    ['Paid with', 'Yoco'],
  ];
  facts.forEach((fact, index) => {
    const columnX = MARGIN + 14 + (index % 2) * (width / 2);
    const rowY = y - 22 - Math.floor(index / 2) * 34;
    page.drawText(fact[0], { x: columnX, y: rowY, size: 8, font, color: MUTED });
    const value = wrap(font, fact[1], 10, width / 2 - 28)[0] ?? '';
    page.drawText(value, { x: columnX, y: rowY - 14, size: 10, font: bold, color: INK });
  });
  y -= 100;

  page.drawRectangle({ x: MARGIN, y: y - 22, width, height: 22, color: NAVY });
  page.drawText('Description', { x: MARGIN + 10, y: y - 15, size: 9, font: bold, color: rgb(1, 1, 1) });
  page.drawText('Amount', { x: PAGE_W - MARGIN - 70, y: y - 15, size: 9, font: bold, color: rgb(1, 1, 1) });
  y -= 22;

  const description = wrap(font, invoice.description || invoice.plan_name, 11, width - 130);
  const rowHeight = Math.max(36, 16 + description.length * 14);
  description.forEach((line, index) => {
    page.drawText(line, { x: MARGIN + 10, y: y - 18 - index * 14, size: 11, font, color: INK });
  });
  const seatLine = `${invoice.seats} ${invoice.seats === 1 ? 'seat' : 'seats'} · ${invoice.plan_name} · 1 year`;
  page.drawText(printable(font, seatLine), {
    x: MARGIN + 10, y: y - 18 - description.length * 14 - 2, size: 9, font, color: MUTED,
  });
  const net = rands(invoice.net_cents);
  page.drawText(net, {
    x: PAGE_W - MARGIN - 10 - bold.widthOfTextAtSize(net, 11),
    y: y - 20,
    size: 11,
    font: bold,
    color: INK,
  });
  y -= rowHeight + 8;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.6, color: LINE });

  y -= 28;
  const totals: [string, string][] = [['Net', rands(invoice.net_cents)]];
  if (invoice.vat_enabled) totals.push([`VAT ${vatLabel(invoice.vat_rate)}`, rands(invoice.vat_cents)]);
  totals.push(['Total paid', rands(invoice.gross_cents)]);
  for (const [label, amount] of totals) {
    const last = label === 'Total paid';
    const face = last ? bold : font;
    const size = last ? 13 : 11;
    page.drawText(label, { x: PAGE_W - MARGIN - 180, y, size, font: face, color: last ? NAVY : MUTED });
    page.drawText(amount, {
      x: PAGE_W - MARGIN - face.widthOfTextAtSize(amount, size),
      y,
      size,
      font: face,
      color: last ? NAVY : INK,
    });
    y -= last ? 22 : 18;
  }

  y -= 16;
  const notes = [
    'Paid in full. This confirms the payment Mycroscope received. The card number is not stored.',
    'Amounts are in South African rand. The date is South African time.',
    'Keep this document for your records.',
  ];
  for (const note of notes) {
    for (const line of wrap(font, note, 9, width)) {
      page.drawText(line, { x: MARGIN, y, size: 9, font, color: MUTED });
      y -= 13;
    }
    y -= 3;
  }

  page.drawText('Mycroscope', { x: MARGIN, y: 36, size: 9, font: bold, color: NAVY });
  page.drawText(printable(font, invoice.number), {
    x: PAGE_W - MARGIN - font.widthOfTextAtSize(invoice.number, 9),
    y: 36,
    size: 9,
    font,
    color: MUTED,
  });

  return doc.save();
}
