// End-to-end smoke test for the renderer, driven in plain Chromium via
// Playwright (the browser-host fallback in app.js stands in for Electron's
// preload API). Verifies: open, render, search, rotate, reorder, delete,
// text overlay + bake, undo. Saves screenshots to scripts/out/.
//
// Usage: node scripts/smoke.mjs

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { PDFDocument, PDFHexString, PDFName, StandardFonts, rgb } from 'pdf-lib';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.SMOKE_OUT || path.join(root, 'scripts', 'out');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
};

async function makeFixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const colors = [rgb(0.9, 0.3, 0.2), rgb(0.2, 0.5, 0.9), rgb(0.2, 0.7, 0.3)];
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([612, 792]);
    page.drawRectangle({ x: 0, y: 752, width: 612, height: 40, color: colors[i] });
    page.drawText(`Chapter ${i + 1}`, { x: 40, y: 700, size: 32, font });
    page.drawText(`This is searchable body text on page ${i + 1}.`, { x: 40, y: 650, size: 14, font });
    page.drawText('shelly', { x: 40, y: 620, size: 14, font });
  }
  return doc.save();
}

function serve(dir) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      try {
        const data = await readFile(path.join(dir, p));
        res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
        res.end(data);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let failures = 0;
function check(label, ok, extra = '') {
  console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` (${extra})` : ''}`);
  if (!ok) failures++;
}

const server = await serve(path.join(root, 'dist'));
const port = server.address().port;
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on('pageerror', (err) => {
  failures++;
  console.log('  ✗ page error:', err.message);
});

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForSelector('#empty-state');

// --- open a document ---
const fixture = await makeFixture();
await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await window.__shellyTest.openBytes(bytes, '/tmp/fixture.pdf', 'fixture.pdf');
}, Buffer.from(fixture).toString('base64'));

await page.waitForFunction(() => document.querySelectorAll('.viewer.active .page canvas').length === 3);
await page.waitForFunction(() => {
  const c = document.querySelector('.viewer.active .page canvas');
  return c && c.width > 0;
});
check('opens a 3-page PDF', (await page.textContent('#page-total')).trim() === '/ 3');

// canvas actually painted? sample the colored header bar
const painted = await page.evaluate(() => {
  const c = document.querySelector('.viewer.active .page canvas');
  const px = c.getContext('2d').getImageData(Math.floor(c.width / 2), 10, 1, 1).data;
  return px[0] > 150 && px[1] < 150; // reddish header on page 1
});
check('page 1 canvas is painted with content', painted);

const textLayerSpans = await page.locator('.viewer.active .page .textLayer span').count();
check('text layer built (selectable text)', textLayerSpans > 0, `${textLayerSpans} spans`);

await page.waitForFunction(() => document.querySelectorAll('.thumbs.active .thumb').length === 3);
check('thumbnails built', true);
await page.screenshot({ path: path.join(outDir, '1-reader.png') });

// --- search ---
await page.click('#btn-find');
await page.fill('#find-input', 'searchable body');
await page.waitForFunction(() => document.querySelectorAll('.hl').length > 0);
const matches = await page.textContent('#find-count');
check('search finds matches on every page', matches.trim() === '1 / 3', matches.trim());
await page.click('#find-next');
check('next-match cycles', (await page.textContent('#find-count')).trim() === '2 / 3');
await page.screenshot({ path: path.join(outDir, '2-search.png') });
await page.click('#find-close');

// --- rotate page 2 ---
await page.click('.thumbs.active .thumb:nth-child(2)');
await page.click('#pg-rotate-r');
await page.waitForFunction(() => !document.getElementById('btn-undo').disabled);
const rot = await page.evaluate(() =>
  window.__shellyTest.engine.getPageRotation(window.__shellyTest.state.bytes, 1)
);
check('rotate right sets /Rotate 90 on page 2', rot === 90);
const landscape = await page.evaluate(() => {
  const el = document.querySelectorAll('.viewer.active .page')[1];
  return el.offsetWidth > el.offsetHeight;
});
check('rotated page renders landscape', landscape);

// --- reorder: move page 3 to the front (simulate the drop handler) ---
await page.evaluate(() => {
  window.__shellyTest.thumbs.dispatchEvent(
    new CustomEvent('reorder', { detail: { order: [2, 0, 1] } })
  );
});
await page.waitForFunction(async () => {
  const t = window.__shellyTest;
  return (await t.engine.getPageRotation(t.state.bytes, 2)) === 90;
});
check('reorder moves rotated page from slot 2 to slot 3', true);

// --- add a text overlay and bake ---
await page.click('#tool-text');
await page.click('.viewer.active .page', { position: { x: 200, y: 300 } });
await page.keyboard.type('Reviewed by Shelly');
await page.click('#status-file'); // blur commits the text
const bakedGrows = await page.evaluate(async () => {
  const t = window.__shellyTest;
  const payload = t.overlays.bakePayload();
  if (payload.length !== 1 || payload[0].text !== 'Reviewed by Shelly') return false;
  const baked = await t.engine.bakeOverlays(t.state.bytes, payload);
  return baked.length > t.state.bytes.length;
});
check('text overlay bakes into the PDF', bakedGrows);
await page.screenshot({ path: path.join(outDir, '3-edit.png') });

// --- delete page ---
await page.click('.thumbs.active .thumb:nth-child(1)');
await page.click('#pg-delete');
await page.waitForFunction(() => document.querySelectorAll('.viewer.active .page').length === 2);
check('delete page leaves 2 pages', (await page.textContent('#page-total')).trim() === '/ 2');

// --- undo restores it ---
await page.click('#btn-undo');
await page.waitForFunction(() => document.querySelectorAll('.viewer.active .page').length === 3);
check('undo restores the deleted page', true);

// --- a second undo takes back the text overlay ---
check('overlay survived the delete/undo cycle', await page.evaluate(() => window.__shellyTest.overlays.items.length === 1));
await page.click('#btn-undo');
await page.waitForFunction(() => window.__shellyTest.overlays.items.length === 0);
check('second undo removes the text overlay', true);

// --- zoom ---
const w1 = await page.evaluate(() => document.querySelector('.viewer.active .page').offsetWidth);
await page.click('#btn-zoom-in');
await page.waitForFunction(
  (prev) => document.querySelector('.viewer.active .page').offsetWidth > prev,
  w1
);
check('zoom in enlarges pages', true);

// ---------------------------------------------------------------------------
// Part 3 features: highlight, sticky note, signature, form filling
// ---------------------------------------------------------------------------

// fresh document so coordinates are predictable
await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await window.__shellyTest.openBytes(bytes, '/tmp/fixture.pdf', 'fixture.pdf');
}, Buffer.from(fixture).toString('base64'));
await page.waitForFunction(() => {
  const spans = document.querySelectorAll('.viewer.active .page .textLayer span');
  return spans.length > 0;
});

// --- highlight: drag across the body text on page 1 ---
await page.click('#tool-highlight');
const spanBox = await page.evaluate(() => {
  const span = document.querySelector('.viewer.active .page .textLayer span');
  const r = span.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await page.mouse.move(spanBox.x + 2, spanBox.y + spanBox.h / 2);
await page.mouse.down();
await page.mouse.move(spanBox.x + spanBox.w - 2, spanBox.y + spanBox.h / 2, { steps: 8 });
await page.mouse.up();
await page.waitForFunction(() =>
  window.__shellyTest.overlays.items.some((i) => i.type === 'highlight')
);
const hlOk = await page.evaluate(async () => {
  const t = window.__shellyTest;
  const payload = t.overlays.bakePayload();
  const hl = payload.find((p) => p.type === 'highlight');
  if (!hl || !hl.rects.length) return false;
  const baked = await t.engine.bakeOverlays(t.state.bytes, payload);
  return baked.length > t.state.bytes.length;
});
check('highlight created from text selection and bakes', hlOk);

// --- sticky note: place, type, bake as a real /Text annotation ---
await page.click('#tool-note');
await page.click('.viewer.active .page', { position: { x: 250, y: 400 } });
await page.waitForSelector('.overlay.ov-note textarea');
await page.keyboard.type('Please double-check this section');
await page.click('#status-file'); // blur commits
const noteCount = await page.evaluate(async () => {
  const t = window.__shellyTest;
  const baked = await t.engine.bakeOverlays(t.state.bytes, t.overlays.bakePayload());
  return t.engine.countTextAnnotations(baked, 0);
});
check('sticky note bakes as a /Text annotation', noteCount === 1, `count=${noteCount}`);

// --- signature: draw in the dialog, place on the page ---
await page.click('#tool-sign');
await page.waitForSelector('#sign-dialog[open]');
const sc = await page.evaluate(() => {
  const r = document.getElementById('sign-canvas').getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await page.mouse.move(sc.x + sc.w * 0.2, sc.y + sc.h * 0.6);
await page.mouse.down();
await page.mouse.move(sc.x + sc.w * 0.4, sc.y + sc.h * 0.3, { steps: 10 });
await page.mouse.move(sc.x + sc.w * 0.6, sc.y + sc.h * 0.7, { steps: 10 });
await page.mouse.move(sc.x + sc.w * 0.8, sc.y + sc.h * 0.4, { steps: 10 });
await page.mouse.up();
await page.click('#sign-use');
await page.waitForFunction(() => !document.getElementById('sign-dialog').open);
// page 2: page 1 has the sticky note's popup covering part of it
await page.click('.viewer.active .page[data-page="1"]', { position: { x: 300, y: 300 } });
await page.waitForFunction(() =>
  window.__shellyTest.overlays.items.some((i) => i.type === 'image')
);
check('signature drawn and placed as an image overlay', true);
await page.screenshot({ path: path.join(outDir, '4-annotate.png') });

// --- form filling ---
async function makeFormPdf() {
  const doc = await PDFDocument.create();
  const pg = doc.addPage([500, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  pg.drawText('Name:', { x: 30, y: 330, size: 14, font });
  const form = doc.getForm();
  const nameField = form.createTextField('name');
  nameField.addToPage(pg, { x: 100, y: 320, width: 220, height: 26 });
  const agree = form.createCheckBox('agree');
  agree.addToPage(pg, { x: 100, y: 270, width: 20, height: 20 });
  return doc.save();
}
const formPdf = await makeFormPdf();
await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await window.__shellyTest.openBytes(bytes, '/tmp/form.pdf', 'form.pdf');
}, Buffer.from(formPdf).toString('base64'));
await page.waitForSelector('.viewer.active .page .annotationLayer input');
await page.fill('.viewer.active .page .annotationLayer input[type="text"]', 'Eddie Khaw');
await page.click('.viewer.active .page .annotationLayer input[type="checkbox"]');
const formOk = await page.evaluate(async () => {
  const t = window.__shellyTest;
  if (!t.viewer.hasFormEdits) return 'no edits detected';
  const values = await t.viewer.collectFormValues();
  const applied = await t.engine.applyFormValues(t.state.bytes, values);
  const readBack = await t.engine.readFormValues(applied);
  return readBack.name === 'Eddie Khaw' && readBack.agree === true ? true : JSON.stringify(readBack);
});
check('form fields fill and save into the PDF', formOk === true, formOk === true ? '' : String(formOk));
await page.screenshot({ path: path.join(outDir, '5-form.png') });

// --- tabs: multiple documents open at once ---
const tabCount = await page.evaluate(() => window.__shellyTest.sessionCount());
check('three documents open in tabs', tabCount === 3, `tabs=${tabCount}`);
const visibleViewers = await page.evaluate(() => document.querySelectorAll('.viewer.active').length);
check('only one viewer visible at a time', visibleViewers === 1);
await page.click('#tabbar .tab:nth-child(1)');
await page.waitForFunction(() => document.querySelector('#page-total').textContent.trim() === '/ 3');
check('switching tabs restores the first document (3 pages, its own state)', true);
await page.screenshot({ path: path.join(outDir, '6-tabs.png') });
await page.evaluate(() => window.__shellyTest.closeCurrent());
await page.waitForFunction(() => window.__shellyTest.sessionCount() === 2);
check(
  'closing a tab activates a neighbor',
  await page.evaluate(() => !!window.__shellyTest.state && document.querySelectorAll('.viewer.active').length === 1)
);

// ---------------------------------------------------------------------------
// Acrobat-parity fixes
// ---------------------------------------------------------------------------

// fresh tab
await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await window.__shellyTest.openBytes(bytes, '/tmp/fixture.pdf', 'fixture.pdf');
}, Buffer.from(fixture).toString('base64'));
await page.waitForFunction(() => document.querySelectorAll('.viewer.active .textLayer span').length > 0);

// --- search across text runs (phrase spans a line break in the PDF) ---
await page.click('#btn-find');
await page.fill('#find-input', 'page 1. shelly');
await page.waitForFunction(() => document.querySelector('#find-count').textContent.trim() !== '');
const crossRun = (await page.textContent('#find-count')).trim();
check('search matches phrases across text runs / line breaks', crossRun === '1 / 1', crossRun);
await page.click('#find-close');

// --- Ctrl+wheel zooms ---
const scaleBefore = await page.evaluate(() => window.__shellyTest.viewer.scale);
const viewerBox = await page.evaluate(() => {
  const r = document.querySelector('.viewer.active').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.move(viewerBox.x, viewerBox.y);
await page.keyboard.down('Control');
await page.mouse.wheel(0, -120);
await page.keyboard.up('Control');
await page.waitForFunction(
  (prev) => window.__shellyTest.viewer.scale > prev,
  scaleBefore,
  { timeout: 10000 }
);
check('Ctrl+wheel zooms in', true);

// --- custom zoom level is displayed as a percentage ---
const zoomLabel = await page.evaluate(() => {
  const sel = document.getElementById('zoom-select');
  return sel.selectedOptions[0]?.textContent.trim() ?? '';
});
check('zoom dropdown shows the actual percentage', /^\d+%$/.test(zoomLabel), zoomLabel);

// --- text box with white fill ---
await page.click('#tool-text');
await page.check('#text-bg');
await page.click('.viewer.active .page', { position: { x: 300, y: 500 } });
await page.keyboard.type('CORRECTED');
await page.click('#status-file');
const fillOk = await page.evaluate(() => {
  const payload = window.__shellyTest.overlays.bakePayload();
  const t = payload.find((p) => p.type === 'text' && p.text === 'CORRECTED');
  return !!(t && t.bg && t.bg.width > 0 && t.bg.height > 0);
});
check('text box can carry an opaque fill', fillOk);
await page.uncheck('#text-bg');

// --- highlights save as annotations AND render when the file is reopened ---
await page.click('#tool-highlight');
const hlSpan = await page.evaluate(() => {
  const span = document.querySelector('.viewer.active .textLayer span');
  const r = span.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await page.mouse.move(hlSpan.x + 2, hlSpan.y + hlSpan.h / 2);
await page.mouse.down();
await page.mouse.move(hlSpan.x + hlSpan.w - 2, hlSpan.y + hlSpan.h / 2, { steps: 6 });
await page.mouse.up();
await page.waitForFunction(() => window.__shellyTest.overlays.items.some((i) => i.type === 'highlight'));

const hlInfo = await page.evaluate(async () => {
  const t = window.__shellyTest;
  const item = t.overlays.items.find((i) => i.type === 'highlight');
  const rect = item.rects[0];
  const payload = t.overlays.bakePayload().filter((p) => p.type === 'highlight');
  const baked = await t.engine.bakeOverlays(t.state.bytes, payload);
  const count = await t.engine.countAnnotations(baked, item.pageIndex, 'Highlight');
  return { rect, pageIndex: item.pageIndex, count, b64: btoa(String.fromCharCode(...new Uint8Array(baked.slice(0, 0)))) , bakedB64: (() => { let s = ''; const u = new Uint8Array(baked); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); })() };
});
check('highlight saves as a /Highlight annotation', hlInfo.count === 1, `count=${hlInfo.count}`);

await page.evaluate(async ({ bakedB64 }) => {
  const bytes = Uint8Array.from(atob(bakedB64), (c) => c.charCodeAt(0));
  await window.__shellyTest.openBytes(bytes, null, 'highlighted.pdf');
}, hlInfo);
await page.waitForFunction(
  (pi) => window.__shellyTest.viewer.pages[pi]?.rendered === true,
  hlInfo.pageIndex
);
const hlRendered = await page.evaluate(({ rect, pageIndex }) => {
  const t = window.__shellyTest;
  const p = t.viewer.pages[pageIndex];
  const s = t.viewer.scale;
  const ratio = p.canvas.width / p.canvas.clientWidth;
  const cx = Math.round((rect.x + rect.w / 2) * s * ratio);
  const cy = Math.round((rect.y + rect.h / 2) * s * ratio);
  const px = p.canvas.getContext('2d').getImageData(cx, cy, 1, 1).data;
  // yellow-ish tint: strong red+green, weaker blue, not plain white
  return { px: [...px], ok: px[0] > 180 && px[1] > 150 && px[2] < 210 && !(px[0] > 245 && px[1] > 245 && px[2] > 245) };
}, hlInfo);
check('reopened file renders the highlight annotation', hlRendered.ok, `rgb=${hlRendered.px.slice(0, 3)}`);
await page.screenshot({ path: path.join(outDir, '7-parity.png') });

// ---------------------------------------------------------------------------
// OCR: scanned page → recognize → search → save → searchable everywhere
// ---------------------------------------------------------------------------

// Fake a scan: draw text onto a canvas and wrap the PNG in an image-only PDF.
const scanPngB64 = await page.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 1275;
  c.height = 1650;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#111';
  ctx.font = 'bold 64px Arial';
  ctx.fillText('SCANNED INVOICE', 120, 260);
  ctx.font = '48px Arial';
  ctx.fillText('Total amount 8450 dollars', 120, 420);
  ctx.fillText('Payment due in thirty days', 120, 540);
  return c.toDataURL('image/png').split(',')[1];
});
const scanDoc = await PDFDocument.create();
const scanImg = await scanDoc.embedPng(Buffer.from(scanPngB64, 'base64'));
scanDoc.addPage([612, 792]).drawImage(scanImg, { x: 0, y: 0, width: 612, height: 792 });
const scanPdf = await scanDoc.save();

await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await window.__shellyTest.openBytes(bytes, null, 'scan.pdf');
}, Buffer.from(scanPdf).toString('base64'));
await page.waitForFunction(() => window.__shellyTest.viewer?.pages[0]?.rendered === true);

// before OCR: the page has no searchable text
const preOcr = await page.evaluate(async () => {
  const tc = await window.__shellyTest.viewer.pages[0].proxy.getTextContent();
  return tc.items.length;
});
check('scanned page starts with no text layer', preOcr === 0, `items=${preOcr}`);

await page.click('#btn-ocr');
await page.waitForFunction(() => window.__shellyTest.session.ocr.size > 0, null, { timeout: 180000 });
const ocrWordCount = await page.evaluate(() => window.__shellyTest.session.ocr.get(0)?.length ?? 0);
check('OCR recognized words on the scanned page', ocrWordCount >= 8, `${ocrWordCount} words`);

const ocrSpans = await page.locator('.viewer.active .ocrLayer span').count();
check('OCR words become selectable spans', ocrSpans >= 8, `${ocrSpans} spans`);

await page.click('#btn-find');
await page.fill('#find-input', '8450 dollars');
await page.waitForFunction(() => document.querySelector('#find-count').textContent.trim() !== '');
const ocrSearch = (await page.textContent('#find-count')).trim();
check('search finds text on the scanned page', ocrSearch === '1 / 1', ocrSearch);
await page.screenshot({ path: path.join(outDir, '8-ocr.png') });
await page.click('#find-close');

// save → invisible text is baked in; a fresh load of the saved bytes must be
// natively searchable (what Acrobat and other readers will see)
const savedB64 = await page.evaluate(async () => {
  const baked = await window.__shellyTest.session.buildSaveBytes();
  let s = '';
  const u = new Uint8Array(baked);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
});
await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await window.__shellyTest.openBytes(bytes, null, 'scan-searchable.pdf');
}, savedB64);
await page.waitForFunction(() => window.__shellyTest.viewer?.pages[0]?.rendered === true);
const nativeText = await page.evaluate(async () => {
  const tc = await window.__shellyTest.viewer.pages[0].proxy.getTextContent();
  return tc.items.map((i) => i.str).join(' ');
});
check(
  'saved PDF carries a real invisible text layer',
  /8450/.test(nativeText) && /INVOICE/i.test(nativeText),
  nativeText.slice(0, 60)
);

// ---------------------------------------------------------------------------
// Round 2: watermark, redaction, password-protected PDFs, bookmarks
// ---------------------------------------------------------------------------

const openFixtureTab = async (bytes, name) => {
  await page.evaluate(
    async ({ b64, name }) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await window.__shellyTest.openBytes(data, null, name);
    },
    { b64: Buffer.from(bytes).toString('base64'), name }
  );
  await page.waitForFunction(() => window.__shellyTest.viewer?.pages[0]?.rendered === true);
};

// --- watermark ---
await openFixtureTab(fixture, 'wm.pdf');
await page.click('#btn-stamp');
await page.waitForSelector('#wm-dialog[open]');
await page.fill('#wm-text', 'DRAFT COPY');
await page.click('#wm-apply');
await page.waitForFunction(() => !document.getElementById('btn-undo').disabled);
await page.waitForFunction(() => window.__shellyTest.viewer.pages[0].rendered === true);
const wmTint = await page.evaluate(() => {
  // count reddish pixels in a region around the page center — the diagonal
  // watermark passes through it (single-pixel probes can land in letter gaps)
  const t = window.__shellyTest;
  const p = t.viewer.pages[0];
  const ratio = p.canvas.width / p.canvas.clientWidth;
  const size = Math.round(160 * ratio);
  const cx = Math.round((p.canvas.clientWidth / 2) * ratio - size / 2);
  const cy = Math.round((p.canvas.clientHeight / 2) * ratio - size / 2);
  const data = p.canvas.getContext('2d').getImageData(cx, cy, size, size).data;
  let tinted = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > data[i + 2] + 8) tinted++; // red channel clearly above blue
  }
  return tinted;
});
check('watermark tints the page center region', wmTint > 50, `${wmTint} tinted px`);
await page.click('#btn-undo');
await page.waitForFunction(() => document.getElementById('btn-undo').disabled);
check('watermark is undoable', true);

// --- redaction ---
await openFixtureTab(fixture, 'redact-me.pdf');
await page.click('#tool-redact');
const target = await page.evaluate(() => {
  const span = document.querySelector('.viewer.active .textLayer span'); // "Chapter 1"
  const r = span.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await page.mouse.move(target.x - 6, target.y - 6);
await page.mouse.down();
await page.mouse.move(target.x + target.w + 6, target.y + target.h + 6, { steps: 6 });
await page.mouse.up();
await page.waitForFunction(() =>
  window.__shellyTest.overlays.items.some((i) => i.type === 'redact')
);
check('redaction box drawn', true);

const redactedB64 = await page.evaluate(async () => {
  const baked = await window.__shellyTest.session.buildSaveBytes();
  let s = '';
  const u = new Uint8Array(baked);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
});
await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await window.__shellyTest.openBytes(bytes, null, 'redacted.pdf');
}, redactedB64);
await page.waitForFunction(() => window.__shellyTest.viewer?.pages[0]?.rendered === true);
const redactResult = await page.evaluate(async ({ x, y, w, h }) => {
  const t = window.__shellyTest;
  const tc = await t.viewer.pages[0].proxy.getTextContent();
  const text = tc.items.map((i) => i.str).join(' ');
  // sample where "Chapter 1" used to be — layout matches (same fit-width page)
  const p = t.viewer.pages[0];
  const pr = p.el.getBoundingClientRect();
  const ratio = p.canvas.width / p.canvas.clientWidth;
  const px = p.canvas
    .getContext('2d')
    .getImageData(
      Math.round((x + w / 2 - pr.x) * ratio),
      Math.round((y + h / 2 - pr.y) * ratio),
      1,
      1
    ).data;
  return { text, px: [...px] };
}, target);
check(
  'redacted text is GONE from the saved file',
  !/Chapter/i.test(redactResult.text),
  redactResult.text.slice(0, 50) || '(no text)'
);
check(
  'redacted area is black pixels',
  redactResult.px[0] < 40 && redactResult.px[1] < 40 && redactResult.px[2] < 40,
  `rgb=${redactResult.px.slice(0, 3)}`
);
check(
  'surviving text re-OCRed and still searchable',
  /searchable/i.test(redactResult.text),
  ''
);
await page.screenshot({ path: path.join(outDir, '9-redact.png') });

// --- password-protected PDF (view-only) ---
const plainDoc = await PDFDocument.create();
const pfont = await plainDoc.embedFont(StandardFonts.Helvetica);
plainDoc.addPage([612, 792]).drawText('Top secret figures', { x: 60, y: 700, size: 24, font: pfont });
const plainPath = path.join(outDir, '_plain.pdf');
const encPath = path.join(outDir, '_enc.pdf');
await writeFile(plainPath, await plainDoc.save());
execFileSync('python3', [
  '-c',
  `import pikepdf; pdf = pikepdf.open('${plainPath}'); pdf.save('${encPath}', encryption=pikepdf.Encryption(owner='owner-pw', user='sesame', R=6))`,
]);
const encBytes = await readFile(encPath);

await page.evaluate((b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  window.__pwOpen = window.__shellyTest.openBytes(bytes, null, 'secret.pdf');
}, Buffer.from(encBytes).toString('base64'));
await page.waitForSelector('#pw-dialog[open]');
check('password dialog appears for encrypted PDFs', true);

await page.fill('#pw-input', 'wrong-guess');
await page.click('#pw-open');
await page.waitForFunction(() =>
  document.getElementById('pw-message').textContent.includes('Wrong password')
);
check('wrong password re-prompts', true);

await page.fill('#pw-input', 'sesame');
await page.click('#pw-open');
// wait for the encrypted session to become the active tab, then to render
await page.waitForFunction(() =>
  document.querySelector('#tabbar .tab.active .tab-label')?.textContent.includes('🔒')
);
await page.waitForFunction(() => window.__shellyTest.viewer?.pages[0]?.rendered === true);
const pwState = await page.evaluate(async () => {
  const t = window.__shellyTest;
  const tc = await t.viewer.pages[0].proxy.getTextContent();
  return {
    text: tc.items.map((i) => i.str).join(' '),
    readOnly: t.session.readOnly,
    toolsDisabled: document.getElementById('tool-text').disabled,
    saveDisabled: document.getElementById('btn-save').disabled,
    lock: document.querySelector('#tabbar .tab.active .tab-label').textContent,
  };
});
check('encrypted PDF opens and renders after correct password', /Top secret/.test(pwState.text));
check(
  'encrypted PDF is read-only (editing disabled, lock shown)',
  pwState.readOnly && pwState.toolsDisabled && pwState.saveDisabled && pwState.lock.includes('🔒'),
  pwState.lock
);

// --- bookmarks ---
async function makeOutlineFixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [];
  for (let i = 0; i < 3; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Section ${i + 1}`, { x: 40, y: 700, size: 24, font });
    pages.push(p);
  }
  const ctx = doc.context;
  const outlineRef = ctx.nextRef();
  const aRef = ctx.nextRef();
  const bRef = ctx.nextRef();
  const dest = (p) => ctx.obj([p.ref, PDFName.of('XYZ'), null, null, null]);
  ctx.assign(
    aRef,
    ctx.obj({ Title: PDFHexString.fromText('Introduction'), Parent: outlineRef, Next: bRef, Dest: dest(pages[0]) })
  );
  ctx.assign(
    bRef,
    ctx.obj({ Title: PDFHexString.fromText('Financials'), Parent: outlineRef, Prev: aRef, Dest: dest(pages[2]) })
  );
  ctx.assign(outlineRef, ctx.obj({ Type: 'Outlines', First: aRef, Last: bRef, Count: 2 }));
  doc.catalog.set(PDFName.of('Outlines'), outlineRef);
  return doc.save();
}
await openFixtureTab(await makeOutlineFixture(), 'outlined.pdf');
await page.click('#side-marks');
await page.waitForFunction(() => document.querySelectorAll('.outline.active .ol-title').length === 2);
const marks = await page.evaluate(() =>
  [...document.querySelectorAll('.outline.active .ol-title')].map((el) => el.textContent)
);
check('bookmarks panel lists the outline', marks.join(',') === 'Introduction,Financials', marks.join(','));
await page.evaluate(() => {
  [...document.querySelectorAll('.outline.active .ol-title')]
    .find((el) => el.textContent === 'Financials')
    .click();
});
await page.waitForFunction(() => window.__shellyTest.viewer.currentPage === 2);
check('clicking a bookmark jumps to its page', true);
await page.click('#side-pages');
await page.screenshot({ path: path.join(outDir, '10-round2.png') });

