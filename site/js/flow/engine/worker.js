// Physics worker: runs the PhantomFlow engine's bike at its fixed step, batched per frame, and publishes states for the page
// to draw. A module worker (new Worker(url, { type: "module" })); the messages are listed in the README beside this folder.
//
// - The clock: simulated time follows the wall clock. If the engine cannot keep up, catch-up is capped and the ride slows
//   (the published "speed ratio" says by how much), never spirals.
// - The profile is chosen by measured cost: a calibration burst before the ride, then a rolling check during it (see
//   chooseProfile and watchCost). Interactive drops to Ambient when its cost exceeds the profile's declared budget; the
//   choice and the numbers are logged to the page.
// - Every ride is its seed, setup and an event log (inputs, terrain appends and drops by tick), so it can be replayed in a
//   second bike and its digest compared: that is the "verify replay" control.
// - Two courses: the endless stand-in rollers, streamed ahead of the bike, or the proving loop, the engine's fixed test course
//   (rollers, rough, a step-up, a jump, a climb, two drops, a compression and a run-out), appended whole and launched at
//   LOOP_SPEED. The loop ends when the frame passes its finish.
// - Run integrity: a stop gate (a crash, a break, or numerics that cannot continue) ends the ride at the last accepted state;
//   a quality gate (the model outside where it is qualified, such as ground overlap past its limit) is recorded in the run
//   report, published with every frame, and the ride goes on.
// - A third course, the flow section: the proving loop through its jump (roll-in, rollers, rough, step-up and jump, launched at SECTION_SPEED),
//   timed from its start line to its finish with a split per sector, and bottom-outs counted. A finished section is posted as a
//   result (setup, event log, marks, splits, digest); handed back in the next start's config as `phantom`, it is replayed exactly
//   in a second bike, in step with the live ride, and drawn as a ghost; its digest is checked against the recorded one.
// - An optional speed governor (off by default) holds the ride at SPEED_LIMIT: above it the drive is cut and the brakes are
//   held. The event log records the input applied, governor included.
// - An optional auto rider (config.autoRider; rider_mvp.js) on the proving-loop courses: a scripted assist that works the
//   engine's rider slide and the rear hub at each jump. It decides once per batch from the last observation and the trail, so
//   its output is an input like the keys' and goes into the event log; a replay of the log needs no rider.
import { loadEngine, defaultSetup, PROFILE, STATUS, OBS, INFO, GATE, STOP_KIND_NAMES } from "./engine.js";
import { RiderMvp, findLips, combine } from "./rider_mvp.js";

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
const SPEED_LIMIT = 5.0;     // m/s (18 km/h): the optional governor's limit
const GOVERNOR = { frontBrake: 20, rearBrake: 40 }; // brake torques [N m] held above the limit
const LOOP_SEED = 2026;      // the proving loop's seed (the engine's native proving-loop tests use the same)
const LOOP_SPEED = 10.0;     // m/s: the proving loop's launch speed (it is sized for 8 to 12 m/s)
const SECTION_SPEED = 7.0;   // m/s: the flow section's launch speed (slower, so that ordinary setups ride it through)
const SECTION_FEATURES = ["lead-in", "rollers", "rough", "step-up", "jump"]; // the loop's features the flow section is made of, in order
const BOTTOM_BIT = 1 << GATE.bottomOut; // the observation's bit for the bottom-out quality gate

let engine = null;
let config = null;
let ride = null;             // the running ride, or null
let paused = false;
let input = { drive: 0, frontBrake: 0, rearBrake: 0 };
const NO_INPUT = Object.freeze({ drive: 0, frontBrake: 0, rearBrake: 0, riderTarget: 0, riderForce: 0 });
let last = performance.now();
let timer = 0;

