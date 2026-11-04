// Glue between the PhantomFlow engine's WebAssembly module and the ride code: loads the module, checks its layout against
// the constants below, and wraps one bike (create, step, terrain, observe, snapshot, digest). Plain ES module with no DOM,
// so it runs in a worker, in the page and under Node (the determinism gate loads this same file).
//
// The module is a build of the engine and is loaded from a URL the page gives; this client and the module are released together
// (the layout version below ties them).

// The layout version: must equal FLOW_API_VERSION in the module's flow_api.h. It changes whenever the observation or the
// static information gains, loses or moves an entry, so a page never reads a module it does not match.
export const API_VERSION = 3;

// Layout of the engine's records (mirrors flow_api.h; checked against the module at load).
export const SETUP_BYTES = 88;
export const INPUT_DOUBLES = 11; // drive, front brake, rear brake, then 8 reserved rider slots (must stay zero for now)
export const INPUT_BYTES = INPUT_DOUBLES * 8;
export const OBS = Object.freeze({
  time: 0, tick: 1, guard: 2, asleep: 3, frameX: 4, frameZ: 5, pitch: 6, riderX: 7, riderZ: 8,
  frontX: 9, frontZ: 10, frontAngle: 11, rearX: 12, rearZ: 13, rearAngle: 14,
  forkTravel: 15, rearTravel: 16, riderOffset: 17, speed: 18, verticalSpeed: 19,
  frontLoad: 20, rearLoad: 21, frontDrag: 22, rearDrag: 23, frontContacts: 24, rearContacts: 25,
  terrainFirstX: 26, terrainLastX: 27, swingAngle: 28,
  frontContactX: 29, frontContactZ: 30, rearContactX: 31, rearContactZ: 32, gates: 33, count: 34,
});
export const INFO = Object.freeze({
  step: 0, nodes: 1, wheelRadius: 2, rimRadius: 3, forkTravel: 4, shockTravel: 5, riderTravel: 6, mass: 7,
  headAxisX: 8, headAxisZ: 9, budget: 10, full: 11,
  frontAxleX: 12, frontAxleZ: 13, rearAxleX: 14, rearAxleZ: 15, pivotX: 16, pivotZ: 17,
  shockFrameX: 18, shockFrameZ: 19, shockArmX: 20, shockArmZ: 21, shockRest: 22,
  bbX: 23, bbZ: 24, headBottomX: 25, headBottomZ: 26, headTopX: 27, headTopZ: 28,
  seatJointX: 29, seatJointZ: 30, seatTopX: 31, seatTopZ: 32, count: 33,
});
export const STATUS = Object.freeze({ ok: 0, guard: 1, arg: -1, setup: -2, fault: -3, rider: -4, terrain: -5, buffer: -6 });
export const PROFILE = Object.freeze({ interactive: 0, ambient: 1 });
export const SUSPENSION = Object.freeze({ full: 0, hardtail: 1 });
export const TYRE = Object.freeze({ soft: 0, standard: 1, firm: 2 });
// Stop gates end a run (a crash, a break, or numerics that cannot continue); quality gates are recorded in the run report
// and the run goes on. Names come from the module (FlowEngine.guardName, FlowEngine.gateName).
export const STOP_KIND = Object.freeze({ none: 0, crash: 1, break: 2, numerics: 3 });
export const STOP_KIND_NAMES = ["", "crash", "break", "numerics"];
export const GATE = Object.freeze({
  penetration: 0, pitch: 1, strain: 2, displacement: 3, motion: 4, bottomOut: 5, energy: 6, solver: 7, count: 8,
});
export const REPORT_BYTES = 576;
const GATE_DOUBLES = 8;
const ROLLER_POINTS = 33;
const PROVING_FEATURES = 10;
const MAX_TERRAIN_POINTS = 4096;

/** The setup record's defaults; any field may be overridden. Zero means the engine's default. */
export function defaultSetup(over = {}) {
  return {
    profile: PROFILE.interactive, suspension: SUSPENSION.full, tyre: TYRE.standard,
    forkRate: 0, shockRate: 0, compression: 0, rebound: 0, speed: 3, friction: 0,
    startX: 0, startZ: 0, guardInterval: 0, ...over,
  };
}

