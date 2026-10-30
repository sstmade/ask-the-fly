// Ask the Fly — application flow.
//
//   00 cover → 01 dilemma → 02 questions → 03 simulation → 04 answer → 05 why
//
// Every number shown after 03 comes from the fly engine (js/engine/), which
// runs on this device; the 3D specimen is lit frame by frame with the
// per-neuron rates it returns, each population in its own colour.

import { Brain } from "./brain.js";
import { decide, warmUp } from "./engine/client.js";
import { seedFrom, translate } from "./engine/flyengine.js";
import { drawMark, el } from "./shapes.js";

const native = window.webkit?.messageHandlers;
const $ = (s) => document.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const fmt = (x, d = 2) => Number(x).toFixed(d);
const pad = (k) => String(k).padStart(2, "0");
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isMobile = () => window.innerWidth < 960;
const finePointer = window.matchMedia("(pointer: fine)").matches;

// One colour per population, defined in style.css and shared with the 3D view.
const POP = {
  PN: ["Smell", "--c-pn"],
  KC: ["Memory", "--c-kc"],
  APL: ["Inhibition", "--c-apl"],
  PAM: ["Reward", "--c-pam"],
  PPL1: ["Punishment", "--c-ppl1"],
  MBON: ["Decision", "--c-mbon"],
};
const cvar = (g) => `var(${POP[g][1]})`;

// Six questions, each asked about both options, then the fly's mood. Answers
// are five steps from 0 to 1; what each becomes inside the fly is in `fly`
// (see flyengine/engine.py for the exact mapping).
const QUESTIONS = [
  { key: "reward", topic: "Upside", pop: "PAM", q: "How good could it <em>turn out?</em>",
    answers: ["Meh", "Okay", "Good", "Great", "Life-changing"],
    fly: "<b>Reward neurons.</b> Sets how hard the fly's 307 PAM dopamine neurons fire while it smells this option." },
  { key: "threat", topic: "Risk", pop: "PPL1", q: "How badly could it <em>go wrong?</em>",
    answers: ["Not at all", "Slightly", "Somewhat", "Badly", "Disaster"],
    fly: "<b>Punishment neurons.</b> Drives the fly's 16 PPL1 dopamine neurons: more risk, more “this is bad”." },
  { key: "novelty", topic: "Newness", pop: "PN", q: "How <em>new</em> is it?",
    answers: ["Same old", "Mostly known", "A bit new", "Fresh", "Brand new"],
    fly: "<b>Smell strength.</b> Newer options smell stronger, so more of the fly's brain notices them." },
  { key: "familiarity", topic: "Familiarity", pop: "KC", q: "How well do you <em>know it</em> already?",
    answers: ["Never tried", "Barely", "Somewhat", "Well", "Inside out"],
    fly: "<b>Memory.</b> Sets how fast the fly learns about this smell, so how strong its memory of it becomes." },
  { key: "effort", topic: "Effort", pop: "PPL1", q: "How much <em>work or cost?</em>",
    answers: ["Effortless", "Light", "Some", "Heavy", "Huge"],
    fly: "<b>A mild punishment.</b> Half as strong as risk, on the same PPL1 neurons." },
  { key: "uncertainty", topic: "Unpredictability", pop: "APL", q: "How sure are you of <em>the outcome?</em>",
    answers: ["Certain", "Fairly sure", "Unsure", "Doubtful", "No idea"],
    fly: "<b>Noise.</b> Makes the teaching signal vary from fly to fly, so the 100 flies disagree more." },
  { key: "mood", topic: "The fly", pop: "MBON", q: "How is the fly <em>feeling?</em>" },
];
const STATES = [
  ["neutral", "Neutral", "As it is. Nothing tipped either way."],
  ["hungry", "Hungry", "Rewards count for more, risks a little less."],
  ["satiated", "Sated", "Rewards count for less. Harder to tempt."],
  ["cautious", "Cautious", "Risks count for more, newness for less."],
  ["exploratory", "Curious", "Newness counts for more; flies vary more."],
];
const v = (reward, threat, novelty, familiarity, effort, uncertainty) => ({ reward, threat, novelty, familiarity, effort, uncertainty });
const EXAMPLES = [
  ["Stay in and work", v(.5, 0, 0, 1, .75, 0), "Go to the party", v(.75, .5, .75, .5, .5, .75)],
  ["Quit the job", v(.75, .75, 1, 0, .75, 1), "Stay another year", v(.25, .25, 0, 1, .5, .25)],
  ["Text them", v(.5, .75, .5, .5, .25, 1), "Let it go", v(.25, 0, 0, .75, 0, .25)],
  ["Sleep now", v(.5, 0, 0, 1, 0, 0), "Five more minutes", v(.75, .25, .5, 1, 0, .25)],
  ["Move to a new city", v(.75, .5, 1, 0, .75, .75), "Stay put", v(.5, .25, 0, 1, .25, .25)],
  ["Buy it", v(.75, .5, .75, .25, 0, .5), "Walk away", v(.25, 0, 0, 1, 0, 0)],
];
const CHANNELS = [
  ["PN", "Smell", "--c-pn"],
  ["KC", "Memory", "--c-kc"],
  ["APL", "Brake", "--c-apl"],
  ["PAM", "Reward", "--c-pam"],
  ["PPL1", "Punish", "--c-ppl1"],
  ["MBON_approach", "Approach", "--c-mbon"],
  ["MBON_avoid", "Avoid", "--ink-on-dark"],
];
// Cover annotations: one word per population, as on a specimen plate.
const ANNOTATE = {
  KC: { dx: 150, dy: -120 },
  PN: { dx: -170, dy: 96 },
  PAM: { dx: -160, dy: -84 },
  PPL1: { dx: 170, dy: 30 },
  MBON: { dx: 140, dy: 120 },
};