const isCourseLoop = (cfg) => cfg.course === "loop" || cfg.course === "section";

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
    compression: cfg.damping, rebound: cfg.damping, speed: cfg.course === "loop" ? LOOP_SPEED : cfg.course === "section" ? SECTION_SPEED : (cfg.speed ?? 3),
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
  if (ride) { ride.bike.destroy(); ride.phantom?.bike.destroy(); }
  const profile = forcedProfile ?? chooseProfile(cfg);
  const bike = engine.create(setupFor(cfg, profile));
  ride = {
    bike, profile, cfg, dt: bike.dt, accum: 0, ended: false, rideSeconds: 0, strikes: 0, nextCheck: 1.0,
    trail: { x: bike.setup.startX + 5, z: bike.setup.startZ, next: 0 }, window: { x: [], z: [] }, events: [], snapshots: [], costs: [], busyTotal: 0, simTotal: 0,
    wallStart: performance.now(), lastSnapshotTick: -1, terrainMs: 0, terrainBuilds: 0, lastDigest: "",
    applied: { ...NO_INPUT }, speed: 0, governorLogged: false, loop: null, completed: false,
    course: null, tracker: null, phantom: null, result: null, finish: 0, rider: null, lastObs: null,
  };
  input = { drive: 0, frontBrake: 0, rearBrake: 0 };
  // The engine's terrain starts as a flat run from start_x - 3 to start_x + 5 at start_z (flow_create): the page's mirror of
  // it must begin the same way, or the view draws no ground under the launch.
  ride.window = { x: [bike.setup.startX - 3, bike.setup.startX + 5], z: [bike.setup.startZ, bike.setup.startZ] };
  if (isCourseLoop(cfg)) appendLoop(); else appendTrail(4);
  if (cfg.course === "section") {
    ride.course = sectionOf(ride.loop);
    ride.tracker = newTracker(ride.course);
    ride.finish = ride.course.finish;
    if (cfg.phantom) startPhantom(cfg.phantom);
  } else {
    ride.finish = ride.loop?.finish ?? 0;
  }
  if (cfg.autoRider && ride.loop) {
    const jumps = ride.loop.features.filter((f) => f.name === "jump" && f.start < (ride.finish || Infinity));
    ride.rider = new RiderMvp(findLips(ride.loop.points, jumps));
    log(`auto rider on: absorb and level at ${ride.rider.lips.length} jump lip(s) (x ${ride.rider.lips.map((x) => x.toFixed(2)).join(", ")} m)`);
  }
  ride.lastObs = bike.observe();
  post({
    type: "started", profile, reason, info: bike.info, dt: bike.dt, setup: bike.setup, nodes: bike.nodes,
    window: windowPoints(), course: cfg.course === "loop" || cfg.course === "section" ? cfg.course : "rollers", governor: Boolean(cfg.governor),
    autoRider: Boolean(ride.rider),
    features: ride.loop?.features ?? null, section: ride.course,
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

// Appends the whole proving loop after the flat start (about 1,650 points, inside one append) and logs the event.
function appendLoop() {
  const { bike, trail } = ride;
  const loop = engine.provingLoop(LOOP_SEED, trail.x, trail.z);
  ride.loop = loop;
  const t0 = performance.now();
  bike.appendTerrain(loop.points);
  ride.terrainMs += performance.now() - t0;
  ride.terrainBuilds++;
  for (let i = 0; i < loop.points.length; i += 2) { ride.window.x.push(loop.points[i]); ride.window.z.push(loop.points[i + 1]); }
  trail.x = loop.points[loop.points.length - 2];
  trail.z = loop.points[loop.points.length - 1];
  ride.events.push({ tick: bike.tick, type: "loop", seed: LOOP_SEED });
  post({ type: "terrain", points: loop.points });
  log(`proving loop (seed ${LOOP_SEED}): ${loop.points.length / 2} points, ${(loop.finish - loop.features[0].start).toFixed(0)} m to the finish; launched at ${ride.cfg.course === "section" ? SECTION_SPEED : LOOP_SPEED} m/s`);
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
  if (!ride.loop && obs[OBS.terrainLastX] < obs[OBS.frontX] + LOOKAHEAD) appendTrail(APPEND_ROLLERS);
  if (obs[OBS.rearX] - BEHIND > obs[OBS.terrainFirstX] + 8) dropTrail(obs[OBS.rearX] - BEHIND);
}

// The rider's keys; what is applied (and logged) is decided per batch by applyInput, which adds the governor when it is on.
function setInput(msg) {
  input = { drive: msg.drive ?? 0, frontBrake: msg.frontBrake ?? 0, rearBrake: msg.rearBrake ?? 0 };
}

// The optional governor (mirrored by the engine's native page-ride test): above SPEED_LIMIT no drive, and at least
// GOVERNOR's brakes.
function governed(keys, speed) {
  if (!ride.cfg.governor || !(speed > SPEED_LIMIT)) return { ...keys };
  return {
    drive: Math.min(keys.drive, 0), frontBrake: Math.max(keys.frontBrake, GOVERNOR.frontBrake),
    rearBrake: Math.max(keys.rearBrake, GOVERNOR.rearBrake),
  };
}

// The input for the next batch, from the keys, the last observed speed and (when on) the auto rider's decision from the last
// observation; a change goes into the event log.
function applyInput() {
  const keys = governed(input, ride.speed);
  const next = ride.rider ? combine(keys, ride.rider.decide(ride.lastObs)) : { ...keys, riderTarget: 0, riderForce: 0 };
  const a = ride.applied;
  if (next.drive !== a.drive || next.frontBrake !== a.frontBrake || next.rearBrake !== a.rearBrake ||
      next.riderTarget !== a.riderTarget || next.riderForce !== a.riderForce) {
    ride.applied = next;
    ride.events.push({ tick: ride.bike.tick, type: "input", ...next });
  }
  if (ride.cfg.governor && ride.speed > SPEED_LIMIT && !ride.governorLogged) {
    ride.governorLogged = true;
    log(`speed governor (optional, on): holding ${SPEED_LIMIT} m/s (${(SPEED_LIMIT * 3.6).toFixed(0)} km/h)`);
  }
  return ride.applied;
}

function takeSnapshot() {
  const { bike } = ride;
  ride.snapshots.push({
    tick: bike.tick, bytes: bike.snapshot(), trail: { ...ride.trail }, events: ride.events.length,
    window: { x: ride.window.x.slice(), z: ride.window.z.slice() }, applied: { ...ride.applied }, speed: ride.speed,
    rider: ride.rider ? { next: ride.rider.next, phase: ride.rider.phase } : null, lastObs: ride.lastObs.slice(),
  });
  if (ride.snapshots.length > SNAPSHOTS_KEPT) ride.snapshots.shift();
  ride.lastSnapshotTick = bike.tick;
}

function rewind(seconds) {
  if (!ride) return;
  if (ride.tracker) { log("rewind is not offered on the flow section: a timed run restarts instead"); return; }
  const target = ride.bike.tick - Math.round(seconds / ride.dt);
  let pick = ride.snapshots[0];
  for (const s of ride.snapshots) if (s.tick <= target) pick = s;
  ride.bike.restore(pick.bytes);
  ride.trail = { ...pick.trail };
  ride.events.length = pick.events;
  ride.window = { x: pick.window.x.slice(), z: pick.window.z.slice() };
  ride.snapshots = ride.snapshots.filter((s) => s.tick <= pick.tick);
  ride.ended = false;
  ride.completed = false;
  ride.accum = 0;
  ride.applied = { ...pick.applied };
  ride.speed = pick.speed;
  if (ride.rider && pick.rider) Object.assign(ride.rider, pick.rider);
  ride.lastObs = pick.lastObs.slice();
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
  const status = bike.step(n, applyInput());
  const t1 = performance.now();
  const obs = bike.observe();
  const casings = bike.casings();
  ride.speed = obs[OBS.speed];
  ride.lastObs = obs.slice(); // obs itself is transferred to the page
  ensureTerrain(obs);
  if (ride.tracker) track(ride.tracker, obs, bike.info);
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
    const r = bike.report();
    const kind = STOP_KIND_NAMES[r.stopKind] || "?";
    log(`ride stopped at ${r.stopTime.toFixed(2)} s, x ${r.stopX.toFixed(1)} m by a stop gate: ${r.stopName || "?"} (${kind}; ${bike.guardReason || "no detail"}); rewind or restart`);
    logReport(r);
  } else if (ride.loop && obs[OBS.frameX] >= ride.finish) {
    ride.ended = true;
    ride.completed = true;
    log(`${ride.course ? "flow section" : "proving loop"} completed at ${obs[OBS.time].toFixed(2)} s: no stop gate`);
    logReport(bike.report());
    if (ride.tracker) finishSection();
  }
  if (ride.phantom) stepPhantom(n);
  publish(false, obs, casings);
  // The ride ended while the phantom was still running: the last frame (with the phantom where it was) is out, so run the rest
  // of the phantom at once, only to check its digest against the recording.
  if (ride.ended && ride.phantom && !ride.phantom.done) {
    while (!ride.phantom.done) stepPhantom(4096);
  }
  if (!ride.ended) watchCost();
}

// The run report as log lines: each quality gate passed, its worst and where it first passed.
function logReport(r) {
  for (const g of r.gates) {
    if (g.steps > 0) {
      log(`  ${g.name}: worst ${g.worst.toPrecision(3)} against ${g.limit.toPrecision(3)} at x ${g.worstX.toFixed(1)} m; past for ${g.steps} steps (${(g.timePast * 1000).toFixed(0)} ms), first at x ${g.firstX.toFixed(1)} m`);
    }
  }
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
    terrainBuilds: ride.terrainBuilds, terrainMs: ride.terrainMs, ended: ride.ended, completed: ride.completed, paused,
    report: bike.report(),
    section: ride.tracker ? trackerSummary(ride.tracker, obs) : null,
    phantom: ride.phantom ? { done: ride.phantom.done, ok: ride.phantom.ok } : null,
    rider: ride.rider ? ride.rider.phaseName : null,
    ratio: ride.rideSeconds > 0 ? ride.rideSeconds / Math.max(1e-6, (performance.now() - ride.wallStart) / 1000) : 1,
    events: ride.events.length, at: performance.now(),
    // The engine's own ground height under each tyre's mean contact point, for the view's ground check.
    ground: [bike.groundHeight(obs[OBS.frontContactX]), bike.groundHeight(obs[OBS.rearContactX])],
  };
  const transfer = [obs.buffer, ...casings.map((c) => c.buffer)];
  if (ride.phantom) {
    message.ghost = ride.phantom.obs.slice();
    transfer.push(message.ghost.buffer);
  }
  post(message, transfer);
}

