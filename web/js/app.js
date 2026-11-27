// WebPulse UI: toolbar, channel list, WebSocket client and canvas interaction.
// All URLs are relative so the page also works behind a path prefix such as
// code-server's /proxy/9002/.

import { formatFreq, formatRate, formatSI, formatTime, parseSI } from './format.js';
import { CHANNELS, DEC_ROW_H, RULER_H, ROW_H, Renderer, loadTheme } from './renderer.js';
import { Decoders, PALETTE } from './decoders.js';
import { crc32, exportAnnotations } from './decode/export.js';
import { normalizeOptions } from './decode/runtime.js';
import { LANGUAGES, applyI18n, getLang, setLang, tr } from './i18n.js';
import { Viewport } from './viewport.js';

const $ = (id) => document.getElementById(id);

// Resistor colour code (brown, red, orange, yellow, black, green, blue, violet),
// one set per theme. On the dark background the tints are light and "black"
// is a light grey, since a dark line would vanish.
const DEFAULT_COLORS = {
  dark: ['#c69a6d', '#e57373', '#ffa95e', '#f4d35e', '#b8c0cc', '#81c784', '#64b5f6', '#b388ff'],
  light: ['#8d5a2b', '#d32f2f', '#e8710a', '#b38f00', '#202124', '#2e7d32', '#1565c0', '#7b1fa2'],
};
// Saved colours equal to a default (of this or an earlier version) were never
// picked by the user, so they follow the theme's default.
const KNOWN_DEFAULTS = new Set([...DEFAULT_COLORS.dark, ...DEFAULT_COLORS.light,
  '#f4c542', '#4fc3f7', '#81c784', '#ff8a65', '#ba68c8', '#4db6ac', '#e57373', '#aed581']);
const THEME_KEY = 'webpulse.theme';

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}
const TRIG_OPTIONS = [
  ['X', '·', "don't care"], ['0', '0', 'low'], ['1', '1', 'high'],
  ['R', '↑', 'rising edge'], ['F', '↓', 'falling edge'], ['E', '↕', 'either edge'],
];
const BUSY = new Set(['armed', 'capturing', 'processing']);
const STORE_KEY = 'webpulse.settings.v1';

// ---- settings (per-viewer, best effort) --------------------------------------

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSettings() {
  const s = {
    rate: $('rate').value,
    samples: $('samples').value,
    pre: $('pre').value,
    timeout: $('timeout').value,
    channels: channels.map(({ name, custom, trig, enabled }) => ({ name, color: custom, trig, enabled })),
    order,
    decoders: decoders.serialize(),
    decoderDock: settings.decoderDock === true,
  };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch { /* storage unavailable */ }
}

const settings = loadSettings();
const channels = Array.from({ length: CHANNELS }, (_, i) => {
  const saved = (settings.channels || [])[i] || {};
  const c = typeof saved.color === 'string' ? saved.color.toLowerCase() : '';
  return {
    name: typeof saved.name === 'string' ? saved.name : `CH${i}`,
    custom: /^#[0-9a-f]{6}$/.test(c) && !KNOWN_DEFAULTS.has(c) ? c : null,   // user-picked colour
    get color() { return this.custom || DEFAULT_COLORS[currentTheme()][i]; },
    trig: TRIG_OPTIONS.some((o) => o[0] === saved.trig) ? saved.trig : 'X',
    enabled: saved.enabled !== false,
  };
});

// ---- view / renderer -----------------------------------------------------------

const canvas = $('wave');
const vp = new Viewport();
const renderer = new Renderer(canvas, vp, channels);
// Display order of the channels (top first); a saved order is used only if it
// is a permutation of 0..7.
const order = (Array.isArray(settings.order) && settings.order.length === CHANNELS &&
  [...settings.order].sort().every((c, i) => c === i)) ? settings.order.slice()
  : Array.from({ length: CHANNELS }, (_, c) => c);
renderer.order = order;
renderer.layout();

const app = {
  device: null,
  status: null,
  capKey: null,
  cap: null,          // the capture shown (from the status): n, rate, source, time, …
  opened: null,       // { name, modified } of the last file opened here
  ws: null,
  wsRetry: 500,
};

// ---- query scheduling ------------------------------------------------------------
// At most one query in flight; while waiting, only the newest view is kept.

const query = {
  nextId: 1,
  minId: 1,         // responses below this id belong to an older capture
  inflight: null,
  pending: null,
  last: null,

  reset() {
    this.minId = this.nextId;
    this.inflight = null;
    this.pending = null;
    this.last = null;
  },

  request() {
    const q = vp.query();
    if (!q || !app.ws || app.ws.readyState !== WebSocket.OPEN) return;
    const same = (a) => a && a.t0 === q.t0 && a.t1 === q.t1 && a.width === q.width;
    if (same(this.last) || same(this.inflight) || same(this.pending)) return;
    if (this.inflight && performance.now() - this.inflight.at < 3000) {
      this.pending = q;
      return;
    }
    this.send(q);
  },

  send(q) {
    const id = this.nextId++;
    this.inflight = { ...q, id, at: performance.now() };
    this.pending = null;
    app.ws.send(JSON.stringify({ type: 'query', id, t0: q.t0, t1: q.t1, width: q.width }));
  },

  onResponse(buf) {
    const dv = new DataView(buf);
    const id = dv.getUint32(0, true);
    const mode = dv.getUint8(4);
    const width = dv.getUint16(6, true);
    const t0 = Number(dv.getBigUint64(8, true));
    const t1 = Number(dv.getBigUint64(16, true));
    if (this.inflight && this.inflight.id === id) {
      this.last = this.inflight;
      this.inflight = null;
    }
    if (id >= this.minId) {
      const d = { id, mode, t0, t1 };
      if (mode === 0) d.raw = new Uint8Array(buf, 24, t1 - t0);
      else d.px = new Uint16Array(buf.slice(24, 24 + width * 2));
      renderer.setData(d);
    }
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      this.send(p);
    }
  },
};

// ---- edges (measurements, snapping, edge stepping) ------------------------------------
// Text request/response over the same WebSocket; ids are kept apart from the
// binary queries' so error replies can be told apart.

