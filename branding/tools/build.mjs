// Generates the Mycroscope brand kit (SVG + PNG) into ../ . Run: npm install && npm run build
// Letters are converted to outlines (Poppins, SIL Open Font License), so the files need no fonts installed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Resvg } from '@resvg/resvg-js';
import opentype from 'opentype.js';
import pngToIco from 'png-to-ico';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '..');

function loadFont(weight) {
  const buf = fs.readFileSync(path.join(here, `node_modules/@fontsource/poppins/files/poppins-latin-${weight}-normal.woff`));
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
const FONT = { semibold: loadFont(600), regular: loadFont(400), medium: loadFont(500) };

// ---------------------------------------------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------------------------------------------
export const C = {
  navy: '#1E3A8A', navyDeep: '#172554', blue: '#1D4ED8', cyan: '#06B6D4', cyanDark: '#0891B2',
  ink: '#0F172A', slate: '#475569', mist: '#CBD5E1', white: '#FFFFFF', paper: '#F8FAFC',
};
const COLORWAYS = {
  color: { text: C.navy, mark: C.navy, glint: C.cyan, tagline: C.slate, dark: false },
  accent: { text: C.navy, mark: C.cyanDark, glint: C.navy, tagline: C.slate, dark: false },
  reverse: { text: C.white, mark: C.white, glint: C.cyan, tagline: C.mist, dark: true },
  black: { text: C.ink, mark: C.ink, glint: C.ink, tagline: C.ink, dark: false },
  white: { text: C.white, mark: C.white, glint: C.white, tagline: C.white, dark: true },
};
const CONCEPTS = ['classic', 'focus', 'solid', 'lens'];

// ---------------------------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------------------------
const F = 200; // working font size
const n = (v) => Math.round(v * 100) / 100;

function metrics(font) {
  const box = (ch) => font.getPath(ch, 0, 0, F).getBoundingBox();
  const o = box('o');
  const l = box('l');
  const p = box('p');
  return { o, oAdv: font.getAdvanceWidth('o', F), stroke: l.x2 - l.x1, desc: p.y2 };
}

/** The magnifying-glass "y": a lens the size of the font's "o" and a handle that forms the descender. */
/**
 * angleDeg: handle direction from vertical (down-left). Either endY (bottom of the handle, for the wordmark's
 * descender) or gripLen (for the standalone icon) sets its length. grip: handle thickness relative to the ring.
 */
function magnifier({ cx, cy, R, s, concept, ink, glint, angleDeg, endY = null, gripLen = null, grip = 1.2 }) {
  const angle = (angleDeg * Math.PI) / 180;
  const d = { x: -Math.sin(angle), y: Math.cos(angle) };
  const at = (k) => ({ x: cx + d.x * k, y: cy + d.y * k });
  const g = s * grip;
  const neck0 = at(R - s * 0.4);
  const neck1 = at(R + s * 0.55);
  const len = gripLen ?? (endY - g / 2 - neck1.y) / d.y;
  const end = { x: neck1.x + d.x * len, y: neck1.y + d.y * len };
  const r = R - s / 2;
  const parts = [];
  if (concept === 'solid') parts.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${glint}" fill-opacity="0.4"/>`);
  parts.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="none" stroke="${ink}" stroke-width="${n(s)}"/>`);
  parts.push(`<line x1="${n(neck0.x)}" y1="${n(neck0.y)}" x2="${n(neck1.x)}" y2="${n(neck1.y)}" stroke="${ink}" stroke-width="${n(s * 0.86)}"/>`);
  parts.push(`<line x1="${n(neck1.x)}" y1="${n(neck1.y)}" x2="${n(end.x)}" y2="${n(end.y)}" stroke="${ink}" stroke-width="${n(g)}" stroke-linecap="round"/>`);
  if (concept === 'focus') {
    parts.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(s * 0.62)}" fill="${glint}"/>`);
  } else {
    const rg = R - s - s * 0.62;
    const pt = (deg) => ({ x: cx + rg * Math.cos((deg * Math.PI) / 180), y: cy + rg * Math.sin((deg * Math.PI) / 180) });
    const a = pt(198);
    const b = pt(252);
    parts.push(`<path d="M${n(a.x)} ${n(a.y)} A${n(rg)} ${n(rg)} 0 0 1 ${n(b.x)} ${n(b.y)}" fill="none" stroke="${glint}" stroke-width="${n(s * 0.42)}" stroke-linecap="round"/>`);
  }
  const box = {
    x1: Math.min(cx - R, end.x - g / 2), y1: cy - R,
    x2: cx + R, y2: Math.max(cy + R, end.y + g / 2),
  };
  return { svg: parts.join(''), box };
}

