// The connectome view: real FlyWire v783 geometry, lit by real simulated activity.
//
// Layers (all in one shared coordinate frame, nm quantised to uint16):
//   somata    ~139k soma positions of every annotated neuron: the outline of the brain
//   context   ~2.5k neurons sampled across the brain, drawn as near-invisible filaments
//   circuit   the 5,877 mushroom-body neurons the engine simulates
//
// Activity: a per-neuron firing rate (0..1) per simulation step, uploaded as a texture
// and looked up in the vertex shader by each vertex's engine index. Nothing here is
// decorative: if a filament lights up, the engine computed a firing rate for that
// neuron. Each population lights in its own colour (see --c-* in style.css).

import * as THREE from "three";
import { OrbitControls } from "three/addons/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const NIGHT = 0x0f1216; // keep in sync with --night in style.css

const GROUP_CODES = { PN: 0, KC: 1, APL: 2, DPM: 3, PAM: 4, PPL1: 5, MBON: 6, context: 7 };
const ACT_W = 128;

export const VIEWS = {
  front: { dir: [0, 0, -1], up: [0, 1, 0] },
  top: { dir: [0, 1, -0.0001], up: [0, 0, -1] },
  side: { dir: [1, 0, 0], up: [0, 1, 0] },
  oblique: { dir: [0.55, 0.32, -0.77], up: [0, 1, 0] },
};

const LINE_VS = /* glsl */ `
  attribute float aEngine;
  attribute float aGroup;
  uniform sampler2D uAct0;
  uniform sampler2D uAct1;
  uniform float uMix;
  uniform float uActH;
  uniform float uFocus;
  uniform float uCircuitAlpha;
  uniform float uContextAlpha;
  uniform float uGroupAlpha[8];
  uniform vec3 uGroupColor[8];
  uniform float uGroupGain[8];
  uniform float uTintGroup;
  uniform float uLabel;
  varying float vGain;
  varying float vAct;
  varying float vAlpha;
  varying float vDepth;
  varying float vTint;
  varying float vLab;
  varying vec3 vCol;
  float act(sampler2D t, float e) {
    vec2 uv = vec2((mod(e, ${ACT_W}.0) + 0.5) / ${ACT_W}.0, (floor(e / ${ACT_W}.0) + 0.5) / uActH);
    return texture2D(t, uv).r;
  }
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    vDepth = clamp((-mv.z - 1.0) / 4.0, 0.0, 1.0);
    int gi = int(aGroup + 0.5);
    vCol = uGroupColor[gi];
    vGain = uGroupGain[gi];
    vTint = abs(aGroup - uTintGroup) < 0.5 ? 1.0 : 0.0;
    vLab = aEngine < 0.0 ? 0.0 : uLabel;
    if (aEngine < 0.0) {
      vAct = 0.0;
      vAlpha = uContextAlpha;
    } else {
      vAct = mix(act(uAct0, aEngine), act(uAct1, aEngine), uMix);
      float focus = (uFocus < 0.0 || abs(aGroup - uFocus) < 0.5) ? 1.0 : 0.22;
      vAlpha = uCircuitAlpha * uGroupAlpha[int(aGroup + 0.5)] * focus;
    }
  }
`;

const LINE_FS = /* glsl */ `
  uniform vec3 uInk;
  uniform float uGain;
  uniform float uTint;
  uniform float uActAlpha;
  varying float vAct;
  varying float vAlpha;
  varying float vDepth;
  varying float vTint;
  varying float vLab;
  varying float vGain;
  varying vec3 vCol;
  void main() {
    // Transfer function: rate -> visibility. Monotonic, so brighter always means a
    // higher simulated rate; the low end is suppressed so sparse coding stays legible.
    // vTint is a static anatomical label (a coloured region), never activity.
    float a = smoothstep(0.06, 0.75, vAct * uGain);
    float tint = max(vTint * uTint, vLab);
    vec3 base = mix(uInk, vCol, tint);
    vec3 c = mix(base, vCol, smoothstep(0.0, 0.25, a));
    float alpha = vAlpha * (1.0 + 2.2 * tint) * (1.0 - 0.45 * vDepth) * (1.0 - 0.6 * a) + a * uActAlpha * vGain;
    gl_FragColor = vec4(c, clamp(alpha, 0.0, 0.85));
  }
`;

