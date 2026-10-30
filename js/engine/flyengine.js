// Fly Decision Engine — JavaScript port of flyengine/ (model.py, engine.py,
// controls.py, portable.py). Runs entirely on the device: no server needed.
//
// The Python package stays the reference implementation; this file mirrors it
// section by section, and tests/test_js_engine.py checks that the two agree.
// Two deliberate differences, both in random numbers only:
//   * trial noise uses a seeded mulberry32 stream with an inverse-CDF normal
//     table instead of numpy's PCG64 + ziggurat. Results agree statistically,
//     not trial for trial.
//   * control networks (shuffled / random) are rewired with that same stream.
// Everything else (odour choice, seeds, wiring, dynamics, learning, readout)
// is identical.

// ------------------------------------------------------------------ portable
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function utf8(str) {
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Python repr() of the values that reach seed_from: str, int, float, dict, tuple.
class PyFloat { constructor(v) { this.v = v; } }
class PyTuple { constructor(items) { this.items = items; } }

function reprStr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === q) out += "\\" + q;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + q;
}

function reprFloat(x) {
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return x.toFixed(1);
  const a = Math.abs(x);
  if (a !== 0 && (a < 1e-4 || a >= 1e16)) {
    const [m, e] = x.toExponential().split("e");
    const sign = e[0] === "-" ? "-" : "+";
    return `${m}e${sign}${e.replace(/^[+-]/, "").padStart(2, "0")}`;
  }
  return String(x);
}

function pyRepr(v) {
  if (v instanceof PyFloat) return reprFloat(v.v);
  if (v instanceof PyTuple) return v.items.length === 1 ? `(${pyRepr(v.items[0])},)` : `(${v.items.map(pyRepr).join(", ")})`;
  if (typeof v === "string") return reprStr(v);
  if (typeof v === "number") return String(v);
  return `{${Object.entries(v).map(([k, x]) => `${reprStr(k)}: ${pyRepr(x)}`).join(", ")}}`;
}

export function seedFrom(...parts) {
  return crc32(utf8(pyRepr(new PyTuple(parts)))) & 0x7fffffff;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a) >>> 0;
    t = ((t + (Math.imul(t ^ (t >>> 7), 61 | t) >>> 0)) >>> 0) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sample(items, k, seed) {
  const pool = items.slice();
  const rnd = mulberry32(seed);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rnd() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, k);
}

// ------------------------------------------------------------------ random normals
// Inverse normal CDF (Acklam), tabulated at 65,536 quantiles: two normals per
// 32-bit draw. Tails are cut at ±4.2σ, irrelevant for 0.05-amplitude noise.
function invNorm(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -invNorm(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
const NORMAL = (() => {
  const t = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) t[i] = invNorm((i + 0.5) / 65536);
  return t;
})();

class Rng {
  constructor(seed) { this.u = mulberry32(seed); }
  random() { return this.u(); }
  // Fill `out` with standard normals scaled by `scale`.
  normals(out, scale = 1) {
    const n = out.length;
    let i = 0;
    for (; i + 1 < n; i += 2) {
      const bits = (this.u() * 4294967296) >>> 0;
      out[i] = NORMAL[bits & 0xffff] * scale;
      out[i + 1] = NORMAL[bits >>> 16] * scale;
    }
    if (i < n) out[i] = NORMAL[(this.u() * 65536) | 0] * scale;
    return out;
  }
  normal() { return NORMAL[(this.u() * 65536) | 0]; }
  int(n) { return Math.floor(this.u() * n); }
  permute(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
}

// ------------------------------------------------------------------ umwelt.py
// From a human option to a fly odour: the option's words are matched against
// data/umwelt.json, where each concept is something in a fly's world (ripe
// fruit, other flies, mould ...) with the glomeruli that detect it. Up to two
// concepts are used; the rest of the odour is drawn from the remaining
// glomeruli with a seed from the name. Mirrors flyengine/umwelt.py exactly.
const isLetter = (ch) => ch >= "a" && ch <= "z";
function hit(text, word) {
  const prefix = word.endsWith("*");
  const w = prefix ? word.slice(0, -1) : word;
  if (/[^\x00-\x7f]/.test(w)) return text.includes(w);
  for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + 1)) {
    const j = i + w.length;
    if ((i === 0 || !isLetter(text[i - 1])) && (prefix || j === text.length || !isLetter(text[j]))) return true;
  }
  return false;
}

