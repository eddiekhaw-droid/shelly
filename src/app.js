import * as engine from './pdf-engine.js';
import { recognizeCanvas } from './ocr.js';
import { Viewer } from './viewer.js';
import { Thumbnails } from './thumbnails.js';
import { Searcher } from './search.js';
import { OverlayManager } from './overlays.js';
import { openArcade, installKonami, currentGame } from './arcade.js';

const $ = (id) => document.getElementById(id);
const UNDO_LIMIT = 20;

// ---------------------------------------------------------------------------
// Host: Electron preload API, or a browser fallback (file input + download)
// so the renderer also runs in a plain browser for development and testing.
// ---------------------------------------------------------------------------

const host = window.shelly ?? makeBrowserHost();

function makeBrowserHost() {
  const readFile = async (file) => ({
    path: null,
    name: file.name,
    format: file.type === 'image/png' ? 'png' : 'jpeg',
    data: new Uint8Array(await file.arrayBuffer()),
  });
  const pick = (input) =>
    new Promise((resolve) => {
      input.onchange = async () => {
        const files = [...input.files];
        input.value = '';
        if (!files.length) return resolve({ canceled: true });
        resolve({ canceled: false, files: await Promise.all(files.map(readFile)) });
      };
      input.click();
    });

  return {
    openPdf: () => pick($('file-fallback')),
    openImage: async () => {
      const res = await pick($('image-fallback'));
      return res.canceled ? res : { canceled: false, ...res.files[0] };
    },
    saveAsDialog: async (defaultName) => ({ canceled: false, path: `download:${defaultName}` }),
    savePdf: async (path, data) => {
      const name = path.startsWith('download:') ? path.slice(9) : 'document.pdf';
      const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return { ok: true };
    },
    setDirty: () => {},
    confirmClose: () => window.close(),
    onMenu: () => {},
    onOpenFiles: () => {},
  };
}

// ---------------------------------------------------------------------------
// Sessions: one open document per tab, each with its own viewer, thumbnails,
// overlays, search, undo history, and scroll/zoom state.
// ---------------------------------------------------------------------------

const sessions = [];
let current = null;

let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = isError ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 3000);
}

class Session {
  constructor(bytes, path, name, { readOnly = false, password = undefined } = {}) {
    this.state = { bytes, path, name, dirty: false, undo: [], redo: [] };
    this.readOnly = readOnly; // encrypted docs open view-only
    this.password = password;
    this.overlayShadow = [];
    this.ocr = new Map(); // pageIndex → words pending bake into the PDF
    this.ocrRunning = false;

    this.viewerEl = document.createElement('div');
    this.viewerEl.className = 'viewer';
    this.viewerEl.tabIndex = 0;
    $('viewers').appendChild(this.viewerEl);

    this.thumbsEl = document.createElement('div');
    this.thumbsEl.className = 'thumbs';
    $('thumbs-host').appendChild(this.thumbsEl);

    this.outlineEl = document.createElement('div');
    this.outlineEl.className = 'outline';
    $('thumbs-host').appendChild(this.outlineEl);

    this.tabEl = document.createElement('div');
    this.tabEl.className = 'tab';
    const label = document.createElement('span');
    label.className = 'tab-label';
    const dirtyDot = document.createElement('span');
    dirtyDot.className = 'tab-dirty';
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '✕';
    close.title = 'Close tab';
    this.tabEl.append(label, dirtyDot, close);
    $('tabbar').appendChild(this.tabEl);
    this.tabEl.addEventListener('click', (e) => {
      if (e.target === close) return;
      activateSession(this);
    });
    close.addEventListener('click', () => closeSession(this));

    this.viewer = new Viewer(this.viewerEl);
    this.thumbs = new Thumbnails(this.thumbsEl);
    this.searcher = new Searcher(this.viewer, { count: $('find-count') });
    this.overlays = new OverlayManager(this.viewer);

    const ifActive = (fn) => () => {
      if (current === this) fn();
    };

    this.viewer.addEventListener('pagechange', (e) => {
      if (current !== this) return;
      $('page-num').value = e.detail.pageIndex + 1;
      this.thumbs.setCurrent(e.detail.pageIndex);
    });
    this.viewer.addEventListener('layout', ifActive(refreshUi));
    this.viewer.addEventListener('formchange', () => this.markDirty(true));

    this.overlays.addEventListener('change', (e) => {
      // Non-structural changes are live typing; they become undoable only
      // when committed (blur), which arrives as a structural change.
      if (e.detail.structural) {
        this.state.undo.push({ bytes: this.state.bytes, overlays: this.overlayShadow });
        if (this.state.undo.length > UNDO_LIMIT) this.state.undo.shift();
        this.state.redo = [];
        this.overlayShadow = this.overlays.snapshot();
      }
      this.markDirty(true);
    });
    this.overlays.addEventListener('imageplaced', () => setTool('select'));
    wireEraseDialog(this);
    this.overlays.addEventListener('edittextrequest', (e) => {
      const { pageIndex, x, y } = e.detail;
      this.editTextAt(pageIndex, x, y).catch((err) => toast(err.message, true));
    });
    this.overlays.addEventListener('selectionchange', (e) => {
      if (current !== this) return;
      const item = e.detail.item;
      if (item?.type === 'text' || item?.type === 'edittext') {
        $('text-size').value = Math.round(item.size);
        $('text-color').value = item.color;
        $('text-font').value = item.font || 'Helvetica';
        $('text-bg').checked = !!item.bg;
        $('text-bg').parentElement.style.display = item.type === 'text' ? '' : 'none';
        $('text-props').classList.add('visible');
      }
    });

    this.thumbs.addEventListener('goto', (e) => this.viewer.goToPage(e.detail.pageIndex));
    this.thumbs.addEventListener('select', ifActive(refreshUi));
    this.thumbs.addEventListener('reorder', (e) => {
      const order = e.detail.order;
      this.structuralOp(
        (bytes) => engine.reorderPages(bytes, order),
        () => {
          this.overlays.remapAfterReorder(order);
          this.#remapOcr((i) => order.indexOf(i));
        }
      );
    });
  }

  markDirty(dirty) {
    this.state.dirty = dirty;
    host.setDirty(sessions.some((s) => s.state.dirty));
    updateTabs();
    if (current === this) refreshUi();
  }

