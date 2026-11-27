// Unit tests for the decoder runtime and the built-in decoders, on waveforms
// generated here (no server needed):  node tests/decoders_test.mjs

import { runDecoder } from '../web/js/decode/runtime.js';
import { crc32, exportAnnotations } from '../web/js/decode/export.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import uart from '../web/decoders/uart.js';
import spi from '../web/decoders/spi.js';
import i2c from '../web/decoders/i2c.js';
import parallel from '../web/decoders/parallel.js';
import counter from '../web/decoders/counter.js';
import pwm from '../decoders/pwm.js';

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error('FAIL:', msg); } else console.log('ok  ', msg);
}

/** Builds a sample array by appending runs of a given byte. */
class Wave {
  constructor() { this.parts = []; this.n = 0; this.cur = 0; }
  set(bitmask, on) { this.cur = on ? this.cur | bitmask : this.cur & ~bitmask; return this; }
  hold(samples) { this.parts.push([this.cur, Math.round(samples)]); this.n += Math.round(samples); return this; }
  samples() {
    const a = new Uint8Array(this.n);
    let i = 0;
    for (const [v, len] of this.parts) { a.fill(v, i, i + len); i += len; }
    return a;
  }
}

/** Same format as /api/transitions: positions where the masked bits change. */
function transitions(samples, mask) {
  const pos = [0], val = [samples[0]];
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i] ^ samples[i - 1]) & mask) { pos.push(i); val.push(samples[i]); }
  }
  return { pos: Float64Array.from(pos), val: Uint8Array.from(val), n: samples.length };
}

function run(dec, opt, assign, samples, rate) {
  const mask = Object.values(assign).reduce((m, c) => m | (1 << c), 0);
  const o = Object.fromEntries((dec.options || []).map((x) => [x.id, x.default]));
  return runDecoder(dec, { ...o, ...opt }, assign, transitions(samples, mask), rate);
}
const texts = (r, row) => r.rows[row].text.map((t) => t[t.length - 1]);

// ---- UART ------------------------------------------------------------------------
{
  const rate = 1e6, baud = 9600, bit = rate / baud;
  const w = new Wave().set(1, 1).hold(500);
  const frame = (v, { parity = null, stop = 1 } = {}) => {
    w.set(1, 0).hold(bit);
    let ones = 0;
    for (let i = 0; i < 8; i++) { const b = (v >> i) & 1; ones += b; w.set(1, b).hold(bit); }
    if (parity) w.set(1, parity === 'even' ? ones % 2 : 1 - (ones % 2)).hold(bit);
    w.set(1, stop).hold(bit);
    w.set(1, 1).hold(bit * 2);
  };
  for (const c of 'Hi!') frame(c.charCodeAt(0));
  const r = run(uart, { baud, format: 'ascii' }, { rx: 0 }, w.samples(), rate);
  check(!r.error && texts(r, 'data').join('') === 'Hi!', `UART 8N1 "${texts(r, 'data').join('')}" ${r.error || ''}`);
  check(r.rows.error.start.length === 0, 'UART no errors');
  const s0 = r.rows.data.start[0], e0 = r.rows.data.end[0];
  check(s0 === 500 && Math.abs(e0 - (500 + 10 * bit)) <= 1, `UART frame spans start..stop (${s0}..${e0})`);

  const w2 = new Wave().set(1, 1).hold(500);
  w.parts = w2.parts; w.n = w2.n; w.cur = 1;
  frame(0x41, { parity: 'even' });
  frame(0x42, { parity: 'odd' });      // wrong parity for "even"
  frame(0x43, { parity: 'even', stop: 0 });
  w.set(1, 1).hold(bit * 3);
  const p = run(uart, { baud, parity: 'even' }, { rx: 0 }, w.samples(), rate);
  check(texts(p, 'data').join(' ') === '41 42 43', `UART 8E1 data (${texts(p, 'data').join(' ')})`);
  check(texts(p, 'error').join(' ') === 'P F', `UART parity + framing errors (${texts(p, 'error').join(' ')})`);

  // Capture starting inside a frame: skipped until the line has been idle.
  const mid = new Wave().set(1, 0).hold(bit * 3);           // tail of an unknown frame
  for (const b of [1, 0, 1, 1, 0]) mid.set(1, b).hold(bit);
  mid.set(1, 1).hold(bit * 12);
  w.parts = mid.parts; w.n = mid.n; w.cur = 1;
  frame(0x4f);
  const m = run(uart, { baud }, { rx: 0 }, w.samples(), rate);
  check(texts(m, 'data').join(' ') === '4F' && !m.rows.error.start.length,
    `UART resyncs after starting mid-frame (${texts(m, 'data').join(' ')})`);

  const slow = run(uart, { baud: 400000 }, { rx: 0 }, w.samples(), rate);
  check(/too slow/.test(slow.error || ''), 'UART rejects < 4 samples per bit');
}

