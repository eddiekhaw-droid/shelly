import * as engine from './pdf-engine.js';
import { Viewer } from './viewer.js';
import { Thumbnails } from './thumbnails.js';
import { Searcher } from './search.js';
import { OverlayManager } from './overlays.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Host: Electron preload API, or a browser fallback (file input + download)
// so the renderer also runs in a plain browser for development and testing.
// ---------------------------------------------------------------------------

const host = window.shelly ?? makeBrowserHost();

function makeBrowserHost() {
  const pickFile = (input) =>
    new Promise((resolve) => {
      input.onchange = async () => {
        const file = input.files[0];
        input.value = '';
        if (!file) return resolve({ canceled: true });
        const data = new Uint8Array(await file.arrayBuffer());
        resolve({
          canceled: false,
          path: null,
          name: file.name,
          format: file.type === 'image/png' ? 'png' : 'jpeg',
          data,
        });
      };
      input.click();
    });

  return {
    openPdf: () => pickFile($('file-fallback')),
    openImage: () => pickFile($('image-fallback')),
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
// State
// ---------------------------------------------------------------------------

const state = {
  bytes: null, // Uint8Array — current structural document
  path: null,
  name: null,
  dirty: false,
  undo: [],
  redo: [],
};
const UNDO_LIMIT = 20;

const viewer = new Viewer($('viewer'));
const thumbs = new Thumbnails($('thumbs'));
const searcher = new Searcher(viewer, { count: $('find-count') });
const overlays = new OverlayManager(viewer);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = isError ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 3000);
}

function setDirty(dirty) {
  state.dirty = dirty;
  host.setDirty(dirty && !!state.bytes);
  document.title = state.name ? `${dirty ? '● ' : ''}${state.name} — Shelly PDF` : 'Shelly PDF';
  refreshUi();
}

function refreshUi() {
  const loaded = !!state.bytes;
  for (const id of ['btn-save', 'btn-save-as', 'btn-print', 'pg-insert']) $(id).disabled = !loaded;
  $('page-num').disabled = !loaded;
  $('btn-undo').disabled = !state.undo.length;
  $('btn-redo').disabled = !state.redo.length;
  const sel = thumbs.selection;
  const pageActionable = loaded && (sel.length > 0 || viewer.pageCount > 0);
  for (const id of ['pg-rotate-l', 'pg-rotate-r', 'pg-delete', 'pg-extract']) {
    $(id).disabled = !pageActionable;
  }
  $('status-file').textContent = loaded ? state.name : 'No document';
  $('status-info').textContent = loaded
    ? `${viewer.pageCount} page${viewer.pageCount === 1 ? '' : 's'} · ${Math.round(viewer.scale * 100)}%`
    : '';
}

function syncZoomSelect() {
  const select = $('zoom-select');
  if (typeof viewer.zoomMode === 'string') {
    select.value = viewer.zoomMode;
  } else {
    const preset = [...select.options].find((o) => Number(o.value) === viewer.zoomMode);
    select.value = preset ? preset.value : '';
  }
}

/** Pages an action applies to: the thumbnail selection, else the current page. */
function targetPages() {
  const sel = thumbs.selection;
  return sel.length ? sel : [viewer.currentPage];
}

function pushUndo() {
  state.undo.push({ bytes: state.bytes, overlays: overlays.snapshot() });
  if (state.undo.length > UNDO_LIMIT) state.undo.shift();
  state.redo = [];
}

// Rolling pre-change copy of the overlay list, so an overlay edit can push
// the state *before* itself onto the undo stack (its change event fires after
// the mutation).
let overlayShadow = [];

async function reload({ keepPage = true } = {}) {
  const page = keepPage ? Math.min(viewer.currentPage, 1e9) : 0;
  await viewer.load(state.bytes);
  searcher.reset();
  overlays.mountAll();
  thumbs.build(viewer); // not awaited: thumbnails fill in behind
  if (keepPage && page > 0) viewer.goToPage(Math.min(page, viewer.pageCount - 1));
  $('page-num').max = viewer.pageCount;
  $('page-num').value = viewer.currentPage + 1;
  $('page-total').textContent = `/ ${viewer.pageCount}`;
  overlayShadow = overlays.snapshot();
  syncZoomSelect();
  refreshUi();
}

