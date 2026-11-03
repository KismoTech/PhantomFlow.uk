// Physics worker: runs the PhantomFlow engine's bike at its fixed step, batched per frame, and publishes states for the page
// to draw. A module worker (new Worker(url, { type: "module" })); the protocol is documented in site/dev/README.md.
//
// - The clock: simulated time follows the wall clock. If the engine cannot keep up, catch-up is capped and the ride slows
//   (the published "speed ratio" says by how much), never spirals.
// - The profile is chosen by measured cost: a calibration burst before the ride, then a rolling check during it (see
//   chooseProfile and watchCost). Interactive drops to Ambient when its cost exceeds the profile's declared budget; the
//   choice and the numbers are logged to the page.
// - Every ride is its seed, setup and an event log (inputs, terrain appends and drops by tick), so it can be replayed in a
//   second bike and its digest compared: that is the "verify replay" control.
import { loadEngine, defaultSetup, PROFILE, STATUS, OBS, INFO, GUARD_NAMES } from "./engine.js";

const SEED = 20260;          // the ride's trail seed (any 32-bit value)
const LOOKAHEAD = 40;        // metres of terrain kept ahead of the front wheel
const BEHIND = 12;           // metres kept behind the rear wheel
const APPEND_ROLLERS = 2;    // rollers per terrain append
const CHUNK = 107;           // steps per published state (about 16.7 ms of simulated time)
const SNAPSHOT_EVERY = 6400; // ticks between rewind points (1 s)
const SNAPSHOTS_KEPT = 8;
const COST_WINDOW = 2.0;     // seconds of simulated time in the rolling cost
const MARGIN = 1.0;          // cost must stay under budget * MARGIN
const GRACE = 3.0;           // seconds of ride before the rolling check may degrade the profile
const STRIKES = 3;           // consecutive over-budget checks before it does

let engine = null;
let config = null;
let ride = null;             // the running ride, or null
let paused = false;
let input = { drive: 0, frontBrake: 0, rearBrake: 0 };
let last = performance.now();
let timer = 0;

const post = (message, transfer = []) => self.postMessage(message, transfer);
const log = (message) => post({ type: "log", message });

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "init":
        engine = await loadEngine(msg.moduleUrl);
        post({ type: "loaded" });
        break;
      case "start":
        config = msg.config;
        startRide(config);
        break;
      case "input":
        setInput(msg);
        break;
      case "pause":
        paused = Boolean(msg.paused);
        break;
      case "rewind":
        rewind(msg.seconds ?? 3);
        break;
      case "verify":
        verifyReplay();
        break;
      case "reference":
        runReference();
        break;
      default:
        log(`unknown message ${msg.type}`);
    }
  } catch (error) {
    log(`error: ${error.message}`);
    post({ type: "error", message: error.message });
  }
};

// --- profile choice ------------------------------------------------------------------------------------------------

function setupFor(cfg, profileName) {
  return defaultSetup({
    profile: PROFILE[profileName], suspension: cfg.suspension, tyre: cfg.tyre, forkRate: cfg.forkRate, shockRate: cfg.shockRate,
    compression: cfg.damping, rebound: cfg.damping, speed: cfg.speed ?? 3,
  });
}

// Wall time per simulated second of the production loop (steps and observation) over a burst on the start's flat ground.
function measureCost(cfg, profileName) {
  const bike = engine.create(setupFor(cfg, profileName));
  try {
    const warm = 1600, measured = 6400;
    for (let k = 0; k < warm; k += CHUNK) { bike.step(Math.min(CHUNK, warm - k)); bike.observe(); }
    const t0 = performance.now();
    let steps = 0;
    for (let k = 0; k < measured; k += CHUNK) {
      const n = Math.min(CHUNK, measured - k);
      if (bike.step(n) !== STATUS.ok) break;
      bike.observe(); bike.casings();
      steps += n;
    }
    const wall = (performance.now() - t0) / 1000;
    return { cost: wall / (steps * bike.dt), budget: bike.info[INFO.budget], nodes: bike.nodes };
  } finally {
    bike.destroy();
  }
}