const state = {
  step: 0,
  maxStep: 0,
  q: 0,
  vals: { a: { ...EXAMPLES[0][1] }, b: { ...EXAMPLES[0][3] } },
  mood: "neutral",
  result: null,
  playback: null,
  circuit: null,
};

// ------------------------------------------------------------------ motion helpers
// Split a heading into words that rise from behind a mask; <em> stays one word.
function split(node) {
  const out = [];
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 3) {
      for (const part of child.textContent.split(/(\s+)/)) {
        if (!part) continue;
        out.push(/^\s+$/.test(part) ? document.createTextNode(part) : wrap(document.createTextNode(part)));
      }
    } else if (child.nodeName === "BR") out.push(child);
    else out.push(wrap(child));
  }
  node.replaceChildren(...out);
  $$(".w > span", node).forEach((s, i) => s.style.setProperty("--w", i));
  function wrap(n) {
    const w = document.createElement("span"), inner = document.createElement("span");
    w.className = "w"; inner.appendChild(n); w.appendChild(inner);
    return w;
  }
}
$$(".split").forEach(split);

// Replay the entrance of a screen's elements, staggered in document order.
function reveal(screen) {
  $$("[data-r]", screen).forEach((e, i) => {
    e.style.setProperty("--i", i);
    e.style.animation = "none"; void e.offsetWidth; e.style.animation = "";
  });
  $$(".split .w > span", screen).forEach((e) => { e.style.animation = "none"; void e.offsetWidth; e.style.animation = ""; });
}

// Buttons fill from where the pointer enters, and the big ones lean towards it.
document.addEventListener("pointermove", (e) => {
  const t = e.target.closest?.(".cta, .chip");
  if (t) {
    const r = t.getBoundingClientRect();
    t.style.setProperty("--mx", `${e.clientX - r.left}px`);
    t.style.setProperty("--my", `${e.clientY - r.top}px`);
  }
}, { passive: true });
if (finePointer && !reduced) {
  document.addEventListener("pointermove", (e) => {
    for (const m of $$(".screen.active .magnetic")) {
      const r = m.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const dx = e.clientX - cx, dy = e.clientY - cy;
      const near = Math.abs(dx) < r.width / 2 + 40 && Math.abs(dy) < r.height / 2 + 40;
      m.style.transform = near ? `translate(${dx * 0.18}px, ${dy * 0.3}px)` : "";
    }
  }, { passive: true });
}

// ------------------------------------------------------------------ boot
drawMark($(".mark-eye"));
if (new URLSearchParams(location.search).get("mode") === "app") document.body.classList.add("app");
document.documentElement.style.setProperty("--ink-on-dark", "#e8ebf0");

const brain = new Brain($("#specimen"), {
  dataUrl: "data/",
  onProgress: (_, label) => ($("#loading span").textContent = label),
});
brain.load().then(() => {
  $("#loading").classList.add("done");
  stageSpecimen(state.step);
  initAnnotations();
  window.__flyReady = true;
  warmUp().catch(() => {});
  loadCircuitMeta().then(drawOdours);
  // Test hook used by the iOS build check: ask the default dilemma unattended.
  if (new URLSearchParams(location.search).get("autorun") === "1") { goTo(1); goTo(2); run(); }
}).catch((e) => {
  $("#loading span").textContent = "The specimen could not be loaded: " + e.message;
});

// legend on the cover: hover a population to isolate it in the brain
for (const g of ["PN", "KC", "PAM", "PPL1", "MBON", "APL"]) {
  const li = document.createElement("li");
  li.style.setProperty("--c", cvar(g));
  li.innerHTML = `<i></i>${POP[g][0]}`;
  li.onpointerenter = () => brain.focus(g);
  li.onpointerleave = () => brain.focus(null);
  $("#legend").appendChild(li);
}

// ------------------------------------------------------------------ navigation
function goTo(step) {
  if (step === 3 && !state.result && !state.playback) return run();
  if (step >= 4 && !state.result) return;
  if (step === 2 && state.step !== 2 && state.step < 3) state.q = 0;
  setStep(step);
  stageSpecimen(step);
  if (step === 1) drawOdours();
  if (step === 2) renderQuestion(0);
  if (step === 4) renderResult();
  if (step === 5) { renderInsight(); replay(state.result); }
}