/** The hex form of a 64-bit digest, 16 digits. */
export function hex64(value) {
  return BigInt.asUintN(64, value).toString(16).padStart(16, "0");
}

/**
 * Loads the module.
 * @param {string|URL} moduleUrl The phantomflow_engine.mjs to import.
 * @param {object} [options] `locateFile` for the .wasm if it is not next to the module.
 * @returns {Promise<FlowEngine>}
 */
export async function loadEngine(moduleUrl, options = {}) {
  const { default: createModule } = await import(/* @vite-ignore */ String(moduleUrl));
  const module = await createModule(options);
  return new FlowEngine(module);
}

export class FlowEngine {
  constructor(module) {
    this.m = module;
    if (module._flow_version() !== API_VERSION) {
      throw new Error(`The engine module is layout version ${module._flow_version()} but this page needs ${API_VERSION}. Use the module this client was released with.`);
    }
    const p = module._malloc(32);
    module._flow_layout(p);
    const layout = Array.from(module.HEAP32.subarray(p >> 2, (p >> 2) + 8));
    module._free(p);
    const expected = [SETUP_BYTES, INPUT_BYTES, OBS.count, INFO.count, 8, 24, REPORT_BYTES, GATE.count];
    if (layout.some((v, i) => v !== expected[i])) throw new Error(`engine layout ${layout} differs from ${expected}`);
    this.guardNames = [];
    for (let c = 0; ; c++) {
      const name = c === 0 ? "" : module.UTF8ToString(module._flow_guard_name(c));
      if (c > 0 && name === "") break;
      this.guardNames.push(name);
    }
    this.gateNames = [];
    for (let g = 0; g < GATE.count; g++) this.gateNames.push(module.UTF8ToString(module._flow_gate_name(g)));
  }

  /** A stop gate's name ("" for none). */
  guardName(code) {
    return this.guardNames[code] ?? "";
  }

  /** A stop gate's kind (STOP_KIND). */
  guardKind(code) {
    return this.m._flow_guard_kind(code);
  }

  /**
   * The proving loop: the engine's fixed test course (rollers, rough, a step-up, a jump, a climb, two drops, a compression
   * and a run-out), identical on every platform. Its first point is beyond x0.
   * @returns {{points: Float64Array, features: {name: string, start: number, end: number}[], finish: number}}
   */
  provingLoop(seed, x0, z0) {
    const m = this.m;
    const count = m._flow_proving_loop(seed >>> 0, x0, z0, 0, 0);
    if (count < 0) throw new Error(`proving loop failed: ${count}`);
    const p = m._malloc(count * 16);
    const n = m._flow_proving_loop(seed >>> 0, x0, z0, p, count);
    if (n !== count) { m._free(p); throw new Error(`proving loop failed: ${n}`); }
    const points = new Float64Array(m.HEAPF64.buffer, p, n * 2).slice();
    m._free(p);
    const r = m._malloc(16);
    const features = [];
    for (let f = 0; f < PROVING_FEATURES; f++) {
      const name = m.UTF8ToString(m._flow_proving_feature(seed >>> 0, f, x0, r));
      const range = new Float64Array(m.HEAPF64.buffer, r, 2);
      features.push({ name, start: range[0], end: range[1] });
    }
    m._free(r);
    return { points, features, finish: features[PROVING_FEATURES - 1].end };
  }

  /** Builds a bike. Throws with the engine's reason when the setup is refused. */
  create(setup) {
    return new FlowBike(this, setup);
  }

  /** Points of one stand-in trail roller (the engine's, identical on every platform), chained from (x0, z0). */
  roller(seed, index, x0, z0) {
    const m = this.m;
    const p = m._malloc(ROLLER_POINTS * 16);
    const n = m._flow_trail_roller(seed >>> 0, index >>> 0, x0, z0, p, ROLLER_POINTS);
    if (n < 0) { m._free(p); throw new Error(`roller failed: ${n}`); }
    const out = new Float64Array(m.HEAPF64.buffer, p, n * 2).slice();
    m._free(p);
    return out;
  }
}

