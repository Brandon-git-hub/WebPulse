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
      if (prop === 'measureText') return { width: 7 * String(args[0]).length };
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
    this._text = '';
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
  // Like the DOM: setting textContent replaces the children.
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  appendChild(c) {
    // Like the DOM: appending a node that is already a child moves it.
    const k = this.children.indexOf(c);
    if (k >= 0) this.children.splice(k, 1);
    this.children.push(c);
    return c;
  }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.handlers[type] = (this.handlers[type] || []).filter((f) => f !== fn); }
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
  toBlob(cb, type) { this.blobType = type; cb(new Blob(['png'], { type })); }
  click() { this.clicked = true; document.lastClicked = this; }
  remove() {}
  set innerHTML(v) { this._html = v; }
}

const elements = {};
const document = {
  documentElement: new FakeElement('html'),
  body: new FakeElement('body'),
  getElementById(id) { return (elements[id] ||= new FakeElement(id === 'wave' ? 'canvas' : 'div', id)); },
  createElement(tag) {
    const el = new FakeElement(tag);
    if (tag === 'template') el.content = new FakeElement('fragment');
    return el;
  },
  handlers: {},
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
};
// Input defaults from index.html
document.getElementById('samples').value = '2M';
document.getElementById('channels-pop').hidden = true;
document.getElementById('decoders-pop').hidden = true;
document.getElementById('dec-editor').hidden = true;
document.getElementById('pre').value = '25';
document.getElementById('timeout').value = '5';
document.getElementById('empty').querySelector = () => new FakeElement('p');
document.getElementById('run').dataset.mode = 'run';
document.documentElement.dataset.theme = 'dark';

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
  getComputedStyle: () => ({ getPropertyValue: (v) => `var(${v})` }),
  matchMedia: () => ({ matches: false, addEventListener() {} }),
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
check($('run').dataset.mode === 'run' && !$('run').disabled, 'Run button back to Run after the capture');