let clipId = 0;

/**
 * The "y" built like the letter: the handle is the long right stroke running into the descender, the lens sits at
 * its top, and a short left arm meets the handle at the baseline.
 */
function yMagnifier({ x0, font, m, concept, ink, glint }) {
  const yBox = font.getPath('y', 0, 0, F).getBoundingBox();
  const xh = (font.tables.os2.sxHeight / font.unitsPerEm) * F;
  const s = m.stroke;
  const R = xh * 0.41;
  const ringS = s * 0.8;
  const c = { x: x0 + yBox.x2 - R * 0.9, y: -xh + R * 0.7 };
  const end = { x: x0 + yBox.x1 + s * 0.55, y: m.desc * 1.02 - s * 0.55 };
  const len = Math.hypot(end.x - c.x, end.y - c.y);
  const d = { x: (end.x - c.x) / len, y: (end.y - c.y) / len };
  const at = (k) => ({ x: c.x + d.x * k, y: c.y + d.y * k });
  const neck0 = at(R - ringS * 0.4);
  const neck1 = at(R + ringS * 0.45);
  const joinT = (-s * 0.15 - c.y) / d.y;
  const join = at(joinT);
  const armTop = { x: x0 + yBox.x1 + s * 0.15, y: -xh - s * 2 };
  const id = `yclip${clipId++}`;
  const r = R - ringS / 2;
  const parts = [`<clipPath id="${id}"><rect x="${n(x0 - F)}" y="${n(-xh)}" width="${n(F * 3)}" height="${n(F * 3)}"/></clipPath>`];
  parts.push(`<line x1="${n(armTop.x)}" y1="${n(armTop.y)}" x2="${n(join.x)}" y2="${n(join.y)}" stroke="${ink}" stroke-width="${n(s * 0.95)}" clip-path="url(#${id})"/>`);
  if (concept === 'solid') parts.push(`<circle cx="${n(c.x)}" cy="${n(c.y)}" r="${n(r)}" fill="${glint}" fill-opacity="0.4"/>`);
  parts.push(`<circle cx="${n(c.x)}" cy="${n(c.y)}" r="${n(r)}" fill="none" stroke="${ink}" stroke-width="${n(ringS)}"/>`);
  parts.push(`<line x1="${n(neck0.x)}" y1="${n(neck0.y)}" x2="${n(neck1.x)}" y2="${n(neck1.y)}" stroke="${ink}" stroke-width="${n(ringS * 0.85)}"/>`);
  parts.push(`<line x1="${n(neck1.x)}" y1="${n(neck1.y)}" x2="${n(end.x)}" y2="${n(end.y)}" stroke="${ink}" stroke-width="${n(s * 1.05)}" stroke-linecap="round"/>`);
  if (concept === 'focus') {
    parts.push(`<circle cx="${n(c.x)}" cy="${n(c.y)}" r="${n(ringS * 0.55)}" fill="${glint}"/>`);
  } else {
    const rg = r - ringS * 0.5 - ringS * 0.45;
    const pt = (deg) => ({ x: c.x + rg * Math.cos((deg * Math.PI) / 180), y: c.y + rg * Math.sin((deg * Math.PI) / 180) });
    const a = pt(195);
    const b = pt(258);
    parts.push(`<path d="M${n(a.x)} ${n(a.y)} A${n(rg)} ${n(rg)} 0 0 1 ${n(b.x)} ${n(b.y)}" fill="none" stroke="${glint}" stroke-width="${n(ringS * 0.42)}" stroke-linecap="round"/>`);
  }
  return {
    svg: parts.join(''),
    box: { x1: Math.min(x0 + yBox.x1, end.x - s), y1: c.y - R, x2: c.x + R, y2: end.y + s * 0.55 },
    advance: Math.max(font.getAdvanceWidth('y', F), c.x + R - x0 + s * 0.2),
  };
}

