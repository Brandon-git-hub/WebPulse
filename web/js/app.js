// WebPulse UI: toolbar, channel list, WebSocket client and canvas interaction.
// All URLs are relative so the page also works behind a path prefix such as
// code-server's /proxy/8080/.

import { formatFreq, formatRate, formatSI, formatTime, parseSI } from './format.js';
import { CHANNELS, RULER_H, ROW_H, Renderer } from './renderer.js';
import { Viewport } from './viewport.js';

const $ = (id) => document.getElementById(id);

const DEFAULT_COLORS = ['#f4c542', '#4fc3f7', '#81c784', '#ff8a65',
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
    channels: channels.map(({ name, color, trig }) => ({ name, color, trig })),
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
    color: /^#[0-9a-f]{6}$/i.test(saved.color || '') ? saved.color : DEFAULT_COLORS[i],
    trig: TRIG_OPTIONS.some((o) => o[0] === saved.trig) ? saved.trig : 'X',
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
    });
    const color = row.querySelector('input[type=color]');
    color.addEventListener('input', () => {
      ch.color = color.value;
      row.style.setProperty('--c', ch.color);
      renderer.requestDraw();
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
    list.appendChild(row);
  });
  document.documentElement.style.setProperty('--row-h', ROW_H + 'px');
  document.documentElement.style.setProperty('--ruler-h', RULER_H + 'px');
}

function triggerSpec() {
  const s = channels.map((c) => c.trig).join('');
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
  for (const fmt of ['vcd', 'csv']) {
    const a = $('export-' + fmt);
    a.classList.toggle('disabled', !has);
    a.href = has ? `api/export?fmt=${fmt}&names=${names}` : '#';
    a.title = has ? `Download the capture as ${fmt.toUpperCase()}` : 'No capture';
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
  renderer.cursors = { a: null, b: null };
  $('empty').hidden = true;
  vp.setCapture({ n: cap.n, rate: cap.rate, trigger_pos: cap.trigger_pos });
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
      else if (msg.type === 'error' && msg.error !== 'no capture') toast(msg.error);
    } else {
      query.onResponse(ev.data);
    }
  };
  ws.onclose = () => {
    app.ws = null;
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

const drag = { active: false, mode: null, x0: 0, last: 0, moved: false };

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

function setCursor(k, x) {
  if (!vp.capture) return;
  const s = Math.round(vp.sampleAt(x));
  renderer.cursors[k] = Math.min(Math.max(s, 0), vp.capture.n);
  renderer.requestDraw();
  updateCursorReadout();
}

canvas.addEventListener('pointerdown', (ev) => {
  if (!vp.capture || ev.button !== 0) return;
  const { x } = localX(ev);
  const near = cursorNear(x);
  drag.active = true;
  drag.mode = near ? 'cursor-' + near : 'pan';
  drag.x0 = drag.last = x;
  drag.moved = false;
  canvas.setPointerCapture(ev.pointerId);
  if (drag.mode === 'pan') canvas.classList.add('dragging');
});

canvas.addEventListener('pointermove', (ev) => {
  const { x } = localX(ev);
  renderer.hoverX = vp.capture ? x : null;
  if (drag.active) {
    if (Math.abs(x - drag.x0) > 3) drag.moved = true;
    if (drag.mode === 'pan') {
      vp.panPx(x - drag.last);
    } else if (drag.moved) {
      setCursor(drag.mode.slice(-1), x);
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
  if (!drag.moved && drag.mode === 'pan') {
    // A click (no drag) places a cursor: A, or B with Shift.
    setCursor(ev.shiftKey ? 'b' : 'a', x);
  }
  drag.active = false;
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
}, { passive: false });

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
      vp.fit();
      break;
    case 't': case 'T':
      if (vp.capture && vp.capture.trigger_pos >= 0) vp.centreOn(vp.capture.trigger_pos);
      break;
    case '+': case '=':
      vp.zoomAt(W / 2, 0.5);
      break;
    case '-': case '_':
      vp.zoomAt(W / 2, 2);
      break;
    case 'ArrowLeft':
      vp.panPx(W * 0.25);
      break;
    case 'ArrowRight':
      vp.panPx(-W * 0.25);
      break;
    case 'a': case 'A': case 'b': case 'B':
      if (renderer.hoverX != null) setCursor(ev.key.toLowerCase(), renderer.hoverX);
      break;
    case 'Escape':
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
