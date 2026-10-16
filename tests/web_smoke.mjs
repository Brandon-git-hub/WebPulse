// End-to-end smoke test of the web UI without a browser.
//
// Runs the real web/js/app.js under Node (>= 22, for the built-in WebSocket
// and fetch) with a minimal fake DOM and canvas, against a running server:
//
//   ./build/linux/webpulse -b sim -p 18080 &
//   node tests/web_smoke.mjs http://127.0.0.1:18080/
//
// It drives the UI like a user (set a trigger, Run, zoom, place cursors) and
// checks that the page reacts and the renderer draws without throwing.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const base = process.argv[2] || 'http://127.0.0.1:18080/';
const here = path.dirname(fileURLToPath(import.meta.url));

// ---- fake DOM ---------------------------------------------------------------

let drawCalls = 0;
const ctxProxy = new Proxy({}, {
  get(target, prop) {
    if (prop in target) return target[prop];
    return (...args) => {
      if (prop === 'lineTo' || prop === 'fillRect') drawCalls++;
      return undefined;
    };
  },
  set(target, prop, value) { target[prop] = value; return true; },
});

class FakeElement {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.style = { setProperty() {} };
    this.dataset = {};
    this.children = [];
    this.handlers = {};
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.title = '';
    this.href = '';
    this._q = {};
    const cls = new Set();
    this.classList = {
      toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : on ? cls.add(c) : cls.delete(c)),
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      contains: (c) => cls.has(c),
    };
    this.parentElement = { clientWidth: 1200 };
  }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  dispatch(type, ev = {}) {
    const e = { preventDefault() {}, target: this, button: 0, pointerId: 1, ...ev };
    for (const fn of this.handlers[type] || []) fn(e);
  }
  querySelector(sel) { return (this._q[sel] ||= new FakeElement(sel === '.trig' ? 'select' : 'input')); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 400 }; }
  setPointerCapture() {}
  releasePointerCapture() {}
  getContext() { return ctxProxy; }
  set innerHTML(v) { this._html = v; }
}

const elements = {};
const document = {
  documentElement: new FakeElement('html'),
  getElementById(id) { return (elements[id] ||= new FakeElement(id === 'wave' ? 'canvas' : 'div', id)); },
  createElement(tag) { return new FakeElement(tag); },
  handlers: {},
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
};
// Input defaults from index.html
document.getElementById('samples').value = '2M';
document.getElementById('pre').value = '25';
document.getElementById('timeout').value = '5';
document.getElementById('empty').querySelector = () => new FakeElement('p');

const store = {};
Object.assign(globalThis, {
  window: globalThis,
  document,
  location: new URL(base),
  devicePixelRatio: 2,
  localStorage: {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v); },
  },
  requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 5),
  ResizeObserver: class { observe() {} },
});
// fetch() needs absolute URLs under Node; resolve against the page URL.
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(new URL(u, base), o);

// ---- helpers -------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error('FAIL:', msg); } else console.log('ok  ', msg);
}
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(20);
  }
  console.error('timeout waiting for', what);
  return false;
}

// ---- run -------------------------------------------------------------------------

process.on('uncaughtException', (e) => { failures++; console.error('uncaught:', e); });

await import(pathToFileURL(path.join(here, '../web/js/app.js')).href);

await waitFor(() => $('rate').children.length > 0, 3000, 'device info');
check($('rate').children.length === 16, 'rate list populated from /api/device');
$('rate').value = '24000000';
check($('device').textContent.includes('simulator'), 'device label shows backend model');
check($('duration').textContent.includes('83.3 ms'), `duration label (${$('duration').textContent})`);
{
  const presets = $('sample-presets');
  const opt = presets.children.find((o) => o.value === '1M');
  check(opt && opt.textContent.includes('41.7 ms'), `sample presets labelled with duration (${opt && opt.textContent})`);
  presets.value = '1M';
  presets.dispatch('change', { target: presets });
  check($('samples').value === '1M' && $('duration').textContent.includes('41.7 ms'), 'preset sets the sample count');
  $('samples').value = '2M';
}

