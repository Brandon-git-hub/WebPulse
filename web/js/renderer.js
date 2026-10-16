// Canvas 2D waveform renderer.
//
// Layout (css px): a ruler of RULER_H at the top, then one row of ROW_H per
// enabled channel (disabled channels take no space), then one row of DEC_ROW_H
// per protocol decoder annotation row. Data comes from the server as either raw samples or per-pixel
// summaries (see server.c); both are mapped into the current viewport so a
// slightly stale response still lines up while the user pans or zooms.

import { niceStep, tickLabel } from './format.js';

export const RULER_H = 30;
export const ROW_H = 44;
export const DEC_ROW_H = 26;
export const CHANNELS = 8;

// Canvas colours come from CSS custom properties (--cv-*) so the light and
// dark themes are defined in one place; loadTheme() re-reads them.
const COLORS = {};
const COLOR_VARS = {
  bg: '--cv-bg', rowAlt: '--cv-row-alt', rowActive: '--cv-row-active', measure: '--cv-measure',
  ruler: '--cv-ruler', grid: '--cv-grid', gridStrong: '--cv-grid-strong', text: '--cv-text',
  textStrong: '--cv-text-strong', outside: '--cv-outside', trigger: '--cv-trigger',
  triggerInk: '--cv-trigger-ink', cursorA: '--cursor-a', cursorB: '--cursor-b',
  cursorInk: '--cv-cursor-ink', cursorShade: '--cv-cursor-shade', dots: '--cv-dots',
  hover: '--cv-hover', decError: '--danger',
};

