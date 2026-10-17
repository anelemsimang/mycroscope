import type { PDFFont, PDFImage, PDFPage } from 'pdf-lib';
// The package entry pulls in tslib in a way Expo Web cannot load. This build already includes it.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib/dist/pdf-lib.esm.js';

import { WORDMARK_PNG_BASE64 } from './wordmark.ts';

/** A written report or a table report, drawn as a document rather than a picture of the screen. */
export interface PdfReport {
  title: string;
  kicker?: string;
  subtitle?: string;
  intro?: string;
  charts?: { title: string; unit?: string; points: { label: string; value: number; color?: string }[] }[];
  sections?: { heading: string; paragraphs: string[] }[];
  table?: { headers: string[]; rows: string[][]; numericFrom?: number };
  notes?: string[];
  notice?: string;
}

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 54;
const BOTTOM = 58;
const NAVY = rgb(0.118, 0.227, 0.541);
const INK = rgb(0.122, 0.161, 0.216);
const MUTED = rgb(0.42, 0.447, 0.502);
const LINE = rgb(0.898, 0.906, 0.922);
const HEAD = rgb(0.953, 0.957, 0.965);

function clean(font: PDFFont, value: string): string {
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

function drawWordmark(page: PDFPage, logo: PDFImage, x: number, y: number, height: number) {
  page.drawImage(logo, { x, y, width: height * (logo.width / logo.height), height });
}

function trimNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function hexColor(color: string | undefined) {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(color ?? '');
  if (!match) return NAVY;
  const value = Number.parseInt(match[1], 16);
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const words = clean(font, text).split(' ').filter(Boolean);
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

export async function buildPdf(report: PdfReport): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = await doc.embedPng(decodeBase64(WORDMARK_PNG_BASE64));
  const pages: PDFPage[] = [];
  let page = doc.addPage([PAGE_W, PAGE_H]);
  pages.push(page);
  let y = PAGE_H - MARGIN;
  const width = PAGE_W - MARGIN * 2;

  function newPage() {
    page = doc.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    y = PAGE_H - MARGIN;
  }

  function gap(amount: number) {
    y -= amount;
  }

  function ensure(height: number) {
    if (y - height < BOTTOM) newPage();
  }

  function paragraph(text: string, size: number, face: PDFFont, color: typeof INK, after = 8) {
    const lines = wrap(face, text, size, width);
    const leading = size * 1.45;
    for (const line of lines) {
      ensure(leading);
      page.drawText(line, { x: MARGIN, y: y - size, size, font: face, color });
      y -= leading;
    }
    gap(after);
  }

  drawWordmark(page, logo, MARGIN, y - 22, 22);
  y -= 34;

  if (report.kicker) paragraph(report.kicker, 10, bold, NAVY, 2);
  paragraph(report.title, 20, bold, NAVY, 4);
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_W - MARGIN, y },
    thickness: 1,
    color: NAVY,
  });
  gap(14);
  if (report.subtitle) paragraph(report.subtitle, 11, font, MUTED, 10);
  if (report.intro) paragraph(report.intro, 11, font, INK, 14);

  for (const chart of report.charts ?? []) {
    if (chart.points.length > 0) drawChart(chart);
  }

  for (const [index, section] of (report.sections ?? []).entries()) {
    ensure(64);
    paragraph(`${index + 1}. ${section.heading}`, 14, bold, NAVY, 6);
    const paragraphs = section.paragraphs.filter((part) => part.trim());
    if (paragraphs.length === 0) paragraph('Nothing was recorded for this section.', 11, font, INK, 12);
    for (const part of paragraphs) paragraph(part, 11, font, INK, 8);
    gap(8);
  }

  if (report.table && report.table.headers.length > 0) {
    drawTable(report.table);
    gap(12);
  }

  for (const note of report.notes ?? []) paragraph(note, 9, font, MUTED, 4);
  if (report.notice) paragraph(report.notice, 9, font, MUTED, 0);

  pages.forEach((item, index) => {
    const label = `Page ${index + 1} of ${pages.length}`;
    drawWordmark(item, logo, MARGIN, 24, 14);
    const labelWidth = font.widthOfTextAtSize(label, 9);
    item.drawText(label, { x: PAGE_W - MARGIN - labelWidth, y: 32, size: 9, font, color: MUTED });
  });

  return doc.save();

  function drawChart(chart: NonNullable<PdfReport['charts']>[number]) {
    const plotH = 108;
    const labelH = 26;
    ensure(plotH + labelH + 40);
    paragraph(chart.title, 12, bold, NAVY, 2);
    if (y - plotH - labelH < BOTTOM) newPage();
    const count = chart.points.length;
    const max = Math.max(...chart.points.map((point) => point.value), 1);
    const slot = width / count;
    const barW = Math.max(4, Math.min(22, slot - 3));
    const top = y;
    const baseline = top - plotH;
    const maxLabel = chart.unit ? `${trimNumber(max)}${chart.unit}` : trimNumber(max);
    page.drawText(clean(font, maxLabel), { x: MARGIN, y: top - 9, size: 8, font, color: MUTED });
    page.drawLine({
      start: { x: MARGIN, y: baseline },
      end: { x: MARGIN + width, y: baseline },
      thickness: 0.6,
      color: LINE,
    });
    chart.points.forEach((point, index) => {
      const height = Math.max(1.5, (point.value / max) * (plotH - 16));
      const x = MARGIN + index * slot + (slot - barW) / 2;
      page.drawRectangle({ x, y: baseline, width: barW, height, color: hexColor(point.color) });
      const size = count > 18 ? 6 : 7;
      const label = clean(font, point.label);
      const textWidth = font.widthOfTextAtSize(label, size);
      const left = Math.min(Math.max(MARGIN, x + barW / 2 - textWidth / 2), PAGE_W - MARGIN - textWidth);
      page.drawText(label, { x: left, y: baseline - 12, size, font, color: MUTED });
    });
    y = baseline - labelH;
  }

  function drawTable(table: NonNullable<PdfReport['table']>) {
    const cols = table.headers.length;
    const numericFrom = table.numericFrom ?? 1;
    const first = Math.min(190, width * 0.36);
    const rest = cols > 1 ? (width - first) / (cols - 1) : width;
    const widths = cols === 1 ? [width] : [first, ...Array(cols - 1).fill(rest)];
    const size = 9;
    const pad = 4;

    function paint(cells: string[], face: PDFFont, fill: boolean) {
      const lines = cells.map((cell, index) => wrap(face, cell, size, Math.max(12, widths[index] - pad * 2)));
      const height = Math.max(...lines.map((item) => item.length), 1) * (size * 1.35) + pad * 2;
      ensure(height);
      if (fill) {
        page.drawRectangle({ x: MARGIN, y: y - height, width, height, color: HEAD });
      }
      page.drawLine({
        start: { x: MARGIN, y: y - height },
        end: { x: MARGIN + width, y: y - height },
        thickness: 0.4,
        color: LINE,
      });
      let x = MARGIN;
      lines.forEach((item, index) => {
        item.forEach((line, lineIndex) => {
          const textWidth = face.widthOfTextAtSize(line, size);
          const numeric = index >= numericFrom;
          const left = numeric ? x + widths[index] - pad - textWidth : x + pad;
          page.drawText(line, {
            x: left,
            y: y - pad - size - lineIndex * size * 1.35,
            size,
            font: face,
            color: INK,
          });
        });
        x += widths[index];
      });
      y -= height;
    }

    paint(table.headers, bold, true);
    for (const row of table.rows) paint(row, font, false);
  }
}