function setStep(step) {
  state.step = step;
  state.maxStep = Math.max(state.maxStep, step);
  document.body.dataset.step = step;
  document.body.classList.toggle("dark", step === 3);
  if (step !== 5) stopReplay();
  for (const s of $$(".screen")) {
    const on = Number(s.dataset.step) === step;
    if (on && !s.classList.contains("active")) reveal(s);
    s.classList.toggle("active", on);
  }
  $$(".progress button").forEach((b) => {
    const k = Number(b.dataset.goto);
    b.classList.toggle("current", k === step);
    b.classList.toggle("done", k < step);
    b.disabled = k === step || k > state.maxStep || (k >= 3 && !state.result);
  });
}

function stageSpecimen(step) {
  if (!brain.lines) return;
  const view = { 0: "oblique", 1: "oblique", 2: "oblique", 3: "front", 4: "oblique", 5: "front" }[step];
  brain.setView(view, true, isMobile() ? (step === 0 ? 3.4 : 4.6) : step === 3 ? 2.9 : 3.5);
  // a slow drift during the simulation, a calmer turn elsewhere
  brain.setAutoRotate(true, step === 3 ? 0.22 : 0.35);
  brain.setTheme(step === 3);
  brain.focus(null);
  // On the cover every population wears its colour as a label, never as activity.
  brain.setLabel(step === 0);
  if (step <= 2) brain.clearActivity();
  if ((step === 4 || step === 5) && state.result) showFinalFrame();
  if (step === 0) $("#caption-live").textContent = "Coloured by population · anatomy, not activity";
  else if (step === 5) $("#caption-live").textContent = "Last moment of the test · brightness = simulated rate";
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-goto]");
  if (!t || t.disabled) return;
  e.preventDefault();
  goTo(Number(t.dataset.goto));
});
document.addEventListener("keydown", (e) => {
  if (e.target.matches("textarea, input, select")) return;
  if (e.key === "Escape") return closeMethod();
  if (!method.hidden) return;
  if (state.step === 2 && /^[1-5]$/.test(e.key)) return pickByKey(Number(e.key) - 1);
  if (e.key === "ArrowRight") {
    if (state.step === 0) goTo(1);
    else if (state.step === 1) goTo(2);
    else if (state.step === 2) $("#q-next").click();
    else if (state.step === 4) goTo(5);
  }
  if (e.key === "ArrowLeft") {
    if (state.step === 2) $("#q-prev").click();
    else if (state.step > 0 && state.step !== 3) goTo(state.step === 4 ? 2 : state.step - 1);
  }
});

// ------------------------------------------------------------------ 01 dilemma
const nameA = $("#name-a"), nameB = $("#name-b");
const optName = (slot) => (slot === "a" ? nameA : nameB).value.trim() || (slot === "a" ? "Option A" : "Option B");
function setExample([a, va, b, vb]) {
  nameA.value = a; nameB.value = b;
  state.vals.a = { ...va }; state.vals.b = { ...vb };
  namesChanged();
}
for (const ex of EXAMPLES) {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.textContent = `${ex[0]} vs ${ex[2]}`;
  b.onclick = () => { setExample(ex); invalidate(); pulseCards(); };
  li.appendChild(b);
  $("#examples").appendChild(li);
}
function pulseCards() {
  for (const c of $$(".card")) c.animate([{ transform: getComputedStyle(c).transform }, { transform: "scale(.96)" }, { transform: getComputedStyle(c).transform }], { duration: 500, easing: "cubic-bezier(.34,1.56,.64,1)" });
}
$("#swap").onclick = () => {
  [nameA.value, nameB.value] = [nameB.value, nameA.value];
  [state.vals.a, state.vals.b] = [state.vals.b, state.vals.a];
  $("#swap").classList.toggle("spin");
  namesChanged(); invalidate(); pulseCards();
};
for (const t of [nameA, nameB]) {
  t.addEventListener("input", () => { namesChanged(); invalidate(); });
  t.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); (t === nameA ? nameB : $("#to-questions")).focus(); } });
}
$("#to-questions").onclick = () => goTo(2);
function namesChanged() {
  clearTimeout(namesChanged.t);
  namesChanged.t = setTimeout(drawOdours, 260);
}