function chooseProfile(cfg) {
  const want = cfg.profileMode;
  if (want === "interactive" || want === "ambient") {
    log(`profile ${want}: chosen by the page, not by cost`);
    return want;
  }
  const a = measureCost(cfg, "interactive");
  const fmt = (r) => `${(r.cost * 1000).toFixed(0)} ms of CPU per simulated second against a ${(r.budget * 1000).toFixed(0)} ms budget`;
  if (a.cost <= a.budget * MARGIN) {
    log(`profile interactive: calibration burst measured ${fmt(a)}: within budget`);
    return "interactive";
  }
  const b = measureCost(cfg, "ambient");
  const verdict = b.cost <= b.budget * MARGIN ? "within its budget" : "OVER its budget too: the device may not keep up";
  log(`profile ambient: interactive measured ${fmt(a)}: over budget; ambient measured ${fmt(b)}: ${verdict}`);
  return "ambient";
}

// --- the ride ---------------------------------------------------------------------------------------------------------

function startRide(cfg, forcedProfile = null, reason = "") {
  if (ride) ride.bike.destroy();
  const profile = forcedProfile ?? chooseProfile(cfg);
  const bike = engine.create(setupFor(cfg, profile));
  ride = {
    bike, profile, cfg, dt: bike.dt, accum: 0, ended: false, rideSeconds: 0, strikes: 0, nextCheck: 1.0,
    trail: { x: 5, z: 0, next: 0 }, window: { x: [], z: [] }, events: [], snapshots: [], costs: [], busyTotal: 0, simTotal: 0,
    wallStart: performance.now(), lastSnapshotTick: -1, terrainMs: 0, terrainBuilds: 0, lastDigest: "",
  };
  input = { drive: 0, frontBrake: 0, rearBrake: 0 };
  appendTrail(4);
  post({
    type: "started", profile, reason, info: bike.info, dt: bike.dt, setup: bike.setup, nodes: bike.nodes,
    window: windowPoints(),
  });
  if (reason) log(reason);
  takeSnapshot();
  paused = false;
  last = performance.now();
  if (!timer) timer = setTimeout(loop, 0);
}

function windowPoints() {
  const { x, z } = ride.window;
  const out = new Float64Array(x.length * 2);
  for (let i = 0; i < x.length; i++) { out[2 * i] = x[i]; out[2 * i + 1] = z[i]; }
  return out;
}

// Generates `count` more rollers, appends them to the engine and the page's mirror, and logs the event.
function appendTrail(count) {
  const { bike, trail } = ride;
  const first = trail.next;
  const parts = [];
  for (let i = 0; i < count; i++) {
    const points = engine.roller(SEED, trail.next++, trail.x, trail.z);
    trail.x = points[points.length - 2];
    trail.z = points[points.length - 1];
    parts.push(points);
  }
  const all = new Float64Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  const t0 = performance.now();
  bike.appendTerrain(all);
  ride.terrainMs += performance.now() - t0;
  ride.terrainBuilds++;
  for (let i = 0; i < all.length; i += 2) { ride.window.x.push(all[i]); ride.window.z.push(all[i + 1]); }
  ride.events.push({ tick: bike.tick, type: "append", first, count });
  post({ type: "terrain", points: all });
}

function dropTrail(x) {
  const { bike } = ride;
  const t0 = performance.now();
  bike.dropBehind(x);
  ride.terrainMs += performance.now() - t0;
  ride.terrainBuilds++;
  const w = ride.window;
  let i = 0;
  while (i + 1 < w.x.length && w.x[i + 1] <= x) i++;
  if (i > 0) { w.x.splice(0, i); w.z.splice(0, i); }
  ride.events.push({ tick: bike.tick, type: "drop", x });
  post({ type: "drop", x });
}

function ensureTerrain(obs) {
  if (obs[OBS.terrainLastX] < obs[OBS.frontX] + LOOKAHEAD) appendTrail(APPEND_ROLLERS);
  if (obs[OBS.rearX] - BEHIND > obs[OBS.terrainFirstX] + 8) dropTrail(obs[OBS.rearX] - BEHIND);
}

