// Protocol decoder runtime. Runs one decoder over a capture given as the list
// of transitions of the channels it uses, and collects its annotations.
//
// A decoder is an ES module whose default export looks like this (see
// web/decoders/*.js and README "Protocol decoders"):
//
//   export default {
//     id: 'uart', name: 'UART', desc: '…',
//     channels: [{ id: 'rx', name: 'RX', optional: false }],
//     options:  [{ id: 'baud', name: 'Baud rate', default: 115200 },
//                { id: 'parity', name: 'Parity', default: 'none', values: ['none', 'odd', 'even'] }],
//     rows:     [{ id: 'data', name: 'Data' }, { id: 'error', name: 'Errors' }],
//     *decode(d, opt) { … }
//   };
//
// decode() is a generator. It asks for the next sample of interest with
// `yield d.wait(cond)` (the value of the yield is that sample number) and reports
// results with d.put(start, end, row, text). cond is an object of conditions
// that must all hold, or an array of such objects of which one must hold:
//   { rx: 'f' }                  falling edge on rx ('r' rising, 'e' either,
//                                'h' high, 'l' low)
//   { scl: 'h', sda: 'f' }       sda falls while scl is high
//   [{ clk: 'r' }, { cs: 'r' }]  whichever comes first; d.matched tells which
//   { skip: n }                  n samples later (may be fractional)
//   d.until(s)                   sample s (absolute)
// Waiting always moves forward (a match at the current sample does not count).
// When no sample matches before the end of the capture, decode() is stopped.

const MAX_ANNOTATIONS = 4_000_000;

export class DecodeError extends Error {}

/** Annotations of one row: parallel arrays, sorted by start. */
class Row {
  constructor() {
    this.start = [];
    this.end = [];
    this.text = [];    // each entry: array of strings, longest first
  }
}

/**
 * Run decoder `dec` with options `opt`.
 *   assign: { channelId: channel number } for the assigned channels
 *   tr:     { pos: Float64Array, val: Uint8Array, n } transitions of the
 *           assigned channels (pos[0] = 0) and the number of samples
 *   rate:   sample rate in Hz
 * Returns { rows: { rowId: Row }, count, error }.
 */