const edges = {
  nextId: 1e9,
  waiting: new Map(),       // id -> resolve
  hover: { inflight: false, pending: null },

  request(ch, s) {
    if (!vp.capture || !app.ws || app.ws.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const id = this.nextId++;
    const key = app.capKey;
    app.ws.send(JSON.stringify({ type: 'edges', id, ch, s: Math.max(0, Math.floor(s)) }));
    // A reply for an earlier capture is dropped.
    return new Promise((resolve) => this.waiting.set(id, (m) => resolve(m && app.capKey === key ? m : null)));
  },

  onMessage(m) {
    const done = this.waiting.get(m.id);
    if (!done) return false;
    this.waiting.delete(m.id);
    done(m.type === 'edges' ? m : null);
    return true;
  },

  reset() {
    for (const done of this.waiting.values()) done(null);
    this.waiting.clear();
    this.hover = { inflight: false, pending: null };
  },
};

const SNAP_PX = 8;

/** Highlight channel ch (the row under the pointer); null keeps the current one. */
function setActive(ch) {
  if (ch == null || ch === renderer.active) return;
  renderer.active = ch;
  renderer.measure = null;
  channels.forEach((c, i) => c.row && c.row.classList.toggle('active', i === ch));
  renderer.requestDraw();
  updateMeasureReadout();
}

/** Measure the pulse of channel ch around sample s (at most one request in flight). */
function measureAt(ch, s) {
  const m = renderer.measure;
  // Still inside the level already measured: nothing to ask.
  if (m && m.ch === ch && s >= Math.max(m.p, 0) && (m.n < 0 || s < m.n)) return;
  const h = edges.hover;
  if (h.inflight) {
    h.pending = { ch, s };
    return;
  }
  h.inflight = true;
  edges.request(ch, s).then((r) => {
    if (edges.hover !== h) return;        // reset meanwhile
    h.inflight = false;
    if (r && r.ch === renderer.active) {
      renderer.measure = r;
      renderer.requestDraw();
      updateMeasureReadout();
    }
    if (h.pending) {
      const p = h.pending;
      h.pending = null;
      measureAt(p.ch, p.s);
    }
  });
}

/** High / low time, period, frequency and duty from an edges reply. */
function measureValues(m) {
  const width = m.p >= 0 && m.n >= 0 ? m.n - m.p : null;
  const other = m.n >= 0 && m.nn >= 0 ? m.nn - m.n : m.pm >= 0 && m.p >= 0 ? m.p - m.pm : null;
  const high = m.level ? width : other;
  const low = m.level ? other : width;
  const period = high != null && low != null ? high + low : null;
  return { high, low, period };
}

function updateMeasureReadout() {
  const el = $('measure');
  const m = renderer.measure;
  if (!vp.capture || !m || m.ch !== renderer.active) {
    el.hidden = true;
    return;
  }
  const ch = channels[m.ch];
  const rate = vp.capture.rate;
  const t = (n) => (n == null ? '–' : formatTime(n / rate, 4));
  const head = `<span class="ch-sw" style="--c:${ch.color}"></span>${escapeHtml(ch.name)}`;
  if (m.p < 0 && m.n < 0) {
    el.innerHTML = `${head}<span class="k">${tr(m.level ? 'constant high' : 'constant low')}</span>`;
  } else {
    const v = measureValues(m);
    const f = v.period ? formatFreq(rate / v.period) : '–';
    const duty = v.period ? (100 * v.high / v.period).toFixed(1) + ' %' : '–';
    el.innerHTML = `${head}<span class="k">${tr('High')}</span> ${t(v.high)}<span class="k">${tr('Low')}</span> ${t(v.low)}` +
      `<span class="k">${tr('Period')}</span> ${t(v.period)}<span class="k">${tr('Freq')}</span> ${f}` +
      `<span class="k">${tr('Duty')}</span> ${duty}`;
  }
  el.hidden = false;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Nearest edge of the measured pulse within SNAP_PX of x, else s itself. */
function snapSample(s, x) {
  const m = renderer.measure;
  if (!m || m.ch !== renderer.active) return s;
  let best = s, dist = SNAP_PX + 1;
  for (const e of [m.pm, m.p, m.n, m.nn]) {
    if (e < 0) continue;
    const d = Math.abs(vp.xOf(e) - x);
    if (d < dist) {
      dist = d;
      best = e;
    }
  }
  return dist <= SNAP_PX ? best : s;
}

/** Move cursor k to the previous (dir < 0) or next edge of the highlighted channel. */
async function stepEdge(k, dir) {
  if (!vp.capture) return;
  if (renderer.active == null || !channels[renderer.active].enabled) {
    setActive(channels.findIndex((c) => c.enabled));
  }
  const ch = renderer.active;
  const cur = renderer.cursors[k];
  const from = cur != null ? Math.min(cur, vp.capture.n - 1) : Math.round(vp.sampleAt(vp.width / 2));
  const m = await edges.request(ch, from);
  if (!m) return;
  // p is the edge at or before from; when the cursor sits on it, step past it.
  const to = dir > 0 ? m.n : m.p >= 0 && m.p < m.s ? m.p : m.pm;
  if (to < 0) {
    toast(tr(dir > 0 ? 'No later edge on {ch}' : 'No earlier edge on {ch}', { ch: channels[ch].name }), 'info');
    return;
  }
  renderer.cursors[k] = to;
  const x = vp.xOf(to);
  if (x < 0 || x > vp.width) {
    vp.centreOn(to);
  }
  renderer.requestDraw();
  updateCursorReadout();
  measureAt(ch, to);
}

vp.onChange(() => {
  renderer.requestDraw();
  query.request();
  updateViewInfo();
  updateCursorReadout();
});

// ---- channel list ------------------------------------------------------------------

// ---- theme ---------------------------------------------------------------------------
// "auto" follows the system; the choice is kept per viewer.

const THEMES = ['auto', 'light', 'dark'];
const THEME_TITLES = { auto: 'Theme: follow the system', light: 'Theme: light', dark: 'Theme: dark' };
let themeChoice = (() => {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return THEMES.includes(t) ? t : 'auto';
  } catch {
    return 'auto';
  }
})();

function applyTheme() {
  const t = themeChoice;
  document.documentElement.dataset.theme =
    t === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
  $('theme').title = tr(THEME_TITLES[t]) + tr(' (click to change)');
  $('theme-label').textContent = tr(t[0].toUpperCase() + t.slice(1));
  loadTheme();
  // Default channel colours differ per theme.
  channels.forEach((ch) => {
    if (!ch.row) return;
    ch.row.style.setProperty('--c', ch.color);
    ch.row.querySelector('input[type=color]').value = ch.color;
  });
  updateChannelPicker();
  updateMeasureReadout();
  renderer.requestDraw();
}

function cycleTheme() {
  themeChoice = THEMES[(THEMES.indexOf(themeChoice) + 1) % THEMES.length];
  try {
    localStorage.setItem(THEME_KEY, themeChoice);
  } catch { /* storage unavailable: applies to this page only */ }
  applyTheme();
}

function buildChannelList() {
  channels.forEach((ch, i) => {
    const row = document.createElement('div');
    row.className = 'ch';
    row.style.setProperty('--c', ch.color);
    row.dataset.ch = i;
    row.innerHTML = `
      <span class="bar"></span>
      <span class="grip" title="Drag to reorder (or Alt+↑ / Alt+↓ in the name box)">⠿</span>
      <span class="idx">${i}</span>
      <label class="color" title="Channel colour"><input type="color" value="${ch.color}"></label>
      <input class="name" maxlength="24" spellcheck="false" title="Channel name">
      <select class="trig" title="Trigger condition for CH${i}"></select>`;
    const name = row.querySelector('.name');
    name.value = ch.name;
    name.addEventListener('keydown', (ev) => {
      if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
      ev.preventDefault();
      moveChannel(i, ev.key === 'ArrowUp' ? -1 : 1);
      name.focus();
    });
    name.addEventListener('change', () => {
      ch.name = name.value.trim() || `CH${i}`;
      name.value = ch.name;
      saveSettings();
      updateExportLinks();
      updateChannelPicker();
    });
    const color = row.querySelector('input[type=color]');
    color.addEventListener('input', () => {
      ch.custom = color.value.toLowerCase();
      row.style.setProperty('--c', ch.color);
      renderer.requestDraw();
      updateChannelPicker();
    });
    color.addEventListener('change', saveSettings);
    const trig = row.querySelector('.trig');
    for (const [v, glyph, title] of TRIG_OPTIONS) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = glyph;
      o.title = tr(title);
      o.dataset.title = title;
      trig.appendChild(o);
    }
    trig.value = ch.trig;
    trig.classList.toggle('active', ch.trig !== 'X');
    trig.addEventListener('change', () => {
      ch.trig = trig.value;
      trig.classList.toggle('active', ch.trig !== 'X');
      saveSettings();
    });
    ch.row = row;
    row.hidden = !ch.enabled;
    row.querySelector('.grip').addEventListener('pointerdown', (ev) => startRowDrag(ev, i));
  });
  placeRows();
  document.documentElement.style.setProperty('--row-h', ROW_H + 'px');
  document.documentElement.style.setProperty('--ruler-h', RULER_H + 'px');
}

// ---- protocol decoders ------------------------------------------------------------------

const decoders = new Decoders({
  onUpdate: (structure = true) => syncDecoders(structure),
  onError: (msg) => toast(msg),
});
decoders.restore(settings.decoders);

/** Push the decoder rows to the renderer and the side list. */
function syncDecoders(structure = true) {
  const rows = decoders.rows();
  const sameHeight = rows.length === renderer.decRows.length;
  renderer.decRows = rows;
  if (sameHeight) {
    renderer.layout();
    renderer.requestDraw();
  } else {
    renderer.relayout();
  }
  if (!structure) return;     // progress only
  const box = $('dec-labels');
  box.textContent = '';
  for (const r of rows) {
    const el = document.createElement('div');
    el.className = 'dec-label' + (r.error && r.status ? ' err' : '');
    el.dataset.uid = String(r.inst.uid);
    el.style.setProperty('--c', r.color);
    el.innerHTML = '<span class="bar"></span><span class="txt"></span>';
    el.querySelector('.txt').textContent = r.label;
    el.title = r.status || tr('{name} (click for settings)', { name: r.label });
    const open = (ev) => {
      ev.preventDefault();
      showDecoderSettings(decPop.inst === r.inst && ev.type === 'click' ? null : r.inst, el);
    };
    el.addEventListener('click', open);
    el.addEventListener('contextmenu', open);
    box.appendChild(el);
  }
  if (decPop.inst && !decoders.list.includes(decPop.inst)) showDecoderSettings(null);
  else if (decPop.inst) placeDecoderSettings();
  updateExportLinks();
  if (dialogOpen('dec-export-dialog')) updateDecoderExport();
}

function chLabel(c) {
  const ch = channels[c];
  return ch.name === `CH${c}` ? ch.name : `CH${c} ${ch.name}`;
}

// ---- decoder list (docked on the right) --------------------------------------------------
//
// Like PulseView's decoder selector: a search box over the list of decoders,
// the one picked is described below, double-click or Enter adds it. The panel
// stays open, so several decoders can be added one after the other.

const dock = { sel: null };     // key of the selected decoder

function buildDecoderDock() {
  $('decoders-btn').addEventListener('click', () => showDecoderDock($('dec-dock').hidden));
  $('dock-close').addEventListener('click', () => showDecoderDock(false));
  const search = $('dec-search');
  search.addEventListener('input', () => renderDecoderCatalog());
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      moveDecoderSelection(ev.key === 'ArrowDown' ? 1 : -1);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      // Enter adds the selected decoder, or the only one left by the search.
      const shown = visibleDecoderDefs().filter((d) => d.def);
      const key = shown.some((d) => d.key === dock.sel) ? dock.sel : shown.length === 1 ? shown[0].key : null;
      if (key) addDecoder(key);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      if (search.value) {
        search.value = '';
        renderDecoderCatalog();
      } else {
        showDecoderDock(false);
      }
    }
  });
  $('dec-reload').addEventListener('click', () => decoders.loadDefs().then(() => {
    renderDecoderCatalog();
    toast(tr('Decoders reloaded ({n} available)', { n: decoders.defs.filter((d) => d.def).length }), 'info');
  }));
  showDecoderDock(settings.decoderDock === true, false);
}

function showDecoderDock(open, focus = true) {
  $('dec-dock').hidden = !open;
  $('decoders-btn').setAttribute('aria-pressed', String(open));
  if (open) {
    renderDecoderCatalog();
    if (focus) $('dec-search').focus();
  }
  if (settings.decoderDock !== open) {
    settings.decoderDock = open;
    saveSettings();
  }
}

