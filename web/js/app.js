// WebPulse UI: toolbar, channel list, WebSocket client and canvas interaction.
// All URLs are relative so the page also works behind a path prefix such as
// code-server's /proxy/8080/.

import { formatFreq, formatRate, formatSI, formatTime, parseSI } from './format.js';
import { CHANNELS, RULER_H, ROW_H, Renderer } from './renderer.js';
import { Viewport } from './viewport.js';

const $ = (id) => document.getElementById(id);

// Resistor colour code (brown, red, orange, yellow, black, green, blue, violet)
// in light tints that read well on the dark background; "black" is drawn as a
// light grey since a dark line would vanish.
const DEFAULT_COLORS = ['#c69a6d', '#e57373', '#ffa95e', '#f4d35e',
                        '#b8c0cc', '#81c784', '#64b5f6', '#b388ff'];
// Defaults of earlier versions: a saved colour equal to one of these was never
// picked by the user, so it follows the new default.
const OLD_DEFAULT_COLORS = ['#f4c542', '#4fc3f7', '#81c784', '#ff8a65',
                            '#ba68c8', '#4db6ac', '#e57373', '#aed581'];
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
    channels: channels.map(({ name, color, trig, enabled }) => ({ name, color, trig, enabled })),
  };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch { /* storage unavailable */ }
}

const settings = loadSettings();
const channels = Array.from({ length: CHANNELS }, (_, i) => {
  const saved = (settings.channels || [])[i] || {};
  return {
    name: typeof saved.name === 'string' ? saved.name : `CH${i}`,
    color: /^#[0-9a-f]{6}$/i.test(saved.color || '') && saved.color !== OLD_DEFAULT_COLORS[i]
      ? saved.color : DEFAULT_COLORS[i],
    trig: TRIG_OPTIONS.some((o) => o[0] === saved.trig) ? saved.trig : 'X',
    enabled: saved.enabled !== false,
  };
});

// ---- view / renderer -----------------------------------------------------------

const canvas = $('wave');
const vp = new Viewport();
const renderer = new Renderer(canvas, vp, channels);

const app = {
  device: null,
  status: null,
  capKey: null,
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
    el.innerHTML = `${head}<span class="k">constant ${m.level ? 'high' : 'low'}</span>`;
  } else {
    const v = measureValues(m);
    const f = v.period ? formatFreq(rate / v.period) : '–';
    const duty = v.period ? (100 * v.high / v.period).toFixed(1) + ' %' : '–';
    el.innerHTML = `${head}<span class="k">High</span> ${t(v.high)}<span class="k">Low</span> ${t(v.low)}` +
      `<span class="k">Period</span> ${t(v.period)}<span class="k">Freq</span> ${f}<span class="k">Duty</span> ${duty}`;
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
    toast(`No ${dir > 0 ? 'later' : 'earlier'} edge on ${channels[ch].name}`, 'info');
    return;
  }
  renderer.cursors[k] = to;
  const x = vp.xOf(to);
  if (x < 0 || x > vp.width) {
    vp.save();
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

function buildChannelList() {
  const list = $('channels');
  channels.forEach((ch, i) => {
    const row = document.createElement('div');
    row.className = 'ch';
    row.style.setProperty('--c', ch.color);
    row.innerHTML = `
      <span class="bar"></span>
      <span class="idx">${i}</span>
      <label class="color" title="Channel colour"><input type="color" value="${ch.color}"></label>
      <input class="name" maxlength="24" spellcheck="false" title="Channel name">
      <select class="trig" title="Trigger condition for CH${i}"></select>`;
    const name = row.querySelector('.name');
    name.value = ch.name;
    name.addEventListener('change', () => {
      ch.name = name.value.trim() || `CH${i}`;
      name.value = ch.name;
      saveSettings();
      updateExportLinks();
      updateChannelPicker();
    });
    const color = row.querySelector('input[type=color]');
    color.addEventListener('input', () => {
      ch.color = color.value;
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
      o.title = title;
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
    list.appendChild(row);
  });
  document.documentElement.style.setProperty('--row-h', ROW_H + 'px');
  document.documentElement.style.setProperty('--ruler-h', RULER_H + 'px');
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
    toast('At least one channel must stay enabled', 'info');
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
    const changes = m == null ? '' : (m >> i) & 1 ? ' · changing' : ' · no change';
    label.querySelector('.nm').textContent = isNamed(ch, i) ? `${i} ${ch.name}` : ch.name;
    label.title = `CH${i}${isNamed(ch, i) ? ' "' + ch.name + '"' : ''}${changes}`;
    label.classList.toggle('steady', m != null && !((m >> i) & 1));
  });
  for (const b of $('channels-pop').querySelectorAll('button[data-act]')) {
    const needsCap = b.dataset.sel === 'changing' || b.dataset.sel === 'steady';
    b.disabled = needsCap && m == null;
    b.title = b.disabled ? 'Needs a completed capture' : '';
  }
  const n = channels.filter((c) => c.enabled).length;
  $('channels-count').textContent = n === CHANNELS ? '' : `${n}/${CHANNELS}`;
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
    el.textContent = n === null ? 'invalid' : '';
    $('samples-box').style.borderColor = n === null ? 'var(--danger)' : '';
    return;
  }
  const max = app.device ? app.device.max_samples : Infinity;
  $('samples-box').style.borderColor = n > max || n < 16 ? 'var(--danger)' : '';
  el.textContent = '= ' + formatTime(n / rate, 3) + (n > max ? ` (max ${formatSI(max)})` : '');
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
    toast('Invalid sample count (examples: 1M, 10M, 50000)');
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
    $('run').disabled = true;
    await api('api/capture', body);
  } catch (e) {
    toast(e.message);
    $('run').disabled = false;
  }
}