// Each option's smell, exactly as the engine will build it: the option's words
// are translated into things in a fly's world (data/umwelt.json), which pick
// glomeruli; the name fills the rest of the 8. Their projection neurons are
// drawn on the card. This is the real input pattern, not decoration.
async function loadCircuitMeta() {
  if (state.circuit) return state.circuit;
  const [meta, umwelt] = await Promise.all([fetch("data/circuit.json"), fetch("data/umwelt.json")].map((f) => f.then((r) => r.json())));
  const glom = new Set(meta.glomeruli);
  const pnOf = new Map();
  meta.cell_type.forEach((t, i) => {
    const g = t.split("_")[0];
    if (glom.has(g)) (pnOf.get(g) || pnOf.set(g, []).get(g)).push(i);
  });
  return (state.circuit = { meta, pnOf, umwelt });
}
// Same inputs as engine.decide(): the name the engine will receive, and the
// slot only when both names are equal. Returns [glomeruli, matched concepts].
function odourOf(name, other, slot) {
  const { meta, umwelt } = state.circuit;
  const key = name.trim() || (slot ? "B" : "A");
  const same = key === (other.trim() || (slot ? "A" : "B"));
  const [gl, ids] = translate(umwelt, key, meta.glomeruli, meta.params.glomeruli_per_odor, seedFrom(key.toLowerCase(), same ? slot : 0));
  return [gl, ids.map((id) => umwelt.concepts.find((c) => c.id === id))];
}
function drawOdours() {
  if (!state.circuit || !brain.lines) return;
  const { meta, pnOf } = state.circuit;
  [[nameA, nameB, 0, "a"], [nameB, nameA, 1, "b"]].forEach(([mine, other, slot, s]) => {
    const [gl, found] = odourOf(mine.value, other.value, slot);
    const sense = $(`#sense-${s}`);
    const said = found.map((c) => c.id).join(" ") || "-";
    if (sense.dataset.key !== said) {
      sense.dataset.key = said;
      sense.innerHTML = found.length
        ? `<span>smells like</span>${found.map((c) => `<b title="${c.human} → ${c.fly}: ${c.glomeruli.join(" ")}">${c.fly}</b>`).join("<span>+</span>")}`
        : `<span>a smell the fly has never met</span>`;
    }
    const key = gl.join(" ");
    const img = $(`#odour-${s}`);
    if (img.dataset.key === key) return;
    const frame = new Uint8Array(meta.n);
    for (const g of gl) for (const i of pnOf.get(g) || []) frame[i] = 255;
    img.classList.remove("on");
    img.dataset.key = key;
    img.src = brain.snapshotActivity(frame, { view: "front", size: 300, distance: 2.3, base: false, outline: false, ink: "#ffffff" });
    img.alt = `Smell of option ${s.toUpperCase()}: glomeruli ${gl.join(", ")}`;
    $(`#smell-${s}`).textContent = `smell · ${gl.slice(0, 4).join(" ")} …`;
    requestAnimationFrame(() => requestAnimationFrame(() => img.classList.add("on")));
  });
}
setExample(EXAMPLES[0]);

// ------------------------------------------------------------------ 02 questions
const qBar = $("#q-bar");
QUESTIONS.forEach(() => qBar.appendChild(document.createElement("i")));
const nearest = (x) => Math.round(Math.min(1, Math.max(0, x)) * 4);
const flyGlyph = (g) => `<svg viewBox="0 0 34 34" aria-hidden="true"><circle cx="17" cy="17" r="15.5" fill="none" stroke="${cvar(g)}" stroke-opacity=".35"/><circle cx="17" cy="17" r="9" fill="none" stroke="${cvar(g)}" stroke-opacity=".6"/><circle cx="17" cy="17" r="4" fill="${cvar(g)}"/></svg>`;

function renderQuestion(dir) {
  const k = state.q, Q = QUESTIONS[k];
  const stage = $("#q-stage");
  for (const old of $$(".q-card", stage)) {
    if (old.classList.contains("leave")) { old.remove(); continue; }
    if (dir === 0) { old.remove(); continue; }
    old.classList.remove("enter", "back");
    old.classList.add("leave");
    if (dir < 0) old.classList.add("back");
    old.addEventListener("animationend", () => old.remove(), { once: true });
  }
  const card = document.createElement("div");
  card.className = `q-card enter${dir < 0 ? " back" : ""}`;
  card.style.setProperty("--c", cvar(Q.pop));
  let body;
  if (Q.key === "mood") {
    body = `<div class="moods" role="radiogroup" aria-label="The fly's mood">${STATES.map(([key, label, desc], i) => `
      <button class="mood" role="radio" aria-checked="${key === state.mood}" data-mood="${key}" style="animation-delay:${i * 50}ms">
        <span class="face">${["i", "ii", "iii", "iv", "v"][i]}</span><span><b>${label}</b><br><span>${desc}</span></span></button>`).join("")}</div>`;
  } else {
    body = `<div class="q-rows">${["a", "b"].map((s) => `
      <div class="q-row" style="--opt:var(--${s})">
        <span class="q-who"><i></i><span>${esc(optName(s))}</span></span>
        <div class="chips" role="radiogroup" aria-label="${esc(optName(s))}">${Q.answers.map((ans, i) => `
          <button class="chip" role="radio" data-slot="${s}" data-i="${i}" aria-checked="${nearest(state.vals[s][Q.key]) === i}">${ans}</button>`).join("")}</div>
      </div>`).join("")}</div>
      <p class="q-fly">${flyGlyph(Q.pop)}<span>${Q.fly}</span></p>`;
  }
  card.innerHTML = `<span class="q-topic"><i></i>${Q.topic}</span><h2 id="q-title" class="split">${Q.q}</h2>${body}`;
  stage.appendChild(card);
  split(card.querySelector("h2"));
  $$(".w > span", card).forEach((s) => (s.style.animation = "wordUp 1s var(--ease) both", s.style.animationDelay = `calc(var(--w) * 60ms + 120ms)`));
  // children rise in after the heading
  $$(".q-row, .moods, .q-fly", card).forEach((e, i) => (e.style.animation = `rise .9s var(--ease) ${220 + i * 90}ms both`));
  card.touched = new Set();
  $("#q-count").textContent = `${pad(k + 1)} / ${pad(QUESTIONS.length)}`;
  $$("i", qBar).forEach((b, i) => b.classList.toggle("done", i <= k));
  const last = k === QUESTIONS.length - 1;
  $("#q-next-label").textContent = last ? "Ask the fly" : "Next";
  $("#q-next").style.setProperty("--hover", last ? "var(--a)" : "var(--b)");
}

