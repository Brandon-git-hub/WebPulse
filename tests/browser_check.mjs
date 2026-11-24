// Checks the UI in a real (headless) Chrome against a running simulator,
// through the DevTools protocol (no npm packages needed):
//
//   ./build/linux/webpulse -b sim -p 18080 &
//   node tests/browser_check.mjs http://127.0.0.1:18080/ [screenshot-dir]
//
// Chrome is taken from $CHROME, else `chromium` on PATH (see chrome.mjs).
// Unlike web_smoke.mjs this applies the real CSS and runs decoders in a Web
// Worker. It checks that the side list lines up with the canvas rows, that a
// decoder decodes, that there are no script errors, and saves screenshots.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launch, sleep } from './chrome.mjs';

const base = process.argv[2] || 'http://127.0.0.1:18080/';
const shots = process.argv[3] || null;
const RULER_H = 30, ROW_H = 44, DEC_ROW_H = 26;

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error('FAIL:', msg); } else console.log('ok  ', msg);
}

try {
  await fetch(new URL('api/device', base));
} catch (e) {
  console.error(`browser_check: cannot reach ${base} (${e.cause?.code || e.message}); is webpulse -b sim running?`);
  process.exit(2);
}

// ---- Chrome ------------------------------------------------------------------

const browser = await launch({ width: 1400, height: 900 });
const { send, js, mouse, errors } = browser;
async function waitFor(expr, ms, what) {
  if (await browser.waitFor(expr, ms)) return true;
  check(false, `timeout waiting for ${what}`);
  return false;
}
async function shot(name) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  writeFileSync(path.join(shots, name), await browser.screenshot());
}

// The side list (channel rows, then decoder labels) must line up with the
// canvas rows, which start below the ruler.
const ALIGN = `(() => {
  const cv = document.getElementById('wave').getBoundingClientRect();
  const rows = [...document.querySelectorAll('#ch-rows .ch')].filter((r) => r.offsetParent);
  const decs = [...document.querySelectorAll('#dec-labels .dec-label')];
  return {
    canvasH: cv.height,
    ch: rows.map((r) => [Math.round(r.getBoundingClientRect().top - cv.top), Math.round(r.getBoundingClientRect().height)]),
    dec: decs.map((r) => [Math.round(r.getBoundingClientRect().top - cv.top), Math.round(r.getBoundingClientRect().height)]),
  };
})()`;
function checkAlign(a, what) {
  const chOk = a.ch.every(([t, h], k) => Math.abs(t - (RULER_H + k * ROW_H)) <= 1 && Math.abs(h - ROW_H) <= 1);
  const top0 = RULER_H + a.ch.length * ROW_H;
  const decOk = a.dec.every(([t, h], k) => Math.abs(t - (top0 + k * DEC_ROW_H)) <= 1 && Math.abs(h - DEC_ROW_H) <= 1);
  const hOk = Math.abs(a.canvasH - (top0 + a.dec.length * DEC_ROW_H)) <= 1;
  check(chOk && decOk && hOk, `${what}: list lines up with the canvas (${JSON.stringify(a)})`);
}

