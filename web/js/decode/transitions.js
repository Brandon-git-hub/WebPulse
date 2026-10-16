// Fetch the transitions of the channels in `mask` from /api/transitions,
// following the server's `next` pointer until the whole capture is covered.
// See api_transitions() in src/server.c for the binary format.

const MAX_TRANSITIONS = 64 << 20;     // ~600 MB in memory; beyond that, give up

export async function fetchTransitions(base, mask, onProgress) {
  const chunks = [];
  let from = 0, total = 0, n = 0;
  for (;;) {
    const r = await fetch(new URL(`api/transitions?mask=${mask}&from=${from}`, base));
    if (!r.ok) {
      let msg = `${r.status} ${r.statusText}`;
      try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
      throw new Error(`cannot read the capture: ${msg}`);
    }
    const buf = await r.arrayBuffer();
    const dv = new DataView(buf);
    n = dv.getFloat64(0, true);
    const next = dv.getFloat64(8, true);
    const count = dv.getUint32(16, true);
    chunks.push({ pos: new Float64Array(buf, 24, count), val: new Uint8Array(buf, 24 + count * 8, count) });
    total += count;
    if (total > MAX_TRANSITIONS) throw new Error(`more than ${MAX_TRANSITIONS} transitions on these channels`);
    if (next < 0) break;
    from = next;
    if (onProgress) onProgress(from / n);
  }
  if (chunks.length === 1) return { pos: chunks[0].pos, val: chunks[0].val, n };
  const pos = new Float64Array(total), val = new Uint8Array(total);
  let k = 0;
  for (const c of chunks) {
    pos.set(c.pos, k);
    val.set(c.val, k);
    k += c.pos.length;
  }
  return { pos, val, n };
}
