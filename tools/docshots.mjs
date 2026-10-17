// Screenshots and the animated demo for the README, taken in headless Chrome
// from the simulator, so they can be regenerated after UI changes:
//
//   ./build/linux/webpulse -b sim -p 18080 -d decoders &
//   node tools/docshots.mjs http://127.0.0.1:18080/ docs/images
//
// (-d decoders keeps a machine-specific path out of the decoder panel.)
//
// Writes overview-dark.png, overview-light.png, decoder-editor.png,
// channels.png and demo.png (an animated PNG, which GitHub plays inline).

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launch, sleep } from '../tests/chrome.mjs';

const base = process.argv[2] || 'http://127.0.0.1:18080/';
const out = process.argv[3] || 'docs/images';
const W = 1280, H = 760;
const RATE = 24e6, SAMPLES = 2e6;
mkdirSync(out, { recursive: true });

const b = await launch({ width: W, height: H });
const { js, send } = b;
const frames = [];
const save = async (name, clip) => {
  writeFileSync(path.join(out, name), await b.screenshot(clip));
  console.log('wrote', path.join(out, name));
};
const frame = async (delayMs) => frames.push({ png: await b.screenshot(), delayMs });
const el = (sel) => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
const ui = (code) => js(`(() => { ${code} })()`);
const idle = () => b.waitFor(`![...document.querySelectorAll('#dec-labels .dec-label')].some((e) => e.title.startsWith('decoding'))`, 15000);

try {
  await send('Page.navigate', { url: base });
  await b.waitFor(`document.getElementById('state') && document.getElementById('state').dataset.state !== 'offline'`, 10000);
  await js(`localStorage.clear()`);
  await js(`localStorage.setItem('webpulse.theme', 'dark')`);
  await send('Page.reload');
  await b.waitFor(`document.getElementById('state').dataset.state !== 'offline' && document.getElementById('rate').options.length > 0`, 10000);

  // Name the simulator's lines, capture 2M samples at 24 MHz.
  await ui(`
    const names = ['UART TX', 'SCLK', 'MOSI', 'CS', 'PWM', 'CLK 250k', 'NOISE', 'IRQ'];
    for (const r of document.querySelectorAll('#ch-rows .ch')) {
      const n = r.querySelector('.name');
      n.value = names[Number(r.dataset.ch)];
      n.dispatchEvent(new Event('change'));
    }
    document.getElementById('samples').value = '2M';
    document.getElementById('run').click();`);
  await b.waitFor(`document.getElementById('state').dataset.state === 'done'`, 15000);
  await sleep(500);
  await frame(1500);

  // UART and SPI decoders (channels are picked by name).
  for (const key of ['builtin:uart', 'builtin:spi']) {
    await ui(`document.getElementById('decoders-pop').hidden || document.getElementById('decoders-btn').click();`);
    await b.waitFor(`document.getElementById('dec-add-sel').options.length > 0`, 5000);
    await ui(`const s = document.getElementById('dec-add-sel'); s.value = '${key}'; document.getElementById('dec-add').click();`);
  }
  await ui(`document.getElementById('decoders-btn').click();`);   // close the panel
  await idle();
  await sleep(400);
  await frame(1500);

  // Zoom in around the start of the second UART message (sample 42000):
  // at "fit" the view spans SAMPLES * 1.05, centred.
  const cv = await el('#wave');
  const spp0 = (SAMPLES * 1.05) / cv.width;
  const start0 = (SAMPLES - cv.width * spp0) / 2;
  const x = cv.x + (42000 - start0) / spp0;
  const y = cv.y + 200;
  for (const [mods, n] of [[2, 1], [2, 1], [0, 2]]) {      // Ctrl = x8, else x2
    for (let i = 0; i < n; i++) {
      await b.click(x, y, { count: 2, modifiers: mods });
      await sleep(350);
      await frame(700);
    }
  }
  // Drag the view so the UART message starts a little in from the left.
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  for (let k = 1; k <= 8; k++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (40 - (x - cv.x)) * (k / 8), y, buttons: 1 });
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + (40 - (x - cv.x)), y, button: 'left', clickCount: 1 });
  await idle();
  await sleep(400);
  await frame(1200);

  // Cursors A / B on the first SPI burst in view (they snap to its edges),
  // then hover the PWM row for the live measurement.
  const rowY = (k) => cv.y + 30 + k * 44 + 22;
  const view = await js(`document.getElementById('view-info').textContent`);
  const spanMs = parseFloat(/view ([\d.]+) µs/.exec(view)?.[1] || '330') / 1000;
  // SPI bursts start at 2 us into each 100 us period and last 64 us.
  const viewStartUs = 42000 / 24 - (40 / cv.width) * spanMs * 1000;
  const firstBurstUs = Math.ceil((viewStartUs - 2) / 100) * 100 + 2;
  const pxOf = (us) => cv.x + ((us - viewStartUs) / (spanMs * 1000)) * cv.width;
  await b.mouse(pxOf(firstBurstUs) + 1, rowY(3));
  await sleep(200);
  await b.click(pxOf(firstBurstUs) + 1, rowY(3), { modifiers: 8 });            // Shift
  await b.mouse(pxOf(firstBurstUs + 64.5) + 1, rowY(3));
  await sleep(200);
  await b.click(pxOf(firstBurstUs + 64.5) + 1, rowY(3), { button: 'right', modifiers: 8 });
  await sleep(200);
  await frame(1000);
  await b.mouse(pxOf(firstBurstUs + 150), rowY(4));
  await sleep(500);
  await frame(2500);
  await save('overview-dark.png');

  await ui(`document.getElementById('theme').click();`);   // dark -> auto (light in headless)
  await sleep(150);
  if (await js(`document.documentElement.dataset.theme`) !== 'light') {
    await ui(`document.getElementById('theme').click();`);
  }
  await sleep(300);
  await b.mouse(pxOf(firstBurstUs + 150), rowY(4));
  await sleep(400);
  await frame(2500);
  await save('overview-light.png');

  // The decoder editor and the channel picker, cropped.
  await ui(`document.querySelector('#dec-labels .dec-label').click();`);
  await sleep(300);
  const pop = await el('#decoders-pop');
  await save('decoder-editor.png', { x: pop.x - 12, y: 0, width: pop.width + 24, height: pop.y + pop.height + 12 });
  await ui(`document.getElementById('decoders-btn').click(); document.getElementById('channels-btn').click();`);
  await sleep(300);
  const ch = await el('#channels-pop');
  await save('channels.png', { x: Math.max(0, ch.x - 12), y: 0, width: ch.width + 24, height: ch.y + ch.height + 12 });

  writeFileSync(path.join(out, 'demo.png'), apng(frames));
  console.log('wrote', path.join(out, 'demo.png'), `(${frames.length} frames)`);
  if (b.errors.length) console.error('page errors:', b.errors);
} finally {
  await b.close();
}

