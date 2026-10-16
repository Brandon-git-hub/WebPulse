// Horizontal view state: which samples are visible and at what zoom.
// Positions are in CSS pixels; samples are capture sample indices.

export const MIN_SPP = 1 / 64;   // at most 64 px per sample
const HISTORY_MAX = 50;

export class Viewport {
  constructor() {
    this.width = 800;     // css px of the plot area
    this.start = 0;       // sample index at x = 0 (fractional)
    this.spp = 1;         // samples per css px
    this.capture = null;  // { n, rate, trigger_pos }
    this.listeners = [];
    this.history = [];    // earlier views for back(), newest last
  }

  onChange(fn) { this.listeners.push(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  setCapture(cap) {
    this.capture = cap;
    this.history = [];
    this.fit();
  }

  /** Remember the current view so back() can return to it. */
  save() {
    if (!this.capture) return;
    const last = this.history[this.history.length - 1];
    if (last && last.start === this.start && last.spp === this.spp) return;
    this.history.push({ start: this.start, spp: this.spp });
    if (this.history.length > HISTORY_MAX) this.history.shift();
  }

  get canGoBack() { return this.history.length > 0; }

  back() {
    const v = this.history.pop();
    if (!v || !this.capture) return;
    this.spp = v.spp;
    this.start = v.start;
    this.clamp();
    this.emit();
  }

  /** Show samples [s0, s1) with a small margin on both sides. */
  zoomTo(s0, s1) {
    if (!this.capture || !(s1 > s0)) return;
    const span = (s1 - s0) * 1.1;
    this.spp = Math.min(Math.max(span / this.width, MIN_SPP), this.maxSpp);
    this.start = (s0 + s1) / 2 - (this.width / 2) * this.spp;
    this.clamp();
    this.emit();
  }

  setWidth(w) {
    if (w <= 0 || w === this.width) return;
    // Keep the centre fixed while resizing.
    const centre = this.start + (this.width / 2) * this.spp;
    this.width = w;
    this.start = centre - (w / 2) * this.spp;
    this.clamp();
    this.emit();
  }

  get maxSpp() {
    return this.capture ? Math.max(MIN_SPP, (this.capture.n / this.width) * 1.05) : 1;
  }

  get end() { return this.start + this.width * this.spp; }

  clamp() {
    if (!this.capture) return;
    this.spp = Math.min(Math.max(this.spp, MIN_SPP), this.maxSpp);
    const n = this.capture.n;
    const visible = this.width * this.spp;
    if (visible >= n) {
      this.start = (n - visible) / 2;     // centred when zoomed out fully
    } else {
      // Allow a small overscroll margin past either end.
      const margin = visible * 0.1;
      this.start = Math.min(Math.max(this.start, -margin), n - visible + margin);
    }
  }

  fit() {
    if (!this.capture) return;
    this.spp = this.maxSpp;
    this.start = 0;
    this.clamp();
    this.emit();
  }

  zoomAt(x, factor) {
    if (!this.capture) return;
    const s = this.sampleAt(x);
    this.spp *= factor;
    this.spp = Math.min(Math.max(this.spp, MIN_SPP), this.maxSpp);
    this.start = s - x * this.spp;
    this.clamp();
    this.emit();
  }

  panPx(dx) {
    if (!this.capture) return;
    this.start -= dx * this.spp;
    this.clamp();
    this.emit();
  }

  centreOn(sample, spp) {
    if (!this.capture) return;
    if (spp) this.spp = spp;
    this.spp = Math.min(Math.max(this.spp, MIN_SPP), this.maxSpp);
    this.start = sample - (this.width / 2) * this.spp;
    this.clamp();
    this.emit();
  }

  sampleAt(x) { return this.start + x * this.spp; }
  xOf(sample) { return (sample - this.start) / this.spp; }

  /** Time origin: the trigger if there is one, else the first sample. */
  get origin() {
    const c = this.capture;
    return c && c.trigger_pos >= 0 ? c.trigger_pos : 0;
  }

  timeOf(sample) {
    return this.capture ? (sample - this.origin) / this.capture.rate : 0;
  }

  /** Sample range and width to request from the server for the current view. */
  query() {
    if (!this.capture) return null;
    const n = this.capture.n;
    const t0 = Math.max(0, Math.floor(this.start));
    const t1 = Math.min(n, Math.ceil(this.end) + 1);
    if (t1 <= t0) return null;
    // Ask for one bin per css pixel of the visible data span.
    const px = Math.max(1, Math.round((t1 - t0) / this.spp));
    return { t0, t1, width: Math.min(px, 8192) };
  }
}