/** The decoder modules that match the search text (name, id, description, channels). */
function visibleDecoderDefs() {
  const words = $('dec-search').value.toLowerCase().split(/\s+/).filter(Boolean);
  return decoders.defs.filter((d) => {
    const def = d.def || {};
    const text = [d.name, d.key.replace(/^\w+:/, ''), def.id, def.desc,
      ...(def.channels || []).flatMap((c) => [c.name, c.id, ...(c.aliases || [])])]
      .filter(Boolean).join(' ').toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

function renderDecoderCatalog() {
  const list = $('dec-catalog');
  list.textContent = '';
  const shown = visibleDecoderDefs();
  if (!shown.some((d) => d.key === dock.sel)) dock.sel = (shown.find((d) => d.def) || {}).key || null;
  for (const source of ['built-in', 'yours']) {
    const defs = shown.filter((d) => d.source === source);
    if (!defs.length) continue;
    const g = document.createElement('div');
    g.className = 'dec-group';
    g.textContent = tr(source === 'built-in' ? 'Built-in' : 'Your decoders');
    list.appendChild(g);
    for (const d of defs) {
      const el = document.createElement('div');
      el.className = 'dec-entry' + (d.def ? '' : ' bad') + (d.key === dock.sel ? ' sel' : '');
      el.dataset.key = d.key;
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', String(d.key === dock.sel));
      // The description is in the tooltip and in the info below the list.
      el.title = d.def ? [d.def.desc, tr('Double-click to add')].filter(Boolean).join('\n') : d.error;
      el.innerHTML = '<span class="nm"></span><span class="id"></span>';
      el.querySelector('.nm').textContent = d.name;
      el.querySelector('.id').textContent = d.key.replace(/^\w+:/, '');
      if (!d.def) {
        const why = document.createElement('div');
        why.className = 'd';
        why.textContent = tr('cannot load: {error}', { error: d.error });
        el.appendChild(why);
      }
      el.addEventListener('click', () => selectDecoderDef(d.key));
      el.addEventListener('dblclick', () => d.def && addDecoder(d.key));
      list.appendChild(el);
    }
  }
  if (!shown.length) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = tr(decoders.defs.length ? 'No decoder matches.' : 'Loading…');
    list.appendChild(none);
  }
  renderDecoderInfo();
  $('dec-note').textContent = decoders.userDir ? tr('Your own decoders: {dir}', { dir: decoders.userDir }) : '';
}

function selectDecoderDef(key) {
  dock.sel = key;
  for (const el of $('dec-catalog').children) {
    if (!el.dataset.key) continue;
    el.classList.toggle('sel', el.dataset.key === key);
    el.setAttribute('aria-selected', String(el.dataset.key === key));
    if (el.dataset.key === key && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }
  renderDecoderInfo();
}

function moveDecoderSelection(step) {
  const keys = visibleDecoderDefs().map((d) => d.key);
  if (!keys.length) return;
  const k = keys.indexOf(dock.sel);
  selectDecoderDef(keys[Math.max(0, Math.min(keys.length - 1, k < 0 ? 0 : k + step))]);
}

/** What the selected decoder is and needs, with an Add button. */
function renderDecoderInfo() {
  const box = $('dec-info');
  box.textContent = '';
  const d = decoders.defs.find((x) => x.key === dock.sel);
  if (!d) return;
  const add = (tag, text, cls) => {
    const el = document.createElement(tag);
    el.textContent = text;
    if (cls) el.className = cls;
    box.appendChild(el);
    return el;
  };
  add('h4', d.name);
  if (!d.def) {
    add('p', tr('This decoder cannot be loaded: {error}', { error: d.error }), 'err');
    return;
  }
  if (d.def.desc) add('p', d.def.desc);
  add('div', tr('Channels'), 'sec');
  const ul = add('ul', '');
  for (const c of d.def.channels) {
    const li = document.createElement('li');
    li.innerHTML = '<b></b><span class="k"></span>';
    li.querySelector('b').textContent = c.name + (c.optional ? '' : ' *');
    li.querySelector('.k').textContent = c.desc ? ` – ${c.desc}` : '';
    ul.appendChild(li);
  }
  if ((d.def.options || []).length) {
    add('div', tr('Options'), 'sec');
    add('p', d.def.options.map((o) => o.name).join(', '));
  }
  add('p', tr('* required'), 'k');
  const btn = add('button', tr('Add {name}', { name: d.name }), 'primary');
  btn.type = 'button';
  btn.addEventListener('click', () => addDecoder(d.key));
}

function addDecoder(key) {
  const inst = decoders.add(key, order.filter((c) => channels[c].enabled), channels.map((ch) => ch.name));
  if (!inst) return;
  saveSettings();
  // Point out the new rows in the side list; their settings are a click away.
  for (const el of $('dec-labels').children) {
    if (el.dataset.uid !== String(inst.uid)) continue;
    el.classList.add('flash');
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }
}

// ---- decoder settings (popup next to its label) -----------------------------------------
//
// Like PulseView's decode trace popup: name, colour, a channel per decoder
// input and the options. Every change applies (and decodes again) at once.

const decPop = { inst: null };

function buildDecoderSettings() {
  document.addEventListener('pointerdown', (ev) => {
    if (!decPop.inst) return;
    const t = ev.target;
    if ($('dec-pop').contains(t) || (t.closest && t.closest('.dec-label'))) return;
    showDecoderSettings(null);
  });
  $('dec-pop').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    showDecoderSettings(null);
  });
  if (typeof addEventListener === 'function') addEventListener('resize', () => decPop.inst && placeDecoderSettings());
  $('channels').addEventListener('scroll', () => decPop.inst && placeDecoderSettings());
}

function showDecoderSettings(inst) {
  decPop.inst = inst;
  const pop = $('dec-pop');
  for (const el of $('dec-labels').children) {
    el.classList.toggle('open', !!inst && el.dataset.uid === String(inst.uid));
  }
  if (!inst) {
    pop.hidden = true;
    pop.textContent = '';
    return;
  }
  fillDecoderSettings(inst);
  pop.hidden = false;
  placeDecoderSettings();
}

/** Beside the decoder's first label, kept inside the window. */
function placeDecoderSettings() {
  const pop = $('dec-pop');
  const inst = decPop.inst;
  const label = [...$('dec-labels').children].find((el) => el.dataset.uid === String(inst.uid));
  updateDecoderSettingsStatus();
  if (!label || !label.getBoundingClientRect || !pop.getBoundingClientRect) return;
  for (const el of $('dec-labels').children) el.classList.toggle('open', el.dataset.uid === String(inst.uid));
  const r = label.getBoundingClientRect();
  const p = pop.getBoundingClientRect();
  const vw = globalThis.innerWidth || 1200, vh = globalThis.innerHeight || 800;
  const left = Math.max(8, Math.min(r.right + 6, vw - p.width - 8));
  const top = Math.max(8, Math.min(r.top - 10, vh - p.height - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.style.setProperty('--c', inst.color);
}

function updateDecoderSettingsStatus() {
  const el = $('dec-pop').querySelector('.status');
  if (!el || !decPop.inst) return;
  const st = decoders.state.get(decPop.inst.uid) || {};
  el.className = 'status' + (st.status === 'error' ? ' err' : '');
  el.textContent = st.status === 'error' ? st.error
    : st.status === 'running' ? tr('Decoding…')
    : vp.capture ? '' : tr('Decodes after the next capture.');
  // The decoder's d.summary() lines, if any.
  const lines = (st.status === 'done' || st.status === 'error') && st.result ? st.result.summary || [] : [];
  const pre = $('dec-pop').querySelector('.summary');
  const head = $('dec-pop').querySelector('.summary-head');
  if (!pre || !head) return;
  pre.textContent = lines.join('\n');
  pre.hidden = head.hidden = !lines.length;
}

function fillDecoderSettings(inst) {
  const pop = $('dec-pop');
  pop.textContent = '';
  const d = decoders.def(inst.key);
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  const row = (labelText, hint, control, required = false) => {
    const lab = el('label');
    lab.textContent = labelText + (required ? ' *' : '');
    if (hint) lab.title = hint;           // a tooltip, not small print
    if (control.id) lab.htmlFor = control.id;
    pop.appendChild(lab);
    pop.appendChild(control);
  };
  const head = el('div', { className: 'head' });
  head.appendChild(el('b', { textContent: d ? d.def.name : inst.key, title: d ? d.def.desc || '' : '' }));
  if (!d) head.appendChild(el('p', { textContent: tr('This decoder is not available (any more).') }));
  pop.appendChild(head);
  pop.appendChild(el('p', { className: 'status' }));

  // Name and colour: only the look, no decoding again.
  const name = el('input', { id: 'dec-f-label', maxLength: 40, value: inst.label });
  name.addEventListener('change', () => {
    decoders.restyle(inst, { label: name.value.trim() || (d ? d.def.name : inst.key) });
    saveSettings();
  });
  row(tr('Name'), '', name);
  const sw = el('div', { className: 'swatches' });
  const setColor = (c) => {
    decoders.restyle(inst, { color: c });
    for (const b of sw.children) b.classList.toggle('on', b.dataset.c === c);
    pick.value = c;
    saveSettings();
  };
  for (const c of PALETTE) {
    const b = el('button', { type: 'button', title: c });
    b.dataset.c = c;
    b.style.setProperty('--sw', c);
    b.classList.toggle('on', c === inst.color);
    b.addEventListener('click', () => setColor(c));
    sw.appendChild(b);
  }
  const pick = el('input', { type: 'color', value: inst.color, title: tr('Other colour') });
  pick.addEventListener('input', () => setColor(pick.value));
  sw.appendChild(pick);
  row(tr('Colour'), '', sw);

  if (d) {
    pop.appendChild(el('div', { className: 'sec', textContent: tr('Channels') }));
    for (const c of d.def.channels) {
      const sel = el('select', { id: `dec-c-${c.id}` });
      sel.dataset.ch = c.id;
      sel.appendChild(el('option', { value: '', textContent: '—' }));
      for (const k of order) {
        sel.appendChild(el('option', { value: String(k), textContent: chLabel(k) + (channels[k].enabled ? '' : tr(' (hidden)')) }));
      }
      sel.value = inst.assign[c.id] == null ? '' : String(inst.assign[c.id]);
      sel.addEventListener('change', () => {
        decoders.update(inst, { assign: { ...inst.assign, [c.id]: sel.value === '' ? null : Number(sel.value) } });
        saveSettings();
      });
      row(c.name, c.desc || '', sel, !c.optional);
    }
    if ((d.def.options || []).length) pop.appendChild(el('div', { className: 'sec', textContent: tr('Options') }));
    for (const o of d.def.options || []) {
      const cur = inst.options[o.id] ?? o.default;
      let ctl;
      if (Array.isArray(o.values)) {
        ctl = el('select', { id: `dec-o-${o.id}` });
        for (const v of o.values) ctl.appendChild(el('option', { value: String(v), textContent: String(v) }));
      } else {
        ctl = el('input', { id: `dec-o-${o.id}` });
        if (typeof o.default === 'number') Object.assign(ctl, { type: 'number', step: 'any' });
      }
      ctl.dataset.opt = o.id;
      ctl.value = String(cur);
      // Inputs apply on Enter or when left, selects at once.
      ctl.addEventListener('change', () => {
        const v = ctl.value;
        const val = typeof o.default === 'number' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
        decoders.update(inst, { options: { ...inst.options, [o.id]: val } });
        saveSettings();
      });
      row(o.name, o.desc || '', ctl);
    }
    if (d.def.channels.some((c) => !c.optional)) pop.appendChild(el('p', { className: 'note', textContent: tr('* Required channels') }));
  }
  pop.appendChild(el('div', { className: 'sec summary-head', textContent: tr('Summary'), hidden: true }));
  pop.appendChild(el('pre', { className: 'summary', hidden: true }));

  const btns = el('div', { className: 'btns' });
  const del = el('button', { type: 'button', className: 'del', textContent: tr('Remove decoder') });
  del.addEventListener('click', () => {
    showDecoderSettings(null);
    decoders.remove(inst);
    saveSettings();
  });
  const close = el('button', { type: 'button', textContent: tr('Close') });
  close.addEventListener('click', () => showDecoderSettings(null));
  btns.appendChild(del);
  btns.appendChild(close);
  pop.appendChild(btns);
  updateDecoderSettingsStatus();
}

/** Status bar text for the annotation under the pointer. */
function showAnnotation(row, ann) {
  const el = $('measure');
  app.annotation = true;
  if (!ann) {
    el.hidden = true;
    return;
  }
  const rate = vp.capture.rate;
  el.innerHTML = `<span class="ch-sw" style="--c:${row.color}"></span>${escapeHtml(row.label)}` +
    `<span class="k">${escapeHtml(ann.text[0])}</span>` +
    `<span class="k">${formatTime((ann.end - ann.start) / rate, 4)}</span>`;
  el.hidden = false;
}

// ---- channel order ---------------------------------------------------------------------

/** Put the list rows in display order (appendChild moves existing nodes). */
function placeRows() {
  const list = $('ch-rows');
  for (const c of order) list.appendChild(channels[c].row);
}

function setOrder(next) {
  if (next.every((c, k) => c === order[k])) return;
  order.splice(0, order.length, ...next);
  placeRows();
  renderer.relayout();
  saveSettings();
}

/** Move channel c up (-1) or down (+1) past the next visible channel. */
function moveChannel(c, dir) {
  const next = order.slice();
  let k = next.indexOf(c);
  let j = k + dir;
  while (j >= 0 && j < next.length && !channels[next[j]].enabled) j += dir;
  if (j < 0 || j >= next.length) return;
  next.splice(k, 1);
  next.splice(j, 0, c);
  setOrder(next);
}

/** Drag a row by its grip; drop it above or below the row under the pointer. */
function startRowDrag(ev, c) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const grip = ev.target;
  const row = channels[c].row;
  let drop = null;            // { c, after }
  grip.setPointerCapture(ev.pointerId);
  row.classList.add('dragging');
  const clear = () => channels.forEach((ch) => ch.row.classList.remove('drop-above', 'drop-below'));
  const move = (e) => {
    clear();
    drop = null;
    for (const t of order) {
      const r = channels[t].row;
      if (r.hidden || t === c) continue;
      const box = r.getBoundingClientRect();
      if (e.clientY >= box.top && e.clientY < box.top + box.height) {
        drop = { c: t, after: e.clientY >= box.top + box.height / 2 };
        r.classList.add(drop.after ? 'drop-below' : 'drop-above');
        break;
      }
    }
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    row.classList.remove('dragging');
    clear();
    if (!drop) return;
    const next = order.filter((t) => t !== c);
    next.splice(next.indexOf(drop.c) + (drop.after ? 1 : 0), 0, c);
    setOrder(next);
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
}

// ---- channel picker (toolbar popover) ------------------------------------------------

const isNamed = (ch, i) => ch.name !== `CH${i}`;

function changingMask() {
  const cap = app.status && app.status.capture;
  return cap && vp.capture ? cap.changing : null;
}

const CHANNEL_SETS = {
  all: () => true,
  changing: (ch, i, m) => ((m >> i) & 1) === 1,
  steady: (ch, i, m) => ((m >> i) & 1) === 0,
  named: (ch, i) => isNamed(ch, i),
  unnamed: (ch, i) => !isNamed(ch, i),
};

/** Apply a new enabled state for every channel; refuses to hide them all. */
function setEnabled(want) {
  if (!want.some(Boolean)) {
    toast(tr('At least one channel must stay enabled'), 'info');
    updateChannelPicker();
    return;
  }
  let changed = false;
  channels.forEach((ch, i) => {
    if (ch.enabled === want[i]) return;
    ch.enabled = want[i];
    ch.row.hidden = !ch.enabled;
    changed = true;
  });
  updateChannelPicker();
  if (!changed) return;
  renderer.relayout();
  saveSettings();
  updateExportLinks();
}

function buildChannelPicker() {
  const grid = $('channels-grid');
  channels.forEach((ch, i) => {
    const label = document.createElement('label');
    label.className = 'pop-ch';
    label.innerHTML = `<input type="checkbox"><span class="sw"></span><span class="nm"></span>`;
    const cb = label.querySelector('input');
    cb.addEventListener('change', () => setEnabled(channels.map((c, j) => (j === i ? cb.checked : c.enabled))));
    ch.pick = label;
    grid.appendChild(label);
  });
  for (const b of $('channels-pop').querySelectorAll('button[data-act]')) {
    b.addEventListener('click', () => {
      const on = b.dataset.act === 'enable';
      const test = CHANNEL_SETS[b.dataset.sel];
      const m = changingMask();
      setEnabled(channels.map((c, i) => (test(c, i, m) ? on : c.enabled)));
    });
  }
  $('order-reset').addEventListener('click', () => setOrder(channels.map((_, c) => c)));
  const btn = $('channels-btn'), pop = $('channels-pop');
  btn.addEventListener('click', () => showChannelPicker(pop.hidden));
  pop.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    showChannelPicker(false);
    btn.focus();
  });
  document.addEventListener('pointerdown', (ev) => {
    if (!pop.hidden && !pop.contains(ev.target) && !btn.contains(ev.target)) showChannelPicker(false);
  });
  updateChannelPicker();
}

function showChannelPicker(open) {
  $('channels-pop').hidden = !open;
  $('channels-btn').setAttribute('aria-expanded', String(open));
  if (open) updateChannelPicker();
}

function updateChannelPicker() {
  const m = changingMask();
  channels.forEach((ch, i) => {
    const label = ch.pick;
    if (!label) return;
    label.querySelector('input').checked = ch.enabled;
    label.style.setProperty('--c', ch.color);
    const changes = m == null ? '' : tr((m >> i) & 1 ? ' · changing' : ' · no change');
    label.querySelector('.nm').textContent = isNamed(ch, i) ? `${i} ${ch.name}` : ch.name;
    label.title = `CH${i}${isNamed(ch, i) ? ' "' + ch.name + '"' : ''}${changes}`;
    label.classList.toggle('steady', m != null && !((m >> i) & 1));
  });
  for (const b of $('channels-pop').querySelectorAll('button[data-act]')) {
    const needsCap = b.dataset.sel === 'changing' || b.dataset.sel === 'steady';
    b.disabled = needsCap && m == null;
    b.title = b.disabled ? tr('Needs a completed capture') : '';
  }
}

function triggerSpec() {
  // Disabled channels do not take part in the trigger.
  const s = channels.map((c) => (c.enabled ? c.trig : 'X')).join('');
  return /^X+$/.test(s) ? '' : s;
}

// ---- toolbar -----------------------------------------------------------------------

function toast(msg, kind = 'error') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (kind === 'info' ? ' info' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, kind === 'info' ? 2500 : 6000);
}

