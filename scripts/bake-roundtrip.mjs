// Visual round-trip: place a text overlay + image, screenshot, bake into the
// PDF, reload the baked bytes, screenshot again. The two images should show
// the content in the same place. Also exercises a rotated page.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = '/home/user/shelly';
const out = process.env.SMOKE_OUT || path.join(root, 'scripts', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  try {
    const data = await readFile(path.join(root, 'dist', p));
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const page1 = doc.addPage([612, 792]);
page1.drawText('Anchor text for reference', { x: 60, y: 700, size: 20, font });
page1.drawLine({ start: { x: 0, y: 396 }, end: { x: 612, y: 396 }, thickness: 1 });
const fixture = await doc.save();

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const pg = await browser.newPage({ viewport: { width: 1100, height: 850 } });
pg.on('pageerror', (e) => console.log('[pageerror]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`);
await pg.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await window.__shellyTest.openBytes(bytes, null, 'roundtrip.pdf');
}, Buffer.from(fixture).toString('base64'));
await pg.waitForFunction(() => {
  const c = document.querySelector('#viewer .page canvas');
  return c && c.width > 0;
});

// rotate the page so we exercise the rotated-bake path too
await pg.click('#thumbs .thumb:nth-child(1)');
await pg.click('#pg-rotate-r');
await pg.waitForFunction(() => {
  const el = document.querySelector('#viewer .page');
  return el && el.offsetWidth > el.offsetHeight;
});

// place a 24pt green text box mid-page
await pg.click('#tool-text');
await pg.fill('#text-size', '24');
await pg.$eval('#text-size', (el) => el.dispatchEvent(new Event('change')));
await pg.$eval('#text-color', (el) => {
  el.value = '#0a7d20';
  el.dispatchEvent(new Event('input'));
});
await pg.click('#viewer .page', { position: { x: 300, y: 250 } });
await pg.keyboard.type('BAKED HERE');
await pg.click('#btn-sidebar'); // blur without touching page/toolbar inputs
await pg.click('#btn-sidebar');

await pg.screenshot({ path: path.join(out, 'rt-1-before-bake.png') });

const pos = await pg.evaluate(async () => {
  const t = window.__shellyTest;
  const overlayEl = document.querySelector('.overlay.ov-text');
  const before = overlayEl.getBoundingClientRect();
  const baked = await t.engine.bakeOverlays(t.state.bytes, t.overlays.bakePayload());
  t.overlays.clear();
  t.state.bytes = baked;
  await t.viewer.load(baked);
  return { x: before.x, y: before.y };
});
await pg.waitForFunction(() => {
  const c = document.querySelector('#viewer .page canvas');
  return c && c.width > 0;
});
await pg.screenshot({ path: path.join(out, 'rt-2-after-bake.png') });
console.log('overlay was at', pos);

// sample the pixel color where the text was — should be green now
const sample = await pg.evaluate(({ x, y }) => {
  const c = document.querySelector('#viewer .page canvas');
  const rect = c.getBoundingClientRect();
  const dpr = c.width / rect.width;
  const px = c
    .getContext('2d')
    .getImageData(Math.round((x - rect.x) * dpr), Math.round((y - rect.y) * dpr), 60 * dpr, 30 * dpr);
  let green = 0;
  for (let i = 0; i < px.data.length; i += 4) {
    if (px.data[i + 1] > 90 && px.data[i] < 100 && px.data[i + 2] < 100) green++;
  }
  return green;
}, pos);
console.log(sample > 20 ? '✓ baked text found at the placed position' : `✗ FAIL: only ${sample} green pixels near position`);

await browser.close();
server.close();
process.exit(sample > 20 ? 0 : 1);