const POINT_VS = /* glsl */ `
  attribute float aEngine;
  attribute float aGroup;
  uniform vec3 uGroupColor[8];
  uniform float uGroupGain[8];
  varying vec3 vCol;
  varying float vGain;
  uniform sampler2D uAct0;
  uniform sampler2D uAct1;
  uniform float uMix;
  uniform float uActH;
  uniform float uSize;
  uniform float uPixelRatio;
  varying float vAct;
  float act(sampler2D t, float e) {
    vec2 uv = vec2((mod(e, ${ACT_W}.0) + 0.5) / ${ACT_W}.0, (floor(e / ${ACT_W}.0) + 0.5) / uActH);
    return texture2D(t, uv).r;
  }
  void main() {
    vAct = mix(act(uAct0, aEngine), act(uAct1, aEngine), uMix);
    vCol = uGroupColor[int(aGroup + 0.5)];
    vGain = uGroupGain[int(aGroup + 0.5)];
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * uPixelRatio * (0.4 + 2.2 * vAct) / max(0.6, -mv.z * 0.35);
  }
`;

const POINT_FS = /* glsl */ `
  uniform float uGain;
  uniform float uGlow;
  varying float vAct;
  varying vec3 vCol;
  varying float vGain;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d);
    float a = smoothstep(0.06, 0.75, vAct * uGain);
    float glow = smoothstep(0.5, 0.0, r);
    gl_FragColor = vec4(vCol, glow * glow * a * uGlow * vGain * vGain);
    if (gl_FragColor.a < 0.01) discard;
  }
`;

const NODE_VS = /* glsl */ `
  attribute float aEngine;
  attribute float aGroup;
  uniform vec3 uGroupColor[8];
  uniform float uLabel;
  varying vec3 vCol;
  varying float vLabel;
  attribute float aSize;
  attribute float aAlpha;
  uniform sampler2D uAct0;
  uniform sampler2D uAct1;
  uniform float uMix;
  uniform float uActH;
  uniform float uPixelRatio;
  uniform float uNodeAlpha;
  varying float vAct;
  varying float vAlpha;
  float act(sampler2D t, float e) {
    vec2 uv = vec2((mod(e, ${ACT_W}.0) + 0.5) / ${ACT_W}.0, (floor(e / ${ACT_W}.0) + 0.5) / uActH);
    return texture2D(t, uv).r;
  }
  void main() {
    vAct = mix(act(uAct0, aEngine), act(uAct1, aEngine), uMix);
    vCol = uGroupColor[int(aGroup + 0.5)];
    vLabel = uLabel;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float depth = clamp((-mv.z - 1.0) / 4.0, 0.0, 1.0);
    vAlpha = aAlpha * uNodeAlpha * (1.0 - 0.5 * depth);
    gl_PointSize = aSize * uPixelRatio * 3.4 / max(1.2, -mv.z);
  }
`;

const NODE_FS = /* glsl */ `
  uniform vec3 uInk;
  uniform float uGain;
  varying float vAct;
  varying float vAlpha;
  varying vec3 vCol;
  varying float vLabel;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float a = smoothstep(0.06, 0.75, vAct * uGain);
    float edge = smoothstep(0.25, 0.16, r2);
    gl_FragColor = vec4(mix(uInk, vCol, max(a, 0.6 * vLabel)), vAlpha * edge);
  }
`;

const SOMA_VS = /* glsl */ `
  uniform float uSize;
  uniform float uPixelRatio;
  varying float vDepth;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    vDepth = clamp((-mv.z - 1.0) / 4.0, 0.0, 1.0);
    gl_PointSize = uSize * uPixelRatio;
  }
`;

const SOMA_FS = /* glsl */ `
  uniform vec3 uInk;
  uniform float uAlpha;
  varying float vDepth;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    if (dot(d, d) > 0.25) discard;
    gl_FragColor = vec4(uInk, uAlpha * (1.0 - 0.6 * vDepth));
  }
`;

// Shader materials write colours untouched, so hex tokens are kept in sRGB
// (no linear conversion); otherwise every ink would render darker than its token.
function color(hex) {
  return new THREE.Color().setStyle(hex, THREE.LinearSRGBColorSpace);
}

export class Brain {
  constructor(container, { dataUrl = "data/", onProgress = () => {} } = {}) {
    this.container = container;
    this.dataUrl = dataUrl;
    this.onProgress = onProgress;
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.anchors = {};
    this.listeners = new Set();
    this._initRenderer();
  }