  async reload({ keepPage = true } = {}) {
    const page = keepPage ? this.viewer.currentPage : 0;
    await this.viewer.load(this.state.bytes, this.password);
    for (const [i, words] of this.ocr) this.viewer.setOcrPage(i, words); // pending OCR
    this.searcher.reset();
    this.overlays.mountAll();
    this.thumbs.build(this.viewer); // not awaited: thumbnails fill in behind
    this.buildOutline(); // not awaited either
    if (keepPage && page > 0) this.viewer.goToPage(Math.min(page, this.viewer.pageCount - 1));
    this.overlayShadow = this.overlays.snapshot();
    if (current === this) syncSessionUi();
  }

  /** Snapshot for undo, transform bytes, remap overlays, reload. */
  async structuralOp(fn, remapOverlays) {
    if (this.readOnly) {
      toast('This document is password-protected and opened read-only.', true);
      return;
    }
    this.state.undo.push({ bytes: this.state.bytes, overlays: this.overlays.snapshot() });
    if (this.state.undo.length > UNDO_LIMIT) this.state.undo.shift();
    this.state.redo = [];
    try {
      const next = await fn(this.state.bytes);
      if (remapOverlays) remapOverlays();
      this.state.bytes = next;
      await this.reload();
      this.markDirty(true);
    } catch (err) {
      this.state.undo.pop();
      toast(err.message, true);
      if (current === this) refreshUi();
    }
  }

  targetPages() {
    const sel = this.thumbs.selection;
    return sel.length ? sel : [this.viewer.currentPage];
  }

  /**
   * Edit Text tool: find the line of existing text at a click point and open
   * it as a pre-filled editable box. Works on real text and OCR'd words.
   */
  async editTextAt(pageIndex, clickX, clickY) {
    const proxy = this.viewer.pages[pageIndex].proxy;
    const vp1 = this.viewer.baseViewport(pageIndex);
    const tc = await proxy.getTextContent();

    // Every text run mapped to view points: left/baseline/width/height.
    const runs = [];
    const addRun = (str, transform, width, fontName) => {
      if (!str?.trim()) return;
      const h = Math.hypot(transform[2], transform[3]);
      const [vx, vy] = vp1.convertToViewportPoint(transform[4], transform[5]);
      runs.push({ str, x: vx, baseline: vy, w: width, h, fontName });
    };
    for (const it of tc.items) if ('str' in it) addRun(it.str, it.transform, it.width, it.fontName);
    for (const it of this.viewer.ocrItems(pageIndex)) addRun(it.str, it.transform, it.width, null);

    // The clicked line: same baseline (±40% of height), then the horizontally
    // contiguous segment nearest the click (so table columns stay separate).
    const onLine = runs
      .filter((r) => clickY >= r.baseline - r.h * 1.15 && clickY <= r.baseline + r.h * 0.4)
      .sort((a, b) => a.x - b.x);
    if (!onLine.length) {
      toast('No text found there — use + Text to add new text.');
      return;
    }
    const segments = [];
    for (const r of onLine) {
      const last = segments[segments.length - 1];
      if (last && r.x - (last.x + last.w) < Math.max(8, r.h * 1.5)) {
        // continue segment; add a space when the gap looks like a word break
        const gap = r.x - (last.x + last.w);
        const needSpace = gap > r.h * 0.22 && !last.text.endsWith(' ') && !r.str.startsWith(' ');
        last.text += (needSpace ? ' ' : '') + r.str;
        last.w = r.x + r.w - last.x;
        last.h = Math.max(last.h, r.h);
        last.baseline = Math.max(last.baseline, r.baseline);
      } else {
        segments.push({ x: r.x, w: r.w, h: r.h, baseline: r.baseline, text: r.str, fontName: r.fontName });
      }
    }
    let seg = segments.find((s) => clickX >= s.x - 4 && clickX <= s.x + s.w + 4);
    seg ??= segments.reduce((best, s) =>
      Math.abs(clickX - (s.x + s.w / 2)) < Math.abs(clickX - (best.x + best.w / 2)) ? s : best
    );

    const family = tc.styles?.[seg.fontName]?.fontFamily || '';
    const font = /serif/.test(family) && !/sans/.test(family) ? 'TimesRoman' : /mono/.test(family) ? 'Courier' : 'Helvetica';

    this.overlays.addEditText({
      pageIndex,
      x: seg.x - 2,
      y: seg.baseline - seg.h - 2,
      w: seg.w + 4,
      h: seg.h * 1.3 + 4,
      baselineV: seg.baseline,
      text: seg.text.trim(),
      size: seg.h,
      font,
    });
    this.markDirty(true);
  }

  /** Render the document's bookmark tree into the sidebar's Bookmarks pane. */
  async buildOutline() {
    const outline = await this.viewer.getOutline();
    this.outlineEl.textContent = '';
    if (!outline || !outline.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No bookmarks in this document.';
      this.outlineEl.appendChild(empty);
      return;
    }
    const build = (items, parent) => {
      for (const item of items) {
        const hasKids = item.items && item.items.length > 0;
        const details = document.createElement('details');
        details.open = true;
        const summary = document.createElement('summary');
        const row = document.createElement('div');
        row.className = 'ol-row';
        const toggle = document.createElement('span');
        toggle.className = 'ol-toggle';
        if (hasKids) {
          toggle.innerHTML = '<span class="tri">▶</span>';
          toggle.addEventListener('click', (e) => {
            e.preventDefault();
            details.open = !details.open;
          });
        }
        const title = document.createElement('span');
        title.className = 'ol-title';
        title.textContent = item.title || '(untitled)';
        title.title = item.title || '';
        title.addEventListener('click', (e) => {
          e.preventDefault();
          if (item.dest) this.viewer.goToDestination(item.dest);
        });
        row.append(toggle, title);
        summary.appendChild(row);
        details.appendChild(summary);
        if (hasKids) build(item.items, details);
        parent.appendChild(details);
      }
    };
    build(outline, this.outlineEl);
  }