// --- the flow section: timing, splits and the phantom ------------------------------------------------------------------------

// The section is the loop's first features (SECTION_FEATURES): its start line is the first one's start, its finish the last
// one's end (rounded down to a whole metre, as the marks are one per metre), its sectors one per feature.
function sectionOf(loop) {
  const parts = SECTION_FEATURES.map((name) => loop.features.find((f) => f.name === name));
  if (parts.some((f) => !f)) throw new Error("the proving loop lacks a feature the flow section needs");
  const start = parts[0].start;
  const finish = start + Math.floor(parts[parts.length - 1].end - start);
  return { start, finish, sectors: parts.map((f) => ({ name: f.name, start: f.start, end: Math.min(f.end, finish) })) };
}

// A tracker keeps, for the live ride: the time the frame first reached each whole metre from the start line (the marks, the
// split and delta source), the bottom-out count (rising edges of the engine's bottom-out gate) and the travel used.
function newTracker(course) {
  return { course, prev: null, marks: [], bottomOuts: 0, bottomed: false, forkMax: 0, shockMax: 0 };
}

function track(tr, obs, info) {
  const c = tr.course;
  const t = obs[OBS.time], x = obs[OBS.frameX];
  if (tr.prev) {
    const last = c.finish - c.start;
    while (tr.marks.length <= last && x >= c.start + tr.marks.length) {
      const b = c.start + tr.marks.length;
      const span = x - tr.prev.x;
      const f = span > 0 ? Math.min(1, Math.max(0, (b - tr.prev.x) / span)) : 1;
      tr.marks.push(tr.prev.t + f * (t - tr.prev.t));
    }
  }
  tr.prev = { t, x };
  const hit = (obs[OBS.gates] & BOTTOM_BIT) !== 0;
  if (hit && !tr.bottomed) tr.bottomOuts++;
  tr.bottomed = hit;
  tr.forkMax = Math.max(tr.forkMax, obs[OBS.forkTravel] / info[INFO.forkTravel]);
  if (info[INFO.full] > 0.5) tr.shockMax = Math.max(tr.shockMax, obs[OBS.rearTravel] / info[INFO.shockTravel]);
}

