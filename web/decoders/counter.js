// Counter: numbers the edges of one line, optionally restarting at a rising
// edge of a reset line.
export default {
  id: 'counter',
  name: 'Counter',
  desc: 'Counts the edges of a line',
  channels: [
    { id: 'data', name: 'Data', desc: 'Line whose edges are counted' },
    { id: 'reset', name: 'Reset', desc: 'Rising edge restarts the count', optional: true },
  ],
  options: [
    { id: 'edge', name: 'Count', default: 'rising', values: ['rising', 'falling', 'both'] },
    { id: 'start', name: 'First count', default: 1 },
  ],
  rows: [{ id: 'count', name: 'Count' }, { id: 'reset', name: 'Reset' }],

  *decode(d, o) {
    const edge = { rising: 'r', falling: 'f', both: 'e' }[o.edge];
    const conds = d.has('reset') ? [{ data: edge }, { reset: 'r' }] : [{ data: edge }];
    const first = Number(o.start);
    let count = first, at = -1, shown = 0;
    const flush = (end) => {
      if (at >= 0 && end > at) d.put(at, end, 'count', [String(shown)]);
    };
    try {
      for (;;) {
        const s = yield d.wait(conds);
        if (d.has('reset') && d.matched[1]) {
          flush(s);
          at = -1;
          count = first;
          d.put(s, s + 1, 'reset', ['Reset', 'R']);
          if (!d.matched[0]) continue;
        }
        flush(s);
        at = s;                            // each count lasts until the next edge
        shown = count++;
      }
    } finally {
      flush(d.n);
    }
  },
};