  /** Re-key pending OCR results after a page operation. mapFn: old → new|null. */
  #remapOcr(mapFn) {
    const next = new Map();
    for (const [i, words] of this.ocr) {
      const to = mapFn(i);
      if (to != null) next.set(to, words);
    }
    this.ocr = next;
  }

  async rotateSelection(delta) {
    const pages = this.targetPages();
    const dims = new Map(
      pages.map((i) => {
        const v = this.viewer.baseViewport(i);
        return [i, { width: v.width, height: v.height }];
      })
    );
    const clearedOcr = pages.some((i) => this.ocr.has(i));
    let clearedEdits = false;
    await this.structuralOp(
      (bytes) => engine.rotatePages(bytes, pages, delta),
      () => {
        // OCR word positions and pending text edits are tied to the old orientation.
        clearedEdits = this.overlays.dropEditsOnPages(pages);
        this.overlays.remapAfterRotate(pages, delta, dims);
        this.#remapOcr((i) => (pages.includes(i) ? null : i));
      }
    );
    if (clearedOcr) toast('Rotating cleared text recognition on the rotated page(s) — run OCR again.');
    if (clearedEdits) toast('Rotating discarded pending text edits on the rotated page(s).');
  }

  async deleteSelection() {
    const pages = this.targetPages();
    await this.structuralOp(
      (bytes) => engine.deletePages(bytes, pages),
      () => {
        this.overlays.remapAfterDelete(pages);
        this.#remapOcr((i) =>
          pages.includes(i) ? null : i - pages.filter((d) => d < i).length
        );
      }
    );
  }

  async extractSelection() {
    const pages = this.targetPages();
    const res = await host.saveAsDialog(
      (this.state.name || 'document.pdf').replace(/\.pdf$/i, '') + '-pages.pdf'
    );
    if (res.canceled) return;
    try {
      const data = await engine.extractPages(this.state.bytes, pages);
      const write = await host.savePdf(res.path, data);
      if (!write.ok) throw new Error(write.error);
      toast(`Extracted ${pages.length} page${pages.length === 1 ? '' : 's'}.`);
    } catch (err) {
      toast(err.message, true);
    }
  }

  async insertBlank() {
    const sel = this.thumbs.selection;
    const at = sel.length ? sel[sel.length - 1] + 1 : this.viewer.pageCount;
    await this.structuralOp(
      (bytes) => engine.insertBlankPage(bytes, at),
      () => {
        this.overlays.remapAfterInsert(at, 1);
        this.#remapOcr((i) => (i >= at ? i + 1 : i));
      }
    );
    this.viewer.goToPage(at);
    toast('Blank page inserted — use + Text, + Image, or Ctrl+V to fill it.');
  }

  async insertPdf() {
    const res = await host.openPdf();
    if (res.canceled) return;
    const file = res.files[0];
    const other = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    try {
      await engine.validatePdf(other);
    } catch (err) {
      toast(err.message, true);
      return;
    }
    const sel = this.thumbs.selection;
    const at = sel.length ? sel[sel.length - 1] + 1 : this.viewer.pageCount;
    const count = await engine.getPageCount(other);
    await this.structuralOp(
      (bytes) => engine.insertPdf(bytes, other, at),
      () => {
        this.overlays.remapAfterInsert(at, count);
        this.#remapOcr((i) => (i >= at ? i + count : i));
      }
    );
    toast(`Inserted ${count} page${count === 1 ? '' : 's'} from ${file.name}.`);
  }

  /**
   * Run OCR over pages that have no real text layer (scanned pages) and make
   * them searchable/selectable. Results are baked into the PDF as invisible
   * text on the next save.
   */
  async runOcr() {
    if (this.readOnly) {
      toast('This document is password-protected and opened read-only.', true);
      return;
    }
    if (this.ocrRunning) return;
    this.ocrRunning = true;
    try {
      const targets = [];
      for (let i = 0; i < this.viewer.pageCount; i++) {
        if (this.ocr.has(i)) continue; // already recognized
        const tc = await this.viewer.pages[i].proxy.getTextContent();
        const chars = tc.items.reduce((n, it) => n + (it.str ? it.str.trim().length : 0), 0);
        if (chars < 10) targets.push(i);
      }
      if (!targets.length) {
        toast('No scanned pages found — every page already has selectable text.');
        return;
      }
      for (let k = 0; k < targets.length; k++) {
        const i = targets[k];
        toast(`Recognizing text… page ${k + 1} of ${targets.length}`);
        const proxy = this.viewer.pages[i].proxy;
        const base = proxy.getViewport({ scale: 1 });
        // ~300 DPI, capped so huge pages don't blow canvas limits
        const S = Math.min(300 / 72, 4000 / Math.max(base.width, base.height));
        const viewport = proxy.getViewport({ scale: S });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await proxy.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const raw = await recognizeCanvas(canvas);

        const words = [];
        for (const w of raw) {
          if (w.confidence < 40) continue;
          const { x0, y0, x1, y1 } = w.bbox;
          const [ux, uy] = viewport.convertToPdfPoint(x0, y1); // baseline-left
          words.push({
            text: w.text,
            viewRect: { x: x0 / S, y: y0 / S, w: (x1 - x0) / S, h: (y1 - y0) / S },
            user: { x: ux, y: uy, width: (x1 - x0) / S, height: (y1 - y0) / S },
          });
        }
        this.viewer.setOcrPage(i, words);
        this.ocr.set(i, words);
      }
      this.searcher.reset(); // pick up the new words
      this.markDirty(true);
      toast(
        `Text recognition done: ${targets.length} page${targets.length === 1 ? '' : 's'}. Saving will make the PDF searchable everywhere.`
      );
    } catch (err) {
      toast(`Text recognition failed: ${err.message}`, true);
    } finally {
      this.ocrRunning = false;
    }
  }

  /**
   * Apply pending redactions destructively: each affected page is re-rendered
   * at ~300 DPI with the boxes blacked out, and the page's entire original
   * content is replaced by that image — the redacted content no longer exists
   * in the file. The flattened page is then re-OCR'd so the surviving text
   * stays searchable.
   */
  async #applyRedactions(data) {
    const redactions = this.overlays.redactionsByPage();
    const erases = this.overlays.erasesByPage();
    const edits = this.overlays.editsByPage();
    if (!redactions.size && !erases.size && !edits.size) return data;
    const pages = [...new Set([...redactions.keys(), ...erases.keys(), ...edits.keys()])].sort(
      (a, b) => a - b
    );
    const replacementTexts = [];
    for (const pageIndex of pages) {
      toast(`Rewriting page ${pageIndex + 1}…`);
      const proxy = this.viewer.pages[pageIndex].proxy;
      const base = proxy.getViewport({ scale: 1 });
      const S = Math.min(300 / 72, 4000 / Math.max(base.width, base.height));
      const viewport = proxy.getViewport({ scale: S });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      await proxy.render({ canvasContext: ctx, viewport }).promise;
      // black out redactions, white out lines being replaced
      ctx.fillStyle = '#000';
      for (const r of redactions.get(pageIndex) ?? []) {
        ctx.fillRect(r.x * S, r.y * S, r.w * S, r.h * S);
      }
      ctx.fillStyle = '#fff';
      for (const r of erases.get(pageIndex) ?? []) {
        ctx.fillRect(r.x * S, r.y * S, r.w * S, r.h * S);
      }
      for (const e of edits.get(pageIndex) ?? []) {
        ctx.fillRect(e.rect.x * S, e.rect.y * S, e.rect.w * S, e.rect.h * S);
      }
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const png = new Uint8Array(await blob.arrayBuffer());
      const wPts = viewport.width / S;
      const hPts = viewport.height / S;
      data = await engine.replacePageWithImage(data, pageIndex, png, wPts, hPts);
      this.ocr.delete(pageIndex); // stale — the page is new content now

      // Replacement text goes on as real (extractable) text after the flatten;
      // the flattened page is unrotated, so view points map to user space by
      // a simple y-flip.
      for (const e of edits.get(pageIndex) ?? []) {
        if (!e.text.trim()) continue; // cleared line = deleted line
        replacementTexts.push({
          type: 'text',
          pageIndex,
          x: e.xLeft,
          y: hPts - e.baselineV,
          text: e.text,
          size: e.size,
          lineHeight: e.size * 1.25,
          color: e.color,
          font: e.font,
        });
      }

      // Re-OCR the flattened (already painted-over) pixels for searchability.
      try {
        const raw = await recognizeCanvas(canvas);
        const words = raw
          .filter((w) => w.confidence >= 40)
          .map((w) => ({
            text: w.text,
            x: w.bbox.x0 / S,
            y: hPts - w.bbox.y1 / S, // flattened page is unrotated
            width: (w.bbox.x1 - w.bbox.x0) / S,
            height: (w.bbox.y1 - w.bbox.y0) / S,
          }));
        if (words.length) data = await engine.bakeOcrText(data, [{ pageIndex, words }]);
      } catch {
        // OCR is best-effort here; the rewrite itself already succeeded
      }
    }
    if (replacementTexts.length) data = await engine.bakeOverlays(data, replacementTexts);
    // overlay cleanup happens in adoptSaved once the write has succeeded
    return data;
  }

  async buildSaveBytes() {
    if (this.readOnly) return this.state.bytes;
    let data = await this.#applyRedactions(this.state.bytes);
    if (this.ocr.size) {
      data = await engine.bakeOcrText(
        data,
        [...this.ocr.entries()].map(([pageIndex, words]) => ({
          pageIndex,
          words: words.map((w) => ({ text: w.text, ...w.user })),
        }))
      );
    }
    if (this.viewer.hasFormEdits) {
      data = await engine.applyFormValues(data, await this.viewer.collectFormValues());
    }
    if (!this.overlays.isEmpty) {
      data = await engine.bakeOverlays(data, this.overlays.bakePayload());
    }
    return data;
  }

  /** Redactions are irreversible once saved; make the user say so. */
  #confirmRedactions() {
    if (!this.overlays.hasRedactions) return true;
    const n = [...this.overlays.redactionsByPage().values()].flat().length;
    return window.confirm(
      `Apply ${n} redaction${n === 1 ? '' : 's'} permanently?\n\n` +
        'The content under the boxes is destroyed and cannot be recovered from the saved file. ' +
        'Redacted pages are flattened to images (links and form fields on those pages are removed).'
    );
  }

  async save() {
    if (!this.state.path) return this.saveAs();
    if (!this.#confirmRedactions()) return false;
    const data = await this.buildSaveBytes();
    const res = await host.savePdf(this.state.path, data);
    if (!res.ok) {
      toast(`Could not save: ${res.error}`, true);
      return false;
    }
    await this.adoptSaved(data);
    toast('Saved.');
    return true;
  }

  async saveAs() {
    if (!this.#confirmRedactions()) return false;
    const res = await host.saveAsDialog(this.state.name || 'document.pdf');
    if (res.canceled) return false;
    const data = await this.buildSaveBytes();
    const write = await host.savePdf(res.path, data);
    if (!write.ok) {
      toast(`Could not save: ${write.error}`, true);
      return false;
    }
    if (!res.path.startsWith('download:')) {
      this.state.path = res.path;
      this.state.name = res.path.split(/[\\/]/).pop();
    }
    await this.adoptSaved(data);
    toast('Saved.');
    return true;
  }

  async adoptSaved(data) {
    // Overlays and form values are now part of the document; drop the
    // editable copies and re-render from the saved bytes.
    const needReload = !this.overlays.isEmpty || this.viewer.hasFormEdits || this.ocr.size > 0;
    this.state.bytes = data;
    if (needReload) {
      this.overlays.clear();
      this.ocr.clear(); // the invisible text layer is in the document now
      await this.reload();
    }
    this.state.undo = [];
    this.state.redo = [];
    this.markDirty(false);
  }

  async undo() {
    const active = document.activeElement;
    if (active && active.isContentEditable) {
      document.execCommand('undo');
      return;
    }
    const snap = this.state.undo.pop();
    if (!snap) return;
    this.state.redo.push({ bytes: this.state.bytes, overlays: this.overlays.snapshot() });
    this.state.bytes = snap.bytes;
    this.overlays.restore(snap.overlays);
    await this.reload();
    this.markDirty(true);
  }

  async redo() {
    const snap = this.state.redo.pop();
    if (!snap) return;
    this.state.undo.push({ bytes: this.state.bytes, overlays: this.overlays.snapshot() });
    this.state.bytes = snap.bytes;
    this.overlays.restore(snap.overlays);
    await this.reload();
    this.markDirty(true);
  }

  destroy() {
    this.overlays.clear();
    this.viewer.doc?.destroy();
    this.viewerEl.remove();
    this.thumbsEl.remove();
    this.outlineEl.remove();
    this.tabEl.remove();
  }
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

function promptPassword(name, wrong) {
  const dialog = $('pw-dialog');
  $('pw-message').textContent = wrong
    ? `Wrong password for "${name}" — try again.`
    : `"${name}" is password-protected. Enter the password to open it (read-only).`;
  const input = $('pw-input');
  input.value = '';
  return new Promise((resolve) => {
    const done = (value) => {
      dialog.close();
      $('pw-open').onclick = null;
      $('pw-cancel').onclick = null;
      input.onkeydown = null;
      dialog.oncancel = null;
      resolve(value);
    };
    $('pw-open').onclick = () => done(input.value);
    $('pw-cancel').onclick = () => done(null);
    dialog.oncancel = () => done(null); // Esc
    input.onkeydown = (e) => {
      if (e.key === 'Enter') done(input.value);
    };
    dialog.showModal();
    input.focus();
  });
}

async function openBytes(data, path, name) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let encrypted = false;
  try {
    await engine.validatePdf(bytes);
  } catch (err) {
    if (/password-protected/i.test(err.message)) {
      encrypted = true;
    } else {
      toast(`${name}: ${err.message}`, true);
      return null;
    }
  }

  const session = new Session(bytes, path, name, { readOnly: encrypted });
  sessions.push(session);
  let wrong = false;
  while (true) {
    if (encrypted) {
      const password = await promptPassword(name, wrong);
      if (password == null) {
        sessions.pop();
        session.destroy();
        updateTabs();
        syncSessionUi();
        return null;
      }
      session.password = password;
    }
    try {
      await session.reload({ keepPage: false });
      break;
    } catch (err) {
      if (encrypted && err?.name === 'PasswordException') {
        wrong = true;
        continue;
      }
      sessions.pop();
      session.destroy();
      updateTabs();
      syncSessionUi();
      toast(`${name}: could not open (${err.message})`, true);
      return null;
    }
  }
  activateSession(session);
  if (path) addRecent(path, name);
  return session;
}

// ---- recent files (Electron only: needs real file paths) ----

function getRecent() {
  try {
    return JSON.parse(localStorage.getItem('shelly.recent') || '[]');
  } catch {
    return [];
  }
}

function addRecent(path, name) {
  if (!window.shelly || !path) return;
  const list = getRecent().filter((r) => r.path !== path);
  list.unshift({ path, name });
  localStorage.setItem('shelly.recent', JSON.stringify(list.slice(0, 10)));
  renderRecent();
}

function removeRecent(path) {
  localStorage.setItem(
    'shelly.recent',
    JSON.stringify(getRecent().filter((r) => r.path !== path))
  );
  renderRecent();
}

function renderRecent() {
  const wrap = $('recent');
  const list = window.shelly ? getRecent() : [];
  wrap.hidden = list.length === 0;
  const container = $('recent-list');
  container.textContent = '';
  for (const r of list) {
    const item = document.createElement('button');
    item.className = 'recent-item';
    const rname = document.createElement('span');
    rname.className = 'rname';
    rname.textContent = r.name;
    const rpath = document.createElement('span');
    rpath.className = 'rpath';
    rpath.textContent = r.path;
    item.append(rname, rpath);
    item.addEventListener('click', async () => {
      const res = await host.readFile(r.path);
      if (!res.ok) {
        toast(`Could not open ${r.name}: the file may have moved.`, true);
        removeRecent(r.path);
        return;
      }
      await openBytes(res.data, r.path, res.name);
    });
    container.appendChild(item);
  }
}

let sidebarMode = 'pages'; // 'pages' | 'marks'

function syncSidebarPanes() {
  $('side-pages').classList.toggle('active', sidebarMode === 'pages');
  $('side-marks').classList.toggle('active', sidebarMode === 'marks');
  for (const s of sessions) {
    s.thumbsEl.classList.toggle('active', s === current && sidebarMode === 'pages');
    s.outlineEl.classList.toggle('active', s === current && sidebarMode === 'marks');
  }
}

function activateSession(session) {
  if (!session || current === session) return;
  current = session;
  for (const s of sessions) {
    s.viewerEl.classList.toggle('active', s === session);
  }
  syncSidebarPanes();
  closeFind();
  setTool('select');
  // A session laid out while hidden (display:none) saw a zero-width
  // container; re-fit it now that it is visible.
  if (
    typeof session.viewer.zoomMode === 'string' &&
    session.viewer.doc &&
    session.viewer.layoutWidth !== session.viewerEl.clientWidth
  ) {
    session.viewer.setZoom(session.viewer.zoomMode).then(syncSessionUi);
  }
  updateTabs();
  syncSessionUi();
}

function closeSession(session, { force = false } = {}) {
  if (!force && session.state.dirty) {
    const ok = window.confirm(`"${session.state.name}" has unsaved changes.\nClose it anyway?`);
    if (!ok) return;
  }
  const idx = sessions.indexOf(session);
  sessions.splice(idx, 1);
  session.destroy();
  if (current === session) {
    current = null;
    activateSession(sessions[Math.min(idx, sessions.length - 1)] ?? null);
  }
  host.setDirty(sessions.some((s) => s.state.dirty));
  updateTabs();
  syncSessionUi();
}

function updateTabs() {
  $('tabbar').hidden = sessions.length === 0;
  for (const s of sessions) {
    s.tabEl.classList.toggle('active', s === current);
    s.tabEl.querySelector('.tab-label').textContent = (s.readOnly ? '🔒 ' : '') + s.state.name;
    s.tabEl.querySelector('.tab-dirty').textContent = s.state.dirty ? '•' : '';
    s.tabEl.title = s.state.path || s.state.name;
  }
}

function syncSessionUi() {
  $('empty-state').classList.toggle('hidden', sessions.length > 0);
  if (sessions.length === 0) renderRecent();
  if (!current) {
    document.title = 'Shelly PDF';
    $('page-num').value = 1;
    $('page-total').textContent = '/ 0';
    refreshUi();
    return;
  }
  const { state, viewer } = current;
  document.title = `${state.dirty ? '● ' : ''}${state.name} — Shelly PDF`;
  $('page-num').max = viewer.pageCount;
  $('page-num').value = viewer.currentPage + 1;
  $('page-total').textContent = `/ ${viewer.pageCount}`;
  current.thumbs.setCurrent(viewer.currentPage);
  syncZoomSelect();
  refreshUi();
}

function refreshUi() {
  const loaded = !!current;
  const editable = loaded && !current.readOnly;
  $('btn-save-as').disabled = !loaded; // read-only docs can still be copied
  $('btn-print').disabled = !loaded;
  for (const id of ['btn-save', 'pg-insert', 'pg-blank', 'btn-ocr', 'btn-stamp']) $(id).disabled = !editable;
  for (const id of ['tool-highlight', 'tool-text', 'tool-note', 'tool-image', 'tool-sign', 'tool-redact', 'tool-erase', 'tool-edittext']) {
    $(id).disabled = !editable;
  }
  $('page-num').disabled = !loaded;
  $('btn-undo').disabled = !editable || !current.state.undo.length;
  $('btn-redo').disabled = !editable || !current.state.redo.length;
  for (const id of ['pg-rotate-l', 'pg-rotate-r', 'pg-delete', 'pg-extract']) {
    $(id).disabled = !editable;
  }
  $('status-file').textContent = current ? current.state.name : 'No document';
  $('status-info').textContent = current
    ? `${current.viewer.pageCount} page${current.viewer.pageCount === 1 ? '' : 's'} · ${Math.round(current.viewer.scale * 100)}%`
    : '';
  if (current) {
    document.title = `${current.state.dirty ? '● ' : ''}${current.state.name} — Shelly PDF`;
  }
}

let customZoomOption = null;

function syncZoomSelect() {
  if (!current) return;
  const select = $('zoom-select');
  const mode = current.viewer.zoomMode;
  if (typeof mode === 'string') {
    select.value = mode;
    return;
  }
  const preset = [...select.options].find((o) => o !== customZoomOption && Number(o.value) === mode);
  if (preset) {
    select.value = preset.value;
    return;
  }
  // Show the actual percentage for in-between zoom levels, like Acrobat.
  if (!customZoomOption) {
    customZoomOption = document.createElement('option');
    customZoomOption.value = 'custom';
    select.prepend(customZoomOption);
  }
  customZoomOption.textContent = `${Math.round(current.viewer.scale * 100)}%`;
  select.value = 'custom';
}

async function openPdfDialog() {
  const res = await host.openPdf();
  if (res.canceled) return;
  for (const file of res.files) await openBytes(file.data, file.path, file.name);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function setTool(mode) {
  current?.overlays.setMode(mode);
  for (const [id, m] of [
    ['tool-select', 'select'],
    ['tool-highlight', 'highlight'],
    ['tool-text', 'text'],
    ['tool-note', 'note'],
    ['tool-image', 'image'],
    ['tool-redact', 'redact'],
    ['tool-erase', 'erase'],
    ['tool-edittext', 'edittext'],
  ]) {
    $(id).classList.toggle('active', m === mode);
  }
  $('text-props').classList.toggle('visible', mode === 'text');
  $('hl-props').classList.toggle('visible', mode === 'highlight');
}

async function chooseImageTool() {
  if (!current) return;
  const res = await host.openImage();
  if (res.canceled) {
    setTool('select');
    return;
  }
  try {
    await current.overlays.setPendingImage(
      res.data instanceof Uint8Array ? res.data : new Uint8Array(res.data),
      res.format
    );
    setTool('image');
    toast('Click a page to place the image.');
  } catch {
    toast('That image could not be read.', true);
    setTool('select');
  }
}

async function print() {
  if (!current) return;
  toast('Preparing pages for printing…');
  await current.viewer.renderForPrint();
  window.print();
}

// Release the high-resolution print canvases once the dialog is gone.
window.addEventListener('afterprint', () => current?.viewer.restoreScreenResolution());

// ---- signature pad ----

const signDialog = $('sign-dialog');
const signCanvas = $('sign-canvas');
const signCtx = signCanvas.getContext('2d');
let signInk = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, any: false };

function signClear() {
  signCtx.clearRect(0, 0, signCanvas.width, signCanvas.height);
  signInk = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, any: false };
}

