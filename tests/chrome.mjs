// Headless Chrome driven over the DevTools protocol, with no npm packages.
// Used by tests/browser_check.mjs and tools/docshots.mjs.
//
// Chrome is taken from $CHROME, else `chromium` on PATH.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start Chrome with one page. Returns { send, js, waitFor, screenshot, mouse,
 * click, errors, close }; errors collects script errors from the page.
 */
export async function launch({ width = 1400, height = 900, scale = 1 } = {}) {
  const profile = mkdtempSync(path.join(tmpdir(), 'webpulse-chrome-'));
  const exe = process.env.CHROME || 'chromium';
  const chrome = spawn(exe, [
    '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let err = '';
    chrome.stderr.on('data', (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) resolve(m[1]);
    });
    chrome.on('exit', (c) => reject(new Error(`${exe} exited (${c}): ${err.slice(-400)}`)));
    setTimeout(() => reject(new Error('Chrome did not start')), 15000);
  });
  const http = wsUrl.replace(/^ws:\/\/([^/]+).*/, 'http://$1');
  const target = (await (await fetch(`${http}/json/list`)).json()).find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });

  let nextId = 1;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      errors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  /** Evaluate an expression (may be async) in the page and return its value. */
  async function js(expr) {
    const r = await send('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  /** Poll until expr is truthy; false after ms. */
  async function waitFor(expr, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        if (await js(expr)) return true;
      } catch { /* page not there yet */ }
      await sleep(100);
    }
    return false;
  }
  /** PNG of the viewport (or of clip = { x, y, width, height }) as a Buffer. */
  async function screenshot(clip) {
    const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip: { ...clip, scale: 1 } } : { format: 'png' });
    return Buffer.from(r.data, 'base64');
  }
  const mouse = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  async function click(x, y, { button = 'left', count = 1, modifiers = 0 } = {}) {
    for (let c = 1; c <= count; c++) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: c, modifiers });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: c, modifiers });
    }
  }
  async function close() {
    ws.close();
    chrome.kill();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  return { send, js, waitFor, screenshot, mouse, click, errors, close };
}
