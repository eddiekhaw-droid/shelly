// Copies runtime assets into Vite's public dir so everything works fully
// offline (no CDN). Runs before `vite build`; the files land in dist/ and
// ship inside the installer.
//
// - ocr/: Tesseract worker, WASM cores, English language data
// - pdfjs/: pdf.js side assets — wasm image codecs (JBIG2/JPEG2000 scans!),
//   CJK character maps, the 14 standard fonts, ICC profiles. Without these,
//   e.g. photocopier scans (JBIG2-compressed) render as blank pages.
import { mkdir, copyFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = (p) => path.join(root, 'node_modules', p);

const ocrOut = path.join(root, 'src', 'public', 'ocr');
await mkdir(ocrOut, { recursive: true });
const ocrFiles = [
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
for (const [src, dest] of ocrFiles) {
  await copyFile(nm(src), path.join(ocrOut, dest));
}

const pdfjsOut = path.join(root, 'src', 'public', 'pdfjs');
for (const dir of ['wasm', 'cmaps', 'standard_fonts', 'iccs']) {
  await cp(nm(`pdfjs-dist/${dir}`), path.join(pdfjsOut, dir), { recursive: true });
}

console.log(`Assets copied to ${ocrOut} and ${pdfjsOut}`);