// ---- SPI -------------------------------------------------------------------------
for (const mode of [0, 1, 2, 3]) {
  const cpol = mode >> 1, cpha = mode & 1;
  const CLK = 1, MOSI = 2, MISO = 4, CS = 8;
  const w = new Wave().set(CLK, cpol).set(CS, 1).hold(20).set(CS, 0).hold(5);
  const bytes = [[0xa5, 0x3c], [0x01, 0xfe]];
  for (const [mo, mi] of bytes) {
    for (let i = 7; i >= 0; i--) {
      // CPHA 0: data valid before the leading edge; CPHA 1: changes on it.
      if (!cpha) w.set(MOSI, (mo >> i) & 1).set(MISO, (mi >> i) & 1);
      w.hold(5).set(CLK, 1 - cpol);
      if (cpha) w.set(MOSI, (mo >> i) & 1).set(MISO, (mi >> i) & 1);
      w.hold(5).set(CLK, cpol);
    }
  }
  w.hold(5).set(CS, 1).hold(20);
  const r = run(spi, { cpol, cpha }, { clk: 0, mosi: 1, miso: 2, cs: 3 }, w.samples(), 1e6);
  check(!r.error && texts(r, 'mosi').join(' ') === 'A5 01' && texts(r, 'miso').join(' ') === '3C FE',
    `SPI mode ${mode}: MOSI ${texts(r, 'mosi').join(' ')}, MISO ${texts(r, 'miso').join(' ')} ${r.error || ''}`);
}
{
  // A partial word is dropped when CS ends the frame; no CS: words by count.
  const CLK = 1, MOSI = 2, CS = 8;
  const w = new Wave().set(CS, 1).hold(10).set(CS, 0).hold(2);
  for (let i = 0; i < 3; i++) w.set(MOSI, 1).hold(2).set(CLK, 1).hold(2).set(CLK, 0);
  w.hold(2).set(CS, 1).hold(4).set(CS, 0).hold(2);
  for (let i = 7; i >= 0; i--) w.set(MOSI, (0x81 >> i) & 1).hold(2).set(CLK, 1).hold(2).set(CLK, 0);
  w.hold(2).set(CS, 1).hold(10);
  const r = run(spi, {}, { clk: 0, mosi: 1, cs: 3 }, w.samples(), 1e6);
  check(texts(r, 'mosi').join(' ') === '81', `SPI CS resets a partial word (${texts(r, 'mosi').join(' ')})`);
  const nocs = run(spi, { wordsize: 4 }, { clk: 0, mosi: 1 }, w.samples(), 1e6);
  // Without CS all 11 clocks count: 1111 0000 (001 left over, not a full word).
  check(texts(nocs, 'mosi').join(' ') === 'F 0', `SPI without CS, 4-bit words (${texts(nocs, 'mosi').join(' ')})`);
  check(/MOSI and\/or MISO/.test(run(spi, {}, { clk: 0 }, w.samples(), 1e6).error || ''), 'SPI needs a data line');
}