function signPoint(e) {
  const r = signCanvas.getBoundingClientRect();
  return [
    ((e.clientX - r.left) / r.width) * signCanvas.width,
    ((e.clientY - r.top) / r.height) * signCanvas.height,
  ];
}

signCanvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  signCanvas.setPointerCapture(e.pointerId);
  signCtx.strokeStyle = $('sign-color').value;
  signCtx.lineWidth = 4;
  signCtx.lineCap = 'round';
  signCtx.lineJoin = 'round';
  let [px, py] = signPoint(e);
  const mark = (x, y) => {
    signInk.minX = Math.min(signInk.minX, x);
    signInk.minY = Math.min(signInk.minY, y);
    signInk.maxX = Math.max(signInk.maxX, x);
    signInk.maxY = Math.max(signInk.maxY, y);
    signInk.any = true;
  };
  mark(px, py);
  const onMove = (ev) => {
    const [x, y] = signPoint(ev);
    signCtx.beginPath();
    signCtx.moveTo(px, py);
    signCtx.lineTo(x, y);
    signCtx.stroke();
    mark(x, y);
    [px, py] = [x, y];
  };
  const onUp = () => {
    signCanvas.removeEventListener('pointermove', onMove);
    signCanvas.removeEventListener('pointerup', onUp);
  };
  signCanvas.addEventListener('pointermove', onMove);
  signCanvas.addEventListener('pointerup', onUp);
});

