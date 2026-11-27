#!/usr/bin/env node
// Run a WebPulse protocol decoder on a .sr file without the UI, and write the
// annotations in the same format as File ▸ Export ▸ Decoder annotations.
// Needs Node.js 18 or later.
//
//   node wp-decode.mjs capture.sr --decoder uart [-o out.txt]
//   node wp-decode.mjs capture.sr --decoder decoders/pwm.js \
//        --opt active=low --ch pwm=CH3 --rows duty --range 10ms:20ms
//
// Run with --help for all options.
//
// In the repository this file uses web/js/decode/ and web/decoders/. In a
// release, tools/package.py has put those modules (and the version) into
// BUNDLE below, so the file runs on its own next to webpulse(.exe), with the
// user decoders in decoders/ beside it.

import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// { version, modules: { 'js/decode/runtime.js': source, 'decoders/uart.js': … } }
// (paths relative to web/); filled in by tools/package.py. Keep this line as is.
const BUNDLE = null;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const USER_DIR = BUNDLE ? join(HERE, 'decoders') : join(ROOT, 'decoders');

/** A module under web/: from the bundle, else from the repository. */
function loadWeb(path) {
  if (!BUNDLE) return import(pathToFileURL(join(ROOT, 'web', path)).href);
  const src = BUNDLE.modules[path];
  // sourceURL: errors name the file (uart.js:12), as in the browser.
  const code = `${src}\n//# sourceURL=webpulse/${path}\n`;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

const { runDecoder, normalizeOptions } = await loadWeb('js/decode/runtime.js');
const { exportAnnotations, crc32 } = await loadWeb('js/decode/export.js');
const { autoAssign, normName } = await loadWeb('js/decode/assign.js');

const USAGE = `Usage: node wp-decode.mjs FILE.sr --decoder ID|FILE.js [options]

FILE.sr is a sigrok / PulseView session file, as saved by WebPulse (File >
Save session or webpulse -c -o x.sr). VCD and CSV files are not read: convert
them in PulseView, or capture again.

  -d, --decoder ID|FILE   a built-in decoder (uart, spi, i2c, parallel, counter)
                          or a decoder file (e.g. decoders/pwm.js)
      --opt NAME=VALUE    a decoder option (repeatable)
      --ch INPUT=CHANNEL  assign a decoder input to a channel: its name in the
                          file, CHn or n; - for none (repeatable). Otherwise an
                          input goes to the channel named like it; a required
                          one with no such channel takes the next free one, an
                          optional one stays unassigned. (Name the channels
                          when capturing: webpulse -c --names VDD,CLK,...)
      --rows A,B,...      rows to write (default: all but those marked
                          export: false by the decoder)
      --range A:B         only annotations starting in [A, B): samples, or
                          times with a unit (10ms:25.5ms, 1s:2s, 400us:)
  -o, --output FILE       write to FILE (default: standard output)
      --list              show the decoder's inputs, options and rows, then exit
  -h, --help              this help

Exit status: 0 done, 1 bad arguments or file, 2 the decoder reported an error
(the annotations made before it are still written).`;

function fail(msg) {
  process.stderr.write(`wp-decode: ${msg}\n`);
  process.exit(1);
}

// ---- arguments ------------------------------------------------------------------------

const args = { opts: {}, ch: {}, rows: null, range: null, out: null, decoder: null, file: null, list: false };
{
  const av = process.argv.slice(2);
  const val = (i, name) => {
    if (i + 1 >= av.length) fail(`${name} needs a value`);
    return av[i + 1];
  };
  const pair = (s, name) => {
    const k = s.indexOf('=');
    if (k <= 0) fail(`${name} expects NAME=VALUE, got "${s}"`);
    return [s.slice(0, k), s.slice(k + 1)];
  };
  for (let i = 0; i < av.length; i++) {
    const a = av[i];
    if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a === '-d' || a === '--decoder') args.decoder = val(i++, a);
    else if (a === '--opt') { const [k, v] = pair(val(i++, a), a); args.opts[k] = v; }
    else if (a === '--ch') { const [k, v] = pair(val(i++, a), a); args.ch[k] = v; }
    else if (a === '--rows') args.rows = val(i++, a).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--range') args.range = val(i++, a);
    else if (a === '-o' || a === '--output') args.out = val(i++, a);
    else if (a === '--list') args.list = true;
    else if (a.startsWith('-') && a !== '-') fail(`unknown option ${a} (see --help)`);
    else if (!args.file) args.file = a;
    else fail(`unexpected argument "${a}"`);
  }
  if (!args.decoder) fail('--decoder is required (see --help)');
  if (!args.file && !args.list) fail('no .sr file given (see --help)');
}