// ---- I2C -------------------------------------------------------------------------
{
  const SCL = 1, SDA = 2, q = 5;    // quarter bit
  const w = new Wave().set(SCL, 1).set(SDA, 1).hold(20);
  const start = () => w.set(SDA, 1).hold(q).set(SCL, 1).hold(q).set(SDA, 0).hold(q).set(SCL, 0).hold(q);
  const stop = () => w.set(SDA, 0).hold(q).set(SCL, 1).hold(q).set(SDA, 1).hold(q * 2);
  const bitOut = (b) => w.set(SDA, b).hold(q).set(SCL, 1).hold(q * 2).set(SCL, 0).hold(q);
  const byte = (v, ack) => { for (let i = 7; i >= 0; i--) bitOut((v >> i) & 1); bitOut(ack ? 0 : 1); };
  start(); byte(0x50 << 1, true); byte(0xa5, true);
  start(); byte((0x50 << 1) | 1, true); byte(0x3c, false); stop();
  const r = run(i2c, {}, { scl: 0, sda: 1 }, w.samples(), 1e6);
  const data = r.rows.data.text.map((t) => t[0]).join(' | ');
  check(!r.error && data === 'Address write: 50 | Data write: A5 | Address read: 50 | Data read: 3C',
    `I2C frames (${data}) ${r.error || ''}`);
  check(texts(r, 'ack').join(' ') === 'S A A Sr A N P', `I2C start/ack/stop (${texts(r, 'ack').join(' ')})`);
  const r8 = run(i2c, { address: '8-bit (incl. R/W)' }, { scl: 0, sda: 1 }, w.samples(), 1e6);
  check(r8.rows.data.text[0][0] === 'Address write: A0', `I2C 8-bit address (${r8.rows.data.text[0][0]})`);
}

// ---- Parallel ----------------------------------------------------------------------
{
  const w = new Wave();
  const vals = [0x3, 0xa, 0x5, 0xf];
  for (const v of vals) w.set(0x0f, 0).set(v, 1).hold(1).set(0x10, 1).hold(4).set(0x10, 0).hold(5);
  const s = w.samples();
  const clk = run(parallel, {}, { clk: 4, d0: 0, d1: 1, d2: 2, d3: 3 }, s, 1e6);
  check(texts(clk, 'word').join(' ') === '3 A 5 F', `Parallel clocked (${texts(clk, 'word').join(' ')})`);
  check(clk.rows.word.end.at(-1) === s.length, 'Parallel last value runs to the end');
  const free = run(parallel, { format: 'bin' }, { d0: 0, d1: 1 }, s, 1e6);
  check(texts(free, 'word').join(' ') === '11 10 01 11', `Parallel unclocked, 2 lines (${texts(free, 'word').join(' ')})`);
}

// ---- Counter -----------------------------------------------------------------------
{
  const w = new Wave().hold(5);
  for (let i = 0; i < 5; i++) w.set(1, 1).hold(3).set(1, 0).hold(3);
  w.set(2, 1).hold(2).set(2, 0).hold(2);
  for (let i = 0; i < 2; i++) w.set(1, 1).hold(3).set(1, 0).hold(3);
  const s = w.samples();
  const r = run(counter, {}, { data: 0, reset: 1 }, s, 1e6);
  check(texts(r, 'count').join(' ') === '1 2 3 4 5 1 2', `Counter rising with reset (${texts(r, 'count').join(' ')})`);
  check(texts(r, 'reset').length === 1, 'Counter reset marked');
  const both = run(counter, { edge: 'both', start: 0 }, { data: 0 }, s, 1e6);
  check(texts(both, 'count').length === 14 && texts(both, 'count')[0] === '0', 'Counter both edges from 0');
}

// ---- example user decoder (decoders/pwm.js) -----------------------------------------
{
  const w = new Wave().hold(7);
  for (const high of [25, 50, 75]) w.set(1, 1).hold(high).set(1, 0).hold(100 - high);
  w.set(1, 1).hold(10);
  const r = run(pwm, {}, { pwm: 0 }, w.samples(), 1e6);
  check(r.rows.duty.text.map((t) => t[0]).join(' | ') === '25.0 % · 10.000 kHz | 50.0 % · 10.000 kHz | 75.0 % · 10.000 kHz',
    `PWM example (${r.rows.duty.text.map((t) => t[0]).join(' | ')})`);
  check(r.summary.join() === '3 periods, duty 25.0 … 75.0 %', `PWM example summary (${r.summary.join()})`);
}