// Protocol decoders: add UART (RX defaults to CH0, the simulator's UART line)
{
  await waitFor(() => $('dec-add-sel').children.length > 0, 5000, 'decoder menu');
  const builtin = $('dec-add-sel').children[0].children.map((o) => o.value).join(',');
  check(builtin === 'builtin:uart,builtin:spi,builtin:i2c,builtin:parallel,builtin:counter', `built-in decoders (${builtin})`);
  // The example next to the executable is listed (Node cannot import it over
  // HTTP, so here it shows up as unavailable).
  const user = ($('dec-add-sel').children[1] || { children: [] }).children.map((o) => o.value).join(',');
  check(user === 'user:pwm.js', `user decoders listed (${user})`);
  $('dec-add-sel').value = 'builtin:uart';
  $('dec-add').dispatch('click');
  await waitFor(() => $('dec-labels').children.length === 2 && !/decoding/.test($('dec-labels').children[0].title),
    10000, 'UART decode');
  check($('dec-labels').children.map((e) => e.querySelector('.txt').textContent).join('|') === 'UART · Data|UART · Errors',
    'decoder rows listed');
  check($('decoders-count').textContent === '1', 'decoder count on the button');
  // Hover the data row (below 8 channel rows) where the line sends its message
  // (x = 560 is sample ~233k, inside a burst): a hex byte + ASCII.
  $('wave').dispatch('pointermove', { clientX: 560, clientY: 30 + 8 * 44 + 13 });
  const ann = ($('measure')._html || '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
  check(/^UART · Data [0-9A-F]{2} '.+' \d/.test(ann), `annotation under the pointer (${ann})`);
  const saved = JSON.parse(store['webpulse.settings.v1']).decoders;
  check(saved.length === 1 && saved[0].key === 'builtin:uart' && saved[0].assign.rx === 0, 'decoder saved');

  // Edit: 9600 baud no longer matches the 115200 baud line, so no "Hello".
  $('dec-labels').children[0].dispatch('click');
  const form = $('dec-editor');
  check(!form.hidden && !$('decoders-pop').hidden, 'editor opens from the row label');
  form.querySelector('[data-opt="baud"]').value = '9600';
  form.onsubmit({ preventDefault() {} });
  await waitFor(() => !/decoding/.test($('dec-labels').children[0].title), 10000, 're-decode');
  check(JSON.parse(store['webpulse.settings.v1']).decoders[0].options.baud === 9600, 'option saved as a number');
  form.querySelector('.btns .del').dispatch('click');
  check($('dec-labels').children.length === 0 && $('decoders-count').textContent === '', 'decoder removed');
  $('decoders-btn').dispatch('click');
  $('decoders-btn').dispatch('click');
}

// Channel order: Alt+Down in a name box, dragging a grip, Reset order
{
  const list = $('channels');
  const shown = () => list.children.map((r) => r.dataset.ch).join('');
  const rowOf = (c) => list.children.find((r) => r.dataset.ch === c);
  const nameKey = (c, key) => rowOf(c).querySelector('.name').dispatch('keydown', { key, altKey: true });
  nameKey(0, 'ArrowDown');
  check(shown() === '10234567', `Alt+Down moves CH0 down (${shown()})`);
  nameKey(0, 'ArrowUp');
  check(shown() === '01234567', `Alt+Up moves it back (${shown()})`);
  // Rows are 44 px tall in display order; drop CH7 on the upper half of CH2.
  list.children.forEach((r, k) => { r.getBoundingClientRect = () => ({ top: 30 + k * 44, height: 44 }); });
  const grip = rowOf(7).querySelector('.grip');
  grip.dispatch('pointerdown', { button: 0, target: grip });
  grip.dispatch('pointermove', { clientY: 30 + 2 * 44 + 10 });
  grip.dispatch('pointerup', {});
  check(shown() === '01723456', `drag CH7 above CH2 (${shown()})`);
  check(JSON.parse(store['webpulse.settings.v1']).order.join('') === '01723456', 'order saved');
  $('order-reset').dispatch('click');
  check(shown() === '01234567', `reset order (${shown()})`);
}

// PNG snapshot of the view
{
  check(!$('export-png').disabled, 'PNG export enabled with a capture');
  drawCalls = 0;
  $('export-png').dispatch('click');
  const a = document.lastClicked;
  check(a && /^webpulse-\d{8}-\d{6}\.png$/.test(a.download) && a.href.startsWith('blob:'),
    `PNG download (${a && a.download})`);
  check(drawCalls > 0, 'PNG labels drawn');
}

// Theme: auto -> light -> dark; default colours follow, a picked colour stays
{
  const colorIn = (i) => $('channels').children[i].querySelector('input[type=color]');
  const c1 = colorIn(1);
  c1.value = '#123456';
  c1.dispatch('input');
  c1.dispatch('change');
  $('theme').dispatch('click');
  check(document.documentElement.dataset.theme === 'light' && $('theme-label').textContent === 'Light',
        `theme light (${document.documentElement.dataset.theme})`);
  check(colorIn(0).value === '#8d5a2b' && colorIn(1).value === '#123456',
        `light default colour, custom kept (${colorIn(0).value}, ${colorIn(1).value})`);
  $('theme').dispatch('click');
  check(document.documentElement.dataset.theme === 'dark' && colorIn(0).value === '#c69a6d', 'theme dark');
  const st = JSON.parse(store['webpulse.settings.v1']);
  check(st.channels[0].color === null && st.channels[1].color === '#123456', 'only picked colours saved');
}

// Save as .sr (CH0 "rx", CH1 "tx", only those two) and open it again
{
  const n0 = $('state-detail').textContent;
  const sr = await (await fetch(new URL('api/export?fmt=sr&names=rx,tx&channels=0,1', base))).arrayBuffer();
  check(new Uint8Array(sr)[0] === 0x50 && new Uint8Array(sr)[1] === 0x4b, `.sr is a ZIP (${sr.byteLength} bytes)`);
  $('open-file').files = [new File([sr], 'roundtrip.sr')];
  $('open-file').dispatch('change');
  await waitFor(() => $('state-detail').textContent.includes('opened roundtrip.sr'), 10000, 'opened file');
  check($('state-detail').textContent.startsWith(n0.split(' ·')[0]), `same samples / rate (${$('state-detail').textContent})`);
  const rows = $('channels').children;
  const rowOf = (c) => rows.find((r) => r.dataset.ch === c);
  check(rowOf(0).querySelector('.name').value === 'rx' && rowOf(1).querySelector('.name').value === 'tx',
    'names from the file applied');
  check(!rowOf(0).hidden && !rowOf(1).hidden && rowOf(2).hidden && rowOf(7).hidden, 'channels not in the file hidden');
  const bad = await fetch(new URL('api/open?name=x.sr', base), { method: 'POST', body: 'not a zip' });
  check(bad.status === 422 && /ZIP/.test((await bad.json()).error), 'invalid file rejected');
}

console.log(failures ? `${failures} failure(s)` : 'all web smoke checks passed');
process.exit(failures ? 1 : 0);
