// Copies the Tesseract worker, WASM cores, and English language data into
// Vite's public dir so OCR runs fully offline (no CDN). Runs before `vite
// build`; the files land in dist/ocr/ and ship inside the installer.
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src', 'public', 'ocr');
await mkdir(out, { recursive: true });

const files = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  // the worker picks one of these depending on CPU WASM feature support
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  [
    'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
    'tesseract-core-relaxedsimd-lstm.wasm.js',
  ],
  ['@tesseract.js-data/eng/4.0.0/eng.traineddata.gz', 'eng.traineddata.gz'],
];

for (const [src, dest] of files) {
  await copyFile(path.join(root, 'node_modules', src), path.join(out, dest));
}
console.log(`OCR assets copied to ${out}`);