export class FlowBike {
  constructor(engine, setup) {
    const m = engine.m;
    this.engine = engine;
    this.m = m;
    const s = { ...defaultSetup(), ...setup };
    const sp = m._malloc(SETUP_BYTES);
    const i32 = new Int32Array(m.HEAPU8.buffer, sp, SETUP_BYTES / 4);
    const f64 = new Float64Array(m.HEAPU8.buffer, sp, SETUP_BYTES / 8);
    i32.fill(0);
    i32[0] = API_VERSION; i32[1] = s.profile; i32[2] = s.suspension; i32[3] = s.tyre;
    f64[2] = s.forkRate; f64[3] = s.shockRate; f64[4] = s.compression; f64[5] = s.rebound; f64[6] = s.speed;
    f64[7] = s.friction; f64[8] = s.startX; f64[9] = s.startZ;
    i32[20] = s.guardInterval;
    const st = m._malloc(4);
    this.handle = m._flow_create(sp, st);
    const status = m.HEAP32[st >> 2];
    m._free(sp); m._free(st);
    if (!this.handle) throw new Error(`engine refused the setup (${status}): ${m.UTF8ToString(m._flow_last_error())}`);
    this.setup = s;
    this.obsPtr = m._malloc(OBS.count * 8);
    this.infoPtr = m._malloc(INFO.count * 8);
    this.casingPtr = m._malloc(2 * 128 * 8);
    this.reportPtr = m._malloc(REPORT_BYTES);
    this.inputCapacity = 0;
    this.inputPtr = 0;
    this.terrainCapacity = 0;
    this.terrainPtr = 0;
    this.snapshotCapacity = 0;
    this.snapshotPtr = 0;
    m._flow_info(this.handle, this.infoPtr, INFO.count);
    this.info = Array.from(new Float64Array(m.HEAPF64.buffer, this.infoPtr, INFO.count));
    this.dt = this.info[INFO.step];
    this.nodes = this.info[INFO.nodes];
  }

  destroy() {
    const m = this.m;
    if (!this.handle) return;
    m._flow_destroy(this.handle);
    for (const p of [this.obsPtr, this.infoPtr, this.casingPtr, this.reportPtr, this.inputPtr, this.terrainPtr, this.snapshotPtr]) if (p) m._free(p);
    this.handle = 0;
  }

  _inputs(count) {
    const m = this.m;
    if (count > this.inputCapacity) {
      if (this.inputPtr) m._free(this.inputPtr);
      this.inputCapacity = Math.max(count, 256);
      this.inputPtr = m._malloc(this.inputCapacity * INPUT_BYTES);
    }
    return new Float64Array(m.HEAPF64.buffer, this.inputPtr, count * INPUT_DOUBLES);
  }

  /**
   * Advances n fixed steps with one input held for all of them.
   * @param {number} n Steps.
   * @param {{drive?:number, frontBrake?:number, rearBrake?:number}} input Drive and brake torques [N m].
   * @returns {number} A STATUS value.
   */
  step(n, input = {}) {
    const view = this._inputs(1);
    view.fill(0);
    view[0] = input.drive ?? 0; view[1] = input.frontBrake ?? 0; view[2] = input.rearBrake ?? 0;
    return this.m._flow_step(this.handle, n, this.inputPtr, 1);
  }

  /**
   * Advances n steps with a record per tick.
   * @param {number} n Steps.
   * @param {(k:number, out:Float64Array)=>void} fill Writes tick k's drive, front brake and rear brake into out[0..2].
   * @returns {number} A STATUS value.
   */
  stepEach(n, fill) {
    const view = this._inputs(n);
    view.fill(0);
    for (let k = 0; k < n; k++) fill(k, view.subarray(k * INPUT_DOUBLES, k * INPUT_DOUBLES + 3));
    return this.m._flow_step(this.handle, n, this.inputPtr, n);
  }

  /** Appends terrain points (a Float64Array of x, z pairs, x increasing past the window's end). */
  appendTerrain(points) {
    const m = this.m;
    const count = points.length / 2;
    if (count > MAX_TERRAIN_POINTS) throw new Error("too many terrain points in one call");
    if (points.length * 8 > this.terrainCapacity) {
      if (this.terrainPtr) m._free(this.terrainPtr);
      this.terrainCapacity = Math.max(points.length * 8, 4096);
      this.terrainPtr = m._malloc(this.terrainCapacity);
    }
    new Float64Array(m.HEAPF64.buffer, this.terrainPtr, points.length).set(points);
    const status = m._flow_terrain_append(this.handle, this.terrainPtr, count);
    if (status !== STATUS.ok) throw new Error(`terrain append failed (${status})`);
  }