// The time the frame was at x, interpolated between the whole-metre marks; NaN where the marks do not reach.
function timeAt(marks, start, x) {
  const u = x - start;
  if (!(u >= 0) || marks.length < 2 || u > marks.length - 1) return NaN;
  const i = Math.min(Math.floor(u), marks.length - 2);
  return marks[i] + (marks[i + 1] - marks[i]) * (u - i);
}

// Per-sector times (NaN until its end is reached), as the difference of its end and start times.
function sectorTimes(marks, course) {
  return course.sectors.map((s) => timeAt(marks, course.start, s.end) - timeAt(marks, course.start, s.start));
}

function trackerSummary(tr, obs) {
  const c = tr.course, m = tr.marks;
  const finished = m.length === c.finish - c.start + 1;
  const time = m.length === 0 ? NaN : finished ? m[m.length - 1] - m[0] : obs[OBS.time] - m[0];
  let delta = NaN;
  const rec = ride.phantom?.rec;
  if (rec && m.length > 0) {
    if (finished) delta = time - rec.time;
    else {
      const g = timeAt(rec.marks, c.start, obs[OBS.frameX]);
      if (Number.isFinite(g)) delta = time - (g - rec.marks[0]);
    }
  }
  return {
    started: m.length > 0, finished, time, delta, splits: sectorTimes(m, c), bottomOuts: tr.bottomOuts,
    forkMax: tr.forkMax, shockMax: tr.shockMax,
  };
}