$('tool-sign').addEventListener('click', () => {
  if (!current) return;
  signClear();
  signDialog.showModal();
});
$('sign-clear').addEventListener('click', signClear);
$('sign-cancel').addEventListener('click', () => signDialog.close());
$('sign-use').addEventListener('click', async () => {
  if (!signInk.any || !current) {
    signDialog.close();
    return;
  }
  const pad = 12;
  const x = Math.max(0, signInk.minX - pad);
  const y = Math.max(0, signInk.minY - pad);
  const w = Math.min(signCanvas.width, signInk.maxX + pad) - x;
  const h = Math.min(signCanvas.height, signInk.maxY + pad) - y;
  const crop = document.createElement('canvas');
  crop.width = w;
  crop.height = h;
  crop.getContext('2d').drawImage(signCanvas, x, y, w, h, 0, 0, w, h);
  const blob = await new Promise((resolve) => crop.toBlob(resolve, 'image/png'));
  await current.overlays.setPendingImage(new Uint8Array(await blob.arrayBuffer()), 'png');
  signDialog.close();
  setTool('image');
  toast('Click a page to place your signature.');
});

// ---------------------------------------------------------------------------
// Toolbar wiring
// ---------------------------------------------------------------------------

$('btn-open').addEventListener('click', openPdfDialog);
$('empty-open').addEventListener('click', openPdfDialog);
$('empty-arcade').addEventListener('click', openArcade);
installKonami();
$('btn-save').addEventListener('click', () => current?.save());
$('btn-save-as').addEventListener('click', () => current?.saveAs());
$('btn-print').addEventListener('click', print);
$('btn-undo').addEventListener('click', () => current?.undo());
$('btn-redo').addEventListener('click', () => current?.redo());
$('btn-sidebar').addEventListener('click', () => $('sidebar').classList.toggle('hidden'));
$('btn-ocr').addEventListener('click', () => current?.runOcr());