function currentRate() {
  return Number($('rate').value) || 0;
}

const SAMPLE_PRESETS = [1e3, 10e3, 100e3, 1e6, 2e6, 5e6, 10e6, 30e6, 50e6, 100e6, 256e6];

// Presets up to the server's limit, each labelled with its duration at the
// current rate. The first (hidden) option keeps the picker showing just "▾".
function updateSamplePresets() {
  const sel = $('sample-presets');
  const rate = currentRate();
  const max = app.device ? app.device.max_samples : Infinity;
  sel.textContent = '';
  const head = document.createElement('option');
  head.value = '';
  head.textContent = '▾';
  head.hidden = true;
  sel.appendChild(head);
  for (const n of SAMPLE_PRESETS.filter((n) => n <= max)) {
    const o = document.createElement('option');
    o.value = formatSI(n);
    o.textContent = formatSI(n) + (rate ? `  (${formatTime(n / rate, 3)})` : '');
    sel.appendChild(o);
  }
  sel.value = '';
}

function updateDuration() {
  const n = parseSI($('samples').value);
  const rate = currentRate();
  const el = $('duration');
  if (!n || !rate) {
    el.textContent = n === null ? tr('invalid') : '';
    $('samples-box').style.borderColor = n === null ? 'var(--danger)' : '';
    return;
  }
  const max = app.device ? app.device.max_samples : Infinity;
  $('samples-box').style.borderColor = n > max || n < 16 ? 'var(--danger)' : '';
  el.textContent = '= ' + formatTime(n / rate, 3) + (n > max ? tr(' (max {n})', { n: formatSI(max) }) : '');
}

async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  const r = await fetch(path, opts);
  let js = null;
  try { js = await r.json(); } catch { /* non-JSON */ }
  if (!r.ok) throw new Error((js && js.error) || `${r.status} ${r.statusText}`);
  return js;
}

async function runCapture() {
  const samples = parseSI($('samples').value);
  if (!samples) {
    toast(tr('Invalid sample count (examples: 1M, 10M, 50000)'));
    return;
  }
  const body = {
    rate: currentRate(),
    samples,
    pre: Math.min(100, Math.max(0, Number($('pre').value) || 0)) / 100,
    trigger: triggerSpec(),
    timeout_ms: Math.max(0, Number($('timeout').value) || 0) * 1000,
  };
  saveSettings();
  try {
    $('run').disabled = true;       // until the status says the capture started
    await api('api/capture', body);
  } catch (e) {
    toast(e.message);
    $('run').disabled = false;
  }
}

/** One button: Run while idle, Stop while a capture is running. */
function setRunButton(busy, online = true) {
  const b = $('run');
  b.dataset.mode = busy ? 'stop' : 'run';
  b.title = tr(busy ? 'Stop capture (S)' : 'Start capture (R)');
  b.disabled = !online;
}

function toggleRun() {
  if ($('run').dataset.mode === 'stop') stopCapture();
  else runCapture();
}

async function stopCapture() {
  try {
    await api('api/stop', {});
  } catch (e) {
    toast(e.message);
  }
}

