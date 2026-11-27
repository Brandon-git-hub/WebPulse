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
    let periods = 0, lo = Infinity, hi = -Infinity;
    try {
      let start = yield d.wait({ pwm: on });          // the first complete period starts here
      for (;;) {
        const mid = yield d.wait({ pwm: off });
        const end = yield d.wait({ pwm: on });
        const duty = (100 * (mid - start)) / (end - start);
        const hz = freq(d.rate / (end - start));
        d.put(start, end, 'duty', [`${duty.toFixed(1)} % · ${hz}`, `${duty.toFixed(1)} %`, `${Math.round(duty)}`]);
        periods++;
        lo = Math.min(lo, duty);
        hi = Math.max(hi, duty);
        start = end;
      }
    } finally {
      // Runs when the capture ends: a summary for the settings popup and the export.
      d.summary(periods ? `${periods} periods, duty ${lo.toFixed(1)} … ${hi.toFixed(1)} %` : 'no complete period');
    }
  },
};

function freq(f) {
  return f >= 1e6 ? `${(f / 1e6).toFixed(3)} MHz` : f >= 1e3 ? `${(f / 1e3).toFixed(3)} kHz` : `${f.toFixed(1)} Hz`;
}
