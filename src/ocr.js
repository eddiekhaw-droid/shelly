// Local OCR via tesseract.js. All assets (worker, WASM core, English model)
// are served from ./ocr/ alongside the app bundle — nothing goes online.

import { createWorker } from 'tesseract.js';

let workerPromise = null;

function getWorker() {
  workerPromise ??= createWorker('eng', 1, {
    workerPath: new URL('ocr/worker.min.js', location.href).href,
    corePath: new URL('ocr', location.href).href,
    langPath: new URL('ocr', location.href).href,
    workerBlobURL: false,
  });
  return workerPromise;
}

/**
 * Recognize text on a rendered page canvas.
 * Returns words as [{ text, bbox: {x0, y0, x1, y1}, confidence }] in canvas
 * pixel coordinates.
 */
export async function recognizeCanvas(canvas) {
  const worker = await getWorker();
  const { data } = await worker.recognize(canvas.toDataURL('image/png'), {}, { blocks: true });
  const words = [];
  const walk = (blocks) => {
    for (const block of blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          for (const word of line.words || []) {
            if (word.text?.trim()) {
              words.push({ text: word.text, bbox: word.bbox, confidence: word.confidence ?? 100 });
            }
          }
        }
      }
    }
  };
  if (data.blocks) walk(data.blocks);
  else if (data.words) {
    for (const w of data.words) {
      if (w.text?.trim()) words.push({ text: w.text, bbox: w.bbox, confidence: w.confidence ?? 100 });
    }
  }
  return words;
}