// ---- menus (File, Help) ------------------------------------------------------------
//
// Desktop-style drop-down menus: click or ↓ opens, arrows move, Esc closes.
// A submenu (File ▸ Export) opens to the right on hover, click, → or Enter.
// An action that needs settings should open a dialog from its menu item.

const menus = [];   // { btn, menu, subs: [{ wrap, trigger, menu, timer }] }

/** subs: [{ wrap, trigger, menu }] elements of the submenus inside `menu`. */
function buildMenu(btn, menu, subs = []) {
  const m = { btn, menu, subs: subs.map((x) => ({ ...x, timer: 0 })) };
  menus.push(m);
  // ev.detail is 0 when the button was "clicked" with the keyboard: then the
  // first item gets the focus, as in a desktop menu.
  btn.addEventListener('click', (ev) => showMenu(m, menu.hidden, ev.detail === 0));
  btn.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown') return;
    ev.preventDefault();
    showMenu(m, true, true);
  });
  document.addEventListener('pointerdown', (ev) => {
    if (!menu.hidden && !menu.contains(ev.target) && !btn.contains(ev.target)) showMenu(m, false);
  });
  for (const sub of m.subs) {
    // Open while the pointer is over the item or the submenu; close a moment
    // after it leaves, so a slightly diagonal move does not close it.
    sub.wrap.addEventListener('pointerenter', () => {
      clearTimeout(sub.timer);
      if (!sub.trigger.disabled) showSubmenu(sub, true);
    });
    sub.wrap.addEventListener('pointerleave', () => {
      clearTimeout(sub.timer);
      sub.timer = setTimeout(() => showSubmenu(sub, false), 250);
    });
    sub.trigger.addEventListener('click', (ev) => showSubmenu(sub, true, ev.detail === 0));
  }
  menu.addEventListener('click', (ev) => {
    const item = ev.target.closest && ev.target.closest('[role^="menuitem"]');
    if (item && !m.subs.some((x) => x.trigger === item)) showMenu(m, false);
  });
  menu.addEventListener('keydown', (ev) => {
    const active = document.activeElement;
    const sub = m.subs.find((x) => x.menu.contains(active));
    const items = menuItems(sub ? sub.menu : menu);
    const k = items.indexOf(active);
    const trigSub = m.subs.find((x) => x.trigger === active);
    if (ev.key === 'Escape' || (ev.key === 'ArrowLeft' && sub)) {
      if (sub) {
        showSubmenu(sub, false);
        sub.trigger.focus();
      } else {
        showMenu(m, false);
        btn.focus();
      }
    } else if (ev.key === 'ArrowRight' && trigSub) {
      showSubmenu(trigSub, true, true);
    } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const step = ev.key === 'ArrowDown' ? 1 : -1;
      if (items.length) items[(k + step + items.length) % items.length].focus();
    } else if (ev.key === 'Home' || ev.key === 'End') {
      if (items.length) items[ev.key === 'Home' ? 0 : items.length - 1].focus();
    } else if (ev.key === 'Tab') {
      showMenu(m, false);
      return;
    } else {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
  });
  return m;
}

/** The usable items of one menu level (not those of a submenu inside it). */
function menuItems(menu) {
  return [...menu.querySelectorAll('[role^="menuitem"]')]
    .filter((e) => e.closest('[role="menu"]') === menu && !e.disabled && !e.classList.contains('disabled'));
}

function showMenu(m, open, focusFirst = false) {
  m.menu.hidden = !open;
  m.btn.setAttribute('aria-expanded', String(open));
  if (!open) for (const sub of m.subs) showSubmenu(sub, false);
  if (open && focusFirst) {
    const first = menuItems(m.menu)[0];
    if (first) first.focus();
  }
}

function showSubmenu(sub, open, focusFirst = false) {
  clearTimeout(sub.timer);
  sub.menu.hidden = !open;
  sub.trigger.setAttribute('aria-expanded', String(open));
  if (open && focusFirst) {
    const first = menuItems(sub.menu)[0];
    if (first) first.focus();
  }
}

/** Close the open menu, if any; true if there was one. */
function closeMenus() {
  const open = menus.filter((m) => !m.menu.hidden);
  for (const m of open) showMenu(m, false);
  return open.length > 0;
}

function buildMenus() {
  buildMenu($('file-btn'), $('file-menu'),
    [{ wrap: $('export-sub'), trigger: $('export-btn'), menu: $('export-menu') }]);
  buildMenu($('help-btn'), $('help-menu'),
    [{ wrap: $('lang-sub'), trigger: $('lang-btn'), menu: $('lang-menu') }]);
  $('help-keys').addEventListener('click', () => showShortcuts(true));
  // Help ▸ Language ▸ one entry per language, named in its own language.
  for (const [code, name] of LANGUAGES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitemradio');
    b.dataset.lang = code;
    b.lang = code;
    b.textContent = name;
    b.addEventListener('click', () => changeLanguage(code));
    $('lang-menu').appendChild(b);
  }
  markLanguage();
  $('help-about').addEventListener('click', showAbout);
  for (const id of DIALOGS) {
    const dlg = $(id);
    dlg.querySelector('.close').addEventListener('click', () => showDialog(id, false));
    // A click on the dark backdrop (the dialog element itself) closes it.
    dlg.addEventListener('click', (ev) => { if (ev.target === dlg) showDialog(id, false); });
  }
  renderShortcuts();
}

// ---- language (Help ▸ Language) -----------------------------------------------------------

function markLanguage() {
  for (const b of $('lang-menu').children) b.setAttribute('aria-checked', String(b.dataset.lang === getLang()));
}

/** Switch the UI language at once: the page's fixed text, then what the
 * code has written (status, lists, tooltips, open popups). */
function changeLanguage(code) {
  setLang(code);
  markLanguage();
  applyI18n(document);
  applyTheme();
  setRunButton(app.status ? BUSY.has(app.status.state) : false, !!app.ws);
  if (app.status) onStatus(app.status);
  else if (!app.ws) {
    $('state').textContent = 'offline';
  }
  if (app.device) showDevice(app.device);
  for (const o of document.querySelectorAll ? document.querySelectorAll('select.trig option') : []) {
    if (o.dataset.title) o.title = tr(o.dataset.title);
  }
  updateDuration();
  updateSamplePresets();
  updateExportLinks();
  updateChannelPicker();
  updateMeasureReadout();
  updateViewInfo();
  renderShortcuts();
  renderDecoderCatalog();
  syncDecoders();
  if (decPop.inst) fillDecoderSettings(decPop.inst);
  if (dialogOpen('about-dialog')) showAbout();
}

// ---- keyboard shortcuts (Help ▸ Keyboard shortcuts) ------------------------------------
//
// What the keys and mouse do, for the help dialog. The keydown handler below
// carries them out; keep the two in step. (User-defined shortcuts would start
// here: give each entry an id and look keys up through this table.)

const SHORTCUTS = [
  ['Capture', [
    [['R'], 'Run'],
    [['S'], 'Stop'],
  ]],
  ['View', [
    [['+', '−'], 'Zoom in / out ×2'],
    [['Double-click', 'Right double-click'], 'Zoom in / out ×2 at the pointer (Ctrl: ×8)'],
    [['Wheel'], 'Zoom at the pointer'],
    [['Drag', 'Shift+Wheel', '←', '→'], 'Pan'],
    [['F'], 'Fit the whole capture'],
    [['Z'], 'Zoom to cursors A–B'],
    [['T'], 'Go to the trigger'],
  ]],
  ['Cursors', [
    [['Shift+Click', 'Shift+Right-click'], 'Place cursor A / B (hold to drag)'],
    [['A', 'B'], 'Place cursor A / B at the pointer'],
    [['Alt'], 'Hold while placing: do not snap to an edge'],
    [['[', ']'], 'Cursor A to the previous / next edge'],
    [['{', '}'], 'Cursor B to the previous / next edge'],
    [['Esc'], 'Clear the cursors'],
  ]],
  ['File', [
    [['Ctrl+O'], 'Open a session file'],
    [['Ctrl+S'], 'Save the session'],
  ]],
  ['Help', [
    [['?'], 'This list'],
  ]],
];

function renderShortcuts() {
  const box = $('keys-list');
  box.textContent = '';
  for (const [group, items] of SHORTCUTS) {
    const sec = document.createElement('section');
    const h = document.createElement('h3');
    h.textContent = tr(group);
    sec.appendChild(h);
    for (const [keys, what] of items) {
      const row = document.createElement('div');
      row.className = 'key-row';
      const k = document.createElement('span');
      k.className = 'k';
      keys.forEach((key) => {
        const kb = document.createElement('kbd');
        kb.textContent = tr(key);
        k.appendChild(kb);
      });
      const d = document.createElement('span');
      d.textContent = tr(what);
      row.appendChild(k);
      row.appendChild(d);
      sec.appendChild(row);
    }
    box.appendChild(sec);
  }
}

const DIALOGS = ['keys-dialog', 'about-dialog', 'dec-export-dialog'];

function dialogOpen(id) {
  const dlg = $(id);
  return dlg.open === true || (dlg.open === undefined && !dlg.hidden);
}

/** A modal dialog is open: keys belong to it (Esc closes it). */
function anyDialogOpen() {
  return DIALOGS.some(dialogOpen);
}

function showDialog(id, open) {
  const dlg = $(id);
  closeMenus();
  if (open && !dialogOpen(id)) {
    if (dlg.showModal) dlg.showModal();
    else dlg.hidden = false;
  } else if (!open && dialogOpen(id)) {
    if (dlg.close) dlg.close();
    else dlg.hidden = true;
  }
}

function showShortcuts(open) {
  showDialog('keys-dialog', open);
}

// ---- Help ▸ About ------------------------------------------------------------------------

const ABOUT = {
  developer: 'Brandon-git-hub',
  github: 'https://github.com/Brandon-git-hub/WebPulse',
  license: 'MIT',
};