/** Index of the first element of sorted array a that is > v. */
function upperBound(a, v) {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function loadTheme() {
  const cs = getComputedStyle(document.documentElement);
  for (const [k, v] of Object.entries(COLOR_VARS)) COLORS[k] = cs.getPropertyValue(v).trim() || '#888';
}
loadTheme();

export class Renderer {
  constructor(canvas, viewport, channels) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.vp = viewport;
    this.channels = channels;   // [{ name, color, enabled }]
    this.data = null;           // last query response
    this.cursors = { a: null, b: null };
    this.hoverX = null;
    this.active = null;         // highlighted channel (pointer row)
    this.measure = null;        // { ch, level, pm, p, n, nn } from the server
    this.dpr = 1;
    this.cssW = 0;
    this.rows = [];             // [{ top, h }] per channel
    this.order = Array.from({ length: CHANNELS }, (_, c) => c);   // display order, top first
    // Decoder rows below the channels: { label, color, error, status, data }
    // where data = { start: number[], end: number[], text: string[][] } or null.
    this.decRows = [];
    this.layout();
    this.pending = false;
  }

  /** Recompute row positions from the channels' enabled flags. */
  layout() {
    let y = RULER_H;
    this.rows = [];
    for (const c of this.order) {
      const h = this.channels[c].enabled ? ROW_H : 0;
      this.rows[c] = { top: y, h };
      y += h;
    }
    this.chBottom = y;
    for (const r of this.decRows) {
      r.top = y;
      y += DEC_ROW_H;
    }
    this.cssH = y;
  }

  /** Call after enabling, disabling or reordering channels. */
  relayout() {
    this.layout();
    this.cssW = 0;      // force resize() to reallocate the canvas
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(this.canvas.parentElement.clientWidth));
    if (w === this.cssW && dpr === this.dpr) return false;
    this.dpr = dpr;
    this.cssW = w;
    this.canvas.style.height = this.cssH + 'px';
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.vp.setWidth(w);
    this.requestDraw();
    return true;
  }

  setData(d) {
    this.data = d;
    this.requestDraw();
  }

  clearData() {
    this.data = null;
    this.requestDraw();
  }

  requestDraw() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.draw();
    });
  }

  // ---- drawing ---------------------------------------------------------------

  draw() {
    const { ctx, dpr, cssW: W, cssH: H } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    // Alternate shading by visible row so it stays striped with rows hidden.
    let vis = 0;
    for (const c of this.order) {
      const { top, h } = this.rows[c];
      if (!h) continue;
      if (vis++ % 2) {
        ctx.fillStyle = COLORS.rowAlt;
        ctx.fillRect(0, top, W, h);
      }
      if (c === this.active) {
        ctx.fillStyle = COLORS.rowActive;
        ctx.fillRect(0, top, W, h);
      }
    }

    const cap = this.vp.capture;
    if (cap) {
      this.drawOutside(W, H);
      const ticks = this.ticks(W);
      this.drawGrid(ticks, H);
      this.drawWaves(W);
      this.drawDecoders(W);
      this.drawMeasure(W);
      this.drawTrigger(H);
      this.drawRuler(ticks, W);
      this.drawCursors(H);
      this.drawHover(H);
    } else {
      this.drawRuler(null, W);
    }

    // Row separators
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 0; c <= CHANNELS; c++) {
      const y = (c < CHANNELS ? this.rows[c].top : this.chBottom) - 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    for (const r of this.decRows) {
      ctx.moveTo(0, r.top + DEC_ROW_H - 0.5);
      ctx.lineTo(W, r.top + DEC_ROW_H - 0.5);
    }
    ctx.stroke();
    if (this.decRows.length) {
      ctx.strokeStyle = COLORS.gridStrong;
      ctx.beginPath();
      ctx.moveTo(0, this.chBottom - 0.5);
      ctx.lineTo(W, this.chBottom - 0.5);
      ctx.stroke();
    }
  }

  /** Decoder row at css y: { row, index }, or null. */
  decoderAt(y) {
    for (let i = 0; i < this.decRows.length; i++) {
      const r = this.decRows[i];
      if (y >= r.top && y < r.top + DEC_ROW_H) return { row: r, index: i };
    }
    return null;
  }

  /** Annotation of decoder row r under css x: { start, end, text } or null. */
  annotationAt(r, x) {
    const d = r.data;
    if (!d || !d.start.length) return null;
    const s = this.vp.sampleAt(x);
    const tol = this.vp.spp * 2;          // a couple of pixels for thin marks
    // Sorted by start and rarely overlapping: the last few starting left of
    // the pointer are the only candidates.
    const last = upperBound(d.start, s + tol) - 1;
    for (let i = last; i >= 0 && i > last - 8; i--) {
      if (d.start[i] - tol <= s && s <= d.end[i] + tol) {
        return { start: d.start[i], end: d.end[i], text: d.text[i] };
      }
    }
    return null;
  }

  /**
   * Annotations as boxes with the longest text that fits. Where annotations
   * are narrower than a pixel, one mark per pixel is drawn and the rest are
   * skipped, so the cost stays proportional to the width.
   */
  drawDecoders(W) {
    const { ctx, vp } = this;
    if (!this.decRows.length) return;
    ctx.font = '11px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const charW = this.charW || (this.charW = ctx.measureText('M').width || 7);
    const s0 = vp.sampleAt(0), s1 = vp.sampleAt(W);
    for (const r of this.decRows) {
      const y0 = r.top + 4, h = DEC_ROW_H - 8, ym = r.top + DEC_ROW_H / 2;
      const color = r.error ? COLORS.decError : r.color;
      if (!r.data) {
        if (r.status) {
          ctx.textAlign = 'left';
          ctx.fillStyle = r.error ? COLORS.decError : COLORS.text;
          ctx.fillText(r.status, 8, ym);
          ctx.textAlign = 'center';
        }
        continue;
      }
      const { start, end, text } = r.data;
      let i = Math.max(0, upperBound(start, s0) - 1);
      while (i < start.length && start[i] <= s1) {
        if (end[i] < s0) { i++; continue; }
        const x0 = vp.xOf(start[i]), x1 = vp.xOf(end[i]);
        const w = x1 - x0;
        if (w < 3) {
          // Dense: one mark for this pixel, then jump past it.
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.7;
          ctx.fillRect(Math.floor(x0), y0, Math.max(1, Math.ceil(w)), h);
          ctx.globalAlpha = 1;
          const next = upperBound(start, vp.sampleAt(Math.floor(x0) + 1));
          i = Math.max(i + 1, next);
          continue;
        }
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.22;
        ctx.fillRect(x0, y0, w, h);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(x0) + 0.5, y0 + 0.5, Math.max(1, Math.round(w) - 1), h - 1);
        const room = Math.min(x1, W) - Math.max(x0, 0) - 6;
        const t = text[i].find((s) => s.length * charW <= room);
        if (t) {
          ctx.fillStyle = COLORS.textStrong;
          ctx.fillText(t, (Math.max(x0, 0) + Math.min(x1, W)) / 2, ym + 0.5);
        }
        i++;
      }
    }
    ctx.textAlign = 'left';
  }

  /** Shade the area before sample 0 and after the last sample. */
  drawOutside(W, H) {
    const { ctx, vp } = this;
    const x0 = vp.xOf(0), x1 = vp.xOf(vp.capture.n);
    ctx.fillStyle = COLORS.outside;
    if (x0 > 0) ctx.fillRect(0, RULER_H, Math.min(x0, W), H - RULER_H);
    if (x1 < W) ctx.fillRect(Math.max(x1, 0), RULER_H, W - Math.max(x1, 0), H - RULER_H);
  }

  ticks(W) {
    const vp = this.vp;
    const rate = vp.capture.rate;
    const secPerPx = vp.spp / rate;
    const step = niceStep(secPerPx * 100);
    const tStart = vp.timeOf(vp.sampleAt(0));
    const tEnd = vp.timeOf(vp.sampleAt(W));
    const out = [];
    const first = Math.ceil(tStart / step);
    for (let k = first; k * step <= tEnd && out.length < 200; k++) {
      const t = k * step;
      const x = vp.xOf(vp.origin + t * rate);
      out.push({ t, x, major: true });
    }
    return { step, list: out };
  }

  drawGrid(ticks, H) {
    const { ctx } = this;
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const tk of ticks.list) {
      const x = Math.round(tk.x) + 0.5;
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, H);
    }
    ctx.stroke();
  }

  drawRuler(ticks, W) {
    const { ctx } = this;
    ctx.fillStyle = COLORS.ruler;
    ctx.fillRect(0, 0, W, RULER_H);
    ctx.strokeStyle = COLORS.gridStrong;
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 0.5);
    ctx.lineTo(W, RULER_H - 0.5);
    ctx.stroke();
    if (!ticks) return;

    ctx.font = '11px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    ctx.strokeStyle = COLORS.gridStrong;
    ctx.beginPath();
    // Minor ticks: 5 per major step
    const vp = this.vp;
    const minor = ticks.step / 5;
    const pxPerSec = vp.capture.rate / vp.spp;
    if (minor * pxPerSec >= 6) {
      const tStart = vp.timeOf(vp.sampleAt(0));
      const tEnd = vp.timeOf(vp.sampleAt(W));
      for (let k = Math.ceil(tStart / minor), n = 0; k * minor <= tEnd && n < 1000; k++, n++) {
        const x = Math.round(vp.xOf(vp.origin + k * minor * vp.capture.rate)) + 0.5;
        ctx.moveTo(x, RULER_H - 5);
        ctx.lineTo(x, RULER_H);
      }
    }
    for (const tk of ticks.list) {
      const x = Math.round(tk.x) + 0.5;
      ctx.moveTo(x, RULER_H - 12);
      ctx.lineTo(x, RULER_H);
    }
    ctx.stroke();
    for (const tk of ticks.list) {
      ctx.fillText(tickLabel(tk.t, ticks.step), Math.round(tk.x) + 4, 5);
    }
  }

  drawWaves(W) {
    const d = this.data;
    if (!d) return;
    if (d.mode === 0) this.drawRaw(d, W);
    else this.drawSummary(d, W);
  }

  rowY(c) {
    const { top, h } = this.rows[c];
    return { hi: top + 10.5, lo: top + h - 10.5 };
  }

  drawRaw(d, W) {
    const { ctx, vp } = this;
    const raw = d.raw;
    const n = raw.length;
    if (!n) return;
    // Visible slice of the response
    let i0 = Math.max(0, Math.floor(vp.sampleAt(0) - d.t0) - 1);
    let i1 = Math.min(n, Math.ceil(vp.sampleAt(W) - d.t0) + 1);
    if (i1 <= i0) return;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'miter';
    for (let c = 0; c < CHANNELS; c++) {
      if (!this.channels[c].enabled) continue;
      const { hi, lo } = this.rowY(c);
      const bit = 1 << c;
      ctx.strokeStyle = this.channels[c].color;
      ctx.beginPath();
      let level = raw[i0] & bit;
      let x = vp.xOf(d.t0 + i0);
      ctx.moveTo(x, level ? hi : lo);
      for (let i = i0 + 1; i < i1; i++) {
        const v = raw[i] & bit;
        if (v !== level) {
          x = vp.xOf(d.t0 + i);
          ctx.lineTo(x, level ? hi : lo);
          ctx.lineTo(x, v ? hi : lo);
          level = v;
        }
      }
      ctx.lineTo(vp.xOf(d.t0 + i1), level ? hi : lo);
      ctx.stroke();
    }
    // Sample dots when zoomed in far enough
    if (1 / vp.spp >= 12) {
      ctx.fillStyle = COLORS.dots;
      for (let i = i0; i < i1; i++) {
        const x = vp.xOf(d.t0 + i);
        for (let c = 0; c < CHANNELS; c++) {
          if (!this.channels[c].enabled) continue;
          const { hi, lo } = this.rowY(c);
          ctx.fillRect(x - 1, (raw[i] >> c) & 1 ? hi - 1 : lo - 1, 2, 2);
        }
      }
    }
  }

  drawSummary(d, W) {
    const { ctx, vp } = this;
    const px = d.px;
    const w = px.length;
    const span = d.t1 - d.t0;
    if (!w || span <= 0) return;
    const xs = new Float32Array(w + 1);
    for (let p = 0; p <= w; p++) xs[p] = vp.xOf(d.t0 + (span * p) / w);

    for (let c = 0; c < CHANNELS; c++) {
      if (!this.channels[c].enabled) continue;
      const { hi, lo } = this.rowY(c);
      const color = this.channels[c].color;
      const hiBit = 1 << (2 * c), loBit = 1 << (2 * c + 1);

      // Pass 1: dense regions (both levels inside one pixel) as filled blocks.
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.45;
      let runStart = -1;
      for (let p = 0; p <= w; p++) {
        const dense = p < w && (px[p] & hiBit) && (px[p] & loBit);
        if (dense && runStart < 0) runStart = p;
        if (!dense && runStart >= 0) {
          const x0 = xs[runStart], x1 = Math.max(xs[p], x0 + 1);
          if (x1 >= 0 && x0 <= W) ctx.fillRect(x0, hi, x1 - x0, lo - hi);
          runStart = -1;
        }
      }
      ctx.globalAlpha = 1;

      // Pass 2: levels and edges.
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let prev = 0;     // 1 = high, 2 = low, 3 = dense, 0 = none
      for (let p = 0; p < w; p++) {
        const v = px[p];
        const h = (v & hiBit) !== 0, l = (v & loBit) !== 0;
        const st = h && l ? 3 : h ? 1 : l ? 2 : 0;
        const x0 = xs[p], x1 = xs[p + 1];
        if (x1 < -2 || x0 > W + 2) { prev = st; continue; }
        if (st === 1 || st === 2) {
          const y = st === 1 ? hi : lo;
          if (prev === 3 - st) {          // edge between high and low
            ctx.moveTo(x0, st === 1 ? lo : hi);
            ctx.lineTo(x0, y);
          } else {
            ctx.moveTo(x0, y);
          }
          ctx.lineTo(x1, y);
        } else if (st === 3) {
          ctx.moveTo(x0, hi);
          ctx.lineTo(x1, hi);
          ctx.moveTo(x0, lo);
          ctx.lineTo(x1, lo);
        }
        prev = st;
      }
      ctx.stroke();
    }
  }

  /** Channel row at css y, or null (ruler / below the rows). */
  channelAt(y) {
    for (let c = 0; c < CHANNELS; c++) {
      const { top, h } = this.rows[c];
      if (h && y >= top && y < top + h) return c;
    }
    return null;
  }

  /** Mark the pulse under the pointer: its span and the following level. */
  drawMeasure(W) {
    const m = this.measure;
    if (!m || m.ch !== this.active || !this.channels[m.ch].enabled) return;
    const { ctx, vp } = this;
    const { top, h } = this.rows[m.ch];
    const y = top + h / 2 + 0.5;
    const seg = (a, b, alpha) => {
      if (a < 0 || b < 0) return;
      const x0 = vp.xOf(a), x1 = vp.xOf(b);
      if (x1 < 0 || x0 > W || x1 - x0 < 6) return;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(x0 + 1, y);
      ctx.lineTo(x1 - 1, y);
      // arrow heads
      ctx.moveTo(x0 + 5, y - 3); ctx.lineTo(x0 + 1, y); ctx.lineTo(x0 + 5, y + 3);
      ctx.moveTo(x1 - 5, y - 3); ctx.lineTo(x1 - 1, y); ctx.lineTo(x1 - 5, y + 3);
      ctx.stroke();
    };
    ctx.save();
    ctx.strokeStyle = COLORS.measure;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    seg(m.p, m.n, 1);
    seg(m.n, m.nn, 0.4);
    ctx.restore();
  }

  drawTrigger(H) {
    const { ctx, vp } = this;
    const tp = vp.capture.trigger_pos;
    if (tp < 0) return;
    const x = Math.round(vp.xOf(tp)) + 0.5;
    if (x < -10 || x > this.cssW + 10) return;
    ctx.save();
    ctx.strokeStyle = COLORS.trigger;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, RULER_H);
    ctx.lineTo(x, H);
    ctx.stroke();
    ctx.restore();
    // Flag on the ruler
    ctx.fillStyle = COLORS.trigger;
    ctx.beginPath();
    ctx.moveTo(x - 6, RULER_H - 14);
    ctx.lineTo(x + 6, RULER_H - 14);
    ctx.lineTo(x, RULER_H - 1);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = COLORS.triggerInk;
    ctx.font = 'bold 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('T', x, RULER_H - 6);
    ctx.textAlign = 'left';
  }

  drawCursors(H) {
    const { ctx, vp } = this;
    const pairs = [['a', COLORS.cursorA, 'A'], ['b', COLORS.cursorB, 'B']];
    const xs = {};
    for (const [k, color, label] of pairs) {
      const s = this.cursors[k];
      if (s == null) continue;
      const x = Math.round(vp.xOf(s)) + 0.5;
      xs[k] = x;
      if (x < -20 || x > this.cssW + 20) continue;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillRect(x - 7, 1, 14, 13);
      ctx.fillStyle = COLORS.cursorInk;
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x, 8);
      ctx.textAlign = 'left';
    }
    // Shade between cursors
    if (xs.a != null && xs.b != null) {
      const x0 = Math.min(xs.a, xs.b), x1 = Math.max(xs.a, xs.b);
      ctx.fillStyle = COLORS.cursorShade;
      ctx.fillRect(x0, RULER_H, x1 - x0, H - RULER_H);
    }
  }

  drawHover(H) {
    if (this.hoverX == null) return;
    const { ctx } = this;
    const x = Math.round(this.hoverX) + 0.5;
    ctx.strokeStyle = COLORS.hover;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, RULER_H);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
}