$('btn-prev').addEventListener('click', () => current?.viewer.goToPage(current.viewer.currentPage - 1));
$('btn-next').addEventListener('click', () => current?.viewer.goToPage(current.viewer.currentPage + 1));
$('page-num').addEventListener('change', (e) => {
  if (!current) return;
  const n = Number(e.target.value);
  if (n >= 1 && n <= current.viewer.pageCount) current.viewer.goToPage(n - 1);
});

$('btn-zoom-in').addEventListener('click', async () => {
  if (!current) return;
  await current.viewer.zoomBy(1.25);
  syncZoomSelect();
  refreshUi();
});
$('btn-zoom-out').addEventListener('click', async () => {
  if (!current) return;
  await current.viewer.zoomBy(1 / 1.25);
  syncZoomSelect();
  refreshUi();
});
$('zoom-select').addEventListener('change', async (e) => {
  if (!current) return;
  const v = e.target.value;
  if (v === 'custom') return; // the display-only entry for in-between zooms
  await current.viewer.setZoom(v === 'fit-width' || v === 'fit-page' ? v : Number(v));
  refreshUi();
});

// Ctrl + mouse wheel (or trackpad pinch) zooms, like Acrobat.
let wheelZoomFactor = 1;
let wheelZoomPending = false;
$('viewers').addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey || !current) return;
    e.preventDefault();
    wheelZoomFactor *= e.deltaY < 0 ? 1.1 : 1 / 1.1;
    if (wheelZoomPending) return;
    wheelZoomPending = true;
    setTimeout(async () => {
      const factor = wheelZoomFactor;
      wheelZoomFactor = 1;
      wheelZoomPending = false;
      if (!current || factor === 1) return;
      await current.viewer.zoomBy(factor);
      syncZoomSelect();
      refreshUi();
    }, 80);
  },
  { passive: false }
);