// ---- runtime errors -----------------------------------------------------------------
{
  const s = new Wave().set(1, 1).hold(10).samples();
  const bad = { rows: [{ id: 'x' }], *decode(d) { yield d.wait({ nope: 'r' }); } };
  check(/not assigned/.test(runDecoder(bad, {}, { a: 0 }, transitions(s, 1), 1e6).error || ''), 'unassigned channel reported');
  const thrower = { rows: [{ id: 'x' }], *decode(d) { d.put(0, 1, 'x', 'a'); throw new Error('boom'); } };
  const t = runDecoder(thrower, {}, { a: 0 }, transitions(s, 1), 1e6);
  check(/boom/.test(t.error) && t.rows.x.start.length === 1, 'decoder exception keeps earlier annotations');
  check(/^boom \(decoders_test\.mjs:\d+\)$/.test(t.error), `error shown as message and location (${t.error})`);
}

// ---- runtime helpers ------------------------------------------------------------------
{
  const s = new Wave().set(1, 0).hold(10).set(1, 1).hold(10).set(1, 0).hold(10).samples();
  const tr1 = () => transitions(s, 1);

  // finally: an error there is reported, and annotations put there are kept.
  const fin = { rows: [{ id: 'x' }], *decode(d) {
    try { for (;;) yield d.wait({ a: 'e' }); } finally { d.put(0, 1, 'x', 'end'); throw new Error('flush failed'); }
  } };
  const f = runDecoder(fin, {}, { a: 0 }, tr1(), 1e6);
  check(/^flush failed \(decoders_test\.mjs:\d+\)$/.test(f.error || '') && f.rows.x.start.length === 1,
    `error in finally reported (${f.error})`);
  const yielder = { rows: [{ id: 'x' }], *decode(d) { try { for (;;) yield d.wait({ a: 'e' }); } finally { yield d.wait({ a: 'e' }); } } };
  check(/must not yield/.test(runDecoder(yielder, {}, { a: 0 }, tr1(), 1e6).error || ''), 'yield in finally reported');

  // Annotations put out of order come back sorted by start (then end).
  const unsorted = { rows: [{ id: 'x' }], *decode(d) {
    d.put(20, 25, 'x', 'c'); d.put(5, 9, 'x', 'b'); d.put(5, 6, 'x', 'a'); d.put(20, 25, 'x', 'd');
  } };
  const u = runDecoder(unsorted, {}, { a: 0 }, tr1(), 1e6);
  check(texts(u, 'x').join('') === 'abcd' && u.rows.x.start.join(',') === '5,5,20,20', `rows sorted (${texts(u, 'x').join('')})`);

  // d.prev: the level just before the current sample.
  const seen = [];
  const prev = { rows: [{ id: 'x' }], *decode(d) {
    for (;;) { yield d.wait({ a: 'e' }); seen.push(`${d.prev.a}${d.pins.a}`); }
  } };
  runDecoder(prev, {}, { a: 0 }, tr1(), 1e6);
  check(seen.join(' ') === '01 10', `d.prev before each edge (${seen.join(' ')})`);
  const skipSeen = [];
  const prevSkip = { rows: [{ id: 'x' }], *decode(d) {
    yield d.until(15); skipSeen.push(`${d.prev.a}${d.pins.a}`);
    yield d.until(20); skipSeen.push(`${d.prev.a}${d.pins.a}`);
  } };
  runDecoder(prevSkip, {}, { a: 0 }, tr1(), 1e6);
  check(skipSeen.join(' ') === '11 10', `d.prev away from and at an edge (${skipSeen.join(' ')})`);

  // d.us / d.ms, d.summary, option normalisation.
  let got = null;
  const misc = { rows: [{ id: 'x' }],
    options: [{ id: 'gap', default: 300 }, { id: 'mode', default: 'a' }, { id: 'missing', default: 7 }],
    *decode(d, o) {
      got = { us: d.us(12), ms: d.ms(6000), o };
      d.summary('PASS one\nFAIL two');
      d.summary('three');
    } };
  const m = runDecoder(misc, { gap: '250', mode: '5' }, { a: 0 }, tr1(), 12e6);
  check(got.us === 1 && got.ms === 0.5, `d.us / d.ms (${got.us}, ${got.ms})`);
  check(got.o.gap === 250 && got.o.mode === '5' && got.o.missing === 7,
    `options: numbers for number defaults, defaults filled in (${JSON.stringify(got.o)})`);
  check(m.summary.join('|') === 'PASS one|FAIL two|three' && typeof m.ms === 'number', `d.summary lines (${m.summary.join('|')})`);
  const bad = runDecoder(misc, { gap: 'x' }, { a: 0 }, tr1(), 12e6);
  check(bad.error === null && got.o.gap === 'x', 'a non-numeric value is passed as given');
}