/** Wordmark with the magnifier as its "y". Baseline at y = 0. concept 'lens' uses the round-lens construction. */
function wordmark({ concept, colors, lowercase = false }) {
  const font = FONT.semibold;
  const m = metrics(font);
  const lead = lowercase ? 'm' : 'M';
  const leadPath = font.getPath(lead, 0, 0, F);
  const leadBox = leadPath.getBoundingBox();
  const gap = m.stroke * 0.42;
  const slot = font.getAdvanceWidth(lead, F) + gap;
  let mag;
  let restX;
  if (concept === 'lens') {
    const R = ((m.o.x2 - m.o.x1) / 2) * 0.94;
    mag = magnifier({
      cx: slot + (m.o.x1 + m.o.x2) / 2, cy: (m.o.y1 + m.o.y2) / 2, R, s: m.stroke * 1.02,
      concept: 'classic', ink: colors.mark, glint: colors.glint, angleDeg: 24, endY: m.desc * 1.12, grip: 1.12,
    });
    restX = slot + m.oAdv + gap * 0.55;
  } else {
    const x0 = slot + gap * 0.3;
    mag = yMagnifier({ x0, font, m, concept, ink: colors.mark, glint: colors.glint });
    restX = x0 + mag.advance + gap * 0.55;
  }
  const rest = font.getPath('croscope', restX, 0, F, { kerning: true });
  const restBox = rest.getBoundingBox();
  const svg = `<path d="${leadPath.toPathData(2)}" fill="${colors.text}"/>${mag.svg}<path d="${rest.toPathData(2)}" fill="${colors.text}"/>`;
  const box = {
    x1: Math.min(leadBox.x1, mag.box.x1), y1: Math.min(leadBox.y1, restBox.y1, mag.box.y1),
    x2: restBox.x2, y2: Math.max(mag.box.y2, restBox.y2),
  };
  return { svg, box, capTop: leadBox.y1 };
}

function standaloneMark({ concept, colors, scale = 1 }) {
  const m = metrics(FONT.semibold);
  const R = ((m.o.x2 - m.o.x1) / 2) * scale;
  const s = R * 0.3;
  return magnifier({ cx: 0, cy: 0, R, s, concept, ink: colors.mark, glint: colors.glint, angleDeg: 40, gripLen: R * 1.05, grip: 1.3 });
}

function textPath(text, size, weight, x, y, fill, spacing = 0) {
  const font = FONT[weight];
  const p = font.getPath(text, x, y, size, { kerning: true, letterSpacing: spacing });
  return { svg: `<path d="${p.toPathData(2)}" fill="${fill}"/>`, box: p.getBoundingBox() };
}

const TAGLINE = 'Team activity, transparently.';

// ---------------------------------------------------------------------------------------------------------------
// Layouts: return { body, box } in their own coordinates
// ---------------------------------------------------------------------------------------------------------------
function layoutHorizontal(concept, colors, opts = {}) {
  const w = wordmark({ concept, colors, lowercase: opts.lowercase });
  return { body: w.svg, box: w.box };
}

function layoutTagline(concept, colors) {
  const w = wordmark({ concept, colors });
  const size = F * 0.26;
  const t = textPath(TAGLINE, size, 'regular', 0, 0, colors.tagline, 0.02);
  const tw = t.box.x2 - t.box.x1;
  const ww = w.box.x2 - w.box.x1;
  const tx = w.box.x1 + (ww - tw) / 2 - t.box.x1;
  const ty = w.box.y2 + size * 1.05 - t.box.y1 * 0;
  const placed = textPath(TAGLINE, size, 'regular', tx, ty + size * 0.75, colors.tagline, 0.02);
  return {
    body: w.svg + placed.svg,
    box: { x1: Math.min(w.box.x1, placed.box.x1), y1: w.box.y1, x2: Math.max(w.box.x2, placed.box.x2), y2: placed.box.y2 },
  };
}

