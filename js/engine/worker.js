// Runs the fly engine off the main thread, so the interface stays fluid.
import { Engine, parseData } from "./flyengine.js";

let engine;
function load() {
  return (engine ||= Promise.all([
    fetch(new URL("../../data/circuit.json", import.meta.url)).then((r) => r.json()),
    fetch(new URL("../../data/circuit.bin", import.meta.url)).then((r) => r.arrayBuffer()),
    fetch(new URL("../../data/umwelt.json", import.meta.url)).then((r) => r.json()),
  ]).then(([meta, bin, umwelt]) => new Engine(parseData(meta, bin, umwelt))));
}

self.onmessage = async ({ data: { id, request } }) => {
  try {
    const e = await load();
    if (!request) return self.postMessage({ id, ready: true });
    const result = e.decide(request);
    self.postMessage({ id, result }, result.movie ? [result.movie.raw.buffer] : []);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
