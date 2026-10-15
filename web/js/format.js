// Number / time formatting helpers (pure functions, no DOM).

const SI = { k: 1e3, K: 1e3, M: 1e6, G: 1e9, g: 1e9 };

/** Parse "10M", "1.5k", "24000000" -> number, or null if invalid. */
export function parseSI(str) {
  const m = /^\s*([0-9]*\.?[0-9]+(?:e[+-]?\d+)?)\s*([kKMGg]?)\s*$/.exec(String(str));
  if (!m) return null;
  const v = parseFloat(m[1]) * (m[2] ? SI[m[2]] : 1);
  return Number.isFinite(v) ? Math.round(v) : null;
}

/** 24000000 -> "24M", 1500 -> "1.5k". */
export function formatSI(n) {
  const units = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k']];
  for (const [d, u] of units) {
    if (Math.abs(n) >= d) return trimZeros((n / d).toFixed(3)) + u;
  }
  return String(n);
}

export function formatRate(hz) {
  if (hz >= 1e6) return trimZeros((hz / 1e6).toFixed(3)) + ' MHz';
  if (hz >= 1e3) return trimZeros((hz / 1e3).toFixed(3)) + ' kHz';
  return hz + ' Hz';
}

function trimZeros(s) {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

const TIME_UNITS = [[1, 's'], [1e-3, 'ms'], [1e-6, 'µs'], [1e-9, 'ns'], [1e-12, 'ps']];

/** Seconds -> "12.35 µs" with `digits` significant digits. */
export function formatTime(sec, digits = 4) {
  if (!Number.isFinite(sec)) return '–';
  if (sec === 0) return '0 s';
  const a = Math.abs(sec);
  let unit = TIME_UNITS[TIME_UNITS.length - 1];
  for (const u of TIME_UNITS) {
    if (a >= u[0] * 0.9995) { unit = u; break; }
  }
  const v = sec / unit[0];
  const intDigits = Math.max(1, Math.floor(Math.log10(Math.abs(v))) + 1);
  const dec = Math.max(0, digits - intDigits);
  return trimZeros(v.toFixed(dec)) + ' ' + unit[1];
}

/** Hz -> "1.234 MHz". */
export function formatFreq(hz, digits = 4) {
  if (!Number.isFinite(hz) || hz <= 0) return '–';
  const units = [[1e9, 'GHz'], [1e6, 'MHz'], [1e3, 'kHz'], [1, 'Hz']];
  let unit = units[units.length - 1];
  for (const u of units) {
    if (hz >= u[0] * 0.9995) { unit = u; break; }
  }
  const v = hz / unit[0];
  const intDigits = Math.max(1, Math.floor(Math.log10(v)) + 1);
  return trimZeros(v.toFixed(Math.max(0, digits - intDigits))) + ' ' + unit[1];
}

/** Round a step up to 1, 2 or 5 x 10^k. */
export function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

/** Label for a ruler tick at time t (s) when ticks are `step` seconds apart. */
export function tickLabel(t, step) {
  let unit = TIME_UNITS[TIME_UNITS.length - 1];
  for (const u of TIME_UNITS) {
    if (step >= u[0] * 0.9995) { unit = u; break; }
  }
  const stepInUnit = step / unit[0];
  const dec = Math.max(0, -Math.floor(Math.log10(stepInUnit) + 1e-9));
  let v = t / unit[0];
  if (Math.abs(v) < stepInUnit * 1e-6) v = 0;
  return v.toFixed(dec) + ' ' + unit[1];
}