$("#q-stage").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  const mood = e.target.closest(".mood");
  const card = e.target.closest(".q-card");
  if (!card || card.classList.contains("leave")) return;
  if (chip) {
    const Q = QUESTIONS[state.q], s = chip.dataset.slot, i = Number(chip.dataset.i);
    state.vals[s][Q.key] = i / 4;
    $$(`.chip[data-slot="${s}"]`, card).forEach((c) => c.setAttribute("aria-checked", c === chip));
    invalidate();
    card.touched.add(s);
    // once both options have an answer, move on by itself
    if (card.touched.size === 2) { clearTimeout(card.auto); card.auto = setTimeout(() => state.q === QUESTIONS.indexOf(Q) && advance(1), 520); }
  } else if (mood) {
    state.mood = mood.dataset.mood;
    $$(".mood", card).forEach((m) => m.setAttribute("aria-checked", m === mood));
    invalidate();
  }
});
function pickByKey(i) {
  const card = $(".q-card:not(.leave)");
  if (!card) return;
  if (QUESTIONS[state.q].key === "mood") return $$(".mood", card)[i]?.click();
  const s = card.touched.has("a") ? "b" : "a";
  $(`.chip[data-slot="${s}"][data-i="${i}"]`, card)?.click();
}
function advance(dir) {
  const k = state.q + dir;
  if (k < 0) return goTo(1);
  if (k >= QUESTIONS.length) return run();
  state.q = k;
  renderQuestion(dir);
}
$("#q-next").onclick = () => advance(1);
$("#q-prev").onclick = () => advance(-1);

function invalidate() {
  state.result = null;
  state.maxStep = Math.min(state.maxStep, 2);
  $$(".progress button").forEach((b) => { if (Number(b.dataset.goto) >= 3) b.disabled = true; });
}

// ------------------------------------------------------------------ 03 simulation
function buildChannels() {
  $("#channels").innerHTML = CHANNELS.map(([g, name, c]) =>
    `<div class="ch" data-group="${g}" style="--c:var(${c})"><div class="ch-meter"><i></i></div><span class="ch-name">${name}</span></div>`).join("");
}
buildChannels();

async function run(seed) {
  stopPlayback();
  state.result = null;
  state.playback = { pending: true };
  setStep(3);
  stageSpecimen(3);
  setPhaseTitle("The fly is thinking");
  $("#phase").textContent = "Your dilemma becomes two smells for 100 simulated flies.";
  $("#sim-count").textContent = "Simulating 100 flies";
  $("#sim-bar").style.width = "0";
  $$(".tl-labels span").forEach((s) => s.classList.remove("on"));
  $$(".ch-meter i").forEach((i) => (i.style.height = "0"));
  $("#timeline").classList.add("wait");
  const body = {
    a: { name: nameA.value.trim() || "A", ...state.vals.a },
    b: { name: nameB.value.trim() || "B", ...state.vals.b },
    state: state.mood, trials: 100, topology: $("#topology").value,
    seed: seed ?? null, include_activity: true,
  };
  let res;
  const pb = state.playback;
  try {
    res = await decide(body);
  } catch (e) {
    if (state.playback !== pb) return;
    state.playback = null;
    $("#phase").textContent = `The simulation failed: ${e.message}`;
    $("#timeline").classList.remove("wait");
    return;
  }
  if (state.playback !== pb) return; // superseded by a newer run
  $("#timeline").classList.remove("wait");
  play(res);
}

function setPhaseTitle(html) {
  const t = $("#phase-title");
  if (t.innerHTML === html) return;
  t.innerHTML = html;
  t.classList.remove("swap"); void t.offsetWidth; t.classList.add("swap");
}

// Playback order: learning A, learning B, test A, test B. 24 steps each.
const SEGMENTS = [
  [0, 0, "Learning", "The fly smells it while dopamine teaches it what it's worth."],
  [0, 1, "Learning", "The fly smells it while dopamine teaches it what it's worth."],
  [1, 0, "Testing", "The smell alone: do the output neurons say approach, or avoid?"],
  [1, 1, "Testing", "The smell alone: do the output neurons say approach, or avoid?"],
];
const movieFrame = (res, seg, step) => {
  const [, , S, N] = res.movie.shape;
  const [phase, opt] = SEGMENTS[seg];
  const off = ((phase * 2 + opt) * S + step) * N;
  return res.movie.raw.subarray(off, off + N);
};