try {
  await send('Page.navigate', { url: base });
  await waitFor(`document.getElementById('state').dataset.state !== 'offline'`, 10000, 'WebSocket');
  await js(`localStorage.clear()`);
  await send('Page.reload');
  await waitFor(`document.getElementById('state').dataset.state !== 'offline' && document.getElementById('rate').options.length > 0`, 10000, 'page ready');

  await js(`(() => { document.getElementById('samples').value = '2M'; document.getElementById('run').click(); })()`);
  await waitFor(`document.getElementById('state').dataset.state === 'done'`, 15000, 'capture');
  checkAlign(await js(ALIGN), 'after capture');

  // Hidden channel and reordering keep the alignment.
  await js(`document.getElementById('channels-btn').click()`);
  await js(`document.querySelectorAll('#channels-grid input')[3].click()`);
  await js(`document.getElementById('channels-btn').click()`);
  checkAlign(await js(ALIGN), 'CH3 hidden');

  // Add UART and SPI decoders from the docked list; they run in a Web Worker here.
  await js(`document.getElementById('decoders-btn').click()`);
  await waitFor(`document.querySelectorAll('#dec-catalog .dec-entry').length > 0`, 5000, 'decoder list');
  const userDec = await js(`[...document.querySelectorAll('#dec-catalog .dec-entry')].map((e) => e.dataset.key + (e.classList.contains('bad') ? '!' : '')).join(',')`);
  check(userDec.includes('user:pwm.js') && !userDec.includes('pwm.js!'), `user decoder loads in the browser (${userDec})`);
  check(await js(`document.activeElement === document.getElementById('dec-search')`), 'search box focused');
  // Double-click an entry, as in PulseView.
  const entry = await js(`(() => { const r = document.querySelector('#dec-catalog [data-key="builtin:uart"]').getBoundingClientRect(); return { x: r.left + 20, y: r.top + 8 }; })()`);
  for (const clickCount of [1, 2]) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: entry.x, y: entry.y, button: 'left', clickCount });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: entry.x, y: entry.y, button: 'left', clickCount });
  }
  await waitFor(`[...document.querySelectorAll('#dec-labels .dec-label')].length === 2 &&
    !document.querySelector('#dec-labels .dec-label').title.startsWith('decoding')`, 15000, 'UART decode in a worker');
  checkAlign(await js(ALIGN), 'with a decoder');
  // Name CH1..3 like the simulator's SPI lines: adding SPI picks them by name.
  await js(`(() => {
    const rows = [...document.querySelectorAll('#ch-rows .ch')];
    const named = { 1: 'SCLK', 2: 'MOSI', 3: 'CS' };
    for (const r of rows) {
      const c = Number(r.dataset.ch);
      if (named[c]) { const n = r.querySelector('.name'); n.value = named[c]; n.dispatchEvent(new Event('change')); }
    }
  })()`);
  // Search and Enter.
  await js(`(() => { const s = document.getElementById('dec-search'); s.focus(); s.value = 'spi'; s.dispatchEvent(new Event('input')); })()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await waitFor(`[...document.querySelectorAll('#dec-labels .dec-label')].length === 4 &&
    !document.querySelectorAll('#dec-labels .dec-label')[2].title.startsWith('decoding')`, 15000, 'SPI rows');
  const spi = await js(`JSON.stringify(JSON.parse(localStorage.getItem('webpulse.settings.v1')).decoders[1].assign)`);
  check(spi === '{"clk":1,"mosi":2,"miso":null,"cs":3}', `SPI channels picked by name (${spi})`);
  check(!(await js(`document.querySelectorAll('#dec-labels .dec-label')[2].classList.contains('err')`)), 'SPI decodes without error');
  checkAlign(await js(ALIGN), 'with two decoders and the list open');
  await shot('decoder-list.png');
  await js(`document.getElementById('decoders-btn').click()`);
  checkAlign(await js(ALIGN), 'list closed again');

  // Hover the UART data row inside a burst: the status bar shows the byte.
  const cv = await js(`(() => { const r = document.getElementById('wave').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; })()`);
  const a = await js(ALIGN);
  const decTop = a.dec[0][0];
  let ann = '';
  for (const fx of [0.47, 0.30, 0.62, 0.15, 0.80]) {
    await mouse(cv.x + cv.w * fx, cv.y + decTop + DEC_ROW_H / 2);
    await sleep(150);
    ann = await js(`document.getElementById('measure').hidden ? '' : document.getElementById('measure').textContent`);
    if (/[0-9A-F]{2} '/.test(ann)) break;
  }
  check(/^UART.*[0-9A-F]{2} '/.test(ann), `annotation under the pointer (${ann})`);
  await shot('light-decoders.png');

  // Zoom into the start of an SPI burst (2 us in, 8 bytes of 8 us each).
  await js(`(() => { document.getElementById('zoom-fit').click(); })()`);
  for (let i = 0; i < 9; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cv.x + 2, y: cv.y + 100, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cv.x + 2, y: cv.y + 100, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cv.x + 2, y: cv.y + 100, button: 'left', clickCount: 2 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cv.x + 2, y: cv.y + 100, button: 'left', clickCount: 2 });
    await sleep(60);
  }
  await sleep(300);
  await mouse(cv.x + cv.w * 0.5, cv.y + a.dec[2][0] + DEC_ROW_H / 2 + 26);
  await sleep(300);
  await shot('light-zoomed.png');

  // Explicit themes: auto -> light -> dark
  await js(`(() => { document.getElementById('theme').click(); })()`);
  await sleep(200);
  check(await js(`document.documentElement.dataset.theme`) === 'light', 'light theme');
  await js(`(() => { document.getElementById('theme').click(); })()`);
  await sleep(200);
  check(await js(`document.documentElement.dataset.theme`) === 'dark', 'dark theme');
  checkAlign(await js(ALIGN), 'dark theme');
  await shot('dark-zoomed.png');

  // Decoder settings open beside the label, inside the window; a change
  // applies at once.
  await js(`document.querySelector('#dec-labels .dec-label').click()`);
  await sleep(200);
  const pop = await js(`(() => { const p = document.getElementById('dec-pop').getBoundingClientRect(),
    l = document.querySelector('#dec-labels .dec-label').getBoundingClientRect();
    return [p.left, p.top, p.right, p.bottom, innerWidth, innerHeight, l.right]; })()`);
  check(!(await js(`document.getElementById('dec-pop').hidden`)) && pop[0] >= pop[6] && pop[2] <= pop[4] &&
    pop[1] >= 0 && pop[3] <= pop[5], `decoder settings beside the label, inside the window (${pop})`);
  await shot('dark-decoder-settings.png');
  await js(`(() => { const s = document.getElementById('dec-o-format'); s.value = 'ascii'; s.dispatchEvent(new Event('change')); })()`);
  await waitFor(`JSON.parse(localStorage.getItem('webpulse.settings.v1')).decoders[0].options.format === 'ascii'`, 3000, 'option applied');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  check(await js(`document.getElementById('dec-pop').hidden`), 'Esc closes the decoder settings');

  check(errors.length === 0, `no script errors (${errors.join(' | ')})`);
} catch (e) {
  check(false, `exception: ${e.stack || e}`);
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failure(s)` : 'all browser checks passed');
process.exit(failures ? 1 : 0);
