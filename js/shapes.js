// Organic geometry: the membrane joining two discs, and compound-eye hex grids.

const SVG_NS = "http://www.w3.org/2000/svg";

export function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const angle = (a, b) => Math.atan2(a[1] - b[1], a[0] - b[0]);
const vec = (c, a, r) => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];

// The neck between two circles, after the classic metaball construction
// (Hiroyuki Sato): tangent points on each circle joined by two Bezier curves.
// v controls how far the neck spreads, handle how round it is.
export function metaballNeck(r1, r2, c1, c2, handle = 2.4, v = 0.5) {
  const d = dist(c1, c2);
  if (!r1 || !r2 || d > r1 + r2 * 2.5 || d <= Math.abs(r1 - r2)) return "";
  let u1 = 0, u2 = 0;
  if (d < r1 + r2) {
    u1 = Math.acos((r1 * r1 + d * d - r2 * r2) / (2 * r1 * d));
    u2 = Math.acos((r2 * r2 + d * d - r1 * r1) / (2 * r2 * d));
  }
  const ab = angle(c2, c1);
  const spread = Math.acos((r1 - r2) / d);
  const a1 = ab + u1 + (spread - u1) * v;
  const a2 = ab - u1 - (spread - u1) * v;
  const a3 = ab + Math.PI - u2 - (Math.PI - u2 - spread) * v;
  const a4 = ab - Math.PI + u2 + (Math.PI - u2 - spread) * v;
  const p1 = vec(c1, a1, r1), p2 = vec(c1, a2, r1), p3 = vec(c2, a3, r2), p4 = vec(c2, a4, r2);
  const total = r1 + r2;
  const d2 = Math.min(v * handle, dist(p1, p3) / total) * Math.min(1, (d * 2) / total);
  const h1 = vec(p1, a1 - Math.PI / 2, r1 * d2), h2 = vec(p2, a2 + Math.PI / 2, r1 * d2);
  const h3 = vec(p3, a3 + Math.PI / 2, r2 * d2), h4 = vec(p4, a4 - Math.PI / 2, r2 * d2);
  const f = (p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  return `M${f(p1)} C${f(h1)} ${f(h3)} ${f(p3)} A${r2},${r2} 0 ${d > r1 ? 1 : 0} 0 ${f(p4)} C${f(h4)} ${f(h2)} ${f(p2)} Z`;
}

// Draw two discs joined by a membrane with a single hairline outline.
// Strokes are drawn first and fills on top, so only the outer half of each
// stroke survives and the union reads as one continuous organism.
export function drawMembrane(svg, c1, r1, c2, r2) {
  svg.innerHTML = "";
  const defs = el("defs", {}, svg);
  const grad = el("radialGradient", { id: "membrane-grad", cx: "35%", cy: "30%", r: "80%" }, defs);
  el("stop", { offset: "0", "stop-color": "#ffffff", "stop-opacity": "1" }, grad);
  el("stop", { offset: "1", "stop-color": "#e9ecef", "stop-opacity": ".75" }, grad);
  const neck = metaballNeck(r1, r2, c1, c2, 2.4, 0.42);
  const shapes = (cls) => {
    const g = el("g", { class: cls }, svg);
    el("circle", { cx: c1[0], cy: c1[1], r: r1 }, g);
    el("circle", { cx: c2[0], cy: c2[1], r: r2 }, g);
    if (neck) el("path", { d: neck }, g);
    return g;
  };
  shapes("stroke");
  shapes("fill");
  shapes("wash");
  // Ommatidia texture dissolving out from the neck: tiny cells, densest where the
  // two options touch.
  const mid = [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2];
  const dots = el("g", { opacity: 0.55 }, svg);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 70; i++) {
    const a = rnd() * Math.PI * 2, rr = Math.pow(rnd(), 1.8) * Math.min(r1, r2) * 0.9;
    el("circle", { cx: mid[0] + Math.cos(a) * rr * 1.4, cy: mid[1] + Math.sin(a) * rr, r: 0.6 + rnd() * 0.9, fill: "#9aa1ab" }, dots);
  }
}

// Hexagon with flat sides left/right ("pointy top"), centred at (x, y).
export function hexPoints(x, y, r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    pts.push(`${(x + r * Math.cos(a)).toFixed(2)},${(y + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(" ");
}

// The n hex cells closest to the centre of an axial grid: a round compound-eye patch.
export function hexPatch(n, r) {
  const cells = [];
  const R = Math.ceil(Math.sqrt(n)) + 2;
  for (let q = -R; q <= R; q++) {
    for (let s = -R; s <= R; s++) {
      const x = r * Math.sqrt(3) * (q + s / 2);
      const y = r * 1.5 * s;
      cells.push({ x, y, d: Math.hypot(x, y) + (Math.abs(q * 7 + s * 13) % 5) * 0.001 });
    }
  }
  cells.sort((a, b) => a.d - b.d);
  return cells.slice(0, n);
}

export function drawMark(svg) {
  svg.setAttribute("viewBox", "-20 -20 40 40");
  const r = 6.2;
  el("polygon", { points: hexPoints(0, 0, r), class: "on" }, svg);
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    el("polygon", { points: hexPoints(Math.cos(a) * r * Math.sqrt(3), Math.sin(a) * r * Math.sqrt(3), r) }, svg);
  }
}

export function hexIcon(filled) {
  const s = el("svg", { viewBox: "-20 -23 40 46", class: "hex" });
  el("polygon", { points: hexPoints(0, 0, 19) }, s);
  el("polygon", { points: hexPoints(0, 0, 11), class: "inner" }, s);
  if (filled) s.classList.add("on");
  return s;
}
