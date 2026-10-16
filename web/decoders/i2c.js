// I²C: start / repeated start / stop, address with read/write bit, data bytes
// and the ACK / NACK of each.
export default {
  id: 'i2c',
  name: 'I²C',
  desc: 'Inter-Integrated Circuit (two-wire) bus',
  channels: [
    { id: 'scl', name: 'SCL', desc: 'Clock' },
    { id: 'sda', name: 'SDA', desc: 'Data' },
  ],
  options: [
    { id: 'address', name: 'Address', default: '7-bit', values: ['7-bit', '8-bit (incl. R/W)'] },
    { id: 'format', name: 'Data as', default: 'hex', values: ['hex', 'dec', 'bin', 'ascii'] },
  ],
  rows: [{ id: 'data', name: 'Address / data' }, { id: 'ack', name: 'ACK / start / stop' }],

  *decode(d, o) {
    const START = 0, STOP = 1, BIT = 2;
    const conds = [{ scl: 'h', sda: 'f' }, { scl: 'h', sda: 'r' }, { scl: 'r' }];
    let state = 'idle';                    // idle | address | data
    let byte = 0, nbits = 0, first = 0, rw = 0;
    let lastRise = -1, period = 0;         // clock period estimate for short marks

    for (;;) {
      const s = yield d.wait(conds);
      const mark = Math.max(1, period / 2);
      if (d.matched[START]) {
        d.put(s, s + mark, 'ack', state === 'idle' ? ['Start', 'S'] : ['Repeated start', 'Sr']);
        state = 'address';
        byte = nbits = 0;
        continue;
      }
      if (d.matched[STOP]) {
        d.put(s, s + mark, 'ack', ['Stop', 'P']);
        state = 'idle';
        continue;
      }
      if (!d.matched[BIT] || state === 'idle') continue;

      if (lastRise >= 0 && s - lastRise < 4 * (period || Infinity)) period = s - lastRise;
      lastRise = s;
      if (nbits < 8) {
        if (nbits === 0) first = s;
        byte = (byte << 1) | d.pins.sda;
        nbits++;
        continue;
      }
      // 9th clock: ACK (SDA low) or NACK.
      const nack = d.pins.sda === 1;
      const end = s - mark;
      if (state === 'address') {
        rw = byte & 1;
        const addr = o.address === '7-bit' ? byte >> 1 : byte;
        const a = d.hex(addr, o.address === '7-bit' ? 7 : 8);
        d.put(first - mark, end, 'data',
          [`Address ${rw ? 'read' : 'write'}: ${a}`, `A${rw ? 'R' : 'W'} ${a}`, a]);
        state = 'data';
      } else {
        const v = d.format(byte, 8, o.format);
        d.put(first - mark, end, 'data', [`Data ${rw ? 'read' : 'write'}: ${v}`, `D${rw ? 'R' : 'W'} ${v}`, v]);
      }
      d.put(s - mark, s + mark, 'ack', nack ? ['NACK', 'N'] : ['ACK', 'A']);
      byte = nbits = 0;
    }
  },
};