// --- pdf.js side assets: image codecs (JBIG2/JPEG2000 scans), CJK cmaps,
// standard fonts. Missing assets = photocopier scans render blank. ---
const sideAssets = await page.evaluate(async () => {
  const out = {};
  out.jbig2 = (await fetch('pdfjs/wasm/jbig2.wasm')).ok;
  out.openjpeg = (await fetch('pdfjs/wasm/openjpeg.wasm')).ok;
  out.cmap = (await fetch('pdfjs/cmaps/UniGB-UCS2-H.bcmap')).ok;
  out.font = (await fetch('pdfjs/standard_fonts/FoxitFixed.pfb')).ok;
  const wasmBytes = await (await fetch('pdfjs/wasm/jbig2.wasm')).arrayBuffer();
  out.wasmValid = WebAssembly.validate(wasmBytes);
  return out;
});
check(
  'pdf.js image codecs, cmaps, and fonts are bundled',
  Object.values(sideAssets).every(Boolean),
  JSON.stringify(sideAssets)
);
// and the built viewer actually points pdf.js at them
const { readdir } = await import('node:fs/promises');
const bundleNames = (await readdir(path.join(root, 'dist', 'assets'))).filter((f) => f.endsWith('.js'));
let bundleHasUrls = false;
for (const f of bundleNames) {
  const src = await readFile(path.join(root, 'dist', 'assets', f), 'utf8');
  if (src.includes('pdfjs/wasm/') && src.includes('pdfjs/cmaps/')) bundleHasUrls = true;
}
check('viewer passes the side-asset URLs to pdf.js', bundleHasUrls);