  _initRenderer() {
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setClearColor(0xffffff, 0);
    this.container.appendChild(r.domElement);
    r.domElement.setAttribute("aria-label", "3D view of the fruit-fly connectome");
    r.domElement.setAttribute("role", "img");

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 9;
    this.controls.autoRotate = !this.reduced;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.addEventListener("start", () => (this._userTouched = performance.now()));

    this.root = new THREE.Group();
    this.scene.add(this.root);

    const H = Math.ceil(6000 / ACT_W);
    this.actH = H;
    const make = () => {
      const t = new THREE.DataTexture(new Uint8Array(ACT_W * H), ACT_W, H, THREE.RedFormat, THREE.UnsignedByteType);
      t.needsUpdate = true;
      return t;
    };
    this.act0 = make();
    this.act1 = make();

    const css = getComputedStyle(document.documentElement);
    const tok = (n, d) => (css.getPropertyValue(n).trim() || d);
    this.shared = {
      uAct0: { value: this.act0 },
      uAct1: { value: this.act1 },
      uMix: { value: 0 },
      uActH: { value: H },
      uGain: { value: 1.0 },
      uInk: { value: color(tok("--brain-ink", "#3a3f46")) },
      // Population colours, in GROUP_CODES order: PN KC APL DPM PAM PPL1 MBON context.
      uGroupColor: { value: ["--c-pn", "--c-kc", "--c-apl", "--c-apl", "--c-pam", "--c-ppl1", "--c-mbon", "--brain-ink"].map((v) => color(tok(v, "#888888"))) },
      uLabel: { value: 0 },
      // Per-population brightness of activity: crowded populations (5,177 Kenyon
      // cells) are drawn fainter per neuron so their sum does not burn to white.
      // Within a population, brighter still always means a higher rate.
      uGroupGain: { value: [1, 1, 1, 1, 1, 1, 1, 1] },
      uPixelRatio: { value: r.getPixelRatio() },
    };
    this.palette = this.shared.uGroupColor.value.map((c) => c.clone());

    this._resize = () => {
      const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
      r.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      if (this.composer) this.composer.setSize(w, h);
    };
    new ResizeObserver(this._resize).observe(this.container);
    this._resize();
    this.setView("oblique", false);

    const loop = (t) => {
      this._raf = requestAnimationFrame(loop);
      if (this._tween) this._stepTween(t);
      if (this.lineUniforms) {
        const u = this.lineUniforms.uTint;
        u.value += ((this._tintTarget || 0) - u.value) * 0.05;
        const l = this.shared.uLabel;
        l.value += ((this._labelTarget || 0) - l.value) * 0.05;
      }
      this.controls.update();
      // On the dark field, active neurons bloom: light only where the engine
      // computed a rate (the threshold keeps the resting ink out of the glow).
      if (this._dark && this.composer) {
        // Colours here are already display values (see color()), so the bloom
        // chain must not sRGB-encode them a second time.
        const cs = r.outputColorSpace;
        r.outputColorSpace = THREE.LinearSRGBColorSpace;
        this.composer.render();
        r.outputColorSpace = cs;
      }
      else r.render(this.scene, this.camera);
      this._emitAnchors();
    };
    this._raf = requestAnimationFrame(loop);
  }

  async load() {
    const get = async (name, type) => {
      const res = await fetch(this.dataUrl + name);
      if (!res.ok) throw new Error(`${name}: ${res.status}`);
      return type === "json" ? res.json() : res.arrayBuffer();
    };
    this.onProgress(0.05, "Loading specimen");
    const [meta, bin, somata] = await Promise.all([
      get("connectome.json", "json"),
      get("connectome.bin"),
      get("somata.bin"),
    ]);
    this.onProgress(0.7, "Assembling 8,356 neurons");
    this.meta = meta;
    this._buildFrame(meta);
    this._buildSomata(new Uint16Array(somata));
    this._buildSkeletons(meta, bin);
    this.onProgress(1, "Ready");
    return this;
  }

  // Map uint16 grid coordinates into scene units: centred, x spanning ~2.4 units, y up.
  _buildFrame(meta) {
    const lo = meta.bbox.min, hi = meta.bbox.max;
    const ext = hi.map((h, i) => h - lo[i]);
    const s = 2.4 / ext[0];
    this.toScene = new THREE.Matrix4().set(
      (ext[0] / 65535) * s, 0, 0, -ext[0] * s / 2,
      0, -(ext[1] / 65535) * s, 0, ext[1] * s / 2,
      0, 0, -(ext[2] / 65535) * s, ext[2] * s / 2,
      0, 0, 0, 1,
    );
    this.nmToScene = s;
  }