export function concepts(umwelt, name) {
  const text = name.trim().toLowerCase();
  return umwelt.concepts
    .map((c, k) => [c.words.filter((w) => hit(text, w)).length, k, c])
    .filter(([n]) => n > 0)
    .sort((x, y) => y[0] - x[0] || x[1] - y[1])
    .slice(0, 2)
    .map(([, , c]) => c);
}

export function translate(umwelt, name, glomeruli, perOdor, seed) {
  const chosen = [];
  const found = concepts(umwelt, name);
  for (const c of found) for (const g of c.glomeruli) if (!chosen.includes(g) && chosen.length < umwelt.max_matched) chosen.push(g);
  const rest = glomeruli.filter((g) => !chosen.includes(g));
  chosen.push(...sample(rest, perOdor - chosen.length, seed));
  return [chosen.sort(), found.map((c) => c.id)];
}

// ------------------------------------------------------------------ data
// meta: parsed circuit.json; buffer: ArrayBuffer of circuit.bin; umwelt: parsed umwelt.json.
export function parseData(meta, buffer, umwelt) {
  const e = new Int32Array(buffer, 0, 1)[0];
  let off = 4;
  const pre = new Uint16Array(buffer.slice(off, off + 2 * e)); off += 2 * e;
  const post = new Uint16Array(buffer.slice(off, off + 2 * e)); off += 2 * e;
  const signed = new Int16Array(buffer.slice(off, off + 2 * e)); off += 2 * e;
  const group = new Uint8Array(buffer.slice(off, off + meta.n));
  return { meta, pre, post, signed, group, umwelt };
}

// ------------------------------------------------------------------ controls.py
export const TOPOLOGIES = ["real", "shuffled", "random"];

function rewire(pre, post, group, topology, seed) {
  const rng = new Rng(seed);
  pre = Uint16Array.from(pre);
  post = Uint16Array.from(post);
  const blocks = new Map();
  for (let i = 0; i < pre.length; i++) {
    const b = group[pre[i]] * 64 + group[post[i]];
    if (!blocks.has(b)) blocks.set(b, []);
    blocks.get(b).push(i);
  }
  const members = {};
  group.forEach((g, i) => (members[g] ||= []).push(i));
  for (const b of [...blocks.keys()].sort((x, y) => x - y)) {
    const e = blocks.get(b);
    if (topology === "shuffled") {
      const targets = rng.permute(e.map((i) => post[i]));
      e.forEach((i, k) => (post[i] = targets[k]));
    } else {
      const src = members[Math.floor(b / 64)], dst = members[b % 64];
      for (const i of e) { pre[i] = src[rng.int(src.length)]; post[i] = dst[rng.int(dst.length)]; }
    }
  }
  return { pre, post };
}

// ------------------------------------------------------------------ model.py
export class Circuit {
  constructor(data, topology = "real", seed = 0) {
    if (!TOPOLOGIES.includes(topology)) throw new Error(`unknown topology ${topology}`);
    const { meta, group } = data;
    this.meta = meta;
    this.umwelt = data.umwelt;
    this.params = meta.params;
    this.topology = topology;
    this.group = group;
    this.n = meta.n;
    this.cellType = meta.cell_type;
    this.idx = {};
    meta.groups.forEach((g, gi) => {
      const ids = [];
      for (let i = 0; i < this.n; i++) if (group[i] === gi) ids.push(i);
      this.idx[g] = Int32Array.from(ids);
    });
    let { pre, post } = data;
    if (topology !== "real") ({ pre, post } = rewire(pre, post, group, topology, seed));
    this.build(pre, post, data.signed);
    this.buildOdors();
  }