function play(res) {
  const S = res.movie.shape[2];
  const total = SEGMENTS.length * S;
  const frameMs = reduced ? 0 : 100;
  // Channel meters: trial-mean population rate, normalised per channel.
  const traces = {};
  for (const [g] of CHANNELS) {
    const series = SEGMENTS.map(([phase, opt]) => res.trajectory[phase ? "test" : "experience"][g][opt]);
    traces[g] = { series, max: Math.max(1e-6, ...series.flat()) };
  }
  const meters = $$("#channels .ch").map((row) => [traces[row.dataset.group], row.querySelector("i")]);
  const names = res.options.map((o) => esc(o.name));
  const pb = (state.playback = { res, k: 0, last: performance.now(), total, S });
  const tick = (now) => {
    if (state.playback !== pb) return;
    const t = frameMs ? (now - pb.last) / frameMs : total;
    const k = Math.min(total - 1, pb.k + Math.floor(t));
    const mix = frameMs ? ease(t % 1) : 0;
    const seg = Math.floor(k / S), step = k % S;
    const nextK = Math.min(total - 1, k + 1);
    const nseg = Math.floor(nextK / S);
    if (k !== pb.shown) {
      brain.setActivity(movieFrame(res, seg, step), nseg === seg ? movieFrame(res, nseg, nextK % S) : movieFrame(res, seg, step), 0);
      pb.shown = k;
      for (const [{ series, max }, bar] of meters) bar.style.height = `${(series[seg][step] / max) * 100}%`;
      const [, opt, verb, sub] = SEGMENTS[seg];
      setPhaseTitle(`${verb} <em style="color:var(--${opt ? "b" : "a"})">${names[opt]}</em>`);
      $("#phase").textContent = sub;
      $("#sim-count").textContent = `Step ${pad(k + 1)} / ${total} · average of 100 flies · brightness = simulated rate`;
      $("#sim-bar").style.width = `${((k + 1) / total) * 100}%`;
      $$(".tl-labels span").forEach((s, i) => s.classList.toggle("on", i === seg));
      $("#caption-live").textContent = `t = ${pad(step + 1)}/24 · ${SEGMENTS[seg][0] ? "test" : "learning"} · option ${opt ? "B" : "A"} · brightness = simulated rate`;
    }
    brain.shared.uMix.value = nseg === seg ? mix : 0;
    if (k >= total - 1) return finish(res);
    pb.raf = requestAnimationFrame(tick);
  };
  pb.raf = requestAnimationFrame(tick);
}

// Smoothstep between recorded steps, so rates glide instead of ticking.
const ease = (m) => m * m * (3 - 2 * m);

// On the Why screen the brain keeps replaying the recorded test phase (option A,
// then B), so what is shown is still the engine's output, only on a loop.
function replay(res) {
  stopReplay();
  if (!res || reduced) return;
  const S = res.movie.shape[2], segs = [2, 3], total = segs.length * S, frameMs = 120;
  const t0 = performance.now();
  let shown = -1;
  const tick = (now) => {
    if (state.step !== 5 || state.result !== res) return;
    const t = (now - t0) / frameMs, k = Math.floor(t) % total;
    if (k !== shown) {
      const nk = (k + 1) % total;
      const seg = segs[Math.floor(k / S)], nseg = segs[Math.floor(nk / S)];
      brain.setActivity(movieFrame(res, seg, k % S), movieFrame(res, nseg, nk % S), 0);
      $("#caption-live").textContent = `Replaying the test · option ${seg === 3 ? "B" : "A"} · t = ${pad((k % S) + 1)}/24 · brightness = simulated rate`;
      shown = k;
    }
    brain.shared.uMix.value = ease(t % 1);
    state.replayRaf = requestAnimationFrame(tick);
  };
  state.replayRaf = requestAnimationFrame(tick);
}
function stopReplay() {
  if (state.replayRaf) cancelAnimationFrame(state.replayRaf);
  state.replayRaf = null;
}

function finish(res) {
  stopPlayback();
  state.result = res;
  setPhaseTitle("The fly has decided.");
  $("#phase").textContent = "The output neurons have voted.";
  native?.haptic?.postMessage("success");
  setTimeout(() => { if (state.result === res && state.step === 3) goTo(4); }, reduced ? 0 : 1200);
}

function stopPlayback() {
  if (state.playback?.raf) cancelAnimationFrame(state.playback.raf);
  state.playback = null;
}
$("#skip").onclick = () => {
  const pb = state.playback;
  if (pb?.res) { pb.k = pb.total - 1; pb.last = performance.now(); }
};

function showFinalFrame() {
  const res = state.result;
  if (!res) return;
  const S = res.movie.shape[2];
  brain.setActivity(movieFrame(res, res.choice === "B" ? 3 : 2, S - 1));
}