// A finished section becomes a result the page may keep as the next ride's phantom: everything needed to replay it exactly.
function finishSection() {
  const { bike, tracker: tr, course } = ride;
  const { phantom: _unused, ...cfg } = ride.cfg;
  const marks = tr.marks.slice();
  ride.result = {
    cfg, profile: ride.profile, events: ride.events.map((e) => ({ ...e })), endTick: bike.tick, digest: bike.digestHex(),
    marks, time: marks[marks.length - 1] - marks[0], splits: sectorTimes(marks, course), bottomOuts: tr.bottomOuts,
    forkMax: tr.forkMax, shockMax: tr.shockMax, sectors: course.sectors, start: course.start, finish: course.finish,
  };
  post({ type: "section-done", result: ride.result });
}

// The phantom: a second bike with the recorded run's setup, fed its recorded event log (inputs, terrain appends and drops by
// tick) in step with the live ride. It is drawn as a ghost; when it reaches the recorded end its digest is compared with the
// one the recording kept.
function startPhantom(rec) {
  const bike = engine.create(setupFor(rec.cfg, rec.profile));
  ride.phantom = { rec, bike, ei: 0, input: { ...NO_INPUT }, done: false, ok: null, obs: null };
  applyPhantomEvents(ride.phantom);
  ride.phantom.obs = bike.observe();
  log(`phantom: replaying the recorded run (${rec.endTick} ticks, ${rec.time.toFixed(2)} s, ${rec.events.length} events) beside this ride`);
}

function applyPhantomEvents(p) {
  const events = p.rec.events;
  while (p.ei < events.length && events[p.ei].tick <= p.bike.tick) {
    const e = events[p.ei++];
    if (e.type === "input") p.input = inputOf(e);
    else if (e.type === "drop") p.bike.dropBehind(e.x);
    else if (e.type === "loop") p.bike.appendTerrain(engine.provingLoop(e.seed, 5, 0).points);
  }
}

function stepPhantom(n) {
  const p = ride.phantom;
  if (p.done) return;
  const status = p.bike.step(Math.min(n, p.rec.endTick - p.bike.tick), p.input);
  applyPhantomEvents(p);
  p.obs = p.bike.observe();
  if (status !== STATUS.ok || p.bike.tick >= p.rec.endTick) {
    p.done = true;
    const digest = p.bike.digestHex();
    p.ok = status === STATUS.ok && digest === p.rec.digest;
    log(`phantom replay ${p.ok ? "MATCHES" : "DIFFERS"}: ${p.bike.tick} ticks replayed from the input log, digest ${digest}, recorded ${p.rec.digest}`);
    post({ type: "phantom-check", ok: p.ok, digest, recorded: p.rec.digest, ticks: p.bike.tick });
  }
}

// --- replay verification ----------------------------------------------------------------------------------------------

// A logged input event as the input it applied (a recording from before the rider slots has none: zero).
function inputOf(e) {
  return { drive: e.drive, frontBrake: e.frontBrake, rearBrake: e.rearBrake, riderTarget: e.riderTarget ?? 0, riderForce: e.riderForce ?? 0 };
}

// Replays the event log in a second bike up to the current tick and compares digests with the live one.
function verifyReplay() {
  if (!ride) return;
  const target = ride.bike.tick;
  const live = ride.bike.digestHex();
  const events = ride.events.filter((e) => e.tick <= target);
  const copy = engine.create(ride.bike.setup);
  const trail = { x: 5, z: 0, next: 0 };
  let current = { ...NO_INPUT };
  let status = STATUS.ok;
  const t0 = performance.now();
  const advance = (to) => {
    while (copy.tick < to && status === STATUS.ok) status = copy.step(Math.min(4096, to - copy.tick), current);
  };
  for (const e of events) {
    advance(e.tick);
    if (e.type === "input") current = inputOf(e);
    else if (e.type === "drop") copy.dropBehind(e.x);
    else if (e.type === "loop") copy.appendTerrain(engine.provingLoop(e.seed, trail.x, trail.z).points);
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