async function openBytes(data, path, name) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  try {
    await engine.validatePdf(bytes);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  state.bytes = bytes;
  state.path = path;
  state.name = name;
  state.undo = [];
  state.redo = [];
  overlays.clear();
  $('empty-state').classList.add('hidden');
  await reload({ keepPage: false });
  setDirty(false);
}

/** Run a structural edit: snapshot for undo, transform bytes, remap overlays, reload. */
async function structuralOp(fn, remapOverlays) {
  if (!state.bytes) return;
  pushUndo();
  try {
    const next = await fn(state.bytes);
    if (remapOverlays) remapOverlays();
    state.bytes = next;
    await reload();
    setDirty(true);
  } catch (err) {
    state.undo.pop();
    toast(err.message, true);
    refreshUi();
  }
}

// ---------------------------------------------------------------------------
// File actions
// ---------------------------------------------------------------------------

async function openPdf() {
  const res = await host.openPdf();
  if (res.canceled) return;
  await openBytes(res.data, res.path, res.name);
}

async function buildSaveBytes() {
  return overlays.isEmpty ? state.bytes : engine.bakeOverlays(state.bytes, overlays.bakePayload());
}

async function save() {
  if (!state.bytes) return false;
  if (!state.path) return saveAs();
  const data = await buildSaveBytes();
  const res = await host.savePdf(state.path, data);
  if (!res.ok) {
    toast(`Could not save: ${res.error}`, true);
    return false;
  }
  await adoptSaved(data);
  toast('Saved.');
  return true;
}

async function saveAs() {
  if (!state.bytes) return false;
  const res = await host.saveAsDialog(state.name || 'document.pdf');
  if (res.canceled) return false;
  const data = await buildSaveBytes();
  const write = await host.savePdf(res.path, data);
  if (!write.ok) {
    toast(`Could not save: ${write.error}`, true);
    return false;
  }
  if (!res.path.startsWith('download:')) {
    state.path = res.path;
    state.name = res.path.split(/[\\/]/).pop();
  }
  await adoptSaved(data);
  toast('Saved.');
  return true;
}

async function adoptSaved(data) {
  // Overlays are now part of the document; drop the editable copies.
  state.bytes = data;
  if (!overlays.isEmpty) {
    overlays.clear();
    await reload();
  }
  state.undo = [];
  state.redo = [];
  setDirty(false);
}