// --- Edit Text: click an existing line, retype it, original is destroyed ---
await openFixtureTab(fixture, 'edit-me.pdf');
await page.click('#tool-edittext');
const bodySpan = await page.evaluate(() => {
  const span = [...document.querySelectorAll('.viewer.active .textLayer span')].find((s) =>
    s.textContent.includes('searchable body')
  );
  const r = span.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(bodySpan.x, bodySpan.y);
await page.waitForSelector('.overlay.ov-edittext .ov-edit');
const prefilled = await page.evaluate(() => document.querySelector('.overlay.ov-edittext .ov-edit').textContent);
check(
  'clicking a line pre-fills its text',
  prefilled.includes('searchable body text on page 1'),
  prefilled.slice(0, 50)
);
// font/size/color controls appear and apply to the edit box
await page.waitForFunction(() => document.getElementById('text-props').classList.contains('visible'));
await page.selectOption('#text-font', 'TimesRoman');
await page.fill('#text-size', '18');
await page.$eval('#text-size', (el) => el.dispatchEvent(new Event('change')));
const propsApplied = await page.evaluate(() => {
  const it = window.__shellyTest.overlays.items.find((i) => i.type === 'edittext');
  return { font: it.font, size: it.size, family: it.el.style.fontFamily };
});
check(
  'font and size controls apply to the edit box',
  propsApplied.font === 'TimesRoman' && propsApplied.size === 18 && /Times/.test(propsApplied.family),
  JSON.stringify(propsApplied)
);

// the text is select-all'ed on open: typing replaces the whole line
await page.evaluate(() => {
  // re-select the contents (the toolbar interaction moved focus)
  const it = window.__shellyTest.overlays.items.find((i) => i.type === 'edittext');
  it.editEl.focus();
  const range = document.createRange();
  range.selectNodeContents(it.editEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
await page.keyboard.type('Corrected figure 9999');
await page.click('#status-file'); // blur commits

const editedB64 = await page.evaluate(async () => {
  const baked = await window.__shellyTest.session.buildSaveBytes();
  let s = '';
  const u = new Uint8Array(baked);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
});
await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await window.__shellyTest.openBytes(bytes, null, 'edited.pdf');
}, editedB64);
await page.waitForFunction(() => window.__shellyTest.viewer?.pages[0]?.rendered === true);
const editResult = await page.evaluate(async () => {
  const tc = await window.__shellyTest.viewer.pages[0].proxy.getTextContent();
  return tc.items.map((i) => i.str).join(' ');
});
check('replacement text is real, extractable text', /Corrected figure 9999/.test(editResult), editResult.slice(0, 80));
check('original line is destroyed, not just covered', !/searchable body/i.test(editResult));
check('rest of the page stays searchable via auto-OCR', /Chapter/i.test(editResult));
await page.screenshot({ path: path.join(outDir, '11-edittext.png') });

// ---------------------------------------------------------------------------
// Erase & replace picture, insert blank page, paste image from clipboard
// ---------------------------------------------------------------------------

await openFixtureTab(fixture, 'replace-pic.pdf');

// --- insert blank page after page 1 ---
await page.click('.thumbs.active .thumb:nth-child(1)');
await page.click('#pg-blank');
await page.waitForFunction(() => document.querySelectorAll('.viewer.active .page').length === 4);
check('blank page inserted', (await page.textContent('#page-total')).trim() === '/ 4');
const blankIsWhite = await page.evaluate(async () => {
  const t = window.__shellyTest;
  await t.viewer.renderPage(1);
  const c = t.viewer.pages[1].canvas;
  const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(200, c.height)).data;
  for (let i = 0; i < d.length; i += 400) if (d[i] < 250) return false;
  return true;
});
check('inserted page is blank white', blankIsWhite);

// --- paste an image (like an Excel table copied as a picture) ---
const tableB64 = await page.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 600;
  c.height = 200;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 600, 200);
  ctx.strokeStyle = '#1a3f9e';
  ctx.lineWidth = 3;
  for (let r = 0; r <= 4; r++) { ctx.beginPath(); ctx.moveTo(0, r * 50); ctx.lineTo(600, r * 50); ctx.stroke(); }
  for (let col = 0; col <= 3; col++) { ctx.beginPath(); ctx.moveTo(col * 200, 0); ctx.lineTo(col * 200, 200); ctx.stroke(); }
  ctx.fillStyle = '#111';
  ctx.font = '24px Arial';
  ctx.fillText('EIF.999 NEW SCHEDULE', 20, 32);
  return c.toDataURL('image/png').split(',')[1];
});
const pasted = await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const ok = await window.__shellyTest.pasteImageBytes(bytes, 'png');
  const it = window.__shellyTest.overlays.items.find((i) => i.type === 'image');
  return { ok, placed: !!it, pageIndex: it?.pageIndex };
}, tableB64);
check('clipboard image pastes onto the current page', pasted.ok && pasted.placed, `page=${pasted.pageIndex}`);
await page.evaluate(() => {
  const it = window.__shellyTest.overlays.items.find((i) => i.type === 'image');
  window.__shellyTest.overlays.remove(it.id); // keep the erase test clean
});