function setInput(msg) {
  const next = { drive: msg.drive ?? 0, frontBrake: msg.frontBrake ?? 0, rearBrake: msg.rearBrake ?? 0 };
  if (next.drive === input.drive && next.frontBrake === input.frontBrake && next.rearBrake === input.rearBrake) return;
  input = next;
  if (ride) ride.events.push({ tick: ride.bike.tick, type: "input", ...next });
}

function takeSnapshot() {
  const { bike } = ride;
  ride.snapshots.push({
    tick: bike.tick, bytes: bike.snapshot(), trail: { ...ride.trail }, events: ride.events.length,
    window: { x: ride.window.x.slice(), z: ride.window.z.slice() }, input: { ...input },
  });
  if (ride.snapshots.length > SNAPSHOTS_KEPT) ride.snapshots.shift();
  ride.lastSnapshotTick = bike.tick;
}

function rewind(seconds) {
  if (!ride) return;
  const target = ride.bike.tick - Math.round(seconds / ride.dt);
  let pick = ride.snapshots[0];
  for (const s of ride.snapshots) if (s.tick <= target) pick = s;
  ride.bike.restore(pick.bytes);
  ride.trail = { ...pick.trail };
  ride.events.length = pick.events;
  ride.window = { x: pick.window.x.slice(), z: pick.window.z.slice() };
  ride.snapshots = ride.snapshots.filter((s) => s.tick <= pick.tick);
  ride.ended = false;
  ride.accum = 0;
  input = { ...pick.input };
  post({ type: "terrain-reset", points: windowPoints() });
  log(`rewound to tick ${pick.tick} (${(pick.tick * ride.dt).toFixed(2)} s): snapshot restored, digest ${ride.bike.digestHex()}`);
  publish(true);
}

// --- the loop -------------------------------------------------------------------------------------------------------

function loop() {
  timer = 0;
  const now = performance.now();
  const wall = Math.min((now - last) / 1000, 0.25);
  last = now;
  if (ride && !paused && !ride.ended) {
    ride.accum += Math.min(wall, 0.1); // catch-up is capped: a slow device slows the ride, it does not spiral
    ride.wallSince = (ride.wallSince ?? 0) + wall;
    let guardTime = performance.now();
    while (ride.accum >= CHUNK * ride.dt * 0.999 && performance.now() - guardTime < 12 && !ride.ended) {
      stepChunk(CHUNK);
    }
    if (ride.accum > 0.2) ride.accum = 0.2;
  }
  timer = setTimeout(loop, 4);
}

function stepChunk(n) {
  const { bike } = ride;
  const t0 = performance.now();
  const status = bike.step(n, input);
  const t1 = performance.now();
  const obs = bike.observe();
  const casings = bike.casings();
  ensureTerrain(obs);
  const t2 = performance.now();
  const sim = n * ride.dt;
  ride.accum -= sim;
  ride.rideSeconds += sim;
  ride.costs.push({ step: (t1 - t0) / 1000, busy: (t2 - t0) / 1000, sim });
  let window = 0;
  while (ride.costs.length > 1 && (window = ride.costs.reduce((s, c) => s + c.sim, 0)) > COST_WINDOW) ride.costs.shift();
  if (bike.tick - ride.lastSnapshotTick >= SNAPSHOT_EVERY && status === STATUS.ok) takeSnapshot();
  if (status !== STATUS.ok) {
    ride.ended = true;
    log(`ride ended by a guard at ${(bike.tick * ride.dt).toFixed(2)} s: ${GUARD_NAMES[bike.guardCode] || "?"} (${bike.guardReason || "no detail"}); rewind or restart`);
  }
  publish(false, obs, casings);
  if (!ride.ended) watchCost();
}

function rollingCost() {
  let step = 0, busy = 0, sim = 0;
  for (const c of ride.costs) { step += c.step; busy += c.busy; sim += c.sim; }
  return sim > 0 ? { step: step / sim, busy: busy / sim } : { step: 0, busy: 0 };
}