// ------------------------------------------------------------------ 04 answer
function countUp(node, to, ms = 1400) {
  if (reduced) return (node.textContent = `${to}%`);
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 4);
    node.textContent = `${Math.round(to * e)}%`;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderResult() {
  const r = state.result;
  const names = r.options.map((o) => o.name);
  const tie = r.choice === "tie";
  const k = r.choice === "B" ? 1 : 0;
  const n = tie ? 50 : Math.max(r.counts.A, r.counts.B);
  const word = (tie ? "Undecided" : names[k]) + ".";
  const verdict = $("#verdict").parentElement;
  verdict.classList.remove("go");
  verdict.classList.toggle("long", word.length > 13);
  $("#verdict").innerHTML = word.split(/(\s+)/).map((w) => /^\s+$/.test(w) ? " "
    : `<span style="display:inline-block;white-space:nowrap">${[...w].map((ch) => `<span class="ch-l">${esc(ch)}</span>`).join("")}</span>`).join("");
  $$(".ch-l", verdict).forEach((s, i) => s.style.setProperty("--l", i));
  requestAnimationFrame(() => verdict.classList.add("go"));
  document.documentElement.style.setProperty("--win", tie ? "var(--ink)" : `var(--${k ? "b" : "a"})`);
  countUp($("#pct"), n);
  $("#pct-label").textContent = tie ? "a perfect split" : `of 100 flies chose ${names[k]}`;
  $("#bars").innerHTML = ["A", "B"].map((s, i) => `
    <div class="bar-row${r.counts[s] >= 30 ? " lit" : ""}${r.counts[s] >= 92 ? " full" : ""}" style="--opt:var(--${s.toLowerCase()})"><i></i><span>${esc(names[i])}</span><span class="n">${r.counts[s]}</span></div>`).join("");
  setTimeout(() => $$("#bars i").forEach((b, j) => (b.style.width = `${r.counts[j ? "B" : "A"]}%`)), 350);
  // one dot per fly, grouped by choice
  const picks = [...r.picks].sort();
  const grid = $("#fly-grid");
  grid.classList.remove("go");
  grid.innerHTML = picks.map((p, i) => `<i class="${p.toLowerCase()}" style="--d:${i}"></i>`).join("");
  grid.setAttribute("aria-label", `${r.counts.A} flies chose ${names[0]}, ${r.counts.B} chose ${names[1]}`);
  requestAnimationFrame(() => grid.classList.add("go"));
  $("#caption-live").textContent = `seed ${r.seed} · ${r.topology} wiring · ${r.trials} trials · no language model`;
}

$("#see-why").onclick = () => goTo(5);
for (const id of ["#again", "#again2"]) $(id).onclick = () => run(Math.floor(Math.random() * 2 ** 31));
for (const id of ["#restart", "#restart2"]) $(id).onclick = () => { invalidate(); goTo(1); };
$("#share").onclick = saveImage;

// ------------------------------------------------------------------ 05 why
function renderInsight() {
  const r = state.result;
  const names = r.options.map((o) => esc(o.name));
  const p = r.populations, t = r.teaching;
  const tie = r.choice === "tie";
  $("#why-title").innerHTML = tie ? "Why <em>no answer?</em>" : `Why <em>${names[r.choice === "B" ? 1 : 0]}?</em>`;
  const rows = [
    ["KC", "Memory", "Kenyon cells switched on", p.KC.active_fraction],
    ["PAM", "Reward", "dopamine while learning", t.PAM],
    ["PPL1", "Punishment", "dopamine while learning", t.PPL1],
    ["MBON", "Approach", "output neurons that pull closer", p.MBON_approach.test],
    ["MBON", "Avoid", "output neurons that push away", p.MBON_avoid.test],
    ["MBON", "Votes", "flies that chose it", [r.counts.A, r.counts.B]],
  ];
  const level = ([a, b]) => {
    const d = Math.abs(a - b) / Math.max(1e-6, Math.abs(a), Math.abs(b));
    if (d < 0.05) return "<b>About even</b>";
    return `<b>${names[a > b ? 0 : 1]}</b> ${d > 0.4 ? "clearly" : d > 0.15 ? "moderately" : "slightly"} higher`;
  };
  $("#why").innerHTML = rows.map(([g, name, desc, vals]) => {
    const max = Math.max(1e-6, ...vals.map(Math.abs));
    const w = vals.map((x) => (Math.max(0, x) / max) * 100);
    return `<li data-group="${g}" style="--c:${cvar(g)}">
      <span><span class="name"><i></i>${name}</span><span class="level">${level(vals)} · ${desc}</span></span>
      <span class="mini" role="img" aria-label="A ${fmt(vals[0])}, B ${fmt(vals[1])}"><span><i data-w="${w[0]}"></i></span><span><i data-w="${w[1]}"></i></span></span></li>`;
  }).join("");
  setTimeout(() => $$("#why .mini i").forEach((i) => (i.style.width = `${i.dataset.w}%`)), 600);
  for (const li of $$("#why li")) {
    li.onpointerenter = () => brain.focus(li.dataset.group);
    li.onpointerleave = () => brain.focus(null);
  }
  const top = r.mbons.slice(0, 6);
  const m = Math.max(1e-9, ...top.map((x) => Math.abs(x.contribution)));
  $("#mbons").innerHTML = top.map((x) => {
    const w = (50 * Math.abs(x.contribution)) / m;
    const left = x.contribution >= 0 ? 50 : 50 - w;
    const kind = x.valence > 0.2 ? "approach" : x.valence < -0.2 ? "avoid" : "mixed";
    return `<li><span>${x.type}</span><span>${kind}</span><span class="bar"><i style="left:${left}%;width:${w}%;background:${x.contribution >= 0 ? "var(--a)" : "var(--b)"}"></i></span></li>`;
  }).join("");
  $("#meta").textContent = `seed ${r.seed} · wiring=${r.topology} · state=${r.state} · ${r.trials} trials · engine ${r.engine === "server" ? "python (server)" : "on-device"} · A = ${(r.meaning?.[0] || []).join("+") || "unmatched"} → ${r.odors[0].join(" ")} · B = ${(r.meaning?.[1] || []).join("+") || "unmatched"} → ${r.odors[1].join(" ")}`;
}
$("#topology").onchange = () => run();