async function showAbout() {
  // Ask again: the board may have been connected since the page loaded.
  try {
    app.device = await api('api/device');
    showDevice(app.device);
  } catch { /* show what we have */ }
  const d = app.device || {};
  $('about-version').textContent = d.version ? `v${d.version}` : '';
  const device = d.backend === 'sim' ? tr('Simulator')
    : d.connected ? `${d.model}${d.firmware ? ' · ' + d.firmware : ''}` : tr('FX2 not connected');
  const rows = [
    [tr('Version'), d.version || '–'],
    [tr('Build date'), d.build || '–'],
    [tr('OS'), d.os || '–'],
    [tr('Browser'), browserName()],
    [tr('Device'), device],
    [tr('Dependencies'), [
      `CivetWeb ${d.civetweb || ''} (MIT)`,
      d.libusb ? `libusb ${d.libusb} (LGPL-2.1)` : null,
      'fx2lafw firmware 0.1.7 (GPL-2.0+)',
    ].filter(Boolean)],
    [tr('Developer'), ABOUT.developer],
    ['GitHub', { href: ABOUT.github, text: ABOUT.github.replace(/^https:\/\//, '') }],
    [tr('License'), ABOUT.license],
  ];
  const dl = $('about-list');
  dl.textContent = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    if (Array.isArray(v)) {
      for (const line of v) {
        const div = document.createElement('div');
        div.textContent = line;
        dd.appendChild(div);
      }
    } else if (v && v.href) {
      const a = document.createElement('a');
      a.href = v.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = v.text;
      dd.appendChild(a);
    } else {
      dd.textContent = v;
    }
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  showDialog('about-dialog', true);
}

/** "Chrome 131", "Edge 131", "Firefox 133", … from the user agent. */
function browserName() {
  const ua = (globalThis.navigator && navigator.userAgent) || '';
  for (const [re, name] of [[/Edg\/(\d+)/, 'Edge'], [/OPR\/(\d+)/, 'Opera'], [/Firefox\/(\d+)/, 'Firefox'],
    [/Chrome\/(\d+)/, 'Chrome'], [/Version\/(\d+).*Safari/, 'Safari']]) {
    const m = re.exec(ua);
    if (m) return `${name} ${m[1]}`;
  }
  return ua ? ua.slice(0, 60) : '–';
}

function updateExportLinks() {
  const has = !!vp.capture;
  $('export-png').disabled = !has;
  $('export-dec').disabled = !has || !decoders.list.length;
  $('export-btn').disabled = !has;
  const names = encodeURIComponent(channels.map((c) => c.name.replace(/,/g, '_')).join(','));
  const on = channels.flatMap((c, i) => (c.enabled ? [i] : []));
  const sel = on.length === CHANNELS ? '' : `&channels=${on.join(',')}`;
  for (const fmt of ['sr', 'vcd', 'csv']) {
    const a = $('export-' + fmt);
    a.classList.toggle('disabled', !has);
    a.href = has ? `api/export?fmt=${fmt}&names=${names}${sel}` : '#';
    // Hidden channels are left out: say so where it matters, in the tooltip.
    a.title = !has ? tr('No capture yet') : sel ? tr('Only the shown channels: {list}', { list: 'CH' + on.join(', CH') }) : '';
  }
}

// ---- status ------------------------------------------------------------------------

function onStatus(st) {
  app.status = st;
  const busy = BUSY.has(st.state);
  const pill = $('state');
  pill.dataset.state = st.state;
  pill.textContent = st.state === 'armed' ? 'waiting for trigger' : st.state;   // kept in English
  setRunButton(busy);

  const wrap = $('progress-wrap');
  wrap.hidden = !(st.state === 'capturing' || st.state === 'processing');
  if (st.samples) $('progress').style.width = (100 * st.filled / st.samples).toFixed(1) + '%';

  let detail = '';
  if (st.state === 'armed') detail = tr('{s} s · trigger {trig}', { s: (st.elapsed_ms / 1000).toFixed(1), trig: st.trigger });
  else if (st.state === 'capturing') detail = `${formatSI(st.filled)} / ${formatSI(st.samples)}`;
  else if (st.state === 'error') detail = st.error;
  else if (st.state === 'done' && st.capture)
    detail = `${formatSI(st.capture.n)} @ ${formatRate(st.capture.rate)}` +
             (st.error ? ` · ${st.error}` : '');
  $('state-detail').textContent = detail;
  $('state-detail').title = detail;
  if (st.state === 'error' && st.seq !== onStatus.lastErrSeq) {
    onStatus.lastErrSeq = st.seq;
    toast(st.error || tr('Capture failed'));
  }

  const cap = st.capture;
  if (cap && st.state === 'done') {
    const key = `${st.seq}:${cap.n}:${cap.rate}:${cap.trigger_pos}`;
    if (key !== app.capKey) {
      app.capKey = key;
      showCapture(cap);
    }
  } else if (!cap && vp.capture) {
    app.capKey = null;
    app.cap = null;
    vp.capture = null;
    query.reset();
    renderer.clearData();
    edges.reset();
    renderer.measure = null;
    updateMeasureReadout();
    renderer.cursors = { a: null, b: null };
    $('empty').hidden = false;
    decoders.setCapture(null);
    updateExportLinks();
    updateCursorReadout();
    updateViewInfo();
  }
  if (!cap) {
    $('empty').querySelector('.big').textContent =
      tr(st.state === 'armed' ? 'Waiting for trigger…' :
        busy ? 'Capturing…' :
        st.state === 'error' ? 'Capture failed' : 'No capture yet');
  }
  if (!$('channels-pop').hidden) updateChannelPicker();
}

/** Row 1 always shows whether the board is connected (or the simulator). */
function showDevice(d) {
  const el = $('device');
  const state = d.backend === 'sim' ? 'sim' : d.connected ? 'on' : 'off';
  el.dataset.state = state;
  el.textContent = state === 'sim' ? tr('Simulator') : state === 'on' ? d.model : tr('FX2 not connected');
  el.title = state === 'sim' ? tr('Simulated signals (webpulse -b sim)')
    : state === 'on' ? tr('Connected: {model}', { model: d.model + (d.firmware ? ', ' + d.firmware : '') })
    : tr('No FX2 board found. It is looked for again when a capture starts.');
}

/** Upload a .sr file; the new capture then arrives through the status. */
async function openFile(file) {
  if (!file) return;
  toast(tr('Opening {name}…', { name: file.name }), 'info');
  app.opened = { name: file.name, modified: Math.floor((file.lastModified || 0) / 1000) };
  try {
    const r = await fetch(`api/open?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const js = await r.json().catch(() => ({}));
    if (!r.ok || !js.ok) throw new Error(js.error || `${r.status} ${r.statusText}`);
  } catch (e) {
    toast(tr('Cannot open {name}: {error}', { name: file.name, error: e.message }));
  }
}

/** An opened file brings channel names; channels it does not have are hidden. */
function applyFileChannels(names) {
  const any = names.some((n) => n);
  channels.forEach((ch, c) => {
    ch.name = names[c] || `CH${c}`;
    if (any) ch.enabled = !!names[c];
    if (ch.row) {
      ch.row.querySelector('.name').value = ch.name;
      ch.row.hidden = !ch.enabled;
    }
  });
  renderer.relayout();
  updateChannelPicker();
  saveSettings();
}

function showCapture(cap) {
  // The device may have been (re)connected for this capture; refresh its label.
  api('api/device').then((d) => { app.device = d; showDevice(d); }).catch(() => {});
  query.reset();
  renderer.clearData();
  edges.reset();
  renderer.measure = null;
  updateMeasureReadout();
  renderer.cursors = { a: null, b: null };
  $('empty').hidden = true;
  if (Array.isArray(cap.names)) applyFileChannels(cap.names);
  app.cap = cap;
  vp.setCapture({ n: cap.n, rate: cap.rate, trigger_pos: cap.trigger_pos });
  updateChannelPicker();
  updateExportLinks();
  decoders.setCapture({ key: app.capKey, rate: cap.rate });
}

// ---- WebSocket -------------------------------------------------------------------------

function connect() {
  const url = new URL('ws', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  app.ws = ws;

  ws.onopen = () => {
    app.wsRetry = 500;
    query.reset();
    query.request();
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'status') onStatus(msg);
      else if (msg.type === 'edges') edges.onMessage(msg);
      else if (msg.type === 'error' && !edges.onMessage(msg) && msg.error !== 'no capture') toast(msg.error);
    } else {
      query.onResponse(ev.data);
    }
  };
  ws.onclose = () => {
    app.ws = null;
    edges.reset();
    $('state').dataset.state = 'offline';
    $('state').textContent = 'offline';
    $('state-detail').textContent = tr('reconnecting…');
    setRunButton(false, false);
    setTimeout(connect, app.wsRetry);
    app.wsRetry = Math.min(app.wsRetry * 2, 5000);
  };
}

// ---- canvas interaction -------------------------------------------------------------------

const drag = { active: false, mode: null, button: 0, x0: 0, last: 0, moved: false };

function localX(ev) {
  const r = canvas.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}

function cursorNear(x) {
  for (const k of ['a', 'b']) {
    const s = renderer.cursors[k];
    if (s != null && Math.abs(vp.xOf(s) - x) <= 5) return k;
  }
  return null;
}

function setCursor(k, x, snap = false) {
  if (!vp.capture) return;
  let s = Math.round(vp.sampleAt(x));
  if (snap) s = snapSample(s, x);
  renderer.cursors[k] = Math.min(Math.max(s, 0), vp.capture.n);
  renderer.requestDraw();
  updateCursorReadout();
}

// Mouse: left drag pans, left double-click zooms in, right double-click zooms
// out (Ctrl: x8 instead of x2), Shift+left / Shift+right places cursor A / B,
// dragging a cursor line moves it. Double-clicks are detected here rather than
// with 'dblclick' because browsers have no right-button double-click event.
const DBL_MS = 400, DBL_PX = 6, CLICK_PX = 3;
const lastClick = { button: -1, at: 0, x: 0 };

function zoomBy(x, factor) {
  vp.zoomAt(x, factor);
  updateZoomButtons();
}

canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

canvas.addEventListener('pointerdown', (ev) => {
  if (!vp.capture || (ev.button !== 0 && ev.button !== 2)) return;
  const { x } = localX(ev);
  const near = cursorNear(x);
  drag.button = ev.button;
  drag.x0 = drag.last = x;
  drag.moved = false;
  if (ev.shiftKey) {
    const k = ev.button === 0 ? 'a' : 'b';
    setCursor(k, x, !ev.altKey);
    drag.mode = 'cursor-' + k;      // keep the button down to drag it
  } else if (near && ev.button === 0) {
    drag.mode = 'cursor-' + near;
  } else {
    drag.mode = ev.button === 0 ? 'pan' : 'click';
  }
  drag.active = true;
  canvas.setPointerCapture(ev.pointerId);
});

canvas.addEventListener('pointermove', (ev) => {
  const { x, y } = localX(ev);
  renderer.hoverX = vp.capture ? x : null;
  if (vp.capture) {
    const dec = renderer.decoderAt(y);
    if (dec) {
      showAnnotation(dec.row, renderer.annotationAt(dec.row, x));
    } else {
      if (app.annotation) {
        app.annotation = false;
        updateMeasureReadout();
      }
      setActive(renderer.channelAt(y));
      if (renderer.active != null) measureAt(renderer.active, vp.sampleAt(x));
    }
  }
  if (drag.active) {
    if (Math.abs(x - drag.x0) > CLICK_PX) drag.moved = true;
    if (drag.mode === 'pan' && drag.moved) {
      canvas.classList.add('dragging');
      vp.panPx(x - drag.last);
      updateZoomButtons();
    } else if (drag.mode.startsWith('cursor-') && drag.moved) {
      setCursor(drag.mode.slice(-1), x, !ev.altKey);
    }
    drag.last = x;
  } else {
    canvas.style.cursor = cursorNear(x) ? 'ew-resize' : '';
  }
  renderer.requestDraw();
  updateMouseReadout(x);
});

canvas.addEventListener('pointerup', (ev) => {
  if (!drag.active) return;
  const { x } = localX(ev);
  canvas.releasePointerCapture(ev.pointerId);
  canvas.classList.remove('dragging');
  const plain = !drag.moved && (drag.mode === 'pan' || drag.mode === 'click');
  drag.active = false;
  if (!plain) {
    lastClick.button = -1;
    return;
  }
  const now = performance.now();
  if (lastClick.button === drag.button && now - lastClick.at < DBL_MS &&
      Math.abs(x - lastClick.x) <= DBL_PX) {
    const f = ev.ctrlKey ? 8 : 2;
    zoomBy(lastClick.x, drag.button === 0 ? 1 / f : f);
    lastClick.button = -1;
  } else {
    Object.assign(lastClick, { button: drag.button, at: now, x });
  }
});

canvas.addEventListener('pointerleave', () => {
  renderer.hoverX = null;
  renderer.requestDraw();
  $('cur-m').textContent = '–';
});

canvas.addEventListener('wheel', (ev) => {
  if (!vp.capture) return;
  ev.preventDefault();
  const { x } = localX(ev);
  const dx = ev.shiftKey ? ev.deltaY : ev.deltaX;
  const dy = ev.shiftKey ? 0 : ev.deltaY;
  const scale = ev.deltaMode === 1 ? 33 : ev.deltaMode === 2 ? 400 : 1;
  if (Math.abs(dx) > Math.abs(dy)) {
    vp.panPx(-dx * scale);
  } else if (dy) {
    vp.zoomAt(x, Math.exp(dy * scale * 0.0025));
  }
  updateMouseReadout(x);
  updateZoomButtons();
}, { passive: false });

// ---- zoom toolbar -------------------------------------------------------------------------

function zoomToCursors() {
  const { a, b } = renderer.cursors;
  if (a == null || b == null || a === b) return;
  vp.zoomTo(Math.min(a, b), Math.max(a, b));
  updateZoomButtons();
}

function fitView() {
  vp.fit();
  updateZoomButtons();
}

function updateZoomButtons() {
  const has = !!vp.capture;
  const { a, b } = renderer.cursors;
  for (const id of ['zoom-in', 'zoom-out', 'zoom-fit', 'edge-prev', 'edge-next']) $(id).disabled = !has;
  $('zoom-ab').disabled = !has || a == null || b == null || a === b;
}

$('zoom-in').addEventListener('click', () => zoomBy(vp.width / 2, 0.5));
$('zoom-out').addEventListener('click', () => zoomBy(vp.width / 2, 2));
$('zoom-fit').addEventListener('click', fitView);
$('zoom-ab').addEventListener('click', zoomToCursors);
$('edge-prev').addEventListener('click', (ev) => stepEdge(ev.shiftKey ? 'b' : 'a', -1));
$('edge-next').addEventListener('click', (ev) => stepEdge(ev.shiftKey ? 'b' : 'a', 1));

document.addEventListener('keydown', (ev) => {
  if (anyDialogOpen()) return;
  // Ctrl+O / Ctrl+S (Cmd on a Mac) open and save, also from a text box.
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && /^[os]$/i.test(ev.key)) {
    ev.preventDefault();
    closeMenus();
    if (ev.key.toLowerCase() === 'o') $('open-file').click();
    else if (!$('export-sr').classList.contains('disabled')) $('export-sr').click();
    return;
  }
  const tag = (ev.target && ev.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const W = vp.width;
  switch (ev.key) {
    case 'r': case 'R':
      if (!$('run').disabled && $('run').dataset.mode === 'run') runCapture();
      break;
    case 's': case 'S':
      if (!$('run').disabled && $('run').dataset.mode === 'stop') stopCapture();
      break;
    case 'f': case 'F':
      fitView();
      break;
    case '[': case ']': case '{': case '}':
      stepEdge('[]'.includes(ev.key) ? 'a' : 'b', '[{'.includes(ev.key) ? -1 : 1);
      break;
    case 'z': case 'Z':
      zoomToCursors();
      break;
    case 't': case 'T':
      if (vp.capture && vp.capture.trigger_pos >= 0) {
        vp.centreOn(vp.capture.trigger_pos);
        updateZoomButtons();
      }
      break;
    case '+': case '=':
      zoomBy(W / 2, 0.5);
      break;
    case '-': case '_':
      zoomBy(W / 2, 2);
      break;
    case 'ArrowLeft':
      vp.panPx(W * 0.25);
      break;
    case 'ArrowRight':
      vp.panPx(-W * 0.25);
      break;
    case 'a': case 'A': case 'b': case 'B':
      if (renderer.hoverX != null) setCursor(ev.key.toLowerCase(), renderer.hoverX, !ev.altKey);
      break;
    case '?':
      showShortcuts(true);
      break;
    case 'Escape':
      if (closeMenus()) break;
      if (!$('channels-pop').hidden) {
        showChannelPicker(false);
        break;
      }
      if (decPop.inst) {
        showDecoderSettings(null);
        break;
      }
      if (!$('dec-dock').hidden) {
        showDecoderDock(false);
        break;
      }
      renderer.cursors = { a: null, b: null };
      renderer.requestDraw();
      updateCursorReadout();
      break;
    default:
      return;
  }
  ev.preventDefault();
});

// ---- readouts --------------------------------------------------------------------------

function updateMouseReadout(x) {
  if (!vp.capture) return;
  const s = vp.sampleAt(x);
  $('cur-m').textContent = formatTime(vp.timeOf(s), 5);
}

function updateCursorReadout() {
  updateZoomButtons();    // A<->B depends on the cursors, Back on the view
  const { a, b } = renderer.cursors;
  const t = (s) => (s == null || !vp.capture ? null : vp.timeOf(s));
  const ta = t(a), tb = t(b);
  $('cur-a').textContent = ta == null ? '–' : formatTime(ta, 6);
  $('cur-b').textContent = tb == null ? '–' : formatTime(tb, 6);
  if (ta != null && tb != null && a !== b) {
    const dt = Math.abs(tb - ta);
    $('cur-dt').textContent = formatTime(dt, 6) + ` (${Math.abs(b - a)} smp)`;
    $('cur-f').textContent = formatFreq(1 / dt, 5);
  } else {
    $('cur-dt').textContent = '–';
    $('cur-f').textContent = '–';
  }
}

// ---- PNG snapshot ---------------------------------------------------------------------
// The current view as an image: channel / decoder names, the waveform canvas
// as drawn, and a line with the capture and cursor details.

const PNG_LABEL_W = 180, PNG_FOOT_H = 26;

function snapshotCanvas() {
  const dpr = renderer.dpr;
  const W = renderer.cssW, H = renderer.cssH;
  const out = document.createElement('canvas');
  out.width = Math.round((PNG_LABEL_W + W) * dpr);
  out.height = Math.round((H + PNG_FOOT_H) * dpr);
  const ctx = out.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();

  ctx.fillStyle = v('--panel');
  ctx.fillRect(0, 0, PNG_LABEL_W + W, H + PNG_FOOT_H);
  // Without the pointer's row highlight, hover line and pulse marks.
  const keep = { active: renderer.active, hoverX: renderer.hoverX };
  renderer.active = renderer.hoverX = null;
  renderer.draw();
  ctx.drawImage(canvas, PNG_LABEL_W, 0, W, H);
  Object.assign(renderer, keep);
  renderer.requestDraw();
  ctx.strokeStyle = v('--border');
  ctx.beginPath();
  ctx.moveTo(PNG_LABEL_W - 0.5, 0);
  ctx.lineTo(PNG_LABEL_W - 0.5, H + PNG_FOOT_H);
  ctx.moveTo(0, H + 0.5);
  ctx.lineTo(PNG_LABEL_W + W, H + 0.5);
  ctx.stroke();

  const label = (y, h, color, text, sub) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, y, 4, h);
    ctx.fillStyle = v('--text');
    ctx.font = `${sub ? 12 : 13}px ${v('--sans') || 'sans-serif'}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    let t = text;
    while (t.length > 1 && ctx.measureText(t).width > PNG_LABEL_W - 20) t = t.slice(0, -2) + '…';
    ctx.fillText(t, 12, y + h / 2);
  };
  ctx.fillStyle = v('--muted');
  ctx.font = `11px ${v('--sans') || 'sans-serif'}`;
  ctx.textBaseline = 'middle';
  ctx.fillText('WebPulse', 12, RULER_H / 2);
  for (const c of order) {
    const { top, h } = renderer.rows[c];
    if (h) label(top, h, channels[c].color, channels[c].name === `CH${c}` ? `CH${c}` : `${c}  ${channels[c].name}`);
  }
  for (const r of renderer.decRows) label(r.top, DEC_ROW_H, r.color, r.label, true);

  // Footer: rate, samples, view, cursors.
  const cap = vp.capture;
  const parts = [`${formatSI(cap.n)} samples @ ${formatRate(cap.rate)}`, $('view-info').textContent];
  const { a, b } = renderer.cursors;
  if (a != null) parts.push(`A ${$('cur-a').textContent}`);
  if (b != null) parts.push(`B ${$('cur-b').textContent}`);
  if (a != null && b != null) parts.push(`Δt ${$('cur-dt').textContent}`, `1/Δt ${$('cur-f').textContent}`);
  parts.push(new Date().toLocaleString());
  ctx.fillStyle = v('--muted');
  ctx.font = `12px ${v('--mono') || 'monospace'}`;
  ctx.fillText(parts.filter(Boolean).join('   ·   '), 12, H + PNG_FOOT_H / 2 + 1);
  return out;
}

function exportPng() {
  if (!vp.capture) return;
  const out = snapshotCanvas();
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const name = `webpulse-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-` +
    `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.png`;
  out.toBlob((blob) => {
    if (!blob) {
      toast(tr('Could not create the image'));
      return;
    }
    download(blob, name);
  }, 'image/png');
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---- File ▸ Export ▸ Decoder annotations ---------------------------------------------------
// One decoder's annotations as text (format: js/decode/export.js), the same
// as tools/wp-decode.mjs writes.

const decExport = { uid: null, rows: new Map() };    // rows: "uid:row" -> checked

function buildDecoderExport() {
  $('export-dec').addEventListener('click', () => {
    closeMenus();
    updateDecoderExport();
    showDialog('dec-export-dialog', true);
  });
  $('dx-dec').addEventListener('change', () => {
    decExport.uid = Number($('dx-dec').value);
    updateDecoderExport();
  });
  $('dx-cancel').addEventListener('click', () => showDialog('dec-export-dialog', false));
  $('dx-form').addEventListener('change', (ev) => {
    if (ev.target.name === 'dx-row') decExport.rows.set(ev.target.value, ev.target.checked);
    updateDecoderExportInfo();
  });
  $('dx-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    exportDecoder().catch((e) => toast(e.message));
  });
}

/** The decoder picked in the dialog, its module and decoding state. */
function decoderExportTarget() {
  const inst = decoders.list.find((i) => i.uid === decExport.uid) || decoders.list[0];
  if (!inst) return null;
  return { inst, d: decoders.def(inst.key), st: decoders.state.get(inst.uid) || {} };
}

function updateDecoderExport() {
  const t = decoderExportTarget();
  const sel = $('dx-dec');
  sel.textContent = '';
  for (const inst of decoders.list) sel.appendChild(new Option(inst.label, String(inst.uid)));
  if (t) {
    decExport.uid = t.inst.uid;
    sel.value = String(t.inst.uid);
  }
  const box = $('dx-rows');
  box.textContent = '';
  for (const r of (t && t.d && t.d.def.rows) || []) {
    const key = `${t.inst.uid}:${r.id}`;
    const lab = document.createElement('label');
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', name: 'dx-row', value: key });
    // Rows marked export: false (e.g. one annotation per bit) start unchecked.
    cb.checked = decExport.rows.has(key) ? decExport.rows.get(key) : r.export !== false;
    lab.append(cb, ' ', r.name);
    box.appendChild(lab);
  }
  const c = renderer.cursors;
  const both = c.a !== null && c.b !== null && c.a !== c.b;
  $('dx-range-cursors').disabled = !both;
  $('dx-range-cursors').parentElement.classList.toggle('off', !both);
  if (!both && $('dx-range-cursors').checked) $('dx-form').elements['dx-range'].value = 'all';
  updateDecoderExportInfo();
}

/** [first, end) samples for the chosen range, or null for all. */
function decoderExportRange() {
  const n = vp.capture ? vp.capture.n : 0;
  const which = $('dx-form').elements['dx-range'].value;
  if (which === 'view') return [Math.max(0, Math.floor(vp.start)), Math.min(n, Math.ceil(vp.end))];
  if (which === 'cursors') {
    const { a, b } = renderer.cursors;
    if (a !== null && b !== null) return [Math.round(Math.min(a, b)), Math.round(Math.max(a, b))];
  }
  return null;
}

function checkedExportRows(t) {
  return [...$('dx-rows').querySelectorAll('input:checked')].map((cb) => cb.value.slice(String(t.inst.uid).length + 1));
}

function updateDecoderExportInfo() {
  const t = decoderExportTarget();
  const info = $('dx-info');
  let msg = '', err = false;
  if (!t || !t.d) { msg = tr('This decoder is not available (any more).'); err = true; }
  else if (t.st.status === 'running') msg = tr('Decoding…');
  else if (!t.st.result) { msg = t.st.error || tr('No result yet.'); err = true; }
  else {
    const range = decoderExportRange();
    let count = 0;
    for (const id of checkedExportRows(t)) {
      const r = t.st.result.rows[id];
      if (!r) continue;
      if (!range) count += r.start.length;
      else for (let i = 0; i < r.start.length; i++) if (r.start[i] >= range[0] && r.start[i] < range[1]) count++;
    }
    msg = tr('{n} annotations', { n: count.toLocaleString() });
    if (t.st.error) { msg += ' · ' + t.st.error; err = true; }
  }
  info.textContent = msg;
  info.classList.toggle('err', err);
  $('dx-ok').disabled = !(t && t.d && t.st.result && t.st.status !== 'running');
}

async function exportDecoder() {
  const t = decoderExportTarget();
  if (!t || !t.d || !t.st.result) return;
  const { inst, d, st } = t;
  const builtin = d.source === 'built-in';
  let crc = '';
  if (!builtin) {
    // Which version of the file decoded this: its CRC now (decoding re-reads it on Reload).
    try { crc = crc32(await (await fetch(d.url)).text()); } catch { /* left out */ }
  }
  const cap = app.cap || {};
  const file = cap.source || '';
  const fromHere = file && app.opened && app.opened.name === file && app.opened.modified;
  const version = app.device && app.device.version ? `WebPulse ${app.device.version}` : 'WebPulse';
  const chunks = exportAnnotations({
    version,
    capture: {
      source: file,
      time: fromHere ? app.opened.modified : cap.time || 0,
      timeKind: fromHere ? 'modified' : 'opened',
      rate: vp.capture.rate,
      n: vp.capture.n,
      trigger_pos: vp.capture.trigger_pos,
    },
    decoder: builtin ? { id: d.def.id || d.name, builtin: true }
      : { id: d.def.id || d.key.replace(/^user:|\.m?js$/g, ''), file: d.key.replace(/^user:/, ''), crc },
    channels: d.def.channels.map((c) => {
      const ch = inst.assign[c.id];
      return [c.id, ch === null || ch === undefined || ch === '' ? '' : channels[Number(ch)].name];
    }),
    options: normalizeOptions(d.def, inst.options),
    rows: checkedExportRows(t),
    result: st.result,
    range: decoderExportRange(),
  });
  const base = file ? file.replace(/\.sr$/i, '') : `webpulse-${stamp(cap.time ? new Date(cap.time * 1000) : new Date())}`;
  const safe = inst.label.replace(/[^\w.-]+/g, '_');
  download(new Blob(chunks, { type: 'text/plain' }), `${base}-${safe}.txt`);
  showDialog('dec-export-dialog', false);
}

/** 20261127-114619 */
function stamp(d) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

function updateViewInfo() {
  const el = $('view-info');
  if (!vp.capture) {
    el.textContent = '';
    return;
  }
  const span = (vp.width * vp.spp) / vp.capture.rate;
  const z = vp.spp >= 1 ? `${formatSI(Math.round(vp.spp))} smp/px` : `${(1 / vp.spp).toFixed(1)} px/smp`;
  el.textContent = tr('view {span} · {zoom}', { span: formatTime(span, 3), zoom: z });
}

// ---- init ------------------------------------------------------------------------------

async function init() {
  buildChannelList();
  buildChannelPicker();
  applyI18n(document);
  buildMenus();
  buildDecoderDock();
  buildDecoderSettings();
  buildDecoderExport();
  document.documentElement.style.setProperty('--dec-row-h', DEC_ROW_H + 'px');
  decoders.loadDefs().then(renderDecoderCatalog);
  for (const id of ['samples', 'pre', 'timeout']) {
    if (settings[id] != null) $(id).value = settings[id];
  }
  $('samples').addEventListener('input', updateDuration);
  $('samples').addEventListener('change', saveSettings);
  $('sample-presets').addEventListener('change', (ev) => {
    if (!ev.target.value) return;
    $('samples').value = ev.target.value;
    ev.target.value = '';
    updateDuration();
    saveSettings();
  });
  $('rate').addEventListener('change', () => {
    updateDuration();
    updateSamplePresets();
    saveSettings();
  });
  $('pre').addEventListener('change', saveSettings);
  $('timeout').addEventListener('change', saveSettings);
  $('run').addEventListener('click', toggleRun);
  $('export-png').addEventListener('click', exportPng);
  $('open').addEventListener('click', () => $('open-file').click());
  $('open-file').addEventListener('change', (ev) => {
    openFile(ev.target.files && ev.target.files[0]);
    ev.target.value = '';           // the same file can be opened again
  });
  // Dropping a .sr file anywhere opens it too.
  document.addEventListener('dragover', (ev) => ev.preventDefault());
  document.addEventListener('drop', (ev) => {
    const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (!f) return;
    ev.preventDefault();
    openFile(f);
  });
  $('theme').addEventListener('click', cycleTheme);
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme());
  applyTheme();

  new ResizeObserver(() => renderer.resize()).observe($('wave-wrap'));
  renderer.resize();
  updateExportLinks();

  try {
    app.device = await api('api/device');
    const sel = $('rate');
    for (const r of app.device.rates.slice().reverse()) {
      const o = document.createElement('option');
      o.value = r;
      o.textContent = formatRate(r);
      sel.appendChild(o);
    }
    const want = settings.rate && app.device.rates.includes(Number(settings.rate))
      ? settings.rate : String(Math.max(...app.device.rates));
    sel.value = want;
    showDevice(app.device);
  } catch (e) {
    toast(tr('Cannot reach the WebPulse server: {error}', { error: e.message }));
  }
  updateDuration();
  updateSamplePresets();
  connect();
}

init();
