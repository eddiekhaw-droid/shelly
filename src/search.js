// Text search across the document. Matches are located per text item using
// pdf.js text content, and painted as highlight boxes in each page's hlLayer.

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

export class Searcher {
  constructor(viewer, ui) {
    this.viewer = viewer;
    this.ui = ui; // { count } element for "3/17"
    this.items = null; // per page: [{ str, transform, width }]
    this.matches = [];
    this.active = -1;
    this.query = '';

    viewer.addEventListener('layout', () => this.#paintAll());
  }

  reset() {
    this.items = null;
    this.clear();
  }

  clear() {
    this.matches = [];
    this.active = -1;
    this.query = '';
    this.#paintAll();
    this.#updateCount();
  }

  async #collect() {
    if (this.items) return;
    this.items = [];
    for (let i = 0; i < this.viewer.pageCount; i++) {
      const content = await this.viewer.pages[i].proxy.getTextContent();
      this.items.push(
        content.items
          .filter((it) => 'str' in it && it.str)
          .map((it) => ({ str: it.str, transform: it.transform, width: it.width }))
      );
    }
  }

  async search(query) {
    this.query = query;
    this.matches = [];
    this.active = -1;
    if (query.trim().length >= 1) {
      await this.#collect();
      const q = query.toLowerCase();
      for (let page = 0; page < this.items.length; page++) {
        for (const item of this.items[page]) {
          const hay = item.str.toLowerCase();
          let from = 0;
          let at;
          while ((at = hay.indexOf(q, from)) !== -1) {
            this.matches.push({
              page,
              item,
              startFrac: at / item.str.length,
              endFrac: (at + q.length) / item.str.length,
            });
            from = at + q.length;
          }
        }
      }
    }
    if (this.matches.length) this.active = 0;
    this.#paintAll();
    this.#updateCount();
    this.#scrollToActive();
    return this.matches.length;
  }

  next(dir = 1) {
    if (!this.matches.length) return;
    this.active = (this.active + dir + this.matches.length) % this.matches.length;
    this.#paintAll();
    this.#updateCount();
    this.#scrollToActive();
  }

  #updateCount() {
    if (!this.ui?.count) return;
    this.ui.count.textContent = this.query
      ? this.matches.length
        ? `${this.active + 1} / ${this.matches.length}`
        : 'No matches'
      : '';
  }

  /** Viewport-space rect for a match at the current zoom. */
  #matchRect(m) {
    const viewport = this.viewer.viewport(m.page);
    const tx = pdfjsLib.Util.transform(viewport.transform, m.item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    const widthView = m.item.width * viewport.scale;
    return {
      x: tx[4] + m.startFrac * widthView,
      y: tx[5] - fontHeight,
      w: Math.max(2, (m.endFrac - m.startFrac) * widthView),
      h: fontHeight * 1.15,
    };
  }

  #paintAll() {
    if (!this.viewer.pages.length) return;
    for (const p of this.viewer.pages) p.hlLayer.textContent = '';
    this.matches.forEach((m, idx) => {
      const rect = this.#matchRect(m);
      const div = document.createElement('div');
      div.className = idx === this.active ? 'hl active' : 'hl';
      div.style.left = `${rect.x}px`;
      div.style.top = `${rect.y}px`;
      div.style.width = `${rect.w}px`;
      div.style.height = `${rect.h}px`;
      this.viewer.pages[m.page].hlLayer.appendChild(div);
    });
  }

  #scrollToActive() {
    if (this.active < 0) return;
    const m = this.matches[this.active];
    const rect = this.#matchRect(m);
    this.viewer.scrollToPoint(m.page, rect.y);
  }
}
