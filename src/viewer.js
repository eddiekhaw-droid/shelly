// Renders the document with pdf.js: continuous scroll, lazy page rendering,
// zoom modes, text layers for selection/search.

// The legacy build carries polyfills for newer JS features, widening the
// range of Electron/Chromium versions the app runs on.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const PAGE_GAP = 16;
const H_PADDING = 48; // breathing room used by fit-width

export class Viewer extends EventTarget {
  constructor(root) {
    super();
    this.root = root;
    this.doc = null;
    this.pages = []; // { proxy, el, canvas, textLayerDiv, hlLayer, ovLayer, viewport, rendered }
    this.scale = 1;
    this.zoomMode = 'fit-width'; // 'fit-width' | 'fit-page' | number
    this.currentPage = 0;
    this.observer = null;

    this.root.addEventListener('scroll', () => this.#trackCurrentPage());
    window.addEventListener('resize', () => {
      if (typeof this.zoomMode === 'string' && this.doc) this.setZoom(this.zoomMode);
    });
  }

  get pageCount() {
    return this.doc ? this.doc.numPages : 0;
  }

  async load(bytes) {
    if (this.doc) {
      await this.doc.destroy();
      this.doc = null;
    }
    // pdf.js takes ownership of (detaches) the buffer, so hand it a copy.
    this.doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const proxies = [];
    for (let i = 1; i <= this.doc.numPages; i++) proxies.push(await this.doc.getPage(i));
    this.proxies = proxies;
    await this.#layout();
    this.currentPage = 0;
    this.#trackCurrentPage();
  }

  /** Base (scale=1) viewport, includes the page's own rotation. */
  baseViewport(pageIndex) {
    return this.proxies[pageIndex].getViewport({ scale: 1 });
  }

  viewport(pageIndex) {
    return this.pages[pageIndex].viewport;
  }

  pageEl(pageIndex) {
    return this.pages[pageIndex]?.el;
  }

  #computeScale() {
    if (typeof this.zoomMode === 'number') return this.zoomMode;
    const first = this.baseViewport(0);
    const availW = Math.max(120, this.root.clientWidth - H_PADDING);
    if (this.zoomMode === 'fit-page') {
      const availH = Math.max(120, this.root.clientHeight - PAGE_GAP * 2);
      return Math.min(availW / first.width, availH / first.height);
    }
    return availW / first.width; // fit-width
  }

  async #layout() {
    if (this.observer) this.observer.disconnect();
    this.root.textContent = '';
    this.scale = this.#computeScale();
    this.pages = [];

    for (let i = 0; i < this.proxies.length; i++) {
      const proxy = this.proxies[i];
      const viewport = proxy.getViewport({ scale: this.scale });
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.page = String(i);
      el.style.width = `${Math.floor(viewport.width)}px`;
      el.style.height = `${Math.floor(viewport.height)}px`;
      el.style.setProperty('--scale-factor', String(viewport.scale));

      const canvas = document.createElement('canvas');
      const textLayerDiv = document.createElement('div');
      textLayerDiv.className = 'textLayer';
      const hlLayer = document.createElement('div');
      hlLayer.className = 'hlLayer';
      const ovLayer = document.createElement('div');
      ovLayer.className = 'ovLayer';
      el.append(canvas, textLayerDiv, hlLayer, ovLayer);
      this.root.appendChild(el);

      this.pages.push({ proxy, el, canvas, textLayerDiv, hlLayer, ovLayer, viewport, rendered: false, rendering: null });
    }

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) this.renderPage(Number(entry.target.dataset.page));
        }
      },
      { root: this.root, rootMargin: '600px 0px' }
    );
    for (const p of this.pages) this.observer.observe(p.el);

    this.dispatchEvent(new CustomEvent('layout'));
  }

  async renderPage(i) {
    const p = this.pages[i];
    if (!p || p.rendered || p.rendering) return p?.rendering;
    p.rendering = (async () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      p.canvas.width = Math.floor(p.viewport.width * dpr);
      p.canvas.height = Math.floor(p.viewport.height * dpr);
      p.canvas.style.width = `${Math.floor(p.viewport.width)}px`;
      p.canvas.style.height = `${Math.floor(p.viewport.height)}px`;
      const ctx = p.canvas.getContext('2d');
      await p.proxy.render({
        canvasContext: ctx,
        viewport: p.viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      }).promise;

      try {
        const textLayer = new pdfjsLib.TextLayer({
          textContentSource: p.proxy.streamTextContent(),
          container: p.textLayerDiv,
          viewport: p.viewport,
        });
        await textLayer.render();
      } catch (err) {
        console.warn('text layer failed on page', i + 1, err);
      }

      p.rendered = true;
      p.rendering = null;
      this.dispatchEvent(new CustomEvent('pagerendered', { detail: { pageIndex: i } }));
    })();
    return p.rendering;
  }

  async renderAllPages() {
    for (let i = 0; i < this.pages.length; i++) await this.renderPage(i);
  }

  async setZoom(mode) {
    if (!this.doc) {
      this.zoomMode = mode;
      return;
    }
    // Keep the reader anchored on the page they were looking at.
    const anchorPage = this.currentPage;
    const anchorEl = this.pages[anchorPage]?.el;
    const offsetFrac = anchorEl
      ? (this.root.scrollTop - anchorEl.offsetTop) / Math.max(1, anchorEl.offsetHeight)
      : 0;

    this.zoomMode = mode;
    await this.#layout();

    const newEl = this.pages[anchorPage]?.el;
    if (newEl) this.root.scrollTop = newEl.offsetTop + offsetFrac * newEl.offsetHeight;
    this.#trackCurrentPage();
  }

  async zoomBy(factor) {
    const next = Math.min(6, Math.max(0.2, this.scale * factor));
    await this.setZoom(Math.round(next * 100) / 100);
  }

  goToPage(i) {
    const el = this.pages[i]?.el;
    if (!el) return;
    this.root.scrollTop = el.offsetTop - PAGE_GAP / 2;
    this.#trackCurrentPage();
  }

  scrollToPoint(pageIndex, yView) {
    const el = this.pages[pageIndex]?.el;
    if (!el) return;
    this.root.scrollTop = el.offsetTop + yView - this.root.clientHeight / 3;
    this.#trackCurrentPage();
  }

  #trackCurrentPage() {
    if (!this.pages.length) return;
    const probe = this.root.scrollTop + Math.min(200, this.root.clientHeight / 3);
    let best = 0;
    for (let i = 0; i < this.pages.length; i++) {
      const el = this.pages[i].el;
      if (el.offsetTop <= probe) best = i;
      else break;
    }
    if (best !== this.currentPage) {
      this.currentPage = best;
      this.dispatchEvent(new CustomEvent('pagechange', { detail: { pageIndex: best } }));
    }
  }
}
