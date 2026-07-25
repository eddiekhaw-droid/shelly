// Smoke test for the Shelly Invaders easter egg: open via button + Konami,
// play a few seconds, verify firing kills invaders and scores, pause, close.
// Usage: node scripts/arcade-smoke.mjs  (run `npm run build` first)
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.SMOKE_OUT || path.join(root, 'scripts', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };

const server = await new Promise((resolve) => {
  const s = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    try {
      const data = await readFile(path.join(root, 'dist', p));
      res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const port = server.address().port;
await mkdir(outDir, { recursive: true });

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` (${extra})` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.on('pageerror', (err) => { failures++; console.log('  ✗ page error:', err.message); });

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForSelector('#empty-arcade');

// Open via the start-screen button
await page.click('#empty-arcade');
check('overlay opens from start screen', await page.isVisible('#arcade canvas'));
check('starts on title screen', await page.evaluate(() => window.__shellyTest.arcade.mode === 'title'));
await page.screenshot({ path: `${outDir}/arcade-title.png` });

// Space starts the game
await page.keyboard.press('Space');
check('Space starts play', await page.evaluate(() => window.__shellyTest.arcade.mode === 'play'));
check('55 invaders spawned', await page.evaluate(() => window.__shellyTest.arcade.invaders.length === 55));

// Hold fire + wiggle for a few seconds; the auto-fire loop should kill some invaders
await page.keyboard.down(' ');
for (let i = 0; i < 12; i++) {
  await page.keyboard.down(i % 2 ? 'ArrowLeft' : 'ArrowRight');
  await page.waitForTimeout(400);
  await page.keyboard.up(i % 2 ? 'ArrowLeft' : 'ArrowRight');
}
await page.keyboard.up(' ');
const { score, dead, mode } = await page.evaluate(() => {
  const g = window.__shellyTest.arcade;
  return { score: g.score, dead: g.invaders.filter((i) => !i.alive).length, mode: g.mode };
});
check('invaders die when shot', dead > 0, `${dead} killed`);
check('score increases', score > 0, `score ${score}`);
console.log(`  mode after play: ${mode}`);
await page.screenshot({ path: `${outDir}/arcade-play.png` });

// Pause / resume
if (mode === 'play') {
  await page.keyboard.press('p');
  check('P pauses', await page.evaluate(() => window.__shellyTest.arcade.mode === 'pause'));
  await page.keyboard.press('p');
  check('P resumes', await page.evaluate(() => window.__shellyTest.arcade.mode === 'play'));
}

// High score persisted
const hs = await page.evaluate(() => Number(localStorage.getItem('shelly.arcade.highscore')) || window.__shellyTest.arcade.highScore);
console.log(`  high score slot: ${hs}`);

// Esc closes and app shortcuts work again
await page.keyboard.press('Escape');
check('Esc closes the overlay', (await page.$('#arcade')) === null);
check('instance cleared', await page.evaluate(() => window.__shellyTest.arcade === null));

// Konami code reopens it
for (const k of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']) {
  await page.keyboard.press(k);
}
check('Konami code opens the game', (await page.$('#arcade')) !== null);
await page.keyboard.press('Escape');

await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
