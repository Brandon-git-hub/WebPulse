// Protocol decoders: the available decoder modules (built-in and the user's
// own from the server's decoders folder), the decoders added to the view, and
// running them on the current capture in a Web Worker.

import { runDecoder } from './decode/runtime.js';
import { fetchTransitions } from './decode/transitions.js';

export const BUILTIN = ['uart', 'spi', 'i2c', 'parallel', 'counter'];
const PALETTE = ['#4fa3e0', '#e0913a', '#5fb85f', '#d9578f', '#9a7ad8', '#3fb5a8'];

let nextUid = 1;

export class Decoders {
  /**
   * onUpdate(): rows or their contents changed (relayout / redraw)
   * onError(msg): a decoder failed to load or run
   */
  constructor({ onUpdate, onError }) {
    this.defs = [];         // { key, name, source, def, error }
    this.list = [];         // { uid, key, label, color, assign, options }
    this.state = new Map(); // uid -> { status, progress, result, error, worker }
    this.capture = null;    // { key, rate }
    this.userDir = '';
    this.onUpdate = onUpdate;
    this.onError = onError;
  }

  /** (Re)load the decoder modules. User files are re-imported (cache-busted). */
  async loadDefs() {
    const defs = [];
    for (const id of BUILTIN) {
      const url = new URL(`../decoders/${id}.js`, import.meta.url).href;
      defs.push(await loadDef(`builtin:${id}`, url, 'built-in'));
    }
    try {
      const r = await fetch('api/decoders');
      const js = await r.json();
      this.userDir = js.dir || '';
      const v = Date.now();
      for (const f of js.files || []) {
        const url = new URL(`api/decoders/${encodeURIComponent(f)}?v=${v}`, location.href).href;
        defs.push(await loadDef(`user:${f}`, url, 'yours'));
      }
    } catch (e) {
      this.onError(`Cannot list your decoders: ${e.message}`);
    }
    this.defs = defs;
    for (const d of defs) if (d.error) this.onError(`${d.name}: ${d.error}`);
    // Re-run the decoders that use a reloaded module.
    for (const inst of this.list) this.run(inst);
    this.onUpdate();
  }

  def(key) {
    return this.defs.find((d) => d.key === key && d.def);
  }

  /** Add a decoder; channels are assigned to the first channels in `order`. */
  add(key, order) {
    const d = this.def(key);
    if (!d) return null;
    const assign = {};
    let k = 0;
    for (const ch of d.def.channels || []) assign[ch.id] = ch.optional ? null : order[k++ % order.length];
    const options = {};
    for (const o of d.def.options || []) options[o.id] = o.default;
    const n = this.list.filter((i) => i.key === key).length;
    const inst = {
      uid: nextUid++,
      key,
      label: d.def.name + (n ? ` ${n + 1}` : ''),
      color: PALETTE[this.list.length % PALETTE.length],
      assign,
      options,
    };
    this.list.push(inst);
    this.run(inst);
    this.onUpdate();
    return inst;
  }

  update(inst, patch) {
    Object.assign(inst, patch);
    this.run(inst);
    this.onUpdate();
  }

  remove(inst) {
    this.cancel(inst);
    this.state.delete(inst.uid);
    this.list = this.list.filter((i) => i !== inst);
    this.onUpdate();
  }

  /** Saved form: [{ key, label, color, assign, options }]. */
  serialize() {
    return this.list.map(({ key, label, color, assign, options }) => ({ key, label, color, assign, options }));
  }

  restore(saved) {
    if (!Array.isArray(saved)) return;
    for (const s of saved) {
      if (!s || typeof s.key !== 'string') continue;
      this.list.push({
        uid: nextUid++,
        key: s.key,
        label: String(s.label || s.key),
        color: /^#[0-9a-f]{6}$/i.test(s.color || '') ? s.color : PALETTE[this.list.length % PALETTE.length],
        assign: { ...(s.assign || {}) },
        options: { ...(s.options || {}) },
      });
    }
  }

  /** New capture (or null when there is none): decode everything again. */
  setCapture(cap) {
    this.capture = cap;
    for (const inst of this.list) this.run(inst);
    this.onUpdate();
  }