// --- quirky image formats (like email images) are normalized so they can't
// vanish on save: a JPEG mislabeled as PNG must still embed and survive ---
const quirkyJpegB64 = await page.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 200;
  c.height = 200;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#8e44ad';
  ctx.fillRect(0, 0, 200, 200);
  return c.toDataURL('image/jpeg', 0.9).split(',')[1]; // JPEG bytes…
});
const quirky = await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await window.__shellyTest.pasteImageBytes(bytes, 'png'); // …claimed to be PNG
  const it = window.__shellyTest.overlays.items.find((i) => i.type === 'image');
  const payload = window.__shellyTest.overlays.bakePayload().find((p) => p.type === 'image');
  const baked = await window.__shellyTest.engine.bakeOverlays(
    window.__shellyTest.state.bytes,
    [payload]
  );
  window.__shellyTest.overlays.remove(it.id);
  return { format: payload.format, grew: baked.length > window.__shellyTest.state.bytes.length };
}, quirkyJpegB64);
check(
  'mislabeled/quirky images are normalized and still save',
  quirky.format === 'png' && quirky.grew,
  `normalized to ${quirky.format}`
);

// --- dragging an overlay onto another page re-homes it (paste on page N,
// drag to page N+1, save: it must survive on the page it was dropped on) ---
await page.evaluate(() => window.__shellyTest.viewer.setZoom(0.5)); // several pages visible
await page.waitForFunction(() => window.__shellyTest.viewer.pages[0].rendered === true);
await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  window.__shellyTest.viewer.goToPage(0);
  await window.__shellyTest.pasteImageBytes(bytes, 'png');
}, tableB64);
const dragBoxes = await page.evaluate(() => {
  const ov = document.querySelector('.viewer.active .overlay.ov-image').getBoundingClientRect();
  const pages = document.querySelectorAll('.viewer.active .page');
  const target = pages[1].getBoundingClientRect();
  return {
    from: { x: ov.x + ov.width / 2, y: ov.y + ov.height / 2 },
    to: { x: target.x + target.width / 2, y: target.y + target.height / 2 },
  };
});
await page.mouse.move(dragBoxes.from.x, dragBoxes.from.y);
await page.mouse.down();
await page.mouse.move(dragBoxes.to.x, dragBoxes.to.y, { steps: 8 });
await page.mouse.up();
const rehomed = await page.evaluate(async () => {
  const t = window.__shellyTest;
  const it = t.overlays.items.find((i) => i.type === 'image');
  const vp = t.viewer.baseViewport(it.pageIndex);
  const onPage = it.y >= 0 && it.y + it.h <= vp.height + 1;
  const payload = t.overlays.bakePayload().find((p) => p.type === 'image');
  const baked = await t.engine.bakeOverlays(t.state.bytes, [payload]);
  t.overlays.remove(it.id);
  return { pageIndex: it.pageIndex, onPage, grew: baked.length > t.state.bytes.length };
});
check(
  'cross-page drag re-homes the overlay to the drop page',
  rehomed.pageIndex === 1 && rehomed.onPage && rehomed.grew,
  JSON.stringify(rehomed)
);