  build(pre, post, signed) {
    const { n, group, params, meta } = this;
    const G = meta.groups;
    const KC = G.indexOf("KC"), MBON = G.indexOf("MBON");
    const isDan = new Uint8Array(G.length);
    for (const d of meta.dan_groups) isDan[G.indexOf(d)] = 1;
    const E = pre.length;

    const inTotal = new Float64Array(n);
    for (let i = 0; i < E; i++) if (!isDan[group[pre[i]]]) inTotal[post[i]] += Math.abs(signed[i]);
    for (let i = 0; i < n; i++) if (inTotal[i] === 0) inTotal[i] = 1;
    const gainOf = G.map((g) => params.gain[g]);
    this.theta = new Float32Array(n);
    for (let i = 0; i < n; i++) this.theta[i] = params.theta[G[group[i]]];

    // Static fast edges grouped by presynaptic neuron (W transposed, CSR): each
    // step scatters only from neurons that are active, and most Kenyon cells are
    // silent. Plastic KC->MBON edges are kept as a list.
    const outCount = new Int32Array(n + 1);
    const plastic = [];
    for (let i = 0; i < E; i++) {
      if (isDan[group[pre[i]]]) continue;
      if (group[pre[i]] === KC && group[post[i]] === MBON) plastic.push(i);
      else outCount[pre[i] + 1]++;
    }
    for (let i = 0; i < n; i++) outCount[i + 1] += outCount[i];
    const fill = outCount.slice(0, n);
    this.outPtr = outCount;
    this.outIdx = new Int32Array(outCount[n]);
    this.outW = new Float32Array(outCount[n]);
    for (let i = 0; i < E; i++) {
      const p = pre[i], q = post[i];
      if (isDan[group[p]] || (group[p] === KC && group[q] === MBON)) continue;
      const k = fill[p]++;
      this.outIdx[k] = q;
      this.outW[k] = (signed[i] / inTotal[q]) * gainOf[group[q]];
    }

    const mbonIds = this.idx.MBON;
    const mbonLocal = new Int32Array(n).fill(-1);
    mbonIds.forEach((id, k) => (mbonLocal[id] = k));
    const P = plastic.length;
    this.kcPre = new Int32Array(P);
    this.plasticPost = new Int32Array(P);
    this.mbonOfEdge = new Int32Array(P);
    this.wPlastic = new Float32Array(P);
    plastic.forEach((i, e) => {
      this.kcPre[e] = pre[i];
      this.plasticPost[e] = post[i];
      this.mbonOfEdge[e] = mbonLocal[post[i]];
      this.wPlastic[e] = (signed[i] / inTotal[post[i]]) * gainOf[MBON];
    });

    // D[m, d]: share of MBON m's dopaminergic input coming from DAN d.
    const danIds = [];
    for (const g of meta.dan_groups) danIds.push(...this.idx[g]);
    this.danIds = Int32Array.from(danIds);
    const danLocal = new Int32Array(n).fill(-1);
    danIds.forEach((id, k) => (danLocal[id] = k));
    const M = mbonIds.length, ND = danIds.length, nPam = this.idx.PAM.length;
    const D = new Float64Array(M * ND);
    for (let i = 0; i < E; i++) {
      if (isDan[group[pre[i]]] && group[post[i]] === MBON) D[mbonLocal[post[i]] * ND + danLocal[pre[i]]] += Math.abs(signed[i]);
    }
    this.valence = new Float64Array(M);
    for (let m = 0; m < M; m++) {
      let pam = 0, ppl1 = 0;
      for (let d = 0; d < ND; d++) (d < nPam ? (pam += D[m * ND + d]) : (ppl1 += D[m * ND + d]));
      const total = pam + ppl1;
      const norm = total > 0 ? total : 1;
      for (let d = 0; d < ND; d++) D[m * ND + d] /= norm;
      this.valence[m] = total > 0 ? (ppl1 - pam) / norm : 0;
    }
    this.D = D;
    this.nDan = ND;
  }

  buildOdors() {
    const pns = this.idx.PN;
    this.pnGlom = Array.from(pns, (i) => this.cellType[i].split("_")[0]);
    this.glomeruli = this.meta.glomeruli;
  }