  cancel(inst) {
    const st = this.state.get(inst.uid);
    if (st && st.worker) st.worker.terminate();
    if (st) st.worker = null;
  }

  run(inst) {
    this.cancel(inst);
    const st = { status: 'idle', progress: 0, result: null, error: null, worker: null };
    this.state.set(inst.uid, st);
    const d = this.def(inst.key);
    if (!d) {
      st.status = 'error';
      st.error = `decoder ${inst.key} is not available`;
      return;
    }
    if (!this.capture) return;
    const assign = {};
    for (const [id, ch] of Object.entries(inst.assign)) if (ch !== null && ch !== undefined && ch !== '') assign[id] = Number(ch);
    const missing = (d.def.channels || []).filter((c) => !c.optional && !(c.id in assign));
    if (missing.length) {
      st.status = 'error';
      st.error = `assign ${missing.map((c) => c.name).join(', ')}`;
      return;
    }
    const mask = Object.values(assign).reduce((m, c) => m | (1 << c), 0);
    const options = { ...inst.options };
    const capKey = this.capture.key;
    const done = (result, error) => {
      if (this.state.get(inst.uid) !== st || !this.capture || this.capture.key !== capKey) return;
      st.worker = null;
      st.result = result;
      st.error = error || (result && result.error) || null;
      st.status = st.error && !(result && result.count) ? 'error' : 'done';
      if (st.error) this.onError(`${inst.label}: ${st.error}`);
      this.onUpdate();
    };
    st.status = 'running';
    const msg = { url: d.url, options, assign, mask, rate: this.capture.rate, base: location.href };

    if (typeof Worker === 'undefined') {
      // No workers (e.g. the Node smoke test): run here.
      fetchTransitions(msg.base, mask)
        .then((tr) => done(runDecoder(d.def, options, assign, tr, msg.rate)))
        .catch((e) => done(null, e.message));
      return;
    }
    const w = new Worker(new URL('./decode/worker.js', import.meta.url), { type: 'module' });
    st.worker = w;
    w.onmessage = (ev) => {
      const m = ev.data;
      if ('progress' in m) {
        st.progress = m.progress;
        this.onUpdate(false);
        return;
      }
      w.terminate();
      done(m.result || null, m.error);
    };
    w.onerror = (ev) => {
      w.terminate();
      done(null, ev.message || 'decoder worker failed');
    };
    w.postMessage(msg);
  }

  /** Rows for the renderer, top to bottom. */
  rows() {
    const out = [];
    for (const inst of this.list) {
      const d = this.def(inst.key);
      const st = this.state.get(inst.uid) || {};
      const defRows = d ? d.def.rows || [] : [{ id: '?', name: 'unavailable' }];
      defRows.forEach((r, k) => {
        let status = '';
        if (k === 0) {
          if (st.status === 'running') status = `decoding… ${Math.round(100 * (st.progress || 0))} %`;
          else if (st.status === 'error') status = st.error;
        }
        out.push({
          inst,
          label: defRows.length > 1 ? `${inst.label} · ${r.name}` : inst.label,
          color: inst.color,
          error: r.id === 'error' || st.status === 'error',
          status,
          data: st.result && st.result.rows[r.id] && st.result.rows[r.id].start.length ? st.result.rows[r.id] : null,
        });
      });
    }
    return out;
  }
}

async function loadDef(key, url, source) {
  const name = key.replace(/^(builtin|user):/, '');
  try {
    const def = (await import(url)).default;
    const bad = checkDef(def);
    if (bad) return { key, url, name, source, def: null, error: bad };
    return { key, url, name: def.name, source, def, error: null };
  } catch (e) {
    return { key, url, name, source, def: null, error: (e && e.message) || String(e) };
  }
}

/** A short reason why `def` is not a usable decoder, or ''. */
function checkDef(def) {
  if (!def || typeof def !== 'object') return 'the module has no default export';
  if (typeof def.decode !== 'function') return 'decode is not a function';
  if (!def.name) return 'name is missing';
  if (!Array.isArray(def.channels) || !def.channels.length) return 'channels is missing';
  if (!Array.isArray(def.rows) || !def.rows.length) return 'rows is missing';
  return '';
}