// --- erase & replace: erase the red header bar on page 1, drop an image in ---
await page.evaluate(() => window.__shellyTest.viewer.goToPage(0)); // scroll back up
await page.click('#tool-erase');
const headerBox = await page.evaluate(() => {
  const p = document.querySelector('.viewer.active .page');
  const r = p.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width };
});
await page.mouse.move(headerBox.x + 10, headerBox.y + 8);
await page.mouse.down();
await page.mouse.move(headerBox.x + headerBox.w - 10, headerBox.y + 60, { steps: 5 });
await page.mouse.up();
await page.waitForSelector('#erase-dialog[open]');
check('erase dialog offers replacement', true);
await page.click('#erase-only');
const eraseItem = await page.evaluate(() => {
  const it = window.__shellyTest.overlays.items.find((i) => i.type === 'erase');
  return it ? { pageIndex: it.pageIndex, x: it.x, y: it.y, w: it.w, h: it.h } : null;
});
check('erase box recorded', !!eraseItem && eraseItem.w > 100);

// programmatic replacement image into the erased area (file pickers can't be
// automated) — same code path as the dialog's "Choose picture…"
await page.evaluate(
  async ({ b64, rect }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const t = window.__shellyTest;
    await t.overlays.setPendingImage(bytes, 'png');
    t.overlays.placeImageInRect(0, rect);
  },
  { b64: tableB64, rect: eraseItem }
);