  _buildSomata(q) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(q), 3));
    g.applyMatrix4(this.toScene);
    const m = new THREE.ShaderMaterial({
      vertexShader: SOMA_VS,
      fragmentShader: SOMA_FS,
      uniforms: { ...this.shared, uSize: { value: 1.2 }, uAlpha: { value: 0.085 } },
      transparent: true,
      depthWrite: false,
    });
    this.somata = new THREE.Points(g, m);
    this.root.add(this.somata);
  }

  _buildSkeletons(meta, buf) {
    const n = meta.counts.vertices;
    const L = meta.layout;
    const pos = new Uint16Array(buf, L.positions.offset, n * 3);
    const neuron = new Uint16Array(buf, L.neuron.offset, n);
    const parent = new Uint16Array(buf, L.parent.offset, n);
    const neurons = meta.neurons; // [root_id, group, cell_type, engine_index, v0, nv]

    const engine = new Float32Array(n);
    const group = new Float32Array(n);
    const index = [];
    for (let k = 0; k < neurons.length; k++) {
      const [, g, , e, v0, nv] = neurons[k];
      const gc = GROUP_CODES[g];
      for (let i = 0; i < nv; i++) {
        engine[v0 + i] = e;
        group[v0 + i] = gc;
        const p = parent[v0 + i];
        if (p !== i) index.push(v0 + i, v0 + p);
      }
    }
    void neuron;

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute("aEngine", new THREE.BufferAttribute(engine, 1));
    g.setAttribute("aGroup", new THREE.BufferAttribute(group, 1));
    g.setIndex(index);
    g.applyMatrix4(this.toScene);

    this.lineUniforms = {
      ...this.shared,
      uFocus: { value: -1 },
      uCircuitAlpha: { value: 1 },
      uContextAlpha: { value: 0.045 },
      // Per-population base opacity, chosen so dense populations (5,177 KCs) read as a
      // pencil haze rather than a black mass: PN KC APL DPM PAM PPL1 MBON context.
      uGroupAlpha: { value: [0.085, 0.017, 0.06, 0.06, 0.055, 0.09, 0.095, 1] },
      uTintGroup: { value: -1 },
      uTint: { value: 0 },
      uActAlpha: { value: 0.34 },
    };
    const m = new THREE.ShaderMaterial({
      vertexShader: LINE_VS,
      fragmentShader: LINE_FS,
      uniforms: this.lineUniforms,
      transparent: true,
      depthWrite: false,
    });
    this.lines = new THREE.LineSegments(g, m);
    this.root.add(this.lines);

    // One glowing point per simulated neuron, at its root (soma side): the "light".
    const P = new Float32Array(neurons.length * 3);
    const E = new Float32Array(neurons.length);
    const Gc = new Float32Array(neurons.length);
    let k2 = 0;
    const centroids = {};
    const cpos = g.getAttribute("position");
    for (const [, gname, , e, v0, nv] of neurons) {
      if (e < 0) continue;
      P[k2 * 3] = cpos.getX(v0); P[k2 * 3 + 1] = cpos.getY(v0); P[k2 * 3 + 2] = cpos.getZ(v0);
      E[k2] = e;
      Gc[k2] = GROUP_CODES[gname];
      k2++;
      // Anchor annotations on one hemisphere: a bilateral centroid would land on
      // the midline, between the two mushroom bodies, on nothing.
      const c = (centroids[gname] ||= { x: 0, y: 0, z: 0, n: 0 });
      for (let i = 0; i < nv; i += 2) {
        if (cpos.getX(v0 + i) < 0.05) continue;
        c.x += cpos.getX(v0 + i); c.y += cpos.getY(v0 + i); c.z += cpos.getZ(v0 + i); c.n++;
      }
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(P.slice(0, k2 * 3), 3));
    pg.setAttribute("aEngine", new THREE.BufferAttribute(E.slice(0, k2), 1));
    pg.setAttribute("aGroup", new THREE.BufferAttribute(Gc.slice(0, k2), 1));

    // Nodes: every simulated neuron as a dot at its soma, sized by how few and how
    // large its population is (two APL giants read as hubs, 5,177 KCs as dust).
    const NODE = { PN: [2.2, 0.5], KC: [1.3, 0.12], APL: [6.5, 0.9], DPM: [5.5, 0.9], PAM: [2.4, 0.55], PPL1: [4.6, 0.85], MBON: [3.8, 0.8] };
    const sizes = new Float32Array(k2), alphas = new Float32Array(k2);
    let k3 = 0;
    for (const [, gname, , e] of neurons) {
      if (e < 0) continue;
      [sizes[k3], alphas[k3]] = NODE[gname] || [1.5, 0.3];
      k3++;
    }
    const ng = new THREE.BufferGeometry();
    ng.setAttribute("position", pg.getAttribute("position"));
    ng.setAttribute("aEngine", pg.getAttribute("aEngine"));
    ng.setAttribute("aGroup", pg.getAttribute("aGroup"));
    ng.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    ng.setAttribute("aAlpha", new THREE.BufferAttribute(alphas, 1));
    this.nodeUniforms = { ...this.shared, uInk: { value: color("#141518") }, uNodeAlpha: { value: 1 } };
    this.nodes = new THREE.Points(ng, new THREE.ShaderMaterial({
      vertexShader: NODE_VS,
      fragmentShader: NODE_FS,
      uniforms: this.nodeUniforms,
      transparent: true,
      depthWrite: false,
    }));
    this.root.add(this.nodes);
    this.glow = new THREE.Points(pg, new THREE.ShaderMaterial({
      vertexShader: POINT_VS,
      fragmentShader: POINT_FS,
      uniforms: { ...this.shared, uSize: { value: 7 }, uGlow: { value: 0.7 } },
      transparent: true,
      depthWrite: false,
    }));
    this.root.add(this.glow);

    for (const [k, c] of Object.entries(centroids)) {
      if (c.n) this.anchors[k] = new THREE.Vector3(c.x / c.n, c.y / c.n, c.z / c.n);
    }
    // Centre the scene on the mushroom body so rotation orbits the circuit.
    const kc = this.anchors.KC;
    this.root.position.set(-kc.x * 0.55, -kc.y * 0.55, -kc.z * 0.55);
  }

  // ------------------------------------------------------------- activity
  setActivity(a, b = a, mix = 0) {
    for (const [tex, src] of [[this.act0, a], [this.act1, b]]) {
      if (!src) continue;
      tex.image.data.set(src.subarray(0, Math.min(src.length, tex.image.data.length)));
      tex.needsUpdate = true;
    }
    this.shared.uMix.value = mix;
  }

  clearActivity() {
    this.act0.image.data.fill(0); this.act0.needsUpdate = true;
    this.act1.image.data.fill(0); this.act1.needsUpdate = true;
  }

  // Colour every simulated population by its own colour, as a labelled plate (eased).
  setLabel(on) {
    this._labelTarget = on ? 1 : 0;
  }

  // Light paper or dark field. On dark, ink becomes chalk and activity glows additively.
  setTheme(dark) {
    if (!this.lineUniforms || this._dark === dark) return;
    this._dark = dark;
    if (dark && !this.composer) {
      const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
      this.composer = new EffectComposer(this.renderer);
      this.composer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      this.composer.setSize(w, h);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.6, 0.4, 0.45);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass()); // back to sRGB, like a direct render
    }
    this.renderer.setClearColor(new THREE.Color().setHex(dark ? NIGHT : 0xffffff, THREE.LinearSRGBColorSpace), dark ? 1 : 0);
    this.shared.uGroupGain.value = dark ? [1, 0.3, 0.8, 0.8, 0.85, 1, 1, 1] : [1, 0.75, 1, 1, 1, 1, 1, 1];
    this.shared.uInk.value.copy(color(dark ? "#7d8796" : getComputedStyle(document.documentElement).getPropertyValue("--brain-ink").trim() || "#3a3f46"));
    this.nodeUniforms.uInk.value.copy(color(dark ? "#e8ebf0" : "#141518"));
    this.lineUniforms.uActAlpha.value = dark ? 0.5 : 0.62;
    this.somata.material.uniforms.uAlpha.value = dark ? 0.06 : 0.085;
    const gm = this.glow.material;
    gm.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    gm.uniforms.uGlow.value = dark ? 0.4 : 0.75;
    gm.needsUpdate = true;
  }

  // Static highlight of one population (eased in and out); not activity.
  setTint(group, amount = 1) {
    if (!this.lineUniforms) return;
    if (group != null) this.lineUniforms.uTintGroup.value = GROUP_CODES[group];
    this._tintTarget = group == null ? 0 : amount;
  }

  focus(group) {
    if (this.lineUniforms) this.lineUniforms.uFocus.value = group == null ? -1 : GROUP_CODES[group];
  }

  setDensity({ circuit = 1, context = 0.05, somata = 0.11 } = {}) {
    if (!this.lineUniforms) return;
    this.lineUniforms.uCircuitAlpha.value = circuit;
    this.lineUniforms.uContextAlpha.value = context;
    this.somata.material.uniforms.uAlpha.value = somata;
  }

  // ------------------------------------------------------------- camera
  setView(name, animate = true, distance) {
    const v = VIEWS[name] || VIEWS.oblique;
    const d = distance ?? (this.camera.aspect < 0.8 ? 5.4 : 3.6);
    const to = new THREE.Vector3(...v.dir).normalize().multiplyScalar(-d);
    const up = new THREE.Vector3(...v.up);
    if (!animate || this.reduced) {
      this.camera.position.copy(to);
      this.camera.up.copy(up);
      this.camera.lookAt(0, 0, 0);
      this.controls.target.set(0, 0, 0);
      return;
    }
    this._tween = { from: this.camera.position.clone(), to, upFrom: this.camera.up.clone(), up, t0: performance.now(), dur: 1100 };
  }

  _stepTween(now) {
    const tw = this._tween;
    const k = Math.min(1, (now - tw.t0) / tw.dur);
    const e = 1 - Math.pow(1 - k, 3);
    // Interpolate on a sphere so the camera arcs around the specimen.
    const r = THREE.MathUtils.lerp(tw.from.length(), tw.to.length(), e);
    const dir = tw.from.clone().normalize().lerp(tw.to.clone().normalize(), e).normalize();
    this.camera.position.copy(dir.multiplyScalar(r));
    this.camera.up.copy(tw.upFrom.clone().lerp(tw.up, e).normalize());
    this.camera.lookAt(0, 0, 0);
    if (k >= 1) this._tween = null;
  }

  setAutoRotate(on, speed = 0.35) {
    this.controls.autoRotate = on && !this.reduced;
    this.controls.autoRotateSpeed = speed;
  }

  setZoom(distance) {
    const p = this.camera.position;
    p.setLength(distance);
  }

  // Render the specimen from a preset view into a small image (for view thumbnails).
  snapshot(view, size = 160, distance = 3.9) {
    const cam = this.camera.clone();
    const v = VIEWS[view];
    cam.aspect = 1;
    cam.position.copy(new THREE.Vector3(...v.dir).normalize().multiplyScalar(-distance));
    // Small images accumulate more line overlap per pixel; thin the ink to compensate.
    const u = this.lineUniforms, thin = Math.min(1, size / 400);
    const saved = [...u.uGroupAlpha.value], savedCtx = u.uContextAlpha.value, savedSoma = this.somata.material.uniforms.uAlpha.value;
    const savedTint = u.uTint.value, savedNode = this.nodeUniforms.uNodeAlpha.value;
    u.uGroupAlpha.value = saved.map((a) => a * (0.2 + 0.8 * thin));
    u.uContextAlpha.value = savedCtx * (0.35 + 0.65 * thin);
    u.uTint.value = 0;
    this.nodeUniforms.uNodeAlpha.value = savedNode * (0.3 + 0.7 * thin);
    this.somata.material.uniforms.uAlpha.value = savedSoma * (0.3 + 0.7 * thin);
    cam.up.set(...v.up);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    const rt = new THREE.WebGLRenderTarget(size * 2, size * 2, { samples: 4 });
    const clear = [this.renderer.getClearColor(new THREE.Color()), this.renderer.getClearAlpha()];
    this.renderer.setRenderTarget(rt);
    this.renderer.setClearColor(0xffffff, 0);
    this.renderer.clear();
    this.renderer.render(this.scene, cam);
    const px = new Uint8Array(size * 2 * size * 2 * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, size * 2, size * 2, px);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(...clear);
    rt.dispose();
    u.uGroupAlpha.value = saved;
    u.uContextAlpha.value = savedCtx;
    u.uTint.value = savedTint;
    this.nodeUniforms.uNodeAlpha.value = savedNode;
    this.somata.material.uniforms.uAlpha.value = savedSoma;
    const c = document.createElement("canvas");
    c.width = c.height = size * 2;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(size * 2, size * 2);
    for (let y = 0; y < size * 2; y++) {  // flip vertically
      img.data.set(px.subarray((size * 2 - 1 - y) * size * 8, (size * 2 - y) * size * 8), y * size * 8);
    }
    // The render target holds colour already multiplied by alpha; undo that so
    // light inks (white odour lines) stay light once composited by the page.
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a > 0 && a < 255) { const f = 255 / a; d[i] = Math.min(255, d[i] * f); d[i + 1] = Math.min(255, d[i + 1] * f); d[i + 2] = Math.min(255, d[i + 2] * f); }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL("image/png");
  }

  // A portrait of one population alone (context and other populations hidden).
  snapshotGroup(group, view = "front", size = 96) {
    const u = this.lineUniforms;
    const saved = [u.uFocus.value, u.uContextAlpha.value, this.somata.visible, this.glow.visible, this.nodes.visible, [...u.uGroupAlpha.value]];
    u.uFocus.value = GROUP_CODES[group];
    u.uContextAlpha.value = 0;
    this.somata.visible = false;
    this.glow.visible = false;
    this.nodes.visible = false;
    u.uGroupAlpha.value = u.uGroupAlpha.value.map((a, i) => (i === GROUP_CODES[group] ? Math.min(0.42, a * 5) : 0));
    const url = this.snapshot(view, size, 2.2);
    [u.uFocus.value, u.uContextAlpha.value, this.somata.visible, this.glow.visible, this.nodes.visible] = saved;
    u.uGroupAlpha.value = saved[5];
    return url;
  }

  // Render a given activity frame (Uint8 rate*255 per engine index) into an image.
  // base=false draws only the active neurons over a faint outline of the brain;
  // ink, if given, recolours the activity (option A is drawn in graphite).
  snapshotActivity(frame, { view = "front", size = 96, distance = 3.2, base = true, ink = null, outline = true } = {}) {
    const u = this.lineUniforms, sh = this.shared;
    const keep = [this.act0.image.data.slice(), this.act1.image.data.slice(), sh.uMix.value,
      [...u.uGroupAlpha.value], u.uContextAlpha.value, this.nodes.visible, sh.uGroupColor.value.map((c) => c.clone()), sh.uLabel.value];
    sh.uLabel.value = 0;
    this.setActivity(frame, frame, 0);
    if (!base) {
      u.uGroupAlpha.value = u.uGroupAlpha.value.map(() => 0);
      u.uContextAlpha.value = 0;
      this.nodes.visible = false;
    }
    if (ink) sh.uGroupColor.value.forEach((c) => c.copy(color(ink)));
    // Small images: shrink the glow halo so dots stay dots.
    const gs = this.glow.material.uniforms.uSize, keepGlow = gs.value;
    gs.value = keepGlow * Math.min(1, size / 400) * (base ? 1 : 0.45);
    // Without the base drawing, keep only a whisper of the somata as an outline.
    const sa = this.somata.material.uniforms.uAlpha, keepSoma = sa.value;
    if (!base) sa.value = outline ? keepSoma * 0.35 : 0;
    const url = this.snapshot(view, size, distance);
    gs.value = keepGlow;
    sa.value = keepSoma;
    this.act0.image.data.set(keep[0]); this.act0.needsUpdate = true;
    this.act1.image.data.set(keep[1]); this.act1.needsUpdate = true;
    sh.uMix.value = keep[2];
    u.uGroupAlpha.value = keep[3];
    u.uContextAlpha.value = keep[4];
    this.nodes.visible = keep[5];
    sh.uGroupColor.value.forEach((c, i) => c.copy(keep[6][i]));
    sh.uLabel.value = keep[7];
    return url;
  }

  // ------------------------------------------------------------- anchors
  // Screen positions of population centroids, for HTML annotations.
  onAnchors(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emitAnchors() {
    if (!this.listeners.size || !this.anchors.KC) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const out = {};
    const v = new THREE.Vector3();
    for (const [k, p] of Object.entries(this.anchors)) {
      v.copy(p).add(this.root.position).project(this.camera);
      out[k] = { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, visible: v.z < 1 };
    }
    for (const fn of this.listeners) fn(out);
  }

  canvas() {
    return this.renderer.domElement;
  }
}