  /** Drops terrain behind x. */
  dropBehind(x) {
    const status = this.m._flow_terrain_drop(this.handle, x);
    if (status !== STATUS.ok) throw new Error(`terrain drop failed (${status})`);
  }

  groundHeight(x) {
    return this.m._flow_ground_height(this.handle, x);
  }

  /** The observation of the current state as a fresh Float64Array indexed by OBS. */
  observe() {
    const m = this.m;
    const status = m._flow_observe(this.handle, this.obsPtr, OBS.count);
    if (status < 0) throw new Error(`observe failed (${status})`);
    return new Float64Array(m.HEAPF64.buffer, this.obsPtr, OBS.count).slice();
  }

  /** Both casings' node positions: [front, rear], each a Float64Array of x, z pairs. */
  casings() {
    const m = this.m;
    const out = [];
    for (let w = 0; w < 2; w++) {
      if (m._flow_casing(this.handle, w, this.casingPtr, 2 * 128) !== STATUS.ok) throw new Error("casing failed");
      out.push(new Float64Array(m.HEAPF64.buffer, this.casingPtr, 2 * this.nodes).slice());
    }
    return out;
  }

  /**
   * The run report: the stop gate if one ended the run, and every quality gate's record (steps past its limit, when and
   * where it first passed, its worst value, when and where). Not part of the digest.
   */
  report() {
    const m = this.m;
    if (m._flow_run_report(this.handle, this.reportPtr) !== STATUS.ok) throw new Error("run report failed");
    const i32 = new Int32Array(m.HEAPU8.buffer, this.reportPtr, 4);
    const f64 = new Float64Array(m.HEAPU8.buffer, this.reportPtr, REPORT_BYTES / 8);
    const gates = [];
    for (let g = 0; g < i32[3]; g++) {
      const o = 8 + g * GATE_DOUBLES;
      gates.push({
        name: this.engine.gateNames[g], steps: f64[o], timePast: f64[o + 1], firstTime: f64[o + 2], firstX: f64[o + 3],
        worst: f64[o + 4], worstTime: f64[o + 5], worstX: f64[o + 6], limit: f64[o + 7],
      });
    }
    return {
      version: i32[0], stopCode: i32[1], stopKind: i32[2], stopName: this.engine.guardName(i32[1]),
      ticks: f64[2], time: f64[3], stopTime: f64[4], stopX: f64[5], stopValue: f64[6], stopLimit: f64[7], gates,
    };
  }

  get tick() {
    return Number(this.m._flow_tick(this.handle));
  }

  get guardCode() {
    return this.m._flow_guard_code(this.handle);
  }

  get guardReason() {
    return this.m.UTF8ToString(this.m._flow_guard_reason(this.handle));
  }

  /** The determinism digest as a BigInt. */
  digest() {
    return BigInt.asUintN(64, this.m._flow_digest(this.handle));
  }

  digestHex() {
    return hex64(this.digest());
  }

  /** A snapshot as a fresh Uint8Array. */
  snapshot() {
    const m = this.m;
    const size = m._flow_snapshot_size(this.handle);
    if (size > this.snapshotCapacity) {
      if (this.snapshotPtr) m._free(this.snapshotPtr);
      this.snapshotCapacity = size * 2;
      this.snapshotPtr = m._malloc(this.snapshotCapacity);
    }
    const written = m._flow_snapshot(this.handle, this.snapshotPtr, this.snapshotCapacity);
    if (written < 0) throw new Error(`snapshot failed (${written})`);
    return new Uint8Array(m.HEAPU8.buffer, this.snapshotPtr, written).slice();
  }

  /** Restores a snapshot taken from a bike of the same setup. */
  restore(bytes) {
    const m = this.m;
    if (bytes.length > this.snapshotCapacity) {
      if (this.snapshotPtr) m._free(this.snapshotPtr);
      this.snapshotCapacity = bytes.length * 2;
      this.snapshotPtr = m._malloc(this.snapshotCapacity);
    }
    m.HEAPU8.set(bytes, this.snapshotPtr);
    const status = m._flow_restore(this.handle, this.snapshotPtr, bytes.length);
    if (status !== STATUS.ok) throw new Error(`restore failed (${status})`);
  }
}