// Interactive drops to Ambient when its measured cost stays over budget (STRIKES checks in a row, once per second after a
// short grace). The restart is visible: the ride starts again on Ambient, and the reason is logged.
function watchCost() {
  if (ride.rideSeconds < ride.nextCheck) return;
  ride.nextCheck += 1.0;
  if (ride.rideSeconds < GRACE || ride.cfg.profileMode !== "auto" || ride.profile !== "interactive") return;
  const cost = rollingCost().busy;
  const budget = ride.bike.info[INFO.budget];
  ride.strikes = cost > budget * MARGIN ? ride.strikes + 1 : 0;
  if (ride.strikes >= STRIKES) {
    startRide(ride.cfg, "ambient",
      `profile ambient: interactive's rolling cost ${(cost * 1000).toFixed(0)} ms per simulated second exceeded its ${(budget * 1000).toFixed(0)} ms budget for ${STRIKES} seconds in a row; ride restarted on ambient`);
  }
}

function publish(force, obs = null, casings = null) {
  const { bike } = ride;
  obs = obs ?? bike.observe();
  casings = casings ?? bike.casings();
  const rolling = rollingCost();
  const message = {
    type: "frame", obs, casings, digest: bike.digestHex(), tick: bike.tick, profile: ride.profile,
    guard: bike.guardCode, guardReason: bike.guardReason,
    costStep: rolling.step, costBusy: rolling.busy, budget: bike.info[INFO.budget],
    terrainBuilds: ride.terrainBuilds, terrainMs: ride.terrainMs, ended: ride.ended, paused,
    ratio: ride.rideSeconds > 0 ? ride.rideSeconds / Math.max(1e-6, (performance.now() - ride.wallStart) / 1000) : 1,
    events: ride.events.length, at: performance.now(),
  };
  post(message, [obs.buffer, ...casings.map((c) => c.buffer)]);
}

// --- replay verification ----------------------------------------------------------------------------------------------

// Replays the event log in a second bike up to the current tick and compares digests with the live one.
function verifyReplay() {
  if (!ride) return;
  const target = ride.bike.tick;
  const live = ride.bike.digestHex();
  const events = ride.events.filter((e) => e.tick <= target);
  const copy = engine.create(ride.bike.setup);
  const trail = { x: 5, z: 0, next: 0 };
  let current = { drive: 0, frontBrake: 0, rearBrake: 0 };
  let status = STATUS.ok;
  const t0 = performance.now();
  const advance = (to) => {
    while (copy.tick < to && status === STATUS.ok) status = copy.step(Math.min(4096, to - copy.tick), current);
  };
  for (const e of events) {
    advance(e.tick);
    if (e.type === "input") current = { drive: e.drive, frontBrake: e.frontBrake, rearBrake: e.rearBrake };
    else if (e.type === "drop") copy.dropBehind(e.x);
    else if (e.type === "append") {
      const parts = [];
      for (let i = 0; i < e.count; i++) {
        const p = engine.roller(SEED, trail.next++, trail.x, trail.z);
        trail.x = p[p.length - 2]; trail.z = p[p.length - 1];
        parts.push(p);
      }
      const all = new Float64Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) { all.set(p, o); o += p.length; }
      copy.appendTerrain(all);
    }
  }
  advance(target);
  const wall = (performance.now() - t0) / 1000;
  const replayed = copy.digestHex();
  copy.destroy();
  const ok = replayed === live && status === STATUS.ok;
  log(`replay ${ok ? "MATCHES" : "DIFFERS"}: ${events.length} events, ${target} ticks (${(target * ride.dt).toFixed(1)} s) replayed in ${(wall * 1000).toFixed(0)} ms (${(target * ride.dt / wall).toFixed(1)}x real time); live ${live}, replay ${replayed}`);
  post({ type: "verify", ok, live, replayed, wall, ticks: target });
}

// The reference ride, for the native-digest comparison (the page shows the digests side by side).
async function runReference() {
  const ref = await import("./reference.js");
  const results = [];
  for (const profile of ["interactive", "ambient"]) {
    const r = ref.runReference(engine, profile);
    results.push({ profile, ...r });
    log(`reference ride (${profile}): digest ${r.digest}, native ${r.expected}: ${r.match ? "EQUAL" : "DIFFERENT"}; ${r.ticks} ticks in ${(r.wallMs).toFixed(0)} ms wall (${(r.wallMs / (r.ticks * 156.25e-6) / 1000).toFixed(3)} s per simulated second, includes warm-up)`);
  }
  post({ type: "reference", results });
}
