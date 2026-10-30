// The fly engine as seen by the interface: decide(request) -> Promise<result>.
//
// Default: the JavaScript engine, on this device, in a Web Worker. If workers
// are unavailable it runs on the main thread instead. With ?engine=server the
// Python engine is used through POST /api/decide (research / comparison).

const params = new URLSearchParams(location.search);
const useServer = params.get("engine") === "server";
const API = window.FLY_API ?? "";

let worker = null, seq = 0, local = null;
const pending = new Map();

function startWorker() {
  try {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      data.error ? p.reject(new Error(data.error)) : p.resolve(data.result ?? data.ready);
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      worker = null;
      for (const [, p] of pending) p.retry();
      pending.clear();
    };
  } catch {
    worker = null;
  }
}

async function localEngine() {
  return (local ||= (async () => {
    const { Engine, parseData } = await import("./flyengine.js");
    const [meta, bin, umwelt] = await Promise.all([
      fetch(new URL("../../data/circuit.json", import.meta.url)).then((r) => r.json()),
      fetch(new URL("../../data/circuit.bin", import.meta.url)).then((r) => r.arrayBuffer()),
      fetch(new URL("../../data/umwelt.json", import.meta.url)).then((r) => r.json()),
    ]);
    return new Engine(parseData(meta, bin, umwelt));
  })());
}

function viaWorker(request) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const retry = () => viaMainThread(request).then(resolve, reject);
    pending.set(id, { resolve, reject, retry });
    worker.postMessage({ id, request });
  });
}

async function viaMainThread(request) {
  const e = await localEngine();
  await new Promise((r) => setTimeout(r, 30)); // let the interface paint first
  return request ? e.decide(request) : true;
}

async function viaServer(request) {
  const r = await fetch(`${API}/api/decide`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  const res = await r.json();
  if (res.activity) {
    res.movie = { raw: Uint8Array.from(atob(res.activity.data), (c) => c.charCodeAt(0)), shape: res.activity.shape };
    delete res.activity;
  }
  res.engine = "server";
  return res;
}

if (!useServer) startWorker();

export const engineName = useServer ? "server" : "on-device";

// Load the circuit in the background, ahead of the first question.
export function warmUp() {
  if (useServer) return Promise.resolve(true);
  return worker ? viaWorker(null) : viaMainThread(null);
}

export function decide(request) {
  if (useServer) return viaServer(request);
  return worker ? viaWorker(request) : viaMainThread(request);
}
