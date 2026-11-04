// The reference ride: one fixed seed, setup and input log whose digest the engine's native tests pin. Running it in the
// page (or under Node) and getting the same digest shows that the browser build computes what the native build does.
// Everything here is built from integers and the engine's own exact trail arithmetic, so the same ride gives the same bits.
import { PROFILE, SUSPENSION, STATUS, defaultSetup, hex64 } from "./engine.js";

export const SEED = 12345;
export const BATCH = 160;        // steps per call (a 16.7 ms frame is about 107)
export const TOTAL_TICKS = 19200; // 3 s
export const APPEND_TICK = 6400;  // the second set of rollers
export const DROP_TICK = 12800;   // terrain behind x = 3 m goes
export const DROP_X = 3.0;

// The native tests' digests (the engine's tests/test_flow_api.cpp): GCC, Clang and WebAssembly agree.
export const EXPECTED = Object.freeze({
  interactive: "37aa99e9c78f15eb",
  ambient: "6e09e4113d4731d5",
});

/** Drive in the second second, a brake pulse at the end of each 1.5 s. */
export function inputAt(k, out) {
  out[0] = Math.floor(k / 3200) % 3 === 1 ? 25 : 0;
  out[1] = k % 9600 >= 9000 ? 15 : 0;
  out[2] = k % 9600 >= 9200 ? 20 : 0;
}

function rollers(engine, first, count, at) {
  const parts = [];
  for (let i = first; i < first + count; i++) {
    const points = engine.roller(SEED, i, at.x, at.z);
    parts.push(points);
    at.x = points[points.length - 2];
    at.z = points[points.length - 1];
  }
  const all = new Float64Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return all;
}

/**
 * Rides the reference ride and returns its digest.
 * @param {import("./engine.js").FlowEngine} engine
 * @param {"interactive"|"ambient"} profile
 * @returns {{digest:string, expected:string, match:boolean, status:number, wallMs:number, ticks:number, frameX:number, speed:number}}
 */
export function runReference(engine, profile = "interactive", ticks = TOTAL_TICKS) {
  const bike = engine.create(defaultSetup({
    profile: PROFILE[profile], suspension: SUSPENSION.full, speed: 3,
  }));
  const at = { x: 5, z: 0 };
  let status = STATUS.ok;
  const t0 = performance.now();
  try {
    bike.appendTerrain(rollers(engine, 0, 4, at));
    for (let k = 0; k < ticks && status === STATUS.ok;) {
      if (k === APPEND_TICK) bike.appendTerrain(rollers(engine, 4, 4, at));
      if (k === DROP_TICK) bike.dropBehind(DROP_X);
      let n = Math.min(BATCH, ticks - k);
      for (const edge of [APPEND_TICK, DROP_TICK]) if (k < edge && k + n > edge) n = edge - k;
      const start = k;
      status = bike.stepEach(n, (i, out) => inputAt(start + i, out));
      k += n;
    }
    const wallMs = performance.now() - t0;
    const obs = bike.observe();
    const digest = hex64(bike.digest());
    const expected = EXPECTED[profile];
    return { digest, expected, match: digest === expected && status === STATUS.ok, status, wallMs, ticks: bike.tick, frameX: obs[4], speed: obs[18] };
  } finally {
    bike.destroy();
  }
}
