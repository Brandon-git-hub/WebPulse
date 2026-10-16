// SPI: clock plus MOSI and/or MISO, optional chip select. Words are framed by
// chip select when it is assigned; without it, every word-size bits form a word.
export default {
  id: 'spi',
  name: 'SPI',
  desc: 'Serial Peripheral Interface',
  channels: [
    { id: 'clk', name: 'CLK', desc: 'Clock', aliases: ['sclk', 'sck'] },
    { id: 'mosi', name: 'MOSI', desc: 'Master out, slave in', optional: true, auto: true, aliases: ['sdo', 'copi'] },
    { id: 'miso', name: 'MISO', desc: 'Master in, slave out', optional: true, aliases: ['sdi', 'cipo'] },
    { id: 'cs', name: 'CS#', desc: 'Chip select', optional: true, auto: true, aliases: ['ss', 'nss', 'csn'] },
  ],
  options: [
    { id: 'cpol', name: 'Clock polarity (CPOL)', default: 0, values: [0, 1] },
    { id: 'cpha', name: 'Clock phase (CPHA)', default: 0, values: [0, 1] },
    { id: 'cspol', name: 'CS active', default: 'low', values: ['low', 'high'] },
    { id: 'order', name: 'Bit order', default: 'msb-first', values: ['msb-first', 'lsb-first'] },
    { id: 'wordsize', name: 'Word size', default: 8, values: [4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 32] },
    { id: 'format', name: 'Show as', default: 'hex', values: ['hex', 'dec', 'bin', 'ascii'] },
  ],
  rows: [{ id: 'mosi', name: 'MOSI' }, { id: 'miso', name: 'MISO' }],

  *decode(d, o) {
    if (!d.has('mosi') && !d.has('miso')) throw new Error('assign MOSI and/or MISO');
    const size = Number(o.wordsize);
    // Data is sampled on the leading clock edge when CPHA = 0, else on the
    // trailing one; the leading edge is rising when CPOL = 0.
    const edge = (Number(o.cpol) ^ Number(o.cpha)) ? 'f' : 'r';
    const csActive = o.cspol === 'high' ? 1 : 0;
    const hasCs = d.has('cs');
    const conds = hasCs ? [{ clk: edge }, { cs: 'e' }] : [{ clk: edge }];
    const word = { n: 0, mosi: 0, miso: 0, first: 0, last: 0 };
    const add = (v, b) => (o.order === 'msb-first' ? v * 2 + b : v + b * 2 ** word.n);

    for (;;) {
      const s = yield d.wait(conds);
      if (hasCs && d.matched[1]) {
        word.n = 0;                        // chip select changed: a new frame
        if (!d.matched[0]) continue;
      }
      if (hasCs && d.pins.cs !== csActive) continue;
      if (word.n === 0) word.first = s;
      if (d.has('mosi')) word.mosi = word.n ? add(word.mosi, d.pins.mosi) : d.pins.mosi;
      if (d.has('miso')) word.miso = word.n ? add(word.miso, d.pins.miso) : d.pins.miso;
      word.last = s;
      if (++word.n < size) continue;

      // The word spans from half a bit before its first sample to half a bit after its last.
      const half = size > 1 ? (word.last - word.first) / (size - 1) / 2 : 1;
      for (const row of ['mosi', 'miso']) {
        if (!d.has(row)) continue;
        const v = word[row];
        d.put(word.first - half, word.last + half, row,
          o.format === 'ascii' ? [`'${d.ascii(v)}' ${d.hex(v, size)}`, d.ascii(v)] : [d.format(v, size, o.format)]);
      }
      word.n = 0;
    }
  },
};
