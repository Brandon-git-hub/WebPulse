// Web Worker that runs one decoder, so a long decode never blocks the UI.
// Message in:  { url, options, assign, mask, rate, base }
// Messages out: { progress } while reading, then { result } or { error }.

import { runDecoder } from './runtime.js';
import { fetchTransitions } from './transitions.js';

self.onmessage = async (ev) => {
  const { url, options, assign, mask, rate, base } = ev.data;
  try {
    const dec = (await import(url)).default;
    const tr = await fetchTransitions(base, mask, (p) => self.postMessage({ progress: p }));
    const result = runDecoder(dec, options, assign, tr, rate);
    // Hand the position arrays over instead of copying them.
    const transfer = [];
    for (const row of Object.values(result.rows)) {
      row.start = Float64Array.from(row.start);
      row.end = Float64Array.from(row.end);
      transfer.push(row.start.buffer, row.end.buffer);
    }
    self.postMessage({ result }, transfer);
  } catch (e) {
    self.postMessage({ error: (e && e.message) || String(e) });
  }
};