// ---- annotation export ----------------------------------------------------------------
{
  check(crc32('123456789') === 'cbf43926', 'CRC-32 check value');
  const s = new Wave().hold(100).samples();
  const dec = { rows: [{ id: 'op' }, { id: 'bits', export: false }, { id: 'warn' }], *decode(d) {
    d.put(50, 60, 'warn', 'late\tone');
    d.put(10, 20, 'op', ['long text | more', 'short']);
    d.put(10, 15, 'warn', 'early');
    d.put(12, 13, 'bits', '1');
    d.summary('PASS all');
  } };
  const result = runDecoder(dec, {}, { a: 0 }, transitions(s, 1), 12e6);
  const base = {
    version: 'WebPulse 9.9', decoder: { id: 'x', file: 'x.js', crc: 'deadbeef' },
    capture: { source: '', time: 0, rate: 12e6, n: 100, trigger_pos: 40 },
    channels: [['a', 'CLK'], ['b', '']], options: { gap: 300, name: 'two words' }, rows: ['op', 'warn'], result,
  };
  const txt = exportAnnotations(base).join('');
  const lines = txt.split('\n');
  const body = lines.filter((l) => l && !l.startsWith('#'));
  const headOk = lines[0] === '# WebPulse 9.9 decoder export' && txt.includes('# capture   live capture\n') &&
    txt.includes('# rate      12000000 Hz, 100 samples, trigger at sample 40') &&
    txt.includes('# decoder   x  (x.js, crc32 deadbeef)') && txt.includes('# channels  a=CLK b=-') &&
    txt.includes('# options   gap=300 name="two words"') && txt.includes('# rows      op warn') &&
    txt.includes('# result    4 annotations (3 exported),');
  check(headOk, 'export header' + (headOk ? '' : `\n${lines.slice(0, 11).join('\n')}`));
  check(body.slice(0, 3).join('|') ===
    '0.00083\t0.00042\t10\twarn\tearly|0.00083\t0.00083\t10\top\tlong text | more|0.00417\t0.00083\t50\twarn\tlate one',
    `export lines sorted by start, then end; longest text; tabs removed (${body.slice(0, 3).join('|')})`);
  check(txt.endsWith('## summary\nPASS all\n'), 'export ends with the summary');
  const ranged = exportAnnotations({ ...base, range: [11, 60] }).join('').split('\n').filter((l) => l && !l.startsWith('#'));
  check(ranged.length === 2 && ranged[0].includes('\t50\t') && ranged[1] === 'PASS all', `export range: annotations starting in it (${ranged.join('|')})`);
}

