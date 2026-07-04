// Text search across the document. Each page's text runs are concatenated
// into one string (line breaks become spaces) so phrases match even when the
// PDF splits them across runs — the same behavior as Acrobat's Find. Matches
// are painted as highlight boxes in each page's hlLayer.

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

export class Searcher {
  constructor(viewer, ui) {
    this.viewer = viewer;
    this.ui = ui; // { count } element for "3/17"
    this.pages = null; // per page: { text, runs: [{ item, start }] }
    this.matches = []; // { page, segments: [{ item, startFrac, endFrac }] }
    this.active = -1;
    this.query = '';

    viewer.addEventListener('layout', () => this.#paintAll());
  }

  reset() {
    this.pages = null;
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
    if (this.pages) return;
    this.pages = [];
    for (let i = 0; i < this.viewer.pageCount; i++) {
      const content = await this.viewer.pages[i].proxy.getTextContent();
      const items = [...content.items, ...(this.viewer.ocrItems?.(i) ?? [])];
      let text = '';
      const runs = [];
      for (const it of items) {
        if (!('str' in it)) continue;
        if (it.str) {
          runs.push({ item: it, start: text.length });
          text += it.str;
        }
        // A line break acts as a single space, like Acrobat's Find.
        if (it.hasEOL) text += ' ';
      }
      this.pages.push({ text: text.toLowerCase(), runs });
    }
  }

  async search(query) {
    this.query = query;
    this.matches = [];
    this.active = -1;
    if (query.trim().length >= 1) {
      await this.#collect();
      const q = query.toLowerCase();
      for (let page = 0; page < this.pages.length; page++) {
        const { text } = this.pages[page];
        let from = 0;
        let at;
        while ((at = text.indexOf(q, from)) !== -1) {
          this.matches.push({ page, segments: this.#segments(page, at, at + q.length) });
          from = at + q.length;
        }
      }
    }
    if (this.matches.length) this.active = 0;
    this.#paintAll();
    this.#updateCount();
    this.#scrollToActive();
    return this.matches.length;
  }

  /** Map a [start, end) range in the page string back onto its text runs. */
  #segments(page, start, end) {
    const segments = [];
    for (const run of this.pages[page].runs) {
      const len = run.item.str.length;
      const s = Math.max(start, run.start);
      const e = Math.min(end, run.start + len);
      if (s < e) {
        segments.push({
          item: run.item,
          startFrac: (s - run.start) / len,
          endFrac: (e - run.start) / len,
        });
      }
      if (run.start >= end) break;
    }
    return segments;
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

  /** Viewport-space rect for one segment of a match at the current zoom. */
  #segmentRect(pageIndex, seg) {
    const viewport = this.viewer.viewport(pageIndex);
    const tx = pdfjsLib.Util.transform(viewport.transform, seg.item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    const widthView = seg.item.width * viewport.scale;
    return {
      x: tx[4] + seg.startFrac * widthView,
      y: tx[5] - fontHeight,
      w: Math.max(2, (seg.endFrac - seg.startFrac) * widthView),
      h: fontHeight * 1.15,
    };
  }

  #paintAll() {
    if (!this.viewer.pages.length) return;
    for (const p of this.viewer.pages) p.hlLayer.textContent = '';
    this.matches.forEach((m, idx) => {
      for (const seg of m.segments) {
        const rect = this.#segmentRect(m.page, seg);
        const div = document.createElement('div');
        div.className = idx === this.active ? 'hl active' : 'hl';
        div.style.left = `${rect.x}px`;
        div.style.top = `${rect.y}px`;
        div.style.width = `${rect.w}px`;
        div.style.height = `${rect.h}px`;
        this.viewer.pages[m.page].hlLayer.appendChild(div);
      }
    });
  }

  #scrollToActive() {
    if (this.active < 0) return;
    const m = this.matches[this.active];
    if (!m.segments.length) return;
    const rect = this.#segmentRect(m.page, m.segments[0]);
    this.viewer.scrollToPoint(m.page, rect.y);
  }
}