// ---- decoder --------------------------------------------------------------------------

const BUILTIN = ['uart', 'spi', 'i2c', 'parallel', 'counter'];
let decPath, builtin = false;
if (/[\\/]|\.m?js$/.test(args.decoder)) {
  decPath = resolve(args.decoder);
  if (!existsSync(decPath)) fail(`no decoder file ${args.decoder}`);
} else if (BUILTIN.includes(args.decoder)) {
  decPath = `decoders/${args.decoder}.js`;           // under web/
  builtin = true;
} else if (existsSync(join(USER_DIR, `${args.decoder}.js`))) {
  decPath = join(USER_DIR, `${args.decoder}.js`);
} else {
  fail(`unknown decoder "${args.decoder}" (built-in: ${BUILTIN.join(', ')}; your decoders: ${USER_DIR}; or give a .js file)`);
}
let def;
try {
  def = (await (builtin ? loadWeb(decPath) : import(pathToFileURL(decPath).href))).default;
} catch (e) {
  fail(`cannot load ${decPath}: ${e.message}`);
}
if (!def || typeof def.decode !== 'function' || !Array.isArray(def.channels) || !Array.isArray(def.rows)) {
  fail(`${decPath} is not a decoder (needs a default export with channels, rows and decode)`);
}
const decId = def.id || basename(decPath).replace(/\.m?js$/, '');

if (args.list) {
  console.log(`${def.name}${def.desc ? ` - ${def.desc}` : ''}`);
  console.log('inputs:');
  for (const c of def.channels) {
    console.log(`  ${c.id}\t${c.name}${c.optional ? ' (optional)' : ''}${c.aliases ? `  aliases: ${c.aliases.join(', ')}` : ''}`);
  }
  console.log('options:');
  for (const o of def.options || []) {
    console.log(`  ${o.id}\t${o.name}, default ${JSON.stringify(o.default)}${o.values ? `  values: ${o.values.join(', ')}` : ''}`);
  }
  console.log('rows:');
  for (const r of def.rows) console.log(`  ${r.id}\t${r.name}${r.export === false ? '  (not exported by default)' : ''}`);
  process.exit(0);
}

// ---- .sr file -------------------------------------------------------------------------

const cap = readSr(args.file);

/** { samples: Uint8Array (first 8 channels), rate, n, names[8], trigger_pos, note } */
function readSr(path) {
  let buf;
  try { buf = readFileSync(path); } catch (e) { fail(`cannot read ${path}: ${e.message}`); }
  const members = readZip(buf, path);
  const text = (name) => (members.has(name) ? members.get(name)().toString('utf8') : null);
  const meta = text('metadata');
  if (meta === null) fail(`${path}: no metadata (not a sigrok session file?)`);
  let section = '', capfile = 'logic-1', rate = 0, unitsize = 1, total = 0, devices = 0;
  const names = new Array(8).fill('');
  for (const raw of meta.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^\[(.+)\]$/.exec(line);
    if (m) { section = m[1]; if (/^device /.test(section)) devices++; continue; }
    if (devices !== 1 || !/^device /.test(section)) continue;
    const k = line.indexOf('=');
    if (k < 0) continue;
    const key = line.slice(0, k).trim(), v = line.slice(k + 1).trim();
    if (key === 'capturefile') capfile = v;
    else if (key === 'samplerate') rate = parseRate(v);
    else if (key === 'unitsize') unitsize = Number(v);
    else if (key === 'total probes') total = Number(v);
    else if (/^probe\d+$/.test(key)) { const c = Number(key.slice(5)) - 1; if (c >= 0 && c < 8) names[c] = v; }
  }
  if (!rate) fail(`${path}: metadata has no valid samplerate`);
  if (!(unitsize >= 1 && unitsize <= 8)) fail(`${path}: unsupported unitsize ${unitsize}`);
  const parts = [...members.keys()]
    .filter((k) => k === capfile || k.startsWith(`${capfile}-`))
    .sort((a, b) => (Number(a.slice(capfile.length + 1)) || 0) - (Number(b.slice(capfile.length + 1)) || 0));
  if (!parts.length) fail(`${path}: no sample data (${capfile}-*)`);
  const chunks = parts.map((p) => members.get(p)());
  const bytes = chunks.reduce((s, c) => s + c.length, 0);
  const n = Math.floor(bytes / unitsize);
  const samples = new Uint8Array(n);
  if (unitsize === 1) {
    let k = 0;
    for (const c of chunks) { samples.set(c, k); k += c.length; }
  } else {
    // First byte of each unit: channels 1-8.
    let i = 0, carry = 0;
    for (const c of chunks) {
      for (let j = 0; j < c.length; j++) {
        if (carry === 0 && i < n) samples[i++] = c[j];
        if (++carry === unitsize) carry = 0;
      }
    }
  }
  let trigger = -1;
  const extra = text('webpulse');
  const t = extra && /trigger_pos=(-?\d+)/.exec(extra);
  if (t && Number(t[1]) >= 0 && Number(t[1]) < n) trigger = Number(t[1]);
  const note = unitsize > 1 || total > 8 ? `only the first 8 of ${Math.max(total, unitsize * 8)} channels are used` : '';
  return { samples, rate, n, names, trigger_pos: trigger, note };
}