async function stopCapture() {
  try {
    await api('api/stop', {});
  } catch (e) {
    toast(e.message);
  }
}

function updateExportLinks() {
  const has = !!vp.capture;
  const names = encodeURIComponent(channels.map((c) => c.name.replace(/,/g, '_')).join(','));
  const on = channels.flatMap((c, i) => (c.enabled ? [i] : []));
  const sel = on.length === CHANNELS ? '' : `&channels=${on.join(',')}`;
  for (const fmt of ['vcd', 'csv']) {
    const a = $('export-' + fmt);
    a.classList.toggle('disabled', !has);
    a.href = has ? `api/export?fmt=${fmt}&names=${names}${sel}` : '#';
    a.title = has ? `Download the capture as ${fmt.toUpperCase()}` +
      (sel ? ` (CH${on.join(', CH')})` : '') : 'No capture';
  }
}

// ---- status ------------------------------------------------------------------------

function onStatus(st) {
  app.status = st;
  const busy = BUSY.has(st.state);
  const pill = $('state');
  pill.dataset.state = st.state;
  pill.textContent = st.state === 'armed' ? 'waiting for trigger' : st.state;
  $('run').disabled = busy;
  $('stop').disabled = !busy;

  const wrap = $('progress-wrap');
  wrap.hidden = !(st.state === 'capturing' || st.state === 'processing');
  if (st.samples) $('progress').style.width = (100 * st.filled / st.samples).toFixed(1) + '%';

  let detail = '';
  if (st.state === 'armed') detail = `${(st.elapsed_ms / 1000).toFixed(1)} s · trigger ${st.trigger}`;
  else if (st.state === 'capturing') detail = `${formatSI(st.filled)} / ${formatSI(st.samples)}`;
  else if (st.state === 'error') detail = st.error;
  else if (st.state === 'done' && st.capture)
    detail = `${formatSI(st.capture.n)} @ ${formatRate(st.capture.rate)}` +
             (st.error ? ` · ${st.error}` : '');
  $('state-detail').textContent = detail;
  $('state-detail').title = detail;
  if (st.state === 'error' && st.seq !== onStatus.lastErrSeq) {
    onStatus.lastErrSeq = st.seq;
    toast(st.error || 'Capture failed');
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
    vp.capture = null;
    query.reset();
    renderer.clearData();
    edges.reset();
    renderer.measure = null;
    updateMeasureReadout();
    renderer.cursors = { a: null, b: null };
    $('empty').hidden = false;
    updateExportLinks();
    updateCursorReadout();
    updateViewInfo();
  }
  if (!cap) {
    $('empty').querySelector('.big').textContent =
      st.state === 'armed' ? 'Waiting for trigger…' :
      busy ? 'Capturing…' :
      st.state === 'error' ? 'Capture failed' : 'No capture';
  }
  if (!$('channels-pop').hidden) updateChannelPicker();
}

