// Decoder annotations as a text file: a "#" header that says where the result
// came from, one tab-separated line per annotation (all chosen rows merged,
// sorted by start), then the decoder's summary under "## summary". Used by
// File ▸ Export in the UI and by tools/wp-decode.mjs, so both write the same.
//
//   # WebPulse 0.4.0 decoder export
//   # capture   a.sr  (opened 2026-11-27 11:46:13)
//   # rate      12000000 Hz, 10000000 samples, trigger at sample 100000
//   # decoder   uart  (built-in)
//   # channels  rx=RX
//   # options   baud=115200 parity=none
//   # rows      data error
//   # range     all
//   # result    120 annotations, 3 ms, no error
//   #
//   # start_ms<TAB>len_ms<TAB>sample<TAB>row<TAB>text
//   8.33333<TAB>0.08681<TAB>100000<TAB>data<TAB>0x48
//
// Times are from sample 0 (as in VCD / CSV exports); the sample column is exact.

/**
 * The export text, as an array of chunks (join them, or hand them to a Blob).
 *   version:  'WebPulse 0.4.0'
 *   capture:  { source, time, timeKind, rate, n, trigger_pos }   source '' = a
 *             capture; time = Unix seconds (0 = unknown), timeKind how to
 *             label it for a file: 'opened' (default) or 'modified'
 *   decoder:  { id, file, crc, builtin }   file / crc for a decoder file
 *   channels: [[inputId, channel name or ''], …]
 *   options:  { id: value }
 *   rows:     row ids to include, in the decoder's order
 *   result:   from runDecoder()
 *   range:    [first, end) samples, or null for all: annotations starting in it
 */
export function exportAnnotations({ version, capture, decoder, channels, options, rows, result, range = null }) {
  const { rate, n } = capture;
  const digits = Math.min(9, Math.max(3, Math.ceil(Math.log10(rate / 1e3))));
  const ms = (s) => ((s * 1e3) / rate).toFixed(digits);
  const [a, b] = range ? [Math.max(0, range[0]), Math.min(n, range[1])] : [0, n];

  // Merge the chosen rows (each sorted by start) into one list by start, then
  // end; equal ones in row order. With a range: the annotations starting in it.
  const sel = rows.map((id) => ({ id, r: result && result.rows[id] })).filter((x) => x.r);
  for (const x of sel) x.k = firstAtOrAfter(x.r.start, a);
  const body = [];
  let lines = [];
  let count = 0;
  for (;;) {
    let best = null;
    for (const x of sel) {
      if (x.k >= x.r.start.length || x.r.start[x.k] >= b) continue;
      if (!best || x.r.start[x.k] < best.r.start[best.k] ||
          (x.r.start[x.k] === best.r.start[best.k] && x.r.end[x.k] < best.r.end[best.k])) best = x;
    }
    if (!best) break;
    const i = best.k++;
    const st = best.r.start[i];
    lines.push(`${ms(st)}\t${ms(best.r.end[i] - st)}\t${st}\t${best.id}\t${oneLine(best.r.text[i][0])}`);
    count++;
    if (lines.length >= 20000) {
      body.push(lines.join('\n') + '\n');
      lines = [];
    }
  }
  if (lines.length) body.push(lines.join('\n') + '\n');

  const when = capture.time ? localTime(capture.time) : '';
  const src = capture.source
    ? `${capture.source}${when ? `  (${capture.timeKind || 'opened'} ${when})` : ''}`
    : `live capture${when ? `  (${when})` : ''}`;
  const trig = capture.trigger_pos >= 0 ? `trigger at sample ${capture.trigger_pos}` : 'no trigger';
  const dec = decoder.builtin ? `${decoder.id}  (built-in)`
    : `${decoder.id}  (${decoder.file}${decoder.crc ? `, crc32 ${decoder.crc}` : ''})`;
  const total = result ? result.count : 0;
  const err = result && result.error ? `error: ${oneLine(result.error)}` : 'no error';
  const head = [
    `# ${version} decoder export`,
    `# capture   ${oneLine(src)}`,
    `# rate      ${rate} Hz, ${n} samples, ${trig}`,
    `# decoder   ${dec}`,
    `# channels  ${channels.map(([id, name]) => `${id}=${name ? word(name) : '-'}`).join(' ')}`,
    `# options   ${Object.entries(options).map(([k, v]) => `${k}=${word(v)}`).join(' ') || '-'}`,
    `# rows      ${rows.join(' ') || '-'}`,
    `# range     ${range ? `samples ${a}..${b}  (${ms(a)} .. ${ms(b)} ms)` : 'all'}`,
    `# result    ${total} annotations${count !== total ? ` (${count} exported)` : ''}, ${result ? result.ms : 0} ms, ${err}`,
    '#',
    '# start_ms\tlen_ms\tsample\trow\ttext',
  ];
  const chunks = [head.join('\n') + '\n', ...body];
  const summary = (result && result.summary) || [];
  if (summary.length) chunks.push(['## summary', ...summary.map(oneLine)].join('\n') + '\n');
  return chunks;
}

/** Index of the first start >= a (starts are sorted). */
function firstAtOrAfter(start, a) {
  let lo = 0, hi = start.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (start[mid] < a) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function oneLine(s) {
  return String(s).replace(/[\t\r\n]+/g, ' ');
}

/** A value as one word: quoted when it has spaces, quotes or '='. */
function word(v) {
  const s = oneLine(v);
  return /[\s"=]/.test(s) || s === '' ? JSON.stringify(s) : s;
}

function localTime(sec) {
  const d = new Date(sec * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---- CRC-32 (as in zip), to tell decoder file versions apart -----------------

let table = null;

/** CRC-32 of a string's UTF-8 bytes, as 8 hex digits. */
export function crc32(text) {
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
  }
  const bytes = new TextEncoder().encode(text);
  let c = 0xffffffff;
  for (const x of bytes) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
