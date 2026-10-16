// UART (asynchronous serial): one line, start bit, 5-9 data bits, optional
// parity, stop bit(s). Samples each bit in its middle. For RX and TX, add the
// decoder twice.
export default {
  id: 'uart',
  name: 'UART',
  desc: 'Asynchronous serial (RS-232 / TTL UART), one line',
  channels: [{ id: 'rx', name: 'RX / TX', desc: 'Serial data line' }],
  options: [
    { id: 'baud', name: 'Baud rate', default: 115200 },
    { id: 'bits', name: 'Data bits', default: 8, values: [5, 6, 7, 8, 9] },
    { id: 'parity', name: 'Parity', default: 'none', values: ['none', 'odd', 'even'] },
    { id: 'stop', name: 'Stop bits', default: 1, values: [1, 1.5, 2] },
    { id: 'order', name: 'Bit order', default: 'lsb-first', values: ['lsb-first', 'msb-first'] },
    { id: 'invert', name: 'Inverted', default: 'no', values: ['no', 'yes'] },
    { id: 'format', name: 'Show as', default: 'hex', values: ['hex', 'ascii', 'dec', 'bin'] },
  ],
  rows: [{ id: 'data', name: 'Data' }, { id: 'error', name: 'Errors' }],

  *decode(d, o) {
    const baud = Number(o.baud);
    const bits = Number(o.bits);
    const bit = d.rate / baud;
    if (!(bit >= 4)) throw new Error(`${d.rate} Hz is too slow for ${baud} baud (need at least 4 samples per bit)`);
    const inv = o.invert === 'yes' ? 1 : 0;
    const level = () => d.pins.rx ^ inv;     // 1 = idle (mark)

    // A capture that starts with the line active began inside a frame: wait
    // until it has been idle for a whole frame, or the bits would be misread.
    const frame = bit * (2 + bits + (o.parity === 'none' ? 0 : 1) + Number(o.stop));
    yield d.until(0);
    if (level() !== 1) {
      for (;;) {
        yield d.wait({ rx: inv ? 'l' : 'h' });
        yield d.wait([{ rx: inv ? 'r' : 'f' }, { skip: frame }]);
        if (d.matched[1]) break;
      }
    }
    for (;;) {
      const s = yield d.wait({ rx: inv ? 'r' : 'f' });
      yield d.until(s + bit / 2);
      if (level() !== 0) continue;           // a glitch, not a start bit

      let v = 0, ones = 0;
      for (let i = 0; i < bits; i++) {
        yield d.until(s + bit * (1.5 + i));
        const b = level();
        ones += b;
        v = o.order === 'msb-first' ? (v << 1) | b : v | (b << i);
      }
      let p = 1 + bits;                      // bit index after the data bits
      let parityOk = true;
      if (o.parity !== 'none') {
        yield d.until(s + bit * (p + 0.5));
        ones += level();
        parityOk = (ones % 2 === 1) === (o.parity === 'odd');
        p++;
      }
      yield d.until(s + bit * (p + 0.5));
      const stopOk = level() === 1;
      const end = s + bit * (p + Number(o.stop));

      const hex = d.hex(v, bits);
      const text = o.format === 'ascii' ? [`'${d.ascii(v)}' ${hex}`, d.ascii(v)]
        : o.format === 'hex' ? [`${hex} '${d.ascii(v)}'`, hex]
          : [d.format(v, bits, o.format)];
      d.put(s, end, 'data', text);
      if (!parityOk) d.put(s + bit * (p - 1), s + bit * p, 'error', ['Parity error', 'PE', 'P']);
      if (!stopOk) d.put(s + bit * p, end, 'error', ['Framing error', 'FE', 'F']);
    }
  },
};