  odor(name, seed) {
    const [chosen, found] = translate(this.umwelt, name, this.glomeruli, this.params.glomeruli_per_odor, seed);
    const set = new Set(chosen);
    const pattern = new Float32Array(this.n);
    this.idx.PN.forEach((id, k) => { if (set.has(this.pnGlom[k])) pattern[id] = 1; });
    return [pattern, chosen, found];
  }

  // Simulate C columns. I: Float32Array(n*C), neuron-major. plasticW(e, c) via
  // `wAt`: either Float32Array(P) shared by all columns, or Float32Array(P*T)
  // indexed by column modulo T. groups: {name: Int32Array ids} to record;
  // colOpt: Uint8Array(C) option of each column; columns must be laid out
  // [option A trials, option B trials], T each.
  run(I, C, plasticW, T, rng, noiseScale, groups, colOpt) {
    const p = this.params, n = this.n, steps = p.steps, half = Math.floor(steps / 2);
    const r = new Float32Array(n * C), x = new Float32Array(n * C), acc = new Float32Array(n * C);
    const noise = new Float32Array(n * C);
    const sigma = p.noise * noiseScale;
    const traj = {};
    for (const g in groups) traj[g] = [new Float64Array(steps), new Float64Array(steps)];
    const movie = [new Float32Array(steps * n), new Float32Array(steps * n)];
    const shared = plasticW.length === this.wPlastic.length;
    const active = new Uint8Array(n);   // neuron has a non-zero rate in some column

    for (let t = 0; t < steps; t++) {
      x.fill(0);
      scatterStatic(x, r, active, this.outPtr, this.outIdx, this.outW, n, C);
      if (shared) scatterPlasticShared(x, r, active, this.kcPre, this.plasticPost, plasticW, C);
      else scatterPlasticTrial(x, r, active, this.kcPre, this.plasticPost, plasticW, T, C);
      if (sigma > 0) rng.normals(noise, sigma);
      integrate(r, x, I, noise, this.theta, active, p.dt_over_tau, n, C);
      if (t >= half) accumulate(acc, r);
      optionMeans(movie[0], movie[1], r, active, t * n, n, T, C);
      for (const g in groups) {
        const ids = groups[g];
        traj[g][0][t] = groupMean(movie[0], ids, t * n);
        traj[g][1][t] = groupMean(movie[1], ids, t * n);
      }
    }
    const k = 1 / (steps - half);
    for (let i = 0; i < acc.length; i++) acc[i] *= k;
    return { mean: acc, traj, movie };
  }
}

// ------------------------------------------------------------------ kernels
// Hot loops live in small monomorphic functions: JavaScriptCore optimises these
// reliably, whereas one large function with many loops gets de-optimised after
// a few calls and slows down ten-fold. Arrays are neuron-major: a[i * C + c].

// x += W r, scattered from active presynaptic neurons only.
function scatterStatic(x, r, active, outPtr, outIdx, outW, n, C) {
  for (let j = 0; j < n; j++) {
    if (active[j] === 0) continue;
    const ro = j * C;
    const end = outPtr[j + 1];
    for (let k = outPtr[j]; k < end; k++) addScaled(x, outIdx[k] * C, outW[k], r, ro, C);
  }
}

function addScaled(x, xo, w, r, ro, C) {
  for (let c = 0; c < C; c++) x[xo + c] += w * r[ro + c];
}

function scatterPlasticShared(x, r, active, kcPre, post, w, C) {
  for (let e = 0; e < kcPre.length; e++) {
    const j = kcPre[e];
    if (active[j] === 0) continue;
    addScaled(x, post[e] * C, w[e], r, j * C, C);
  }
}

// Column c uses the weights learned in trial c mod T; w is (edges × T).
function scatterPlasticTrial(x, r, active, kcPre, post, w, T, C) {
  for (let e = 0; e < kcPre.length; e++) {
    const j = kcPre[e];
    if (active[j] === 0) continue;
    const ro = j * C, xo = post[e] * C, wo = e * T;
    for (let c = 0; c < T; c++) x[xo + c] += w[wo + c] * r[ro + c];
    for (let c = T; c < C; c++) x[xo + c] += w[wo + c - T] * r[ro + c];
  }
}