function layoutStacked(concept, colors) {
  const w = wordmark({ concept, colors });
  const ww = w.box.x2 - w.box.x1;
  const mark = standaloneMark({ concept, colors, scale: 1.9 });
  const mw = mark.box.x2 - mark.box.x1;
  const mh = mark.box.y2 - mark.box.y1;
  const gap = F * 0.22;
  const mx = w.box.x1 + ww / 2 - (mark.box.x1 + mw / 2);
  const my = w.box.y1 - gap - mark.box.y2;
  return {
    body: `<g transform="translate(${n(mx)} ${n(my)})">${mark.svg}</g>${w.svg}`,
    box: { x1: w.box.x1, y1: my + mark.box.y1, x2: w.box.x2, y2: w.box.y2, markH: mh },
  };
}

function layoutIcon(concept, colors) {
  const mark = standaloneMark({ concept, colors, scale: 2 });
  const b = mark.box;
  const size = Math.max(b.x2 - b.x1, b.y2 - b.y1);
  const cx = (b.x1 + b.x2) / 2;
  const cy = (b.y1 + b.y2) / 2;
  return { body: mark.svg, box: { x1: cx - size / 2, y1: cy - size / 2, x2: cx + size / 2, y2: cy + size / 2 } };
}

// ---------------------------------------------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------------------------------------------
function doc({ body, box }, { pad = 0.08, bg = null, square = false, width = null, height = null, defs = '' } = {}) {
  let w = box.x2 - box.x1;
  let h = box.y2 - box.y1;
  const p = Math.max(w, h) * pad;
  let x = box.x1 - p;
  let y = box.y1 - p;
  w += 2 * p;
  h += 2 * p;
  if (square) {
    const s = Math.max(w, h);
    x -= (s - w) / 2;
    y -= (s - h) / 2;
    w = h = s;
  }
  if (width && height) {
    const ratio = width / height;
    if (w / h < ratio) { const nw = h * ratio; x -= (nw - w) / 2; w = nw; } else { const nh = w / ratio; y -= (nh - h) / 2; h = nh; }
  }
  const bgRect = bg ? `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${bg}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(x)} ${n(y)} ${n(w)} ${n(h)}" width="${n(w)}" height="${n(h)}">${defs}${bgRect}${body}</svg>`;
}

function write(rel, data) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

function png(svg, width) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } }).render().asPng();
}

function emit(name, svg, widths, dir) {
  write(`svg/${dir}/${name}.svg`, svg);
  for (const w of widths) write(`png/${dir}/${name}-${w}px.png`, png(svg, w));
}

// ---------------------------------------------------------------------------------------------------------------
// App icon / avatar / banners (with backgrounds)
// ---------------------------------------------------------------------------------------------------------------
const GRADIENT = `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1E40AF"/><stop offset="1" stop-color="${C.navyDeep}"/></linearGradient></defs>`;

function appIconSvg(concept, { rounded = true, circle = false, size = 1024, markShare = 0.6, background = true } = {}) {
  const icon = layoutIcon(concept, COLORWAYS.reverse);
  const b = icon.box;
  const k = (size * markShare) / (b.x2 - b.x1);
  const tx = size / 2 - ((b.x1 + b.x2) / 2) * k;
  const ty = size / 2 - ((b.y1 + b.y2) / 2) * k;
  const shape = !background ? ''
    : circle ? `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="url(#bg)"/>`
    : `<rect width="${size}" height="${size}" rx="${rounded ? size * 0.225 : 0}" fill="url(#bg)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${background ? GRADIENT : ''}${shape}<g transform="translate(${n(tx)} ${n(ty)}) scale(${n(k)})">${icon.body}</g></svg>`;
}