async function extractSelection() {
  const pages = targetPages();
  const res = await host.saveAsDialog(
    (state.name || 'document.pdf').replace(/\.pdf$/i, '') + `-pages.pdf`
  );
  if (res.canceled) return;
  try {
    const data = await engine.extractPages(state.bytes, pages);
    const write = await host.savePdf(res.path, data);
    if (!write.ok) throw new Error(write.error);
    toast(`Extracted ${pages.length} page${pages.length === 1 ? '' : 's'}.`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function insertPdf() {
  const res = await host.openPdf();
  if (res.canceled) return;
  const other = res.data instanceof Uint8Array ? res.data : new Uint8Array(res.data);
  try {
    await engine.validatePdf(other);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  const sel = thumbs.selection;
  const at = sel.length ? sel[sel.length - 1] + 1 : viewer.pageCount;
  const count = await engine.getPageCount(other);
  await structuralOp(
    (bytes) => engine.insertPdf(bytes, other, at),
    () => overlays.remapAfterInsert(at, count)
  );
  toast(`Inserted ${count} page${count === 1 ? '' : 's'} from ${res.name}.`);
}

// ---------------------------------------------------------------------------
// Page organization
// ---------------------------------------------------------------------------

async function rotateSelection(delta) {
  const pages = targetPages();
  const dims = new Map(
    pages.map((i) => {
      const v = viewer.baseViewport(i);
      return [i, { width: v.width, height: v.height }];
    })
  );
  await structuralOp(
    (bytes) => engine.rotatePages(bytes, pages, delta),
    () => overlays.remapAfterRotate(pages, delta, dims)
  );
}

async function deleteSelection() {
  const pages = targetPages();
  await structuralOp(
    (bytes) => engine.deletePages(bytes, pages),
    () => overlays.remapAfterDelete(pages)
  );
}

async function undo() {
  const active = document.activeElement;
  if (active && active.isContentEditable) {
    document.execCommand('undo');
    return;
  }
  const snap = state.undo.pop();
  if (!snap) return;
  state.redo.push({ bytes: state.bytes, overlays: overlays.snapshot() });
  state.bytes = snap.bytes;
  overlays.restore(snap.overlays);
  await reload();
  setDirty(true);
}

async function redo() {
  const snap = state.redo.pop();
  if (!snap) return;
  state.undo.push({ bytes: state.bytes, overlays: overlays.snapshot() });
  state.bytes = snap.bytes;
  overlays.restore(snap.overlays);
  await reload();
  setDirty(true);
}

async function print() {
  if (!state.bytes) return;
  toast('Preparing pages for printing…');
  await viewer.renderAllPages();
  window.print();
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function setTool(mode) {
  overlays.setMode(mode);
  for (const [id, m] of [
    ['tool-select', 'select'],
    ['tool-text', 'text'],
    ['tool-image', 'image'],
  ]) {
    $(id).classList.toggle('active', m === mode);
  }
  $('text-props').classList.toggle('visible', mode === 'text');
}

async function chooseImageTool() {
  const res = await host.openImage();
  if (res.canceled) {
    setTool('select');
    return;
  }
  try {
    await overlays.setPendingImage(
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

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$('btn-open').addEventListener('click', openPdf);
$('empty-open').addEventListener('click', openPdf);
$('btn-save').addEventListener('click', save);
$('btn-save-as').addEventListener('click', saveAs);
$('btn-print').addEventListener('click', print);
$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);
$('btn-sidebar').addEventListener('click', () => $('sidebar').classList.toggle('hidden'));

$('btn-prev').addEventListener('click', () => viewer.goToPage(viewer.currentPage - 1));
$('btn-next').addEventListener('click', () => viewer.goToPage(viewer.currentPage + 1));
$('page-num').addEventListener('change', (e) => {
  const n = Number(e.target.value);
  if (n >= 1 && n <= viewer.pageCount) viewer.goToPage(n - 1);
});

$('btn-zoom-in').addEventListener('click', async () => {
  await viewer.zoomBy(1.25);
  syncZoomSelect();
  refreshUi();
});
$('btn-zoom-out').addEventListener('click', async () => {
  await viewer.zoomBy(1 / 1.25);
  syncZoomSelect();
  refreshUi();
});
$('zoom-select').addEventListener('change', async (e) => {
  const v = e.target.value;
  await viewer.setZoom(v === 'fit-width' || v === 'fit-page' ? v : Number(v));
  refreshUi();
});

$('tool-select').addEventListener('click', () => setTool('select'));
$('tool-text').addEventListener('click', () => setTool('text'));
$('tool-image').addEventListener('click', chooseImageTool);
$('text-size').addEventListener('change', (e) =>
  overlays.setTextProps({ size: Math.max(6, Math.min(96, Number(e.target.value) || 16)) })
);
$('text-color').addEventListener('input', (e) => overlays.setTextProps({ color: e.target.value }));

$('pg-rotate-l').addEventListener('click', () => rotateSelection(-90));
$('pg-rotate-r').addEventListener('click', () => rotateSelection(90));
$('pg-delete').addEventListener('click', deleteSelection);
$('pg-extract').addEventListener('click', extractSelection);
$('pg-insert').addEventListener('click', insertPdf);

overlays.addEventListener('change', (e) => {
  // Non-structural changes are live typing; they become undoable only when
  // committed (blur), which arrives as a structural change.
  if (e.detail.structural) {
    state.undo.push({ bytes: state.bytes, overlays: overlayShadow });
    if (state.undo.length > UNDO_LIMIT) state.undo.shift();
    state.redo = [];
    overlayShadow = overlays.snapshot();
  }
  setDirty(true);
});
overlays.addEventListener('imageplaced', () => setTool('select'));
overlays.addEventListener('selectionchange', (e) => {
  const item = e.detail.item;
  if (item?.type === 'text') {
    $('text-size').value = item.size;
    $('text-color').value = item.color;
    $('text-props').classList.add('visible');
  }
});

viewer.addEventListener('pagechange', (e) => {
  $('page-num').value = e.detail.pageIndex + 1;
  thumbs.setCurrent(e.detail.pageIndex);
});
viewer.addEventListener('layout', () => {
  syncZoomSelect();
  refreshUi();
});

thumbs.addEventListener('goto', (e) => viewer.goToPage(e.detail.pageIndex));
thumbs.addEventListener('select', refreshUi);
thumbs.addEventListener('reorder', async (e) => {
  const order = e.detail.order;
  await structuralOp(
    (bytes) => engine.reorderPages(bytes, order),
    () => overlays.remapAfterReorder(order)
  );
});

// ---- find bar ----

const findbar = $('findbar');
const findInput = $('find-input');
let findTimer;

function openFind() {
  if (!state.bytes) return;
  findbar.hidden = false;
  findInput.focus();
  findInput.select();
}
function closeFind() {
  findbar.hidden = true;
  searcher.clear();
  $('viewer').focus();
}

$('btn-find').addEventListener('click', openFind);
$('find-close').addEventListener('click', closeFind);
$('find-next').addEventListener('click', () => searcher.next(1));
$('find-prev').addEventListener('click', () => searcher.next(-1));
findInput.addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => searcher.search(findInput.value), 200);
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searcher.next(e.shiftKey ? -1 : 1);
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
  const file = [...(e.dataTransfer?.files || [])].find(
    (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
  );
  if (!file) return;
  await openBytes(new Uint8Array(await file.arrayBuffer()), null, file.name);
});

// ---- menu commands from the Electron main process ----

host.onMenu(async (cmd) => {
  const actions = {
    open: openPdf,
    insert: insertPdf,
    save,
    'save-as': saveAs,
    print,
    undo,
    redo,
    find: openFind,
    'zoom-in': () => $('btn-zoom-in').click(),
    'zoom-out': () => $('btn-zoom-out').click(),
    'zoom-100': async () => {
      await viewer.setZoom(1);
      syncZoomSelect();
      refreshUi();
    },
    'fit-width': async () => {
      await viewer.setZoom('fit-width');
      syncZoomSelect();
      refreshUi();
    },
    'fit-page': async () => {
      await viewer.setZoom('fit-page');
      syncZoomSelect();
      refreshUi();
    },
    sidebar: () => $('sidebar').classList.toggle('hidden'),
    'save-and-close': async () => {
      if (await save()) host.confirmClose();
    },
  };
  await actions[cmd]?.();
});

// ---- keyboard fallback when running in a plain browser (no app menu) ----

if (!window.shelly) {
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const map = {
      o: openPdf,
      s: e.shiftKey ? saveAs : save,
      f: openFind,
      p: print,
      z: e.shiftKey ? redo : undo,
      b: () => $('sidebar').classList.toggle('hidden'),
    };
    const fn = map[e.key.toLowerCase()];
    if (fn) {
      e.preventDefault();
      fn();
    }
  });
}

setTool('select');
refreshUi();

// Exposed for the automated browser smoke test.
window.__shellyTest = { openBytes, state, viewer, searcher, overlays, engine, thumbs };