$('tool-select').addEventListener('click', () => setTool('select'));
$('tool-highlight').addEventListener('click', () => setTool('highlight'));
$('tool-text').addEventListener('click', () => setTool('text'));
$('tool-note').addEventListener('click', () => setTool('note'));
$('tool-image').addEventListener('click', chooseImageTool);
$('tool-redact').addEventListener('click', () => {
  setTool('redact');
  toast('Drag a box over the content to redact. It is removed permanently when you save.');
});
$('tool-erase').addEventListener('click', () => {
  setTool('erase');
  toast('Drag a box over the picture or area to erase.');
});
$('tool-edittext').addEventListener('click', () => {
  setTool('edittext');
  toast('Click a line of text to edit it. The original is replaced when you save.');
});
$('hl-color').addEventListener('input', (e) => current?.overlays.setHighlightColor(e.target.value));
$('text-size').addEventListener('change', (e) =>
  current?.overlays.setTextProps({ size: Math.max(6, Math.min(96, Number(e.target.value) || 16)) })
);
$('text-color').addEventListener('input', (e) => current?.overlays.setTextProps({ color: e.target.value }));
$('text-font').addEventListener('change', (e) => current?.overlays.setTextProps({ font: e.target.value }));
$('text-bg').addEventListener('change', (e) => current?.overlays.setTextProps({ bg: e.target.checked }));

$('pg-rotate-l').addEventListener('click', () => current?.rotateSelection(-90));
$('pg-rotate-r').addEventListener('click', () => current?.rotateSelection(90));
$('pg-delete').addEventListener('click', () => current?.deleteSelection());
$('pg-extract').addEventListener('click', () => current?.extractSelection());
$('pg-insert').addEventListener('click', () => current?.insertPdf());
$('pg-blank').addEventListener('click', () => current?.insertBlank());

// ---- erase & replace picture ----

const eraseDialog = $('erase-dialog');
let pendingEraseItem = null;

function wireEraseDialog(session) {
  session.overlays.addEventListener('eraseplaced', (e) => {
    if (current !== session) return;
    pendingEraseItem = e.detail.item;
    eraseDialog.showModal();
  });
}

$('erase-cancel').addEventListener('click', () => {
  if (pendingEraseItem) current?.overlays.remove(pendingEraseItem.id);
  pendingEraseItem = null;
  eraseDialog.close();
});
$('erase-only').addEventListener('click', () => {
  pendingEraseItem = null;
  eraseDialog.close();
  setTool('select');
});
$('erase-replace').addEventListener('click', async () => {
  eraseDialog.close();
  const item = pendingEraseItem;
  pendingEraseItem = null;
  if (!current || !item) return;
  const res = await host.openImage();
  if (res.canceled) {
    setTool('select');
    return; // erase box stays; user can delete it if unwanted
  }
  try {
    await current.overlays.setPendingImage(
      res.data instanceof Uint8Array ? res.data : new Uint8Array(res.data),
      res.format
    );
    current.overlays.placeImageInRect(item.pageIndex, {
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
    });
    setTool('select');
    toast('Picture placed — drag or resize it, then Save.');
  } catch {
    toast('That image could not be read.', true);
  }
});

// ---- paste an image from the clipboard (e.g. a table copied in Excel) ----

