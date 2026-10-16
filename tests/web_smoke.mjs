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
  querySelectorAll(sel) {
    // Only the channel picker uses this: its Enable/Disable buttons.
    if (this.id !== 'channels-pop') return [];
    return (this._all ||= ['enable', 'disable'].flatMap((act) =>
      ['all', 'changing', 'steady', 'named', 'unnamed'].map((s) => {
        const b = new FakeElement('button');
        b.dataset = { act, sel: s };
        return b;
      })));
  }
  contains(el) { return el === this; }
  setAttribute(k, v) { this[k] = v; }
  focus() {}
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
document.getElementById('channels-pop').hidden = true;
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
const DBL_WAIT = 450;   // longer than the UI's double-click window
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

// Channel picker: hide CH2, bulk enable/disable, export only what is shown.
{
  const rows = $('channels').children;
  const picks = $('channels-grid').children;
  const btn = (act, sel) => $('channels-pop').querySelectorAll('button').find((b) => b.dataset.act === act && b.dataset.sel === sel);
  const pick = (i, on) => {
    const cb = picks[i].querySelector('input');
    cb.checked = on;
    cb.dispatch('change');
  };
  const enabled = () => [...rows].map((r) => (r.hidden ? 0 : 1)).join('');
  $('channels-btn').dispatch('click');
  check(!$('channels-pop').hidden, 'channel picker opens');
  check(!btn('enable', 'changing').disabled, 'changing filter available after a capture');
  const h0 = $('wave').height;
  pick(2, false);
  check(rows[2].hidden && $('wave').height < h0 && $('channels-count').textContent === '7/8',
        `CH2 hidden (${h0} -> ${$('wave').height}, ${$('channels-count').textContent})`);
  const href = $('export-csv').href;
  check(href.endsWith('&channels=0,1,3,4,5,6,7'), `export limited to enabled channels (${href})`);
  const csv = await (await fetch(new URL(href, base) + '&changes=1')).text();
  check(csv.startsWith('sample,time_ns,CH0,CH1,CH3,CH4,CH5,CH6,CH7\n'), `server CSV columns (${csv.split('\n')[0]})`);
  const vcd = await (await fetch(new URL($('export-vcd').href, base))).text();
  check(!vcd.includes(' CH2 ') && vcd.includes('$var wire 1 $ CH3 $end'), 'server VCD omits CH2');

  btn('disable', 'all').dispatch('click');
  check(enabled() === '11011111', `disable all refused (${enabled()})`);
  btn('enable', 'all').dispatch('click');
  check(enabled() === '11111111' && $('wave').height === h0 && !$('export-csv').href.includes('channels='), 'enable all');
  // The 2M capture at 24 MHz covers ~83 ms: every simulated channel toggles.
  btn('disable', 'steady').dispatch('click');
  check(enabled() === '11111111', `non-changing disabled (${enabled()})`);
  // All names are still the defaults, so every channel counts as unnamed.
  btn('disable', 'unnamed').dispatch('click');
  check(enabled() === '11111111', 'disable unnamed refused when all are unnamed');
  rows[5].querySelector('.name').value = 'pwm';
  rows[5].querySelector('.name').dispatch('change');
  btn('disable', 'unnamed').dispatch('click');
  check(enabled() === '00000100', `only the named channel left (${enabled()})`);
  btn('disable', 'named').dispatch('click');
  check(enabled() === '00000100', 'cannot disable the last one');
  btn('enable', 'unnamed').dispatch('click');
  check(enabled() === '11111111', 'enable unnamed');
  rows[5].querySelector('.name').value = '';
  rows[5].querySelector('.name').dispatch('change');
  $('channels-btn').dispatch('click');
  check($('channels-pop').hidden, 'channel picker closes');
}

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

// Fit, then place cursors A and B with Shift+left / Shift+right
document.handlers.keydown.forEach((fn) => fn({ key: 'f', target: {}, preventDefault() {} }));
await sleep(100);
const UNITS = { s: 1, ms: 1e-3, 'µs': 1e-6, ns: 1e-9, ps: 1e-12 };
const viewSpan = () => {
  const m = /^view (\S+) (\S+)/.exec($('view-info').textContent);
  return m ? Number(m[1]) * UNITS[m[2]] : NaN;
};
const click = (x, { button = 0, shiftKey = false, ctrlKey = false } = {}) => {
  $('wave').dispatch('pointerdown', { clientX: x, clientY: 100, button, shiftKey, ctrlKey });
  $('wave').dispatch('pointerup', { clientX: x, clientY: 100, button, shiftKey, ctrlKey });
};
const near = (a, b) => Math.abs(a / b - 1) < 0.02;
const span0 = viewSpan();
click(300);
await sleep(DBL_WAIT);
check($('cur-a').textContent === '–' && near(viewSpan(), span0), 'plain click does nothing');
click(300, { shiftKey: true });
click(700, { button: 2, shiftKey: true });
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

