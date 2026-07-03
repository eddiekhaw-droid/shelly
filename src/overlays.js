// "Add Text" / "Add Image" overlay objects. While editing they live as DOM
// elements positioned over the page canvases; they are only baked into the
// PDF (via pdf-engine.bakeOverlays) when the user saves.
//
// Overlay coordinates are stored in *view points*: the page's viewport at
// scale 1 (so they are zoom-independent), origin top-left, y down.

// Keep in sync with the .ov-text CSS (line-height / font metrics): the first
// baseline of a DOM line box sits roughly at (LH-1)/2 + ascent from the top.
const TEXT_LINE_HEIGHT = 1.25;
const TEXT_BASELINE = (TEXT_LINE_HEIGHT - 1) / 2 + 0.75;

let nextId = 1;

export class OverlayManager extends EventTarget {
  constructor(viewer) {
    super();
    this.viewer = viewer;
    this.items = []; // {id,type,pageIndex,x,y,...} — see below
    this.mode = 'select'; // 'select' | 'text' | 'image'
    this.pendingImage = null; // {bytes, format, objectUrl, naturalW, naturalH}
    this.selectedId = null;
    this.defaults = { size: 16, color: '#d92626' };

    viewer.addEventListener('layout', () => this.mountAll());

    viewer.root.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.overlay')) return;
      this.select(null);
      const pageEl = e.target.closest('.page');
      if (!pageEl || this.mode === 'select') return;
      const pageIndex = Number(pageEl.dataset.page);
      const rect = pageEl.getBoundingClientRect();
      const scale = this.viewer.scale;
      const x = (e.clientX - rect.left) / scale;
      const y = (e.clientY - rect.top) / scale;
      if (this.mode === 'text') this.#placeText(pageIndex, x, y);
      else if (this.mode === 'image' && this.pendingImage) this.#placeImage(pageIndex, x, y);
      e.preventDefault();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const active = document.activeElement;
      if (active && (active.isContentEditable || /^(input|textarea|select)$/i.test(active.tagName))) return;
      if (this.selectedId != null) {
        this.remove(this.selectedId);
        e.preventDefault();
      }
    });
  }

  get isEmpty() {
    return this.items.length === 0;
  }

  setMode(mode) {
    this.mode = mode;
    if (mode !== 'image') this.pendingImage = null;
    this.viewer.root.classList.toggle('tool-text', mode === 'text');
    this.viewer.root.classList.toggle('tool-image', mode === 'image');
  }

  setPendingImage(bytes, format) {
    const blob = new Blob([bytes], { type: format === 'png' ? 'image/png' : 'image/jpeg' });
    const objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    return new Promise((resolve, reject) => {
      img.onload = () => {
        this.pendingImage = { bytes, format, objectUrl, naturalW: img.naturalWidth, naturalH: img.naturalHeight };
        resolve();
      };
      img.onerror = reject;
      img.src = objectUrl;
    });
  }

  #placeText(pageIndex, x, y) {
    const item = {
      id: nextId++,
      type: 'text',
      pageIndex,
      x,
      y,
      text: '',
      committedText: '',
      size: this.defaults.size,
      color: this.defaults.color,
    };
    this.items.push(item);
    this.#mount(item);
    this.select(item.id);
    item.editEl?.focus();
    // No change event yet: an empty box only becomes an edit once text is
    // committed on blur.
  }

  #placeImage(pageIndex, x, y) {
    const { bytes, format, objectUrl, naturalW, naturalH } = this.pendingImage;
    const base = this.viewer.baseViewport(pageIndex);
    let w = Math.min(naturalW * 0.75, base.width / 3);
    let h = w * (naturalH / naturalW);
    const item = { id: nextId++, type: 'image', pageIndex, x: x - w / 2, y: y - h / 2, w, h, bytes, format, objectUrl };
    this.items.push(item);
    this.#mount(item);
    this.select(item.id);
    this.#changed();
    this.dispatchEvent(new CustomEvent('imageplaced'));
  }

  remove(id) {
    const item = this.items.find((it) => it.id === id);
    if (!item) return;
    this.items = this.items.filter((it) => it !== item);
    item.el?.remove();
    if (this.selectedId === id) this.selectedId = null;
    // Discarding a never-committed empty text box is not an edit.
    if (item.type !== 'text' || item.text.trim()) this.#changed();
  }

  select(id) {
    this.selectedId = id;
    for (const it of this.items) it.el?.classList.toggle('selected', it.id === id);
    this.dispatchEvent(new CustomEvent('selectionchange', { detail: { item: this.items.find((i) => i.id === id) || null } }));
  }

  /** Apply font size / color to the selected text overlay (and future ones). */
  setTextProps({ size, color }) {
    if (size) this.defaults.size = size;
    if (color) this.defaults.color = color;
    const item = this.items.find((i) => i.id === this.selectedId && i.type === 'text');
    if (item) {
      if (size) item.size = size;
      if (color) item.color = color;
      this.#style(item);
      this.#changed();
    }
  }

  clear() {
    for (const it of this.items) {
      it.el?.remove();
      if (it.objectUrl) URL.revokeObjectURL(it.objectUrl);
    }
    this.items = [];
    this.selectedId = null;
  }

  /** Serializable snapshot for the undo stack. */
  snapshot() {
    return this.items.map(({ el, editEl, ...rest }) => ({ ...rest }));
  }

  restore(snapshot) {
    this.clear();
    this.items = snapshot.map((it) => ({ ...it }));
    for (const it of this.items) {
      if (it.type === 'image') {
        const blob = new Blob([it.bytes], { type: it.format === 'png' ? 'image/png' : 'image/jpeg' });
        it.objectUrl = URL.createObjectURL(blob);
      }
    }
    this.mountAll();
  }

  mountAll() {
    for (const it of this.items) this.#mount(it);
  }

  #mount(item) {
    item.el?.remove();
    const layer = this.viewer.pages[item.pageIndex]?.ovLayer;
    if (!layer) return null;

    const el = document.createElement('div');
    el.className = `overlay ov-${item.type}`;
    item.el = el;

    if (item.type === 'text') {
      // Editable text lives in its own child so sibling controls (✕, resize)
      // never leak into the captured text.
      const edit = document.createElement('div');
      edit.className = 'ov-edit';
      edit.contentEditable = 'plaintext-only';
      edit.textContent = item.text;
      edit.addEventListener('input', () => {
        item.text = edit.innerText;
        this.#changed(false);
      });
      edit.addEventListener('blur', () => {
        if (!item.text.trim()) {
          this.remove(item.id);
        } else if (item.text !== item.committedText) {
          item.committedText = item.text;
          this.#changed();
        }
      });
      el.appendChild(edit);
      item.editEl = edit;
    } else {
      const img = document.createElement('img');
      img.src = item.objectUrl;
      el.appendChild(img);
      const resize = document.createElement('div');
      resize.className = 'ov-resize';
      el.appendChild(resize);
      this.#wireResize(item, resize);
    }

    const del = document.createElement('button');
    del.className = 'ov-del';
    del.textContent = '✕';
    del.title = 'Remove';
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      this.remove(item.id);
    });
    el.appendChild(del);

    this.#wireDrag(item, el);
    this.#style(item);
    layer.appendChild(el);
    el.classList.toggle('selected', item.id === this.selectedId);
    return el;
  }

  #style(item) {
    const s = this.viewer.scale;
    const el = item.el;
    el.style.left = `${item.x * s}px`;
    el.style.top = `${item.y * s}px`;
    if (item.type === 'text') {
      el.style.fontSize = `${item.size * s}px`;
      el.style.color = item.color;
    } else {
      el.style.width = `${item.w * s}px`;
      el.style.height = `${item.h * s}px`;
    }
  }

  #wireDrag(item, el) {
    el.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('ov-resize')) return;
      this.select(item.id);
      // Text overlays: while the text is focused for editing, leave pointer
      // events to the caret/selection instead of dragging.
      if (item.type === 'text' && document.activeElement === item.editEl) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const origX = item.x;
      const origY = item.y;
      let moved = false;
      const onMove = (ev) => {
        const s = this.viewer.scale;
        const dx = (ev.clientX - startX) / s;
        const dy = (ev.clientY - startY) / s;
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
        moved = true;
        item.x = origX + dx;
        item.y = origY + dy;
        this.#style(item);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (moved) this.#changed();
        else if (item.type === 'text') item.editEl?.focus();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      e.preventDefault();
    });
  }

  #wireResize(item, handle) {
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX;
      const origW = item.w;
      const ratio = item.h / item.w;
      const onMove = (ev) => {
        const s = this.viewer.scale;
        item.w = Math.max(12, origW + (ev.clientX - startX) / s);
        item.h = item.w * ratio;
        this.#style(item);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        this.#changed();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  #changed(structural = true) {
    this.dispatchEvent(new CustomEvent('change', { detail: { structural } }));
  }

  // ---- structural remapping (called by the app around page operations) ----

  remapAfterDelete(deleted) {
    const del = new Set(deleted);
    this.items = this.items.filter((it) => {
      if (del.has(it.pageIndex)) {
        it.el?.remove();
        return false;
      }
      return true;
    });
    for (const it of this.items) {
      it.pageIndex -= deleted.filter((d) => d < it.pageIndex).length;
    }
  }

  remapAfterReorder(order) {
    for (const it of this.items) it.pageIndex = order.indexOf(it.pageIndex);
  }

  remapAfterInsert(atIndex, count) {
    for (const it of this.items) if (it.pageIndex >= atIndex) it.pageIndex += count;
  }

  /**
   * Rotating a page changes its viewed coordinate system; keep overlays under
   * the same spot on screen. W/H are the page's *pre-rotation* view size.
   */
  remapAfterRotate(pageIndices, delta, dims) {
    const d = ((delta % 360) + 360) % 360;
    for (const it of this.items) {
      if (!pageIndices.includes(it.pageIndex)) continue;
      const { width: W, height: H } = dims.get(it.pageIndex);
      const bw = it.type === 'image' ? it.w : (it.el?.offsetWidth ?? 0) / this.viewer.scale;
      const bh = it.type === 'image' ? it.h : (it.el?.offsetHeight ?? 0) / this.viewer.scale;
      let { x, y } = it;
      if (d === 90) {
        [it.x, it.y] = [H - y - bh, x];
      } else if (d === 270) {
        [it.x, it.y] = [y, W - x - bw];
      } else if (d === 180) {
        [it.x, it.y] = [W - x - bw, H - y - bh];
      }
      if (it.type === 'image' && (d === 90 || d === 270)) {
        // The box itself stays axis-aligned; nothing else to change because
        // width/height are stored in view points and follow the box.
      }
    }
  }

  /** Payload for pdf-engine.bakeOverlays: convert view points → PDF user space. */
  bakePayload() {
    const out = [];
    for (const it of this.items) {
      const viewport = this.viewer.baseViewport(it.pageIndex);
      if (it.type === 'text') {
        if (!it.text.trim()) continue;
        const baselineY = it.y + it.size * TEXT_BASELINE;
        const [x, y] = viewport.convertToPdfPoint(it.x, baselineY);
        out.push({
          type: 'text',
          pageIndex: it.pageIndex,
          x,
          y,
          text: it.text.replace(/\r/g, ''),
          size: it.size,
          lineHeight: it.size * TEXT_LINE_HEIGHT,
          color: hexToRgb(it.color),
        });
      } else {
        const [x, y] = viewport.convertToPdfPoint(it.x, it.y + it.h);
        out.push({
          type: 'image',
          pageIndex: it.pageIndex,
          x,
          y,
          width: it.w,
          height: it.h,
          bytes: it.bytes,
          format: it.format,
        });
      }
    }
    return out;
  }
}

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 };
}