// ------------------------------------------------------------------ annotations
// The cover plate: a coloured dot and one word per labelled population.
const anno = {};
function initAnnotations() {
  const svg = $("#annotations");
  svg.innerHTML = "";
  for (const [g, a] of Object.entries(ANNOTATE)) {
    if (!brain.anchors[g]) continue;
    const grp = el("g", {}, svg);
    anno[g] = {
      grp, a,
      line: el("path", { class: "leader" }, grp),
      dot: el("circle", { r: 5, class: "dot", fill: getComputedStyle(document.documentElement).getPropertyValue(POP[g][1]).trim() }, grp),
      text: Object.assign(el("text", {}, grp), { textContent: POP[g][0].toLowerCase() }),
    };
  }
  brain.onAnchors((pts) => {
    if (document.body.dataset.step !== "0" || isMobile()) return;
    const box = $("#specimen").getBoundingClientRect();
    for (const [g, o] of Object.entries(anno)) {
      const p = pts[g];
      if (!p) continue;
      // the specimen is shifted with a CSS transform; follow it
      const x = box.left + p.x * (box.width / $("#specimen").clientWidth), y = box.top + p.y * (box.height / $("#specimen").clientHeight);
      const { dx, dy } = o.a;
      const lx = x + dx, ly = y + dy;
      o.dot.setAttribute("cx", x); o.dot.setAttribute("cy", y);
      o.line.setAttribute("d", `M${x + Math.sign(dx) * 6},${y + Math.sign(dy) * 6} L${lx - Math.sign(dx) * 18},${ly} L${lx},${ly}`);
      o.text.setAttribute("x", lx + Math.sign(dx) * 8);
      o.text.setAttribute("y", ly + 4);
      o.text.setAttribute("text-anchor", dx > 0 ? "start" : "end");
      const tx = lx + Math.sign(dx) * 90;
      o.grp.style.opacity = p.visible && tx > window.innerWidth * 0.42 && tx < window.innerWidth - 20 ? 1 : 0;
    }
  });
}

// ------------------------------------------------------------------ method
const method = $("#method");
$("#open-method").onclick = () => { method.hidden = false; $("#close-method").focus(); };
function closeMethod() { method.hidden = true; }
$("#close-method").onclick = closeMethod;
method.addEventListener("click", (e) => { if (e.target === method) closeMethod(); });

// ------------------------------------------------------------------ share image
async function saveImage() {
  const r = state.result;
  if (!r) return;
  const names = r.options.map((o) => o.name);
  const W = 1080, H = 1350;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  await document.fonts.ready;
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, W, H);

  const tie = r.choice === "tie", k = r.choice === "B" ? 1 : 0;
  const win = tie ? "#101215" : k ? "#6b8fe0" : "#d9854b";
  const mono = (t, x, y, color = "#85888f", size = 22) => { g.font = `400 ${size}px "JetBrains Mono", monospace`; g.fillStyle = color; g.fillText(t, x, y); };
  g.font = '600 34px "Inter Tight", sans-serif'; g.fillStyle = "#0e0e10";
  g.fillText("Ask the Fly", 80, 110);
  mono(`${names[0]}  vs  ${names[1]}`, 80, 160);

  // 100 flies, one dot each
  const picks = [...r.picks].sort();
  picks.forEach((p, i) => {
    g.fillStyle = p === "A" ? "#d9854b" : "#6b8fe0";
    g.beginPath(); g.arc(560 + (i % 10) * 46, 250 + Math.floor(i / 10) * 46, 17, 0, Math.PI * 2); g.fill();
  });

  mono("the fly says", 80, 800);
  const word = (tie ? "Undecided" : names[k]) + ".";
  let size = 170;
  do { g.font = `600 ${size}px "Inter Tight", sans-serif`; size -= 6; } while (g.measureText(word).width > W - 160 && size > 60);
  g.fillStyle = "#0e0e10";
  g.letterSpacing = `${-size * 0.05}px`;
  g.fillText(word, 74, 960);
  g.letterSpacing = "0px";
  const n = tie ? 50 : Math.max(r.counts.A, r.counts.B);
  g.font = '600 110px "Inter Tight", sans-serif'; g.fillStyle = win;
  g.fillText(`${n}%`, 76, 1110);
  mono(tie ? "a perfect split" : `of 100 simulated flies chose it`, 80, 1160);
  mono(`Drosophila mushroom body · FlyWire v783 · 5,877 neurons · seed ${r.seed} · no language model`, 80, H - 70, "#85888f", 17);
  const url = c.toDataURL("image/png");

  if (native?.share) return native.share.postMessage({ image: url, text: `The fly says: ${word}` });
  const a = document.createElement("a");
  a.download = `ask-the-fly-${Date.now()}.png`;
  a.href = url;
  a.click();
}

// ------------------------------------------------------------------ start
goTo(0);
window.__fly = { state, goTo, run, brain };