await waitFor(() => $('state').dataset.state !== 'offline', 3000, 'websocket');
check($('state').dataset.state !== 'offline', `websocket connected, state=${$('state').dataset.state}`);

// Trigger: CH7 rising edge
const ch7 = $('channels').children[7];
const trig = ch7.querySelector('.trig');
trig.value = 'R';
trig.dispatch('change');

drawCalls = 0;
$('run').dispatch('click');
// The server may still hold a previous capture, so wait for this one (2M samples).
await waitFor(() => $('state').dataset.state === 'done' && $('empty').hidden &&
                   $('state-detail').textContent.startsWith('2M @'), 8000, 'capture done');
check($('state').dataset.state === 'done', 'capture finished');
check($('empty').hidden, 'empty-state overlay hidden');
check($('state-detail').textContent.startsWith('2M @ 24 MHz'), `status detail (${$('state-detail').textContent})`);
check(!$('export-vcd').classList.contains('disabled'), 'export enabled');
check($('export-vcd').href.startsWith('api/export?fmt=vcd&names=CH0%2CCH1'), `export href (${$('export-vcd').href})`);

await sleep(300);
check(drawCalls > 500, `waveform drawn in summary mode (${drawCalls} draw calls)`);
check($('view-info').textContent.includes('smp/px'), `view info (${$('view-info').textContent})`);

// Jump to the trigger and zoom in until raw samples are shown
document.handlers.keydown.forEach((fn) => fn({ key: 't', target: {}, preventDefault() {} }));
for (let i = 0; i < 20; i++) {
  $('wave').dispatch('wheel', { clientX: 600, clientY: 100, deltaY: -300, deltaX: 0, deltaMode: 0 });
  await sleep(30);
}
await sleep(300);
check($('view-info').textContent.includes('px/smp'), `zoomed to raw samples (${$('view-info').textContent})`);
drawCalls = 0;
await sleep(100);
document.handlers.keydown.forEach((fn) => fn({ key: 'ArrowRight', target: {}, preventDefault() {} }));
await sleep(300);
check(drawCalls > 0, `raw mode redraw after pan (${drawCalls} draw calls)`);

// Fit, then place cursors A and B with clicks
document.handlers.keydown.forEach((fn) => fn({ key: 'f', target: {}, preventDefault() {} }));
await sleep(100);
const click = (x, shiftKey = false) => {
  $('wave').dispatch('pointerdown', { clientX: x, clientY: 100 });
  $('wave').dispatch('pointerup', { clientX: x, clientY: 100, shiftKey });
};
click(300);
click(700, true);
check($('cur-a').textContent !== '–' && $('cur-b').textContent !== '–',
      `cursors placed (A=${$('cur-a').textContent}, B=${$('cur-b').textContent})`);
check(/smp\)$/.test($('cur-dt').textContent), `delta-t readout (${$('cur-dt').textContent})`);
check($('cur-f').textContent.endsWith('Hz'), `1/dt readout (${$('cur-f').textContent})`);

// Drag cursor A
$('wave').dispatch('pointerdown', { clientX: 300, clientY: 100 });
$('wave').dispatch('pointermove', { clientX: 350, clientY: 100 });
$('wave').dispatch('pointerup', { clientX: 350, clientY: 100 });
const a1 = $('cur-a').textContent;
check(a1 !== '–', `cursor A dragged (${a1})`);

// A second capture without trigger replaces the first one
trig.value = 'X';
trig.dispatch('change');
$('samples').value = '500k';
$('run').dispatch('click');
await waitFor(() => $('state-detail').textContent.startsWith('500k'), 8000, 'second capture');
check($('state-detail').textContent.startsWith('500k @ 24 MHz'), `second capture shown (${$('state-detail').textContent})`);
check($('cur-a').textContent === '–', 'cursors cleared on new capture');

// Settings persisted
const saved = JSON.parse(store['webpulse.settings.v1'] || '{}');
check(saved.samples === '500k' && saved.channels && saved.channels.length === 8, 'settings saved to localStorage');

console.log(failures ? `${failures} failure(s)` : 'all web smoke checks passed');
process.exit(failures ? 1 : 0);
