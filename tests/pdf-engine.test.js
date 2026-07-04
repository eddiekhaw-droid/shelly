import { describe, it, expect, beforeAll } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  validatePdf,
  getPageCount,
  getPageRotation,
  getPageSize,
  rotatePages,
  deletePages,
  reorderPages,
  extractPages,
  insertPdf,
  bakeOverlays,
  applyFormValues,
  readFormValues,
  countTextAnnotations,
  countAnnotations,
} from '../src/pdf-engine.js';

// Pages get distinct widths (100, 110, 120, …) so each page stays
// identifiable after structural edits.
async function makeFixture(pageCount, startWidth = 100) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([startWidth + i * 10, 500]);
    page.drawText(`Page ${i + 1}`, { x: 10, y: 450, size: 14, font });
  }
  return doc.save();
}

async function widths(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => Math.round(p.getSize().width));
}

// 1x1 red pixel
const PNG_BYTES = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  ),
  (c) => c.charCodeAt(0)
);

let fixture5;

beforeAll(async () => {
  fixture5 = await makeFixture(5); // widths 100..140
});

describe('validatePdf', () => {
  it('returns the page count for a healthy PDF', async () => {
    expect(await validatePdf(fixture5)).toBe(5);
  });

  it('rejects garbage bytes with a friendly message', async () => {
    await expect(validatePdf(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/could not be opened/);
  });
});

describe('rotatePages', () => {
  it('rotates selected pages and wraps around 360', async () => {
    let bytes = await rotatePages(fixture5, [0, 2], 90);
    expect(await getPageRotation(bytes, 0)).toBe(90);
    expect(await getPageRotation(bytes, 1)).toBe(0);
    expect(await getPageRotation(bytes, 2)).toBe(90);

    bytes = await rotatePages(bytes, [0], -180);
    expect(await getPageRotation(bytes, 0)).toBe(270);

    bytes = await rotatePages(bytes, [0], 90);
    expect(await getPageRotation(bytes, 0)).toBe(0);
  });
});

describe('deletePages', () => {
  it('removes the requested pages', async () => {
    const bytes = await deletePages(fixture5, [1, 3]);
    expect(await getPageCount(bytes)).toBe(3);
    expect(await widths(bytes)).toEqual([100, 120, 140]);
  });

  it('refuses to delete every page', async () => {
    await expect(deletePages(fixture5, [0, 1, 2, 3, 4])).rejects.toThrow(/at least one page/);
  });
});

describe('reorderPages', () => {
  it('reorders pages according to the given order', async () => {
    const bytes = await reorderPages(fixture5, [4, 2, 0, 1, 3]);
    expect(await widths(bytes)).toEqual([140, 120, 100, 110, 130]);
  });

  it('rejects an order that is not a permutation', async () => {
    await expect(reorderPages(fixture5, [0, 0, 1, 2, 3])).rejects.toThrow(/Invalid page order/);
  });
});

describe('extractPages', () => {
  it('copies the selected pages into a new document', async () => {
    const bytes = await extractPages(fixture5, [1, 4]);
    expect(await getPageCount(bytes)).toBe(2);
    expect(await widths(bytes)).toEqual([110, 140]);
  });
});

describe('insertPdf', () => {
  it('inserts all pages of another PDF at the given position', async () => {
    const other = await makeFixture(2, 300); // widths 300, 310
    const bytes = await insertPdf(fixture5, other, 1);
    expect(await getPageCount(bytes)).toBe(7);
    expect(await widths(bytes)).toEqual([100, 300, 310, 110, 120, 130, 140]);
  });

  it('clamps the insert position to the end', async () => {
    const other = await makeFixture(1, 300);
    const bytes = await insertPdf(fixture5, other, 99);
    expect(await widths(bytes)).toEqual([100, 110, 120, 130, 140, 300]);
  });
});

describe('bakeOverlays', () => {
  it('draws text and image overlays and still produces a loadable PDF', async () => {
    const overlays = [
      {
        type: 'text',
        pageIndex: 0,
        x: 20,
        y: 400,
        text: 'Hello\nWorld',
        size: 18,
        lineHeight: 22,
        color: { r: 0.8, g: 0.1, b: 0.1 },
      },
      { type: 'image', pageIndex: 2, x: 30, y: 200, width: 50, height: 50, bytes: PNG_BYTES, format: 'png' },
    ];
    const before = fixture5.length;
    const bytes = await bakeOverlays(fixture5, overlays);
    expect(bytes.length).toBeGreaterThan(before);
    expect(await getPageCount(bytes)).toBe(5);
  });

  it('draws upright on rotated pages without throwing', async () => {
    const rotated = await rotatePages(fixture5, [1], 90);
    const bytes = await bakeOverlays(rotated, [
      {
        type: 'text',
        pageIndex: 1,
        x: 50,
        y: 50,
        text: 'Rotated note',
        size: 12,
        lineHeight: 15,
        color: { r: 0, g: 0, b: 0 },
      },
    ]);
    expect(await getPageRotation(bytes, 1)).toBe(90);
  });

  it('returns input bytes untouched when there are no overlays', async () => {
    expect(await bakeOverlays(fixture5, [])).toBe(fixture5);
  });

  it('preserves page size', async () => {
    const { width } = await getPageSize(fixture5, 3);
    expect(width).toBe(130);
  });

  it('adds highlights as real /Highlight annotations', async () => {
    const bytes = await bakeOverlays(fixture5, [
      {
        type: 'highlight',
        pageIndex: 0,
        rects: [
          { x: 10, y: 440, width: 80, height: 16 },
          { x: 10, y: 420, width: 60, height: 16 },
        ],
        color: { r: 1, g: 0.9, b: 0.3 },
      },
    ]);
    expect(await countAnnotations(bytes, 0, 'Highlight')).toBe(1);
    expect(await countAnnotations(bytes, 1, 'Highlight')).toBe(0);
    expect(await getPageCount(bytes)).toBe(5);
  });

  it('draws an opaque fill behind text overlays that request it', async () => {
    const bytes = await bakeOverlays(fixture5, [
      {
        type: 'text',
        pageIndex: 0,
        x: 20,
        y: 400,
        text: 'Corrected value',
        size: 14,
        lineHeight: 17.5,
        color: { r: 0, g: 0, b: 0 },
        bg: { x: 18, y: 394, width: 120, height: 20 },
      },
    ]);
    expect(bytes.length).toBeGreaterThan(fixture5.length);
    expect(await getPageCount(bytes)).toBe(5);
  });

  it('adds sticky notes as real /Text annotations', async () => {
    const bytes = await bakeOverlays(fixture5, [
      { type: 'note', pageIndex: 1, x: 50, y: 400, size: 18, text: 'Check this figure', color: { r: 1, g: 0.83, b: 0 } },
      { type: 'note', pageIndex: 1, x: 90, y: 300, size: 18, text: 'Second note', color: { r: 1, g: 0.83, b: 0 } },
      { type: 'note', pageIndex: 1, x: 90, y: 200, size: 18, text: '   ', color: { r: 1, g: 0.83, b: 0 } },
    ]);
    expect(await countTextAnnotations(bytes, 1)).toBe(2); // whitespace-only note skipped
    expect(await countTextAnnotations(bytes, 0)).toBe(0);
  });
});

describe('applyFormValues', () => {
  async function makeFormFixture() {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const form = doc.getForm();
    const name = form.createTextField('applicant.name');
    name.addToPage(page, { x: 20, y: 340, width: 200, height: 24 });
    const agree = form.createCheckBox('agree');
    agree.addToPage(page, { x: 20, y: 300, width: 18, height: 18 });
    const color = form.createRadioGroup('color');
    color.addOptionToPage('red', page, { x: 20, y: 260, width: 18, height: 18 });
    color.addOptionToPage('blue', page, { x: 60, y: 260, width: 18, height: 18 });
    const size = form.createDropdown('size');
    size.addOptions(['S', 'M', 'L']);
    size.addToPage(page, { x: 20, y: 220, width: 80, height: 24 });
    return doc.save();
  }

  it('writes text, checkbox, radio and dropdown values', async () => {
    const fixture = await makeFormFixture();
    const bytes = await applyFormValues(fixture, [
      { name: 'applicant.name', value: 'Eddie Khaw' },
      { name: 'agree', value: true },
      { name: 'color', value: 'blue' },
      { name: 'size', value: 'M' },
    ]);
    const values = await readFormValues(bytes);
    expect(values['applicant.name']).toBe('Eddie Khaw');
    expect(values['agree']).toBe(true);
    expect(values['color']).toBe('blue');
    expect(values['size']).toEqual(['M']);
  });

  it('skips unknown fields and bad options without failing', async () => {
    const fixture = await makeFormFixture();
    const bytes = await applyFormValues(fixture, [
      { name: 'no.such.field', value: 'x' },
      { name: 'color', value: 'green' }, // not an option
      { name: 'applicant.name', value: 'Still applied' },
    ]);
    const values = await readFormValues(bytes);
    expect(values['applicant.name']).toBe('Still applied');
  });

  it('returns input bytes untouched when there is nothing to apply', async () => {
    const fixture = await makeFormFixture();
    expect(await applyFormValues(fixture, [])).toBe(fixture);
  });
});