function bannerSvg(width, height, { tagline = true, align = 'center' } = {}) {
  const art = tagline ? layoutTagline('classic', COLORWAYS.reverse) : layoutHorizontal('classic', COLORWAYS.reverse);
  const b = art.box;
  const target = Math.min(width * (align === 'center' ? 0.5 : 0.42), (height * 0.5) * ((b.x2 - b.x1) / (b.y2 - b.y1)));
  const k = target / (b.x2 - b.x1);
  const left = align === 'center' ? width / 2 - target / 2 : width * 0.08;
  const tx = left - b.x1 * k;
  const ty = height / 2 - ((b.y1 + b.y2) / 2) * k;
  // Faint lens rings as a background motif.
  const R = height * 0.9;
  const rx = width * 0.86;
  const ry = height * 0.55;
  const rings = [1, 0.72, 0.46].map((f, i) =>
    `<circle cx="${n(rx)}" cy="${n(ry)}" r="${n(R * f)}" fill="none" stroke="${C.cyan}" stroke-opacity="${0.07 + i * 0.03}" stroke-width="${n(height * 0.035)}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${GRADIENT}<rect width="${width}" height="${height}" fill="url(#bg)"/>${rings}<g transform="translate(${n(tx)} ${n(ty)}) scale(${n(k)})">${art.body}</g></svg>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------------------------
fs.rmSync(path.join(OUT, 'svg'), { recursive: true, force: true });
fs.rmSync(path.join(OUT, 'png'), { recursive: true, force: true });

const LOGO_WIDTHS = [600, 1200, 2400, 4800];
const ICON_WIDTHS = [64, 128, 256, 512, 1024, 2048];

for (const concept of CONCEPTS) {
  const full = concept === 'classic';
  for (const [cw, colors] of Object.entries(COLORWAYS)) {
    const widths = full ? LOGO_WIDTHS : [1200, 2400];
    emit(`mycroscope-horizontal-${concept}-${cw}`, doc(layoutHorizontal(concept, colors)), widths, `${concept}/horizontal`);
    emit(`mycroscope-icon-${concept}-${cw}`, doc(layoutIcon(concept, colors), { square: true }), full ? ICON_WIDTHS : [512, 1024], `${concept}/icon`);
    if (full) {
      emit(`mycroscope-lowercase-${concept}-${cw}`, doc(layoutHorizontal(concept, colors, { lowercase: true })), widths, `${concept}/lowercase`);
      emit(`mycroscope-tagline-${concept}-${cw}`, doc(layoutTagline(concept, colors)), widths, `${concept}/tagline`);
      emit(`mycroscope-stacked-${concept}-${cw}`, doc(layoutStacked(concept, colors)), [600, 1200, 2400], `${concept}/stacked`);
    }
  }
}

// App and web icons.
for (const concept of ['classic', 'focus', 'solid']) {
  emit(`app-icon-${concept}`, appIconSvg(concept), [180, 192, 512, 1024], 'app-icons');
  emit(`avatar-circle-${concept}`, appIconSvg(concept, { circle: true }), [400, 800], 'app-icons');
}
emit('app-icon-square-classic', appIconSvg('classic', { rounded: false }), [1024], 'app-icons');
emit('android-adaptive-foreground', appIconSvg('classic', { background: false, markShare: 0.42 }), [1024], 'app-icons');
emit('splash-icon', appIconSvg('classic', { background: false, markShare: 0.7 }), [1024], 'app-icons');
emit('splash-icon-dark-mark', `${doc(layoutIcon('classic', COLORWAYS.color), { square: true, pad: 0.15 })}`, [1024], 'app-icons');

// Favicons (the rounded app icon reads best at tiny sizes).
const favSvg = appIconSvg('classic', { markShare: 0.66 });
write('svg/favicon/favicon.svg', favSvg);
const favPngs = [16, 32, 48, 64, 128, 256].map((s) => write(`png/favicon/favicon-${s}.png`, png(favSvg, s)));
write('png/favicon/apple-touch-icon.png', png(appIconSvg('classic', { rounded: false }), 180));
write('png/favicon/favicon.ico', await pngToIco(favPngs.slice(0, 4)));
write('png/favicon/mycroscope-windows.ico', await pngToIco(favPngs));

// Social media and banners.
const SOCIAL = [
  ['linkedin-cover', 1584, 396, { align: 'left' }], ['x-twitter-header', 1500, 500, { align: 'left' }],
  ['facebook-cover', 1640, 624, {}], ['youtube-banner', 2560, 1440, {}], ['open-graph-share', 1200, 630, {}],
  ['email-header', 1200, 300, { tagline: false }], ['presentation-title-16x9', 1920, 1080, {}],
];
for (const [name, w, h, o] of SOCIAL) emit(name, bannerSvg(w, h, o), [w], 'social');

// Email signature (transparent, compact).
emit('email-signature-color', doc(layoutHorizontal('classic', COLORWAYS.color), { pad: 0.04 }), [300, 600], 'email');

// Preview sheet.
function tile(svg, x, y, w, h, bg) {
  const inner = svg.replace(/^<svg([^>]*?) width="[^"]*" height="[^"]*"/, '<svg$1').replace(/^<svg /, `<svg x="${x + w * 0.1}" y="${y + h * 0.15}" width="${w * 0.8}" height="${h * 0.7}" preserveAspectRatio="xMidYMid meet" `);
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="${bg}"/>${inner}`;
}
const rows = [];
const W = 2400;
const tw = 1140;
let y = 140;
const title = textPath('Mycroscope brand kit', 64, 'semibold', 60, 100, C.ink);
rows.push(title.svg);
for (const concept of CONCEPTS) {
  rows.push(tile(doc(layoutHorizontal(concept, COLORWAYS.color)), 60, y, tw, 300, '#FFFFFF'));
  rows.push(tile(doc(layoutHorizontal(concept, COLORWAYS.reverse)), 60 + tw + 60, y, tw, 300, C.navy));
  y += 330;
}
rows.push(tile(doc(layoutTagline('classic', COLORWAYS.color)), 60, y, tw, 360, '#FFFFFF'));
rows.push(tile(doc(layoutStacked('classic', COLORWAYS.reverse)), 60 + tw + 60, y, tw, 360, C.navyDeep));
y += 390;
rows.push(tile(doc(layoutHorizontal('classic', COLORWAYS.accent)), 60, y, tw, 260, '#FFFFFF'));
rows.push(tile(doc(layoutHorizontal('classic', COLORWAYS.color, { lowercase: true })), 60 + tw + 60, y, tw, 260, '#FFFFFF'));
y += 290;
rows.push(tile(doc(layoutHorizontal('classic', COLORWAYS.black)), 60, y, tw, 240, '#E2E8F0'));
rows.push(tile(doc(layoutHorizontal('classic', COLORWAYS.white)), 60 + tw + 60, y, tw, 240, '#111827'));
y += 270;
const icons = [
  appIconSvg('classic'), appIconSvg('focus'), appIconSvg('solid'), appIconSvg('classic', { circle: true }),
  doc(layoutIcon('classic', COLORWAYS.color), { square: true }), doc(layoutIcon('focus', COLORWAYS.accent), { square: true }),
];
icons.forEach((svg, i) => rows.push(tile(svg, 60 + i * 390, y, 360, 360, i < 4 ? '#F1F5F9' : '#FFFFFF')));
y += 400;
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${y}" width="${W}" height="${y}"><rect width="${W}" height="${y}" fill="${C.paper}"/>${rows.join('')}</svg>`;
write('preview-brand-kit.png', png(sheet, W));
write('preview-social-linkedin.png', png(bannerSvg(1584, 396, { align: 'left' }), 1584));

const count = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => /\.(png|svg|ico)$/.test(f)).length;
console.log(`Brand kit written to ${OUT}: ${count(path.join(OUT, 'png'))} PNG/ICO, ${count(path.join(OUT, 'svg'))} SVG`);