// r += dt * (-r + tanh(relu(x + I - theta + noise)))
function integrate(r, x, I, noise, theta, active, dt, n, C) {
  for (let i = 0; i < n; i++) {
    const o = i * C, th = theta[i];
    let any = active[i];
    for (let c = 0; c < C; c++) {
      const v = x[o + c] + I[o + c] - th + noise[o + c];
      const rc = r[o + c];
      if (v > 0) { r[o + c] = rc + dt * (Math.tanh(v) - rc); any = 1; }
      else if (rc !== 0) r[o + c] = rc - dt * rc;
    }
    active[i] = any;
  }
}

function accumulate(acc, r) {
  for (let k = 0; k < r.length; k++) acc[k] += r[k];
}

// Trial-mean rate of every neuron for option A (columns < T) and B.
function optionMeans(m0, m1, r, active, base, n, T, C) {
  const ka = 1 / T, kb = 1 / (C - T);
  for (let i = 0; i < n; i++) {
    if (active[i] === 0) { m0[base + i] = 0; m1[base + i] = 0; continue; }
    const o = i * C;
    let s0 = 0, s1 = 0;
    for (let c = 0; c < T; c++) s0 += r[o + c];
    for (let c = T; c < C; c++) s1 += r[o + c];
    m0[base + i] = s0 * ka;
    m1[base + i] = s1 * kb;
  }
}

function groupMean(m, ids, base) {
  if (!ids.length) return NaN;
  let s = 0;
  for (let k = 0; k < ids.length; k++) s += m[base + ids[k]];
  return s / ids.length;
}

// ------------------------------------------------------------------ engine.py
const ATTRS = ["reward", "threat", "novelty", "familiarity", "effort", "uncertainty"];
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r3 = (x) => Math.round(x * 1e3) / 1e3;

function option(o) {
  const out = { name: String(o.name ?? "") };
  for (const a of ATTRS) {
    const v = o[a] === undefined || o[a] === null ? 0.5 : Number(o[a]);
    if (!(v >= 0 && v <= 1)) throw new Error(`${a} must be in [0, 1], got ${o[a]}`);
    out[a] = v;
  }
  return out;
}

const pyOption = (o) => {
  const d = { name: o.name };
  for (const a of ATTRS) d[a] = new PyFloat(o[a]);
  return d;
};

export class Engine {
  constructor(data) {
    this.data = data;
    this.meta = data.meta;
    this.circuits = {};
  }

  circuit(topology = "real") {
    return (this.circuits[topology] ||= new Circuit(this.data, topology, 0));
  }

