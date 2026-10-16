// Example of a user decoder: the duty cycle and frequency of each PWM period.
//
// WebPulse loads every *.js file in this folder (next to webpulse.exe, or the
// folder given with --decoders). After editing a file, press Reload in the
// Decoders panel. See README.md, "Protocol decoders", for the full API; the
// built-in decoders (web/decoders/*.js in the source) are further examples.
export default {
  id: 'pwm',
  name: 'PWM',
  desc: 'Duty cycle and frequency of each period (example user decoder)',
  channels: [{ id: 'pwm', name: 'PWM', desc: 'PWM signal' }],
  options: [{ id: 'active', name: 'Active level', default: 'high', values: ['high', 'low'] }],
  rows: [{ id: 'duty', name: 'Duty' }],

  *decode(d, o) {
    const on = o.active === 'high' ? 'r' : 'f';
    const off = on === 'r' ? 'f' : 'r';
    let start = yield d.wait({ pwm: on });          // the first complete period starts here
    for (;;) {
      const mid = yield d.wait({ pwm: off });
      const end = yield d.wait({ pwm: on });
      const duty = (100 * (mid - start)) / (end - start);
      const f = d.rate / (end - start);
      const hz = f >= 1e6 ? `${(f / 1e6).toFixed(3)} MHz` : f >= 1e3 ? `${(f / 1e3).toFixed(3)} kHz` : `${f.toFixed(1)} Hz`;
      d.put(start, end, 'duty', [`${duty.toFixed(1)} % · ${hz}`, `${duty.toFixed(1)} %`, `${Math.round(duty)}`]);
      start = end;
    }
  },
};