export function runDecoder(dec, opt, assign, tr, rate) {
  const rows = {};
  for (const r of dec.rows || []) rows[r.id] = new Row();
  const ids = Object.keys(assign);
  const bit = {};
  for (const id of ids) bit[id] = 1 << assign[id];
  const { pos, val, n } = tr;
  const last = pos.length - 1;
  let k = 0;            // pos[k] <= cur < pos[k + 1]
  let count = 0;

  const d = {
    rate,
    n,
    samplenum: -1,
    pins: {},
    matched: [],
    has: (id) => id in assign,
    wait: (cond) => cond,
    skip: (samples) => ({ skip: samples }),
    until: (sample) => ({ until: sample }),
    put(start, end, row, text) {
      const r = rows[row];
      if (!r) throw new DecodeError(`put(): unknown row "${row}"`);
      if (++count > MAX_ANNOTATIONS) throw new DecodeError(`more than ${MAX_ANNOTATIONS} annotations`);
      r.start.push(Math.max(0, Math.round(start)));
      r.end.push(Math.min(n, Math.max(Math.round(start), Math.round(end))));
      r.text.push(Array.isArray(text) ? text.map(String) : [String(text)]);
    },
    ...FORMAT,
  };

  // Value of the masked sample byte at s (s >= current position; moves k forward).
  const valueAt = (s) => {
    while (k < last && pos[k + 1] <= s) k++;
    return val[k];
  };
  const setPins = (s) => {
    const v = valueAt(s);
    for (const id of ids) d.pins[id] = v & bit[id] ? 1 : 0;
  };

  // Earliest sample > cur (>= 0 at the start) where one alternative holds; -1 if none.
  const find = (alts, cur) => {
    const from = cur + 1;
    if (from >= n) return { s: -1 };
    let best = -1, which = null;
    const levelAlts = [];
    for (let a = 0; a < alts.length; a++) {
      const c = alts[a];
      if ('skip' in c || 'until' in c) {
        if (Object.keys(c).length !== 1) throw new DecodeError('skip / until cannot be combined with pin conditions');
        const s = 'skip' in c ? cur + Math.max(1, Math.round(c.skip)) : Math.max(from, Math.round(c.until));
        if (s < n && (best < 0 || s < best)) { best = s; which = [a]; }
        continue;
      }
      for (const id of Object.keys(c)) {
        if (!(id in assign)) throw new DecodeError(`wait(): channel "${id}" is not assigned`);
        if (!'hlrfe'.includes(c[id]) || c[id].length !== 1) throw new DecodeError(`wait(): bad condition "${c[id]}" for ${id}`);
      }
      levelAlts.push(a);
    }
    if (levelAlts.length) {
      // Candidates are `from` itself and every later transition: between
      // transitions nothing changes.
      const test = (s, v, pv, isEdge) => {
        const hit = [];
        for (const a of levelAlts) {
          const c = alts[a];
          let ok = true;
          for (const id of Object.keys(c)) {
            const b = bit[id], now = v & b ? 1 : 0, was = pv & b ? 1 : 0;
            switch (c[id]) {
              case 'h': ok = now === 1; break;
              case 'l': ok = now === 0; break;
              case 'r': ok = isEdge && was === 0 && now === 1; break;
              case 'f': ok = isEdge && was === 1 && now === 0; break;
              case 'e': ok = isEdge && was !== now; break;
            }
            if (!ok) break;
          }
          if (ok) hit.push(a);
        }
        return hit;
      };
      let j = k;
      while (j < last && pos[j + 1] <= from) j++;
      const atEdge = from > 0 && pos[j] === from;
      let hit = test(from, val[j], atEdge ? val[j - 1] : val[j], atEdge);
      let s = hit.length ? from : -1;
      for (j = j + 1; s < 0 && j <= last; j++) {
        if (best >= 0 && pos[j] >= best) break;
        hit = test(pos[j], val[j], val[j - 1], true);
        if (hit.length) s = pos[j];
      }
      if (s >= 0 && (best < 0 || s <= best)) {
        which = s === best ? [...which, ...hit] : hit;
        best = s;
      }
    }
    return { s: best, which };
  };

  let error = null;
  const gen = dec.decode(d, opt);
  try {
    let step = gen.next();
    while (!step.done) {
      const cond = step.value;
      if (!cond || typeof cond !== 'object') throw new DecodeError('yield d.wait(…) expected');
      const alts = Array.isArray(cond) ? cond : [cond];
      const { s, which } = find(alts, d.samplenum);
      if (s < 0) break;
      d.samplenum = s;
      setPins(s);
      d.matched = alts.map((_, a) => which.includes(a));
      step = gen.next(s);
    }
  } catch (e) {
    error = e instanceof DecodeError ? e.message : (e && e.stack) || String(e);
  } finally {
    try { gen.return(); } catch { /* ignore */ }
  }
  return { rows, count, error };
}

// ---- text formatting helpers (also available as d.hex(...) etc.) ------------

const FORMAT = {
  hex: (v, bits = 8) => v.toString(16).toUpperCase().padStart(Math.ceil(bits / 4), '0'),
  bin: (v, bits = 8) => v.toString(2).padStart(bits, '0'),
  dec: (v) => String(v),
  oct: (v, bits = 8) => v.toString(8).padStart(Math.ceil(bits / 3), '0'),
  ascii(v) {
    if (v >= 0x20 && v < 0x7f) return String.fromCharCode(v);
    return { 0: '\\0', 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r', 27: '\\e' }[v] ??
      `\\x${v.toString(16).padStart(2, '0')}`;
  },
  /** v in the given format: 'hex' | 'dec' | 'bin' | 'oct' | 'ascii'. */
  format(v, bits, fmt) {
    return fmt === 'ascii' ? FORMAT.ascii(v) : (FORMAT[fmt] || FORMAT.hex)(v, bits);
  },
};
export { FORMAT };