  // Same inputs and output shape as flyengine.decide() / POST /api/decide.
  // The activity movie is returned as {raw: Uint8Array, shape} instead of base64.
  // opts.noise overrides params.noise (tests use 0 for a deterministic run).
  decide({ a, b, state = "neutral", trials = 100, seed = null, topology = "real", include_activity = false }, opts = {}) {
    const meta = this.meta;
    const S = meta.states[state];
    if (!S) throw new Error(`unknown state ${state}`);
    if (!(trials >= 1 && trials <= 500)) throw new Error("trials must be between 1 and 500");
    const c = this.circuit(topology);
    a = option(a); b = option(b);
    const options = [a, b];
    if (seed === null || seed === undefined) seed = seedFrom(pyOption(a), pyOption(b), state, trials, topology);
    const rng = new Rng(seed);
    const K = meta.constants;
    const n = c.n, T = trials, C = 2 * T;
    const noiseScale = S.noise * (opts.noise === undefined ? 1 : opts.noise / c.params.noise);

    const odors = [], glomeruli = [], meaning = [];
    options.forEach((o, slot) => {
      const [pattern, gl, found] = c.odor(o.name, seedFrom(o.name.trim().toLowerCase(), a.name === b.name ? slot : 0));
      const gain = 1 + 0.6 * o.novelty * S.novelty;
      odors.push(pattern.map((v) => v * gain));
      glomeruli.push(gl);
      meaning.push(found);
    });

    const colOpt = new Uint8Array(C);
    colOpt.fill(1, T);
    const Iodor = new Float32Array(n * C);
    for (let i = 0; i < n; i++) {
      const va = odors[0][i], vb = odors[1][i];
      if (!va && !vb) continue;
      for (let col = 0; col < C; col++) Iodor[i * C + col] = col < T ? va : vb;
    }

    // ---- 1. experience: odour + dopamine teaching signal
    const Ilearn = Iodor.slice();
    options.forEach((o, k) => {
      const jitter = new Float32Array(T);
      for (let t = 0; t < T; t++) jitter[t] = Math.max(0, 1 + K.UNCERTAINTY_JITTER * o.uncertainty * rng.normal());
      const pamDrive = K.DAN_DRIVE * o.reward * S.pam;
      const pplDrive = K.DAN_DRIVE * (o.threat + K.EFFORT_AS_THREAT * o.effort) * S.ppl1;
      for (const [ids, drive] of [[c.idx.PAM, pamDrive], [c.idx.PPL1, pplDrive]]) {
        for (const id of ids) for (let t = 0; t < T; t++) Ilearn[id * C + k * T + t] += drive * jitter[t];
      }
    });
    const groups = readoutGroups(c);
    const learn = c.run(Ilearn, C, c.wPlastic, T, rng, noiseScale, groups, colOpt);

    // dopamine-gated depression, both memories summed per trial
    const M = c.idx.MBON.length, ND = c.nDan, P = c.kcPre.length;
    const teach = new Float64Array(M * C);
    for (let m = 0; m < M; m++) {
      for (let d = 0; d < ND; d++) {
        const w = c.D[m * ND + d];
        if (!w) continue;
        const ro = c.danIds[d] * C;
        for (let col = 0; col < C; col++) teach[m * C + col] += w * learn.mean[ro + col];
      }
    }
    const etaA = c.params.eta * (1 + a.familiarity), etaB = c.params.eta * (1 + b.familiarity);
    const wTrial = new Float32Array(P * T);
    for (let e = 0; e < P; e++) {
      const ro = c.kcPre[e] * C, mo = c.mbonOfEdge[e] * C;
      for (let t = 0; t < T; t++) {
        const depA = etaA * learn.mean[ro + t] * teach[mo + t];
        const depB = etaB * learn.mean[ro + T + t] * teach[mo + T + t];
        wTrial[e * T + t] = c.wPlastic[e] * Math.exp(-(depA + depB));
      }
    }

    // ---- 2. test: each odour alone, with the learned weights of its own trial
    const test = c.run(Iodor, C, wTrial, T, rng, noiseScale, groups, colOpt);
    const mbonIds = c.idx.MBON;
    const drive = new Float64Array(C);
    mbonIds.forEach((id, m) => {
      const v = c.valence[m];
      for (let col = 0; col < C; col++) drive[col] += v * test.mean[id * C + col];
    });
    const diff = [], picks = [];
    let nA = 0;
    for (let t = 0; t < T; t++) {
      const d = drive[t] - drive[T + t];
      diff.push(r4(d));
      const pickA = d > 0 || (d === 0 && rng.random() < 0.5);
      picks.push(pickA ? "A" : "B");
      if (pickA) nA++;
    }

    const result = {
      choice: nA > T - nA ? "A" : nA < T - nA ? "B" : "tie",
      counts: { A: nA, B: T - nA },
      picks,
      trials: T,
      seed,
      state,
      topology,
      options,
      odors: glomeruli,
      meaning,
      drive: { A: stats(drive.subarray(0, T)), B: stats(drive.subarray(T)), diff },
      populations: populations(c, learn.mean, test.mean, C, T),
      trajectory: { experience: trajectory(learn.traj), test: trajectory(test.traj) },
      decision_trace: [0, 1].map((k) => {
        const out = [];
        for (let t = 0; t < c.params.steps; t++) {
          let s = 0;
          mbonIds.forEach((id, m) => (s += test.movie[k][t * n + id] * c.valence[m]));
          out.push(r4(s));
        }
        return out;
      }),
      mbons: mbonTable(c, test.mean, C, T),
      teaching: teaching(c, learn.mean, C, T),
      engine: "js",
    };
    if (include_activity) result.movie = encodeMovie(learn.movie, test.movie, c.params.steps, n);
    return result;
  }
}

