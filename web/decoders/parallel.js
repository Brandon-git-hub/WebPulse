// Parallel bus: up to 8 data lines (D0 = least significant bit) shown as one
// value. With a clock, the value is sampled on each clock edge; without one,
// a new value starts whenever any data line changes.
const DATA = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];

export default {
  id: 'parallel',
  name: 'Parallel',
  desc: 'Parallel bus value from up to 8 lines, optionally clocked',
  channels: [
    { id: 'clk', name: 'CLK', desc: 'Clock (leave unassigned to follow data changes)', optional: true },
    ...DATA.map((id, i) => ({ id, name: `D${i}`, desc: `Data bit ${i}`, optional: true })),
  ],
  options: [
    { id: 'edge', name: 'Clock edge', default: 'rising', values: ['rising', 'falling', 'either'] },
    { id: 'format', name: 'Show as', default: 'hex', values: ['hex', 'dec', 'bin', 'ascii'] },
  ],
  rows: [{ id: 'word', name: 'Value' }],

  *decode(d, o) {
    const used = DATA.filter((id) => d.has(id));
    if (!used.length) throw new Error('assign at least one data line');
    const width = DATA.indexOf(used[used.length - 1]) + 1;
    const read = () => used.reduce((v, id) => v | (d.pins[id] << DATA.indexOf(id)), 0);
    const conds = d.has('clk')
      ? [{ clk: { rising: 'r', falling: 'f', either: 'e' }[o.edge] }]
      : used.map((id) => ({ [id]: 'e' }));
    let start = -1, value = 0;
    const flush = (end) => {
      if (start >= 0 && end > start) d.put(start, end, 'word', [d.format(value, width, o.format)]);
    };
    if (!d.has('clk')) {
      yield d.until(0);                    // the value at the first sample
      start = 0;
      value = read();
    }
    try {
      for (;;) {
        const s = yield d.wait(conds);
        flush(s);
        start = s;
        value = read();
      }
    } finally {
      flush(d.n);                          // the last value runs to the end of the capture
    }
  },
};