// ---- animated PNG from same-sized PNG frames -----------------------------------
// Frame data is reused as is: each frame's IDAT chunks become the frame's
// IDAT (first frame) or fdAT chunks, with an fcTL in front.

function apng(list) {
  const chunks = (buf) => {
    const out = [];
    for (let p = 8; p < buf.length;) {
      const len = buf.readUInt32BE(p);
      out.push({ type: buf.toString('latin1', p + 4, p + 8), data: buf.subarray(p + 8, p + 8 + len) });
      p += 12 + len;
    }
    return out;
  };
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const v of buf) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const parsed = list.map((f) => chunks(f.png));
  const ihdr = parsed[0].find((c) => c.type === 'IHDR').data;
  for (const p of parsed) {
    if (!p.find((c) => c.type === 'IHDR').data.equals(ihdr)) throw new Error('frames differ in size or format');
  }
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(list.length, 0);
  actl.writeUInt32BE(0, 4);                       // loop forever
  parts.push(chunk('acTL', actl));
  let seq = 0;
  parsed.forEach((p, i) => {
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(seq++, 0);
    fctl.writeUInt32BE(ihdr.readUInt32BE(0), 4);  // width
    fctl.writeUInt32BE(ihdr.readUInt32BE(4), 8);  // height
    fctl.writeUInt32BE(0, 12);
    fctl.writeUInt32BE(0, 16);
    fctl.writeUInt16BE(list[i].delayMs, 20);
    fctl.writeUInt16BE(1000, 22);
    fctl[24] = 0;                                 // dispose: none
    fctl[25] = 0;                                 // blend: source
    parts.push(chunk('fcTL', fctl));
    for (const c of p.filter((c) => c.type === 'IDAT')) {
      if (i === 0) {
        parts.push(chunk('IDAT', c.data));
      } else {
        const s = Buffer.alloc(4);
        s.writeUInt32BE(seq++, 0);
        parts.push(chunk('fdAT', Buffer.concat([s, c.data])));
      }
    }
  });
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