function readoutGroups(c) {
  const groups = {};
  for (const g of c.meta.groups) groups[g] = c.idx[g];
  const mb = c.idx.MBON;
  groups.MBON_approach = mb.filter((_, m) => c.valence[m] > 0);
  groups.MBON_avoid = mb.filter((_, m) => c.valence[m] < 0);
  return groups;
}

function encodeMovie(learn, test, steps, n) {
  const raw = new Uint8Array(4 * steps * n);
  [learn[0], learn[1], test[0], test[1]].forEach((m, k) => {
    const o = k * steps * n;
    for (let i = 0; i < m.length; i++) {
      const v = Math.round(m[i] * 255);
      raw[o + i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  });
  return { raw, shape: [2, 2, steps, n] };
}

function stats(x) {
  let s = 0;
  for (const v of x) s += v;
  const mean = s / x.length;
  let q = 0;
  for (const v of x) q += (v - mean) * (v - mean);
  return { mean: r4(mean), std: r4(Math.sqrt(q / x.length)) };
}

function meanOver(rates, ids, C, T, k, pred) {
  let s = 0, cnt = 0;
  for (const id of ids) {
    const o = id * C + k * T;
    for (let t = 0; t < T; t++) { s += pred ? (pred(rates[o + t]) ? 1 : 0) : rates[o + t]; cnt++; }
  }
  return cnt ? s / cnt : NaN;
}

function populations(c, learn, test, C, T) {
  const out = {};
  for (const g of c.meta.groups) {
    const ids = c.idx[g];
    out[g] = {
      n: ids.length,
      experience: [0, 1].map((k) => r4(meanOver(learn, ids, C, T, k))),
      test: [0, 1].map((k) => r4(meanOver(test, ids, C, T, k))),
      active_fraction: [0, 1].map((k) => r4(meanOver(test, ids, C, T, k, (v) => v > 0.1))),
    };
  }
  const mb = c.idx.MBON;
  for (const [name, keep] of [["MBON_approach", (v) => v > 0], ["MBON_avoid", (v) => v < 0]]) {
    const ids = mb.filter((_, m) => keep(c.valence[m]));
    out[name] = {
      n: ids.length,
      experience: [0, 1].map((k) => r4(meanOver(learn, ids, C, T, k))),
      test: [0, 1].map((k) => r4(meanOver(test, ids, C, T, k))),
    };
  }
  return out;
}

function trajectory(traj) {
  const out = {};
  for (const g in traj) out[g] = traj[g].map((arr) => Array.from(arr, r4));
  return out;
}

function mbonTable(c, test, C, T) {
  const mb = c.idx.MBON;
  const types = Array.from(mb, (id) => c.cellType[id]);
  const unique = [...new Set(types)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const rows = unique.map((type) => {
    const members = [];
    types.forEach((t, m) => t === type && members.push(m));
    const ids = members.map((m) => mb[m]);
    const ra = meanOver(test, ids, C, T, 0), rb = meanOver(test, ids, C, T, 1);
    const v = members.reduce((s, m) => s + c.valence[m], 0) / members.length;
    let contrib = 0;
    for (let t = 0; t < T; t++) {
      let s = 0;
      for (const m of members) s += c.valence[m] * (test[mb[m] * C + t] - test[mb[m] * C + T + t]);
      contrib += s;
    }
    return { type, n: members.length, valence: r3(v), rate: [r4(ra), r4(rb)], contribution: r4(contrib / T) };
  });
  rows.sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution));
  return rows;
}

function teaching(c, learn, C, T) {
  const nPam = c.idx.PAM.length;
  const pam = c.danIds.subarray(0, nPam), ppl1 = c.danIds.subarray(nPam);
  return {
    PAM: [0, 1].map((k) => r4(meanOver(learn, pam, C, T, k))),
    PPL1: [0, 1].map((k) => r4(meanOver(learn, ppl1, C, T, k))),
  };
}