function showDevice(d) {
  $('device').textContent = `${d.model}${d.firmware ? ' · ' + d.firmware : ''} · v${d.version}`;
  $('device').title = $('device').textContent;
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
  vp.setCapture({ n: cap.n, rate: cap.rate, trigger_pos: cap.trigger_pos });
  updateChannelPicker();
  updateExportLinks();
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
    $('state-detail').textContent = 'reconnecting…';
    $('run').disabled = true;
    $('stop').disabled = true;
    setTimeout(connect, app.wsRetry);
    app.wsRetry = Math.min(app.wsRetry * 2, 5000);
  };
}

// ---- canvas interaction -------------------------------------------------------------------

const drag = { active: false, mode: null, button: 0, x0: 0, last: 0, moved: false, saved: false };

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
  vp.save();
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
    setActive(renderer.channelAt(y));
    if (renderer.active != null) measureAt(renderer.active, vp.sampleAt(x));
  }
  if (drag.active) {
    if (Math.abs(x - drag.x0) > CLICK_PX) drag.moved = true;
    if (drag.mode === 'pan' && drag.moved) {
      if (!drag.saved) {
        vp.save();
        drag.saved = true;
        canvas.classList.add('dragging');
      }
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
  drag.saved = false;
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

let lastWheel = 0;
canvas.addEventListener('wheel', (ev) => {
  if (!vp.capture) return;
  ev.preventDefault();
  // One history entry per burst of wheel events.
  if (performance.now() - lastWheel > 500) vp.save();
  lastWheel = performance.now();
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
  vp.save();
  vp.zoomTo(Math.min(a, b), Math.max(a, b));
  updateZoomButtons();
}

function fitView() {
  vp.save();
  vp.fit();
  updateZoomButtons();
}

function goBack() {
  vp.back();
  updateZoomButtons();
}

function updateZoomButtons() {
  const has = !!vp.capture;
  const { a, b } = renderer.cursors;
  for (const id of ['zoom-in', 'zoom-out', 'zoom-fit']) $(id).disabled = !has;
  $('zoom-ab').disabled = !has || a == null || b == null || a === b;
  $('zoom-back').disabled = !has || !vp.canGoBack;
}

$('zoom-in').addEventListener('click', () => zoomBy(vp.width / 2, 0.5));
$('zoom-out').addEventListener('click', () => zoomBy(vp.width / 2, 2));
$('zoom-fit').addEventListener('click', fitView);
$('zoom-ab').addEventListener('click', zoomToCursors);
$('zoom-back').addEventListener('click', goBack);
$('edge-prev').addEventListener('click', (ev) => stepEdge(ev.shiftKey ? 'b' : 'a', -1));
$('edge-next').addEventListener('click', (ev) => stepEdge(ev.shiftKey ? 'b' : 'a', 1));

document.addEventListener('keydown', (ev) => {
  const tag = (ev.target && ev.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const W = vp.width;
  switch (ev.key) {
    case 'r': case 'R':
      if (!$('run').disabled) runCapture();
      break;
    case 's': case 'S':
      if (!$('stop').disabled) stopCapture();
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
    case 'Backspace':
      goBack();
      break;
    case 't': case 'T':
      if (vp.capture && vp.capture.trigger_pos >= 0) {
        vp.save();
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
    case 'Escape':
      if (!$('channels-pop').hidden) {
        showChannelPicker(false);
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

function updateViewInfo() {
  const el = $('view-info');
  if (!vp.capture) {
    el.textContent = '';
    return;
  }
  const span = (vp.width * vp.spp) / vp.capture.rate;
  const z = vp.spp >= 1 ? `${formatSI(Math.round(vp.spp))} smp/px` : `${(1 / vp.spp).toFixed(1)} px/smp`;
  el.textContent = `view ${formatTime(span, 3)} · ${z}`;
}

// ---- init ------------------------------------------------------------------------------

async function init() {
  buildChannelList();
  buildChannelPicker();
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
  $('run').addEventListener('click', runCapture);
  $('stop').addEventListener('click', stopCapture);

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
    toast('Cannot reach the WebPulse server: ' + e.message);
  }
  updateDuration();
  updateSamplePresets();
  connect();
}

init();
