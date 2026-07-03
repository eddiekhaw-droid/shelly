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
import { chromium } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.SMOKE_OUT || path.join(root, 'scripts', 'out');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

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

await page.waitForFunction(() => document.querySelectorAll('#viewer .page canvas').length === 3);
await page.waitForFunction(() => {
  const c = document.querySelector('#viewer .page canvas');
  return c && c.width > 0;
});
check('opens a 3-page PDF', (await page.textContent('#page-total')).trim() === '/ 3');

// canvas actually painted? sample the colored header bar
const painted = await page.evaluate(() => {
  const c = document.querySelector('#viewer .page canvas');
  const px = c.getContext('2d').getImageData(Math.floor(c.width / 2), 10, 1, 1).data;
  return px[0] > 150 && px[1] < 150; // reddish header on page 1
});
check('page 1 canvas is painted with content', painted);

const textLayerSpans = await page.locator('#viewer .page .textLayer span').count();
check('text layer built (selectable text)', textLayerSpans > 0, `${textLayerSpans} spans`);

await page.waitForFunction(() => document.querySelectorAll('#thumbs .thumb').length === 3);
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
await page.click('#thumbs .thumb:nth-child(2)');
await page.click('#pg-rotate-r');
await page.waitForFunction(() => !document.getElementById('btn-undo').disabled);
const rot = await page.evaluate(() =>
  window.__shellyTest.engine.getPageRotation(window.__shellyTest.state.bytes, 1)
);
check('rotate right sets /Rotate 90 on page 2', rot === 90);
const landscape = await page.evaluate(() => {
  const el = document.querySelectorAll('#viewer .page')[1];
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
await page.click('#viewer .page', { position: { x: 200, y: 300 } });
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
await page.click('#thumbs .thumb:nth-child(1)');
await page.click('#pg-delete');
await page.waitForFunction(() => document.querySelectorAll('#viewer .page').length === 2);
check('delete page leaves 2 pages', (await page.textContent('#page-total')).trim() === '/ 2');

// --- undo restores it ---
await page.click('#btn-undo');
await page.waitForFunction(() => document.querySelectorAll('#viewer .page').length === 3);
check('undo restores the deleted page', true);

// --- a second undo takes back the text overlay ---
check('overlay survived the delete/undo cycle', await page.evaluate(() => window.__shellyTest.overlays.items.length === 1));
await page.click('#btn-undo');
await page.waitForFunction(() => window.__shellyTest.overlays.items.length === 0);
check('second undo removes the text overlay', true);

// --- zoom ---
const w1 = await page.evaluate(() => document.querySelector('#viewer .page').offsetWidth);
await page.click('#btn-zoom-in');
await page.waitForFunction(
  (prev) => document.querySelector('#viewer .page').offsetWidth > prev,
  w1
);
check('zoom in enlarges pages', true);

await browser.close();
server.close();

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll smoke checks passed.');
process.exit(failures ? 1 : 0);