// ---- tools/wp-decode.mjs on a .sr file --------------------------------------------------
{
  // A sigrok session: UART "Hi" on CH2 (named TX), stored and deflated members.
  const rate = 1e6, bit = rate / 9600;
  const w = new Wave().set(4, 1).hold(300);
  for (const c of 'Hi') {
    const v = c.charCodeAt(0);
    w.set(4, 0).hold(bit);
    for (let i = 0; i < 8; i++) w.set(4, (v >> i) & 1).hold(bit);
    w.set(4, 1).hold(bit * 3);
  }
  const meta = '[global]\nsigrok version=0.5.2\n\n[device 1]\ncapturefile=logic-1\ntotal probes=8\n' +
    'samplerate=1 MHz\nprobe1=CLK\nprobe3=TX\nunitsize=1\n';
  const dir = mkdtempSync(join(tmpdir(), 'wp-decode-'));
  try {
    const file = join(dir, 'uart.sr');
    writeFileSync(file, zip([['version', '2', false], ['metadata', meta, false], ['logic-1-1', w.samples(), true],
      ['webpulse', 'trigger_pos=300\n', false]]));
    const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../tools/wp-decode.mjs', import.meta.url)), ...args],
      { encoding: 'utf8' });
    let r = cli(file, '-d', 'uart', '--opt', 'baud=9600', '--opt', 'format=ascii', '--ch', 'rx=TX');
    const data = r.stdout.split('\n').filter((l) => /\tdata\t/.test(l)).map((l) => l.split('\t')[4]);
    check(r.status === 0 && data.join(' ') === "'H' 48 'i' 69" && r.stdout.includes('# capture   uart.sr  (modified ') &&
      r.stdout.includes('# rate      1000000 Hz, ' + w.n + ' samples, trigger at sample 300') &&
      r.stdout.includes('# channels  rx=TX\n'), `wp-decode on a .sr file (${r.status}: ${data.join(' ')} ${r.stderr})`);
    r = cli(file, '-d', 'uart', '--opt', 'baud=9600', '--range', '0:1ms');
    check(r.status === 0 && r.stdout.includes('# result    2 annotations (1 exported)'), `wp-decode --range (${r.stderr}${r.stdout.split('\n')[8]})`);
    r = cli(file, '-d', 'uart', '--ch', 'rx=-');
    check(r.status === 1 && /assign rx with --ch/.test(r.stderr), `wp-decode: a required input left unassigned (${r.stderr.trim()})`);
    r = cli(file, '-d', 'uart', '--opt', 'baud=400000');
    check(r.status === 2 && /too slow/.test(r.stderr) && r.stdout.includes('error: '), 'wp-decode: decoder error, exit status 2');
    // Optional inputs are not guessed (even `auto` ones); required ones are, with a note.
    const dfile = join(dir, 'pins.js');
    writeFileSync(dfile, `export default { id: 'pins', name: 'Pins', rows: [{ id: 'x', name: 'X' }],
      channels: [{ id: 'clk', name: 'CLK' }, { id: 'dio', name: 'DIO' }, { id: 'dir', name: 'DIR', optional: true, auto: true }],
      *decode(d) { d.put(0, 1, 'x', d.has('dir') ? 'dir' : 'no dir'); } };`);
    r = cli(file, '-d', dfile);
    check(r.status === 0 && r.stdout.includes('# channels  clk=CLK dio=TX dir=-\n') &&
      /by position \(no channel with a matching name\): dio=CH2;/.test(r.stderr) && /not assigned: dir /.test(r.stderr) &&
      !/clk=CH0/.test(r.stderr), `wp-decode guesses only required inputs (${r.stderr.trim().replace(/\n/g, ' | ')})`);
    r = cli(file, '-d', dfile, '--ch', 'dio=TX', '--ch', 'dir=CLK', '--ch', 'clk=-');
    check(r.status === 1 && /assign clk/.test(r.stderr), `wp-decode --ch moves a channel (${r.stderr.trim()})`);
    r = cli(file, '-d', 'uart', '--opt', 'nope=1');
    check(r.status === 1 && /no option "nope"/.test(r.stderr), 'wp-decode rejects an unknown option');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A zip file of [name, string | Uint8Array, deflate?] members. */
function zip(members) {
  const parts = [], dirs = [];
  let off = 0;
  for (const [name, content, deflate] of members) {
    const raw = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
    const data = deflate ? deflateRawSync(raw) : raw;
    const nm = Buffer.from(name);
    const crc = zipCrc(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nm.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(deflate ? 8 : 0, 10);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nm.length, 28); cen.writeUInt32LE(off, 42);
    parts.push(local, nm, data);
    dirs.push(cen, nm);
    off += 30 + nm.length + data.length;
  }
  const size = dirs.reduce((t, b) => t + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, ...dirs, end]);
}

function zipCrc(bytes) {
  let c = 0xffffffff;
  for (const x of bytes) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('all decoder tests passed');