/** Zip members by name -> () => Buffer (stored or deflated). */
function readZip(buf, path) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) {
    const head = buf.toString('latin1', 0, Math.min(buf.length, 512));
    if (/\$(timescale|var|enddefinitions|date|version)\b/.test(head)) {
      fail(`${path} is a VCD file; only .sr session files can be decoded (see --help)`);
    }
    fail(`${path} is not a .sr session file (not a zip file; see --help)`);
  }
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let e = 0; e < count; e++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail(`${path}: bad zip directory`);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (buf.readUInt32LE(local) !== 0x04034b50) fail(`${path}: bad zip entry ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    out.set(name, () => {
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      fail(`${path}: ${name} uses unsupported compression ${method}`);
    });
  }
  return out;
}

function parseRate(s) {
  const m = /^([\d.]+)\s*([GMk]?)/i.exec(s);
  if (!m) return 0;
  const v = Number(m[1]) * ({ g: 1e9, m: 1e6, k: 1e3 }[m[2].toLowerCase()] || 1);
  return v >= 1 ? Math.round(v) : 0;
}

// ---- assignment, options, rows, range ----------------------------------------------------

// Unlike the UI, where the assignment is in view and easy to change, inputs
// are only guessed when they must be: an input goes to the channel named like
// it; else a required one takes the next free channel (and says so on
// stderr); an optional one stays unassigned unless --ch gives it a channel.
// Default names (CH0 … CH7) do not count as names.
const present = cap.names.map((nm, c) => c).filter((c) => cap.names[c]);
const realNames = cap.names.map((nm) => (/^ch\d$/i.test(nm) ? '' : nm));
const assign = autoAssign({ ...def, channels: def.channels.map((c) => ({ ...c, auto: false })) }, realNames, present);
const byName = (id, c) => {
  const ch = def.channels.find((x) => x.id === id);
  return c !== null && realNames[c] && [ch.id, ch.name, ...(ch.aliases || [])].map(normName).includes(normName(realNames[c]));
};
for (const [id, v] of Object.entries(args.ch)) {
  if (!def.channels.some((c) => c.id === id)) fail(`decoder ${decId} has no input "${id}" (see --list)`);
  let c = -1;
  if (v === '-' || v === '') c = null;
  else if (/^\d$/.test(v)) c = Number(v);
  else if (/^ch\d$/i.test(v)) c = Number(v.slice(2));
  else c = cap.names.findIndex((nm) => nm && normName(nm) === normName(v));
  if (c !== null && !(c >= 0 && c < 8)) fail(`--ch ${id}=${v}: no such channel (names: ${cap.names.filter(Boolean).join(', ') || 'none'})`);
  // A channel can feed one input: take it away from another one.
  if (c !== null) for (const k of Object.keys(assign)) if (assign[k] === c && k !== id) assign[k] = null;
  assign[id] = c;
}
const used = {};
for (const [id, c] of Object.entries(assign)) if (c !== null) used[id] = c;
const guessed = Object.keys(used).filter((id) => !(id in args.ch) && !byName(id, used[id]));
if (guessed.length) {
  process.stderr.write(`wp-decode: by position (no channel with a matching name): ${
    guessed.map((id) => `${id}=CH${used[id]}`).join(' ')}; use --ch to choose\n`);
}
const unset = def.channels.filter((c) => c.optional && !(c.id in used) && !(c.id in args.ch)).map((c) => c.id);
if (unset.length) process.stderr.write(`wp-decode: optional inputs not assigned: ${unset.join(' ')} (--ch INPUT=CHANNEL)\n`);
const missing = def.channels.filter((c) => !c.optional && !(c.id in used));
if (missing.length) {
  fail(`assign ${missing.map((c) => c.id).join(', ')} with --ch (channels in the file: ${cap.names.map((nm, c) => nm || `CH${c}`).join(', ')})`);
}

for (const [k, v] of Object.entries(args.opts)) {
  const o = (def.options || []).find((x) => x.id === k);
  if (!o) fail(`decoder ${decId} has no option "${k}" (see --list)`);
  if (Array.isArray(o.values) && !o.values.map(String).includes(v)) fail(`--opt ${k}: one of ${o.values.join(', ')}`);
}
const options = normalizeOptions(def, args.opts);

let rows = def.rows.filter((r) => r.export !== false).map((r) => r.id);
if (args.rows) {
  for (const r of args.rows) if (!def.rows.some((x) => x.id === r)) fail(`decoder ${decId} has no row "${r}" (see --list)`);
  rows = def.rows.map((r) => r.id).filter((id) => args.rows.includes(id));
}

let range = null;
if (args.range) {
  const m = /^([^:]*):([^:]*)$/.exec(args.range);
  if (!m) fail('--range expects A:B');
  const at = (s, dflt) => {
    if (s.trim() === '') return dflt;
    const t = /^\s*([\d.]+)\s*(s|ms|us|ns)?\s*$/.exec(s);
    if (!t) fail(`--range: bad position "${s}"`);
    const v = Number(t[1]);
    return t[2] ? Math.round(v * { s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9 }[t[2]] * cap.rate) : Math.round(v);
  };
  range = [at(m[1], 0), at(m[2], cap.n)];
  if (!(range[0] < range[1])) fail('--range: the start must be before the end');
}

// ---- decode and write ----------------------------------------------------------------

let mask = 0;
for (const c of Object.values(used)) mask |= 1 << c;
const result = runDecoder(def, options, used, transitions(cap.samples, mask), cap.rate);

let version = BUNDLE ? `WebPulse ${BUNDLE.version}` : 'WebPulse';
if (!BUNDLE) try {
  const v = /project\(webpulse VERSION ([\d.]+)/.exec(readFileSync(join(ROOT, 'CMakeLists.txt'), 'utf8'));
  if (v) version = `WebPulse ${v[1]}`;
} catch { /* not in the repository */ }

const st = statSync(args.file);
const text = exportAnnotations({
  version,
  capture: { source: basename(args.file), time: Math.floor(st.mtimeMs / 1000), timeKind: 'modified',
    rate: cap.rate, n: cap.n, trigger_pos: cap.trigger_pos },
  decoder: builtin ? { id: decId, builtin: true }
    : { id: decId, file: basename(decPath), crc: crc32(readFileSync(decPath, 'utf8')) },
  channels: def.channels.map((c) => [c.id, c.id in used ? cap.names[used[c.id]] || `CH${used[c.id]}` : '']),
  options,
  rows,
  result,
  range,
}).join('');

if (args.out) writeFileSync(args.out, text);
else process.stdout.write(text);
if (cap.note) process.stderr.write(`wp-decode: ${cap.note}\n`);
if (result.error) {
  process.stderr.write(`wp-decode: ${decId}: ${result.error}\n`);
  process.exit(2);
}

/** The transitions of the channels in mask, as /api/transitions gives them. */
function transitions(samples, m) {
  let cap = 1 << 16, k = 0;
  let pos = new Float64Array(cap), val = new Uint8Array(cap);
  const n = samples.length;
  if (n) { pos[0] = 0; val[0] = samples[0]; k = 1; }
  for (let i = 1; i < n; i++) {
    if ((samples[i] ^ samples[i - 1]) & m) {
      if (k === cap) {
        cap *= 2;
        const p2 = new Float64Array(cap); p2.set(pos); pos = p2;
        const v2 = new Uint8Array(cap); v2.set(val); val = v2;
      }
      pos[k] = i;
      val[k++] = samples[i];
    }
  }
  return { pos: pos.subarray(0, k), val: val.subarray(0, k), n };
}
