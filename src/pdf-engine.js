// All PDF mutation lives here, as pure bytes-in/bytes-out functions built on
// pdf-lib. No DOM access, so the whole module is unit-testable in Node.

import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFHexString,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
  StandardFonts,
  degrees,
  rgb,
} from 'pdf-lib';

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
 *   { type:'highlight', pageIndex, rects:[{x,y,width,height}], color:{r,g,b} }
 *     — drawn with Multiply blending so the text underneath stays legible.
 *   { type:'note', pageIndex, x, y, size, text, color:{r,g,b} }
 *     — becomes a real /Text (sticky note) annotation other readers can open.
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
    } else if (ov.type === 'highlight') {
      for (const r of ov.rects) {
        page.drawRectangle({
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          color: rgb(ov.color.r, ov.color.g, ov.color.b),
          blendMode: 'Multiply',
          rotate,
        });
      }
    } else if (ov.type === 'note') {
      if (!ov.text.trim()) continue;
      addTextAnnotation(doc, ov);
    }
  }
  return doc.save();
}

/** Append a /Text (sticky note) annotation to a page. */
function addTextAnnotation(doc, ov) {
  const page = doc.getPage(ov.pageIndex);
  const size = ov.size || 18;
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [ov.x, ov.y, ov.x + size, ov.y + size],
    Contents: PDFHexString.fromText(ov.text),
    T: PDFHexString.fromText('Note'),
    Name: 'Comment',
    C: [ov.color.r, ov.color.g, ov.color.b],
    F: 4, // print
  });
  const ref = doc.context.register(annot);
  const annots = page.node.lookup(PDFName.of('Annots'));
  if (annots instanceof PDFArray) {
    annots.push(ref);
  } else {
    page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
  }
}

/**
 * Write user-entered form values into the document's AcroForm fields.
 * values: [{ name, value }] where value is a string (text/choice fields),
 * boolean (checkboxes) or the selected option's export value (radio groups).
 * Unknown fields and type mismatches are skipped rather than failing the save.
 */
export async function applyFormValues(bytes, values) {
  if (!values.length) return bytes;
  const doc = await load(bytes);
  const form = doc.getForm();
  for (const { name, value } of values) {
    let field;
    try {
      field = form.getField(name);
    } catch {
      continue;
    }
    try {
      if (field instanceof PDFTextField) field.setText(value == null ? '' : String(value));
      else if (field instanceof PDFCheckBox) value ? field.check() : field.uncheck();
      else if (field instanceof PDFRadioGroup && typeof value === 'string') field.select(value);
      else if (field instanceof PDFDropdown || field instanceof PDFOptionList) field.select(value);
    } catch {
      // e.g. selecting an option the field doesn't have — leave the field as-is
    }
  }
  try {
    form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica));
  } catch {
    // some exotic fields can't regenerate appearances; values are still set
  }
  return doc.save();
}

/** Names/values of the document's form fields (used by tests and debugging). */
export async function readFormValues(bytes) {
  const doc = await load(bytes);
  const out = {};
  for (const field of doc.getForm().getFields()) {
    if (field instanceof PDFTextField) out[field.getName()] = field.getText();
    else if (field instanceof PDFCheckBox) out[field.getName()] = field.isChecked();
    else if (field instanceof PDFRadioGroup || field instanceof PDFDropdown)
      out[field.getName()] = field.getSelected();
  }
  return out;
}

/** Count /Text annotations on a page (used by tests). */
export async function countTextAnnotations(bytes, pageIndex) {
  const doc = await load(bytes);
  const annots = doc.getPage(pageIndex).node.lookup(PDFName.of('Annots'));
  if (!(annots instanceof PDFArray)) return 0;
  let count = 0;
  for (let i = 0; i < annots.size(); i++) {
    const a = annots.lookup(i);
    if (a && a.get(PDFName.of('Subtype')) === PDFName.of('Text')) count++;
  }
  return count;
}