async function pasteImageBytes(bytes, format) {
  if (!current || current.readOnly) return false;
  const pageIndex = current.viewer.currentPage;
  const vp = current.viewer.baseViewport(pageIndex);
  await current.overlays.setPendingImage(bytes, format);
  // fitted into a centered box ~70% of the page
  current.overlays.placeImageInRect(pageIndex, {
    x: vp.width * 0.15,
    y: vp.height * 0.15,
    w: vp.width * 0.7,
    h: vp.height * 0.7,
  });
  setTool('select');
  toast('Pasted — drag or resize the picture, then Save.');
  return true;
}

window.addEventListener('paste', async (e) => {
  const active = document.activeElement;
  if (active && (active.isContentEditable || /^(input|textarea)$/i.test(active.tagName))) return;
  const items = [...(e.clipboardData?.items || [])];
  const imageItem = items.find((it) => /^image\/(png|jpe?g)$/.test(it.type));
  if (!imageItem) return;
  e.preventDefault();
  const file = imageItem.getAsFile();
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await pasteImageBytes(bytes, file.type.includes('png') ? 'png' : 'jpeg');
});

// ---- sidebar panes ----

$('side-pages').addEventListener('click', () => {
  sidebarMode = 'pages';
  syncSidebarPanes();
});
$('side-marks').addEventListener('click', () => {
  sidebarMode = 'marks';
  syncSidebarPanes();
});

// ---- watermark dialog ----

const wmDialog = $('wm-dialog');
$('btn-stamp').addEventListener('click', () => {
  if (!current || current.readOnly) return;
  wmDialog.showModal();
  $('wm-text').focus();
});
$('wm-cancel').addEventListener('click', () => wmDialog.close());
$('wm-apply').addEventListener('click', async () => {
  if (!current) return;
  const text = $('wm-text').value.trim();
  if (!text) {
    wmDialog.close();
    return;
  }
  const v = parseInt($('wm-color').value.slice(1), 16);
  const color = { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 };
  const opacity = Number($('wm-opacity').value) / 100;
  const pageIndices = $('wm-scope').value === 'current' ? [current.viewer.currentPage] : null;
  wmDialog.close();
  await current.structuralOp((bytes) =>
    engine.addWatermark(bytes, { text, color, opacity, pageIndices })
  );
  toast(`Stamped "${text}" — Ctrl+Z to undo.`);
});

// ---- find bar ----

const findbar = $('findbar');
const findInput = $('find-input');
let findTimer;

function openFind() {
  if (!current) return;
  findbar.hidden = false;
  findInput.focus();
  findInput.select();
}
function closeFind() {
  if (findbar.hidden) return;
  findbar.hidden = true;
  findInput.value = '';
  current?.searcher.clear();
}

$('btn-find').addEventListener('click', openFind);
$('find-close').addEventListener('click', closeFind);
$('find-next').addEventListener('click', () => current?.searcher.next(1));
$('find-prev').addEventListener('click', () => current?.searcher.next(-1));
findInput.addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => current?.searcher.search(findInput.value), 200);
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') current?.searcher.next(e.shiftKey ? -1 : 1);
  if (e.key === 'Escape') closeFind();
});

// ---- drag & drop ----

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('drag-over');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('drag-over');
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('drag-over');
  const files = [...(e.dataTransfer?.files || [])].filter(
    (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
  );
  for (const file of files) {
    await openBytes(new Uint8Array(await file.arrayBuffer()), null, file.name);
  }
});

// ---- menu commands from the Electron main process ----

host.onMenu(async (cmd) => {
  const actions = {
    open: openPdfDialog,
    insert: () => current?.insertPdf(),
    save: () => current?.save(),
    'save-as': () => current?.saveAs(),
    print,
    undo: () => current?.undo(),
    redo: () => current?.redo(),
    find: openFind,
    'close-tab': () => current && closeSession(current),
    'zoom-in': () => $('btn-zoom-in').click(),
    'zoom-out': () => $('btn-zoom-out').click(),
    'zoom-100': async () => {
      await current?.viewer.setZoom(1);
      syncZoomSelect();
      refreshUi();
    },
    'fit-width': async () => {
      await current?.viewer.setZoom('fit-width');
      syncZoomSelect();
      refreshUi();
    },
    'fit-page': async () => {
      await current?.viewer.setZoom('fit-page');
      syncZoomSelect();
      refreshUi();
    },
    sidebar: () => $('sidebar').classList.toggle('hidden'),
    'save-and-close': async () => {
      // Save every dirty tab; abort the close if any save is cancelled/fails.
      for (const s of sessions.filter((s) => s.state.dirty)) {
        activateSession(s);
        if (!(await s.save())) return;
      }
      host.confirmClose();
    },
  };
  await actions[cmd]?.();
});

// PDFs handed over by the OS: app launch arguments, double-clicked files
// routed from a second instance, or macOS open-file events.
host.onOpenFiles?.(async (files) => {
  for (const file of files) await openBytes(file.data, file.path, file.name);
});

// ---- keyboard fallback when running in a plain browser (no app menu) ----

if (!window.shelly) {
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const map = {
      o: openPdfDialog,
      s: () => (e.shiftKey ? current?.saveAs() : current?.save()),
      f: openFind,
      p: print,
      z: () => (e.shiftKey ? current?.redo() : current?.undo()),
      b: () => $('sidebar').classList.toggle('hidden'),
      w: () => current && closeSession(current),
    };
    const fn = map[e.key.toLowerCase()];
    if (fn) {
      e.preventDefault();
      fn();
    }
  });
}

setTool('select');
syncSessionUi();
// Build version in the status bar: the quick way to confirm which build runs.
$('status-version').textContent = `v${typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'}`;

// Exposed for the automated browser smoke test.
window.__shellyTest = {
  openBytes,
  engine,
  get state() {
    return current?.state;
  },
  get viewer() {
    return current?.viewer;
  },
  get overlays() {
    return current?.overlays;
  },
  get searcher() {
    return current?.searcher;
  },
  get thumbs() {
    return current?.thumbs;
  },
  get session() {
    return current;
  },
  sessionCount: () => sessions.length,
  openArcade,
  get arcade() {
    return currentGame();
  },
  activate: (i) => activateSession(sessions[i]),
  closeCurrent: () => current && closeSession(current, { force: true }),
  pasteImageBytes,
};