// Double-click zoom: left in x2, right out x2, Ctrl x8; Back undoes each step
await sleep(DBL_WAIT);
check($('zoom-back').disabled === false, 'back enabled after fit');
const s1 = viewSpan();
click(600); click(600);
check(near(viewSpan(), s1 / 2), `left double-click zooms in x2 (${s1} -> ${viewSpan()})`);
await sleep(DBL_WAIT);
click(600, { ctrlKey: true }); click(600, { ctrlKey: true });
check(near(viewSpan(), s1 / 16), `ctrl double-click zooms in x8 (${viewSpan()})`);
await sleep(DBL_WAIT);
click(600, { button: 2 }); click(600, { button: 2 });
check(near(viewSpan(), s1 / 8), `right double-click zooms out x2 (${viewSpan()})`);
await sleep(DBL_WAIT);
click(600); await sleep(DBL_WAIT); click(600);
check(near(viewSpan(), s1 / 8), 'two slow clicks do not zoom');
$('zoom-back').dispatch('click');
check(near(viewSpan(), s1 / 16), `back (${viewSpan()})`);
$('zoom-back').dispatch('click');
$('zoom-back').dispatch('click');
check(near(viewSpan(), s1), `back to the start (${viewSpan()})`);

// Toolbar zoom buttons
$('zoom-in').dispatch('click');
check(near(viewSpan(), s1 / 2), 'zoom-in button');
$('zoom-out').dispatch('click');
check(near(viewSpan(), s1), 'zoom-out button');
check(!$('zoom-ab').disabled, 'A<->B enabled with both cursors');
$('zoom-ab').dispatch('click');
const ab = viewSpan();
const dtText = /^(\S+) (\S+)/.exec($('cur-dt').textContent);
const dt = Number(dtText[1]) * UNITS[dtText[2]];
check(near(ab, dt * 1.1), `A<->B shows the cursor span (${ab} vs ${dt})`);
$('zoom-fit').dispatch('click');
check(near(viewSpan(), s1), 'fit button');

// Measurement of the pulse under the pointer: CH5 is a 250 kHz square wave
const rowY = (c) => 30 + c * 44 + 22;
const key = (k, extra = {}) => document.handlers.keydown.forEach((fn) => fn({ key: k, target: {}, preventDefault() {}, ...extra }));
const tA = () => {
  const m = /^(\S+) (\S+)/.exec($('cur-a').textContent);
  return Number(m[1]) * UNITS[m[2]];
};
$('wave').dispatch('pointermove', { clientX: 600, clientY: rowY(5) });
await sleep(150);
const meas = $('measure')._html || '';
check(!$('measure').hidden && meas.includes('Period</span> 4 µs') && meas.includes('Duty</span> 50.0 %') &&
      meas.includes('250 kHz'), `CH5 measured (${meas.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')})`);
check($('channels').children[5].classList.contains('active'), 'hovered channel highlighted');

// Edge stepping moves cursor A by half a period (2 µs) on CH5. With the
// cursors cleared, stepping starts from the centre of the view.
key('Escape');
key(']');
await sleep(100);
const e1 = tA();
key(']');
await sleep(100);
check(Math.abs(tA() - e1 - 2e-6) < 1e-9, `] steps to the next edge (${e1} -> ${tA()})`);
key('[');
await sleep(100);
check(Math.abs(tA() - e1) < 1e-9, `[ steps back (${tA()})`);
for (let i = 0; i < 3; i++) {
  key('}');
  await sleep(100);
}
// B = A + 96 samples. Zoomed to A..B, A is ~54.5 px from the left at ~11.4 px
// per sample, so x = 62 is 0.66 samples right of the edge: within snapping range.
$('zoom-ab').dispatch('click');
await sleep(150);
$('wave').dispatch('pointermove', { clientX: 62, clientY: rowY(5) });
await sleep(150);
// Times are shown to 0.1 µs only, so compare the A-B distance in samples.
const dtSmp = () => Number((/\((\d+) smp\)/.exec($('cur-dt').textContent) || [])[1]);
click(62, { shiftKey: true });
check(dtSmp() === 96, `shift+click snaps to the edge (A-B = ${dtSmp()} smp)`);
$('wave').dispatch('pointerdown', { clientX: 62, clientY: rowY(5), button: 0, shiftKey: true, altKey: true });
$('wave').dispatch('pointerup', { clientX: 62, clientY: rowY(5), button: 0, shiftKey: true, altKey: true });
check(dtSmp() === 95, `alt disables snapping (A-B = ${dtSmp()} smp)`);
$('zoom-fit').dispatch('click');


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
