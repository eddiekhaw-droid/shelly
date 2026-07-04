import * as engine from './pdf-engine.js';
import { Viewer } from './viewer.js';
import { Thumbnails } from './thumbnails.js';
import { Searcher } from './search.js';
import { OverlayManager } from './overlays.js';

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
  constructor(bytes, path, name) {
    this.state = { bytes, path, name, dirty: false, undo: [], redo: [] };
    this.overlayShadow = [];

    this.viewerEl = document.createElement('div');
    this.viewerEl.className = 'viewer';
    this.viewerEl.tabIndex = 0;
    $('viewers').appendChild(this.viewerEl);

    this.thumbsEl = document.createElement('div');
    this.thumbsEl.className = 'thumbs';
    $('thumbs-host').appendChild(this.thumbsEl);

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
    this.overlays.addEventListener('selectionchange', (e) => {
      if (current !== this) return;
      const item = e.detail.item;
      if (item?.type === 'text') {
        $('text-size').value = item.size;
        $('text-color').value = item.color;
        $('text-props').classList.add('visible');
      }
    });

    this.thumbs.addEventListener('goto', (e) => this.viewer.goToPage(e.detail.pageIndex));
    this.thumbs.addEventListener('select', ifActive(refreshUi));
    this.thumbs.addEventListener('reorder', (e) => {
      const order = e.detail.order;
      this.structuralOp(
        (bytes) => engine.reorderPages(bytes, order),
        () => this.overlays.remapAfterReorder(order)
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
    await this.viewer.load(this.state.bytes);
    this.searcher.reset();
    this.overlays.mountAll();
    this.thumbs.build(this.viewer); // not awaited: thumbnails fill in behind
    if (keepPage && page > 0) this.viewer.goToPage(Math.min(page, this.viewer.pageCount - 1));
    this.overlayShadow = this.overlays.snapshot();
    if (current === this) syncSessionUi();
  }

  /** Snapshot for undo, transform bytes, remap overlays, reload. */
  async structuralOp(fn, remapOverlays) {
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

  async rotateSelection(delta) {
    const pages = this.targetPages();
    const dims = new Map(
      pages.map((i) => {
        const v = this.viewer.baseViewport(i);
        return [i, { width: v.width, height: v.height }];
      })
    );
    await this.structuralOp(
      (bytes) => engine.rotatePages(bytes, pages, delta),
      () => this.overlays.remapAfterRotate(pages, delta, dims)
    );
  }

  async deleteSelection() {
    const pages = this.targetPages();
    await this.structuralOp(
      (bytes) => engine.deletePages(bytes, pages),
      () => this.overlays.remapAfterDelete(pages)
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
      () => this.overlays.remapAfterInsert(at, count)
    );
    toast(`Inserted ${count} page${count === 1 ? '' : 's'} from ${file.name}.`);
  }

  async buildSaveBytes() {
    let data = this.state.bytes;
    if (this.viewer.hasFormEdits) {
      data = await engine.applyFormValues(data, await this.viewer.collectFormValues());
    }
    if (!this.overlays.isEmpty) {
      data = await engine.bakeOverlays(data, this.overlays.bakePayload());
    }
    return data;
  }

  async save() {
    if (!this.state.path) return this.saveAs();
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
    const needReload = !this.overlays.isEmpty || this.viewer.hasFormEdits;
    this.state.bytes = data;
    if (needReload) {
      this.overlays.clear();
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
    this.tabEl.remove();
  }
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

async function openBytes(data, path, name) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  try {
    await engine.validatePdf(bytes);
  } catch (err) {
    toast(`${name}: ${err.message}`, true);
    return null;
  }
  const session = new Session(bytes, path, name);
  sessions.push(session);
  await session.reload({ keepPage: false });
  activateSession(session);
  return session;
}

function activateSession(session) {
  if (!session || current === session) return;
  current = session;
  for (const s of sessions) {
    s.viewerEl.classList.toggle('active', s === session);
    s.thumbsEl.classList.toggle('active', s === session);
  }
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
    s.tabEl.querySelector('.tab-label').textContent = s.state.name;
    s.tabEl.querySelector('.tab-dirty').textContent = s.state.dirty ? '•' : '';
    s.tabEl.title = s.state.path || s.state.name;
  }
}

function syncSessionUi() {
  $('empty-state').classList.toggle('hidden', sessions.length > 0);
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
  for (const id of ['btn-save', 'btn-save-as', 'btn-print', 'pg-insert']) $(id).disabled = !loaded;
  $('page-num').disabled = !loaded;
  $('btn-undo').disabled = !current || !current.state.undo.length;
  $('btn-redo').disabled = !current || !current.state.redo.length;
  for (const id of ['pg-rotate-l', 'pg-rotate-r', 'pg-delete', 'pg-extract']) {
    $(id).disabled = !loaded;
  }
  $('status-file').textContent = current ? current.state.name : 'No document';
  $('status-info').textContent = current
    ? `${current.viewer.pageCount} page${current.viewer.pageCount === 1 ? '' : 's'} · ${Math.round(current.viewer.scale * 100)}%`
    : '';
  if (current) {
    document.title = `${current.state.dirty ? '● ' : ''}${current.state.name} — Shelly PDF`;
  }
}

function syncZoomSelect() {
  if (!current) return;
  const select = $('zoom-select');
  const mode = current.viewer.zoomMode;
  if (typeof mode === 'string') {
    select.value = mode;
  } else {
    const preset = [...select.options].find((o) => Number(o.value) === mode);
    select.value = preset ? preset.value : '';
  }
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
  await current.viewer.renderAllPages();
  window.print();
}

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
$('btn-save').addEventListener('click', () => current?.save());
$('btn-save-as').addEventListener('click', () => current?.saveAs());
$('btn-print').addEventListener('click', print);
$('btn-undo').addEventListener('click', () => current?.undo());
$('btn-redo').addEventListener('click', () => current?.redo());
$('btn-sidebar').addEventListener('click', () => $('sidebar').classList.toggle('hidden'));

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
  await current.viewer.setZoom(v === 'fit-width' || v === 'fit-page' ? v : Number(v));
  refreshUi();
});

$('tool-select').addEventListener('click', () => setTool('select'));
$('tool-highlight').addEventListener('click', () => setTool('highlight'));
$('tool-text').addEventListener('click', () => setTool('text'));
$('tool-note').addEventListener('click', () => setTool('note'));
$('tool-image').addEventListener('click', chooseImageTool);
$('hl-color').addEventListener('input', (e) => current?.overlays.setHighlightColor(e.target.value));
$('text-size').addEventListener('change', (e) =>
  current?.overlays.setTextProps({ size: Math.max(6, Math.min(96, Number(e.target.value) || 16)) })
);
$('text-color').addEventListener('input', (e) => current?.overlays.setTextProps({ color: e.target.value }));

$('pg-rotate-l').addEventListener('click', () => current?.rotateSelection(-90));
$('pg-rotate-r').addEventListener('click', () => current?.rotateSelection(90));
$('pg-delete').addEventListener('click', () => current?.deleteSelection());
$('pg-extract').addEventListener('click', () => current?.extractSelection());
$('pg-insert').addEventListener('click', () => current?.insertPdf());

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
  sessionCount: () => sessions.length,
  activate: (i) => activateSession(sessions[i]),
  closeCurrent: () => current && closeSession(current, { force: true }),
};
