// All PDF mutation lives here, as pure bytes-in/bytes-out functions built on
// pdf-lib. No DOM access, so the whole module is unit-testable in Node.

import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

async function load(bytes) {
  return PDFDocument.load(bytes, { updateMetadata: false });
}

/**
 * Throws a friendly error for encrypted/corrupt files; returns page count on
 * success. Used by the app to validate a file before adopting it.
 */
export async function validatePdf(bytes) {
  let doc;
  try {
    doc = await load(bytes);
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/encrypted/i.test(msg)) {
      throw new Error('This PDF is password-protected. Encrypted files are not supported.');
    }
    throw new Error('This file could not be opened as a PDF. It may be corrupt.');
  }
  return doc.getPageCount();
}

export async function getPageCount(bytes) {
  return (await load(bytes)).getPageCount();
}

export async function getPageRotation(bytes, pageIndex) {
  return (await load(bytes)).getPage(pageIndex).getRotation().angle;
}

export async function getPageSize(bytes, pageIndex) {
  const { width, height } = (await load(bytes)).getPage(pageIndex).getSize();
  return { width, height };
}

/** Rotate the given pages by delta degrees (multiple of 90, either sign). */
export async function rotatePages(bytes, pageIndices, delta) {
  const doc = await load(bytes);
  for (const i of pageIndices) {
    const page = doc.getPage(i);
    const next = (((page.getRotation().angle + delta) % 360) + 360) % 360;
    page.setRotation(degrees(next));
  }
  return doc.save();
}

export async function deletePages(bytes, pageIndices) {
  const doc = await load(bytes);
  const unique = [...new Set(pageIndices)];
  if (unique.length >= doc.getPageCount()) {
    throw new Error('A PDF must keep at least one page.');
  }
  unique.sort((a, b) => b - a).forEach((i) => doc.removePage(i));
  return doc.save();
}

/**
 * newOrder[k] = index (in the current document) of the page that should end
 * up at position k. Reorders in place so document-level structures such as
 * the outline and AcroForm keep pointing at the same page objects.
 */
export async function reorderPages(bytes, newOrder) {
  const doc = await load(bytes);
  const count = doc.getPageCount();
  const valid =
    newOrder.length === count && [...newOrder].sort((a, b) => a - b).every((v, i) => v === i);
  if (!valid) throw new Error('Invalid page order.');
  const pages = doc.getPages();
  for (let i = count - 1; i >= 0; i--) doc.removePage(i);
  for (const oldIndex of newOrder) doc.addPage(pages[oldIndex]);
  return doc.save();
}

/** Copy the given pages into a brand-new PDF (Extract). */
export async function extractPages(bytes, pageIndices) {
  const src = await load(bytes);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pageIndices);
  copied.forEach((p) => out.addPage(p));
  return out.save();
}

/** Insert every page of `otherBytes` into `bytes` starting at `atIndex`. */
export async function insertPdf(bytes, otherBytes, atIndex) {
  const doc = await load(bytes);
  const other = await load(otherBytes);
  const at = Math.max(0, Math.min(atIndex, doc.getPageCount()));
  const copied = await doc.copyPages(other, other.getPageIndices());
  copied.forEach((p, k) => doc.insertPage(at + k, p));
  return doc.save();
}

/**
 * Permanently draw overlay objects into the document.
 *
 * Coordinates are in PDF user space (origin bottom-left, points), already
 * converted by the caller from viewer coordinates. Each overlay is drawn with
 * `rotate` equal to the page's /Rotate angle so that it reads upright in the
 * orientation the user actually sees.
 *
 * overlays: Array of
 *   { type:'text',  pageIndex, x, y, text, size, lineHeight, color:{r,g,b} }
 *     — (x, y) is the baseline start of the first line, pre-rotation.
 *   { type:'image', pageIndex, x, y, width, height, bytes, format:'png'|'jpeg' }
 *     — (x, y) is the corner that appears bottom-left on screen.
 */
export async function bakeOverlays(bytes, overlays) {
  if (!overlays.length) return bytes;
  const doc = await load(bytes);
  let font = null;

  for (const ov of overlays) {
    const page = doc.getPage(ov.pageIndex);
    const rotate = degrees(page.getRotation().angle);
    if (ov.type === 'text') {
      if (!ov.text.trim()) continue;
      if (!font) font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText(ov.text, {
        x: ov.x,
        y: ov.y,
        size: ov.size,
        lineHeight: ov.lineHeight,
        font,
        color: rgb(ov.color.r, ov.color.g, ov.color.b),
        rotate,
      });
    } else if (ov.type === 'image') {
      const image =
        ov.format === 'png' ? await doc.embedPng(ov.bytes) : await doc.embedJpg(ov.bytes);
      page.drawImage(image, {
        x: ov.x,
        y: ov.y,
        width: ov.width,
        height: ov.height,
        rotate,
      });
    }
  }
  return doc.save();
}
