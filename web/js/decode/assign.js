// Which capture channel each decoder input gets when a decoder is added.
// Shared by the UI (decoders.js) and tools/wp-decode.mjs.

/**
 * A decoder input goes to a capture channel named like its id, name or one of
 * its aliases (e.g. "SCL", "sclk"); else required and `auto` ones go to the
 * next unused channels in `order`; other optional ones stay unassigned (null).
 *   names: the capture channel names, by channel number ('' = unnamed)
 *   order: channel numbers that may be used for the fallback, in order
 */
export function autoAssign(def, names, order) {
  const assign = {};
  const used = new Set();
  for (const ch of def.channels || []) {
    const want = [ch.id, ch.name, ...(ch.aliases || [])].map(normName);
    const hit = names.findIndex((n, c) => !used.has(c) && n && want.includes(normName(n)));
    assign[ch.id] = hit < 0 ? null : hit;
    if (hit >= 0) used.add(hit);
  }
  for (const ch of def.channels || []) {
    if (assign[ch.id] !== null || (ch.optional && !ch.auto)) continue;
    const free = order.find((c) => !used.has(c));
    if (free === undefined) break;
    assign[ch.id] = free;
    used.add(free);
  }
  return assign;
}

/** "ISP_CLK", "isp-clk", "IspClk" all compare equal. */
export function normName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}