const replacedB64 = await page.evaluate(async () => {
  const baked = await window.__shellyTest.session.buildSaveBytes();
  let s = '';
  const u = new Uint8Array(baked);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
});
await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await window.__shellyTest.openBytes(bytes, null, 'replaced.pdf');
}, replacedB64);
await page.waitForFunction(() => window.__shellyTest.viewer?.pages[0]?.rendered === true);
const replacedPx = await page.evaluate((rect) => {
  const t = window.__shellyTest;
  const p = t.viewer.pages[0];
  const s = t.viewer.scale;
  const ratio = p.canvas.width / p.canvas.clientWidth;
  const ctx = p.canvas.getContext('2d');
  // a spot inside the erased strip but left of the centered fitted image:
  // was red header, must be white now
  const corner = ctx.getImageData(
    Math.round((rect.x + 5) * s * ratio),
    Math.round((rect.y + rect.h / 2) * s * ratio),
    1,
    1
  ).data;
  // the replacement image's grid line color should appear somewhere in the strip
  const band = ctx.getImageData(0, Math.round(rect.y * s * ratio), p.canvas.width, Math.round(rect.h * s * ratio)).data;
  let blueish = 0;
  for (let i = 0; i < band.length; i += 40) {
    if (band[i + 2] > 120 && band[i + 2] > band[i] + 40) blueish++;
  }
  return { corner: [...corner].slice(0, 3), blueish };
}, eraseItem);
check('erased area is white (old content gone)', replacedPx.corner.every((v) => v > 240), `rgb=${replacedPx.corner}`);
check('replacement picture rendered in the erased area', replacedPx.blueish > 20, `${replacedPx.blueish} px`);
await page.screenshot({ path: path.join(outDir, '12-replace.png') });

await browser.close();
server.close();

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll smoke checks passed.');
process.exit(failures ? 1 : 0);
