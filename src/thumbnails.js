// Thumbnail sidebar: click to jump, multi-select, drag to reorder.
// Emits: 'goto' {pageIndex}, 'select' {indices}, 'reorder' {order}.

const THUMB_WIDTH = 120;

export class Thumbnails extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.selected = new Set();
    this.lastClicked = 0;
    this.count = 0;
  }

  get selection() {
    return [...this.selected].sort((a, b) => a - b);
  }

  clearSelection() {
    this.selected.clear();
    this.#refreshSelection();
    this.dispatchEvent(new CustomEvent('select', { detail: { indices: [] } }));
  }

  setCurrent(pageIndex) {
    this.container.querySelectorAll('.thumb').forEach((el, i) => {
      el.classList.toggle('current', i === pageIndex);
    });
    const el = this.container.querySelectorAll('.thumb')[pageIndex];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  async build(viewer) {
    this.container.textContent = '';
    this.selected.clear();
    this.count = viewer.pageCount;
    this.dispatchEvent(new CustomEvent('select', { detail: { indices: [] } }));

    for (let i = 0; i < viewer.pageCount; i++) {
      const el = document.createElement('div');
      el.className = 'thumb';
      el.draggable = true;
      el.dataset.index = String(i);
      const canvas = document.createElement('canvas');
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(i + 1);
      el.append(canvas, num);
      this.container.appendChild(el);
      this.#wire(el);
    }

    // Render after the DOM is in place so the sidebar appears immediately.
    for (let i = 0; i < viewer.pageCount; i++) {
      const proxy = viewer.proxies[i];
      const canvas = this.container.children[i]?.querySelector('canvas');
      if (!canvas) break; // rebuilt mid-render
      const base = proxy.getViewport({ scale: 1 });
      const scale = THUMB_WIDTH / base.width;
      const viewport = proxy.getViewport({ scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      try {
        await proxy.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      } catch {
        break; // document was replaced while rendering
      }
    }
  }

  #wire(el) {
    const index = () => Number(el.dataset.index);

    el.addEventListener('click', (e) => {
      const i = index();
      if (e.ctrlKey || e.metaKey) {
        this.selected.has(i) ? this.selected.delete(i) : this.selected.add(i);
        this.lastClicked = i;
      } else if (e.shiftKey) {
        const [a, b] = [Math.min(this.lastClicked, i), Math.max(this.lastClicked, i)];
        for (let k = a; k <= b; k++) this.selected.add(k);
      } else {
        this.selected.clear();
        this.selected.add(i);
        this.lastClicked = i;
        this.dispatchEvent(new CustomEvent('goto', { detail: { pageIndex: i } }));
      }
      this.#refreshSelection();
      this.dispatchEvent(new CustomEvent('select', { detail: { indices: this.selection } }));
    });

    el.addEventListener('dragstart', (e) => {
      const i = index();
      if (!this.selected.has(i)) {
        this.selected.clear();
        this.selected.add(i);
        this.#refreshSelection();
        this.dispatchEvent(new CustomEvent('select', { detail: { indices: this.selection } }));
      }
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'pages'); // required by some engines
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      this.#clearDropMarkers();
    });

    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      this.#clearDropMarkers();
      const rect = el.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      el.classList.add(before ? 'drop-before' : 'drop-after');
    });

    el.addEventListener('dragleave', () => this.#clearDropMarkers());

    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      const target = index() + (before ? 0 : 1);
      this.#clearDropMarkers();
      const moving = this.selection;
      if (!moving.length) return;
      const order = this.#orderAfterMove(moving, target);
      if (order) this.dispatchEvent(new CustomEvent('reorder', { detail: { order } }));
    });
  }

  /** New page order after moving `moving` (sorted old indices) before old position `target`. */
  #orderAfterMove(moving, target) {
    const rest = [];
    for (let i = 0; i < this.count; i++) if (!moving.includes(i)) rest.push(i);
    const insertAt = rest.filter((i) => i < target).length;
    const order = [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
    // No-op moves produce the identity order; skip those.
    return order.some((v, i) => v !== i) ? order : null;
  }

  #refreshSelection() {
    this.container.querySelectorAll('.thumb').forEach((el, i) => {
      el.classList.toggle('selected', this.selected.has(i));
    });
  }

  #clearDropMarkers() {
    this.container
      .querySelectorAll('.drop-before, .drop-after')
      .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  }
}
