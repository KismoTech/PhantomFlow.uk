// Side-on view of the ride on a canvas: draws the published states, interpolated between the two that bracket the render
// clock, so the picture is smooth at any display rate while the physics runs at its own fixed step in the worker.
//
// The bike is drawn from the PhantomFlow engine's own geometry (flow_info: the frame, pivot and shock points, frame-local)
// and its moving coordinates (flow_observe: pose, fork travel, swingarm angle, wheel rotation, tyre nodes). Nothing here
// moves on its own and nothing is guessed: the fork slides by the reported travel, the swingarm turns about the real
// pivot, the shock runs between its real eyes. The frame tubes are an outline the engine derives from those points.
// There is no rider yet: `riderLayer` is the place for one (see draw()).
import { OBS, INFO } from "./engine.js";

const FRAMES_KEPT = 16;
const MAX_LAG = 0.1;      // seconds the render clock may trail the newest state before it snaps
const TARGET_LAG = 0.034;
const SAG_TAU = 2;        // seconds of simulated time in the running mean of travel (the sag mark)
const LOOK_AHEAD = 0.12;  // seconds of speed the camera looks ahead
const LOAD_ARROW = 0.0006; // metres of arrow per newton of ground force
const LOWERS_LENGTH = 0.3; // fork lowers, axle to the top of the lowers [m] (drawn; the stanchions slide into them)

const lerp = (a, b, t) => a + (b - a) * t;
const lerpAngle = (a, b, t) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
};
const PALETTE = [
  "sky", "ground", "ground-line", "tyre", "rim", "spoke", "frame", "swingarm", "stanchion", "lowers", "shock-body", "spring",
  "arrow", "plate", "fg", "muted", "danger", "gauge",
];

export class RideView {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.frames = [];
    this.renderTime = 0;
    this.lastDraw = 0;
    this.info = null;
    this.g = null;
    this.terrainX = [];
    this.terrainZ = [];
    this.camera = { x: 0, z: 0, ready: false };
    this.sag = [0, 0];
    this.groundCheck = { n: 0, maxDrawn: 0, maxContact: 0 };
    this.sagTime = -1;
    this.zoom = 1;           // a multiplier on the view scale (for close inspection)
    this.riderLayer = null;
    this.sw = { rx: 0, rz: 0, ex: 0, ez: 0 };
    this.linkCheck = { n: 0, maxShock: 0, maxRigid: 0, maxAxle: 0 };
    // Scratch, so the draw path allocates nothing per frame.
    this.obs = new Float64Array(OBS.count);
    this.cas = [new Float64Array(0), new Float64Array(0)];
    this.tx = { ox: 0, oz: 0, c: 1, s: 0, W: 0, H: 0, scale: 1, cx: 0, cz: 0 };
    this.px = 0;
    this.py = 0;
    this.colors = {};
    this.readColors();
    // Colours follow the page's theme tokens; re-read when the colour scheme changes.
    if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.readColors());
    this.resize();
  }

  /** Reads the palette from the page's CSS custom properties (--pg-*), which switch with the colour scheme. */
  readColors() {
    const style = getComputedStyle(this.canvas);
    for (const name of PALETTE) this.colors[name] = style.getPropertyValue(`--pg-${name}`).trim() || "#888";
  }

  /** Fits the canvas backing store to its CSS size at the device pixel ratio. */
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
  }

  reset(info) {
    this.info = info;
    this.g = geometryFrom(info);
    this.frames = [];
    this.camera.ready = false;
    this.renderTime = 0;
    this.sagTime = -1;
    this.groundCheck = { n: 0, maxDrawn: 0, maxContact: 0 };
    this.linkCheck = { n: 0, maxShock: 0, maxRigid: 0, maxAxle: 0 };
    this.readColors();
  }

  setTerrain(points) {
    this.terrainX = [];
    this.terrainZ = [];
    this.appendTerrain(points);
  }

  appendTerrain(points) {
    for (let i = 0; i < points.length; i += 2) {
      this.terrainX.push(points[i]);
      this.terrainZ.push(points[i + 1]);
    }
  }

  /** The drawn ground height at x: the polyline the page mirrors from the engine's terrain, or NaN outside it. */
  groundAt(x) {
    const xs = this.terrainX, n = xs.length;
    if (n < 2 || x < xs[0] || x > xs[n - 1]) return NaN;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid; else hi = mid;
    }
    const f = (x - xs[lo]) / (xs[hi] - xs[lo]);
    return this.terrainZ[lo] + (this.terrainZ[hi] - this.terrainZ[lo]) * f;
  }

  dropTerrain(x) {
    let i = 0;
    while (i + 1 < this.terrainX.length && this.terrainX[i + 1] <= x) i++;
    if (i > 0) { this.terrainX.splice(0, i); this.terrainZ.splice(0, i); }
  }

  /** Adds a published state: { obs, casings, simTime }, and folds its travel into the running mean (the sag marks). */
  push(frame) {
    this.frames.push(frame);
    if (frame.ground) this.checkGround(frame);
    if (this.g) this.checkLinkage(frame.obs);
    if (this.frames.length > FRAMES_KEPT) this.frames.shift();
    const t = frame.simTime;
    const travel = [frame.obs[OBS.forkTravel], frame.obs[OBS.rearTravel]];
    if (this.sagTime < 0 || t < this.sagTime) {
      this.sag[0] = travel[0];
      this.sag[1] = travel[1];
    } else {
      const k = 1 - Math.exp(-(t - this.sagTime) / SAG_TAU);
      this.sag[0] += (travel[0] - this.sag[0]) * k;
      this.sag[1] += (travel[1] - this.sag[1]) * k;
    }
    this.sagTime = t;
  }

  // The ground check: under each tyre's mean contact point, the drawn ground must be the engine's ground (flow_ground_height,
  // sampled by the worker), and the contact itself must lie on it. Worst errors are kept in groundCheck [m].
  checkGround(frame) {
    const o = frame.obs;
    const gc = this.groundCheck;
    for (let w = 0; w < 2; w++) {
      if (o[w === 0 ? OBS.frontContacts : OBS.rearContacts] < 0.5) continue;
      const cx = o[w === 0 ? OBS.frontContactX : OBS.rearContactX], cz = o[w === 0 ? OBS.frontContactZ : OBS.rearContactZ];
      const drawn = this.groundAt(cx), engine = frame.ground[w];
      gc.n++;
      if (!(Math.abs(drawn - engine) <= gc.maxDrawn)) gc.maxDrawn = Number.isNaN(drawn) ? Infinity : Math.abs(drawn - engine);
      if (Math.abs(cz - engine) > gc.maxContact) gc.maxContact = Math.abs(cz - engine);
    }
  }

  // The state at the render clock, interpolated between the bracketing frames into the scratch arrays.
  current(nowMs) {
    const n = this.frames.length;
    if (n === 0) return false;
    const newest = this.frames[n - 1].simTime;
    const dt = this.lastDraw ? Math.min((nowMs - this.lastDraw) / 1000, 0.1) : 0;
    this.lastDraw = nowMs;
    this.dt = dt;
    this.renderTime += dt;
    if (this.renderTime < this.frames[0].simTime || newest - this.renderTime > MAX_LAG) this.renderTime = Math.max(this.frames[0].simTime, newest - TARGET_LAG);
    if (this.renderTime > newest) this.renderTime = newest;
    let i = n - 1;
    while (i > 0 && this.frames[i - 1].simTime >= this.renderTime) i--;
    const a = this.frames[Math.max(0, i - 1)], b = this.frames[i];
    const span = b.simTime - a.simTime;
    const t = span > 1e-9 ? Math.min(1, Math.max(0, (this.renderTime - a.simTime) / span)) : 1;
    const obs = this.obs;
    for (let k = 0; k < OBS.count; k++) obs[k] = lerp(a.obs[k], b.obs[k], t);
    obs[OBS.frontAngle] = lerpAngle(a.obs[OBS.frontAngle], b.obs[OBS.frontAngle], t);
    obs[OBS.rearAngle] = lerpAngle(a.obs[OBS.rearAngle], b.obs[OBS.rearAngle], t);
    for (let w = 0; w < 2; w++) {
      const out = this.cas[w].length === b.casings[w].length ? this.cas[w] : (this.cas[w] = new Float64Array(b.casings[w].length));
      const from = a.casings[w], to = b.casings[w];
      for (let k = 0; k < out.length; k++) out[k] = lerp(from[k], to[k], t);
    }
    return true;
  }

  // Frame-local point to screen, into this.px, this.py. Pitch is about +y, nose down positive.
  loc(x, z) {
    const t = this.tx;
    const wx = t.ox + x * t.c + z * t.s;
    const wz = t.oz - x * t.s + z * t.c;
    this.px = t.W / 2 + (wx - t.cx) * t.scale;
    this.py = t.H * 0.56 - (wz - t.cz) * t.scale;
  }

  m(x, z) { this.loc(x, z); this.ctx.moveTo(this.px, this.py); }
  l(x, z) { this.loc(x, z); this.ctx.lineTo(this.px, this.py); }

  // A stroked frame-local segment of the given world width [m].
  seg(x0, z0, x1, z1, width, color) {
    const { ctx } = this;
    ctx.beginPath();
    this.m(x0, z0);
    this.l(x1, z1);
    ctx.lineWidth = Math.max(1.5 * this.dpr, width * this.tx.scale);
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  // A world arrow from (x, z) of the given vector [m]; the head is sized in pixels.
  arrow(x, z, dx, dz, color) {
    const { ctx } = this;
    const t = this.tx, d = this.dpr;
    const x0 = t.W / 2 + (x - t.cx) * t.scale, y0 = t.H * 0.56 - (z - t.cz) * t.scale;
    const x1 = x0 + dx * t.scale, y1 = y0 - dz * t.scale;
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 2 * d) return;
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len, head = Math.min(9 * d, len * 0.6);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2.5 * d;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1 - ux * head * 0.5, y1 - uy * head * 0.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - ux * head - uy * head * 0.5, y1 - uy * head + ux * head * 0.5);
    ctx.lineTo(x1 - ux * head + uy * head * 0.5, y1 - uy * head - ux * head * 0.5);
    ctx.closePath();
    ctx.fill();
  }

  circle(x, y, r, fill, stroke, lineWidth) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.lineWidth = lineWidth; ctx.strokeStyle = stroke; ctx.stroke(); }
  }

  /**
   * Draws the newest interpolated state. `riderLayer(view, obs)`, when set, is called after the frame and fork and before the
   * readouts: draw a rider with view.loc(x, z) (frame-local to this.px, this.py) and obs[OBS.riderX], riderZ, riderOffset.
   */
  draw(nowMs, hud = {}) {
    this.resize();
    const have = this.current(nowMs);
    const { ctx, canvas, colors } = this;
    const W = canvas.width, H = canvas.height, d = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = colors.sky;
    ctx.fillRect(0, 0, W, H);
    if (!have || !this.g) {
      ctx.fillStyle = colors.fg;
      ctx.font = `${14 * d}px system-ui, sans-serif`;
      ctx.fillText(hud.message ?? "waiting for the engine", 16 * d, 28 * d);
      return;
    }
    const g = this.g, obs = this.obs;
    const narrow = this.canvas.clientWidth < 600;
    const scale = (W / (narrow ? 4.2 : 6.2)) * this.zoom;
    // Camera: follows the frame, looking ahead by a fraction of a second of speed; time-based smoothing.
    const ahead = Math.max(0, Math.min(narrow ? 0.5 : 0.9, obs[OBS.speed] * LOOK_AHEAD)) + (narrow ? 0.2 : 0.4);
    const targetX = obs[OBS.frameX] + ahead, targetZ = obs[OBS.frameZ];
    if (!this.camera.ready) { this.camera.x = targetX; this.camera.z = targetZ; this.camera.ready = true; }
    const dt = this.dt || 0.016;
    // A hidden tab or a long frame leaves the camera far behind: snap rather than glide across the trail.
    if (Math.abs(targetX - this.camera.x) > 4 * (narrow ? 1 : 1.5) || Math.abs(targetZ - this.camera.z) > 2) { this.camera.x = targetX; this.camera.z = targetZ; }
    this.camera.x = lerp(this.camera.x, targetX, 1 - Math.exp(-dt / 0.25));
    this.camera.z = lerp(this.camera.z, targetZ, 1 - Math.exp(-dt / 0.5));
    const pitch = obs[OBS.pitch];
    const t = this.tx;
    t.ox = obs[OBS.frameX]; t.oz = obs[OBS.frameZ]; t.c = Math.cos(pitch); t.s = Math.sin(pitch);
    t.W = W; t.H = H; t.scale = scale; t.cx = this.camera.x; t.cz = this.camera.z;
    const sx = (x) => W / 2 + (x - t.cx) * scale;
    const sz = (z) => H * 0.56 - (z - t.cz) * scale;

    this.drawGround(sx, sz, W, H, scale);

    // Wheels: the tyre from the casing nodes, rim, hub and spokes at the wheel's rotation.
    const rim = this.info[INFO.rimRadius];
    this.drawWheel(this.cas[1], obs[OBS.rearX], obs[OBS.rearZ], obs[OBS.rearAngle], rim, sx, sz, scale);
    this.drawWheel(this.cas[0], obs[OBS.frontX], obs[OBS.frontZ], obs[OBS.frontAngle], rim, sx, sz, scale);

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    this.drawFrame();
    this.drawRear(obs);
    this.drawFork(obs[OBS.forkTravel]);
    if (this.riderLayer) this.riderLayer(this, obs);
    this.drawLoads(obs, sx, sz);
    this.drawHud(obs, hud);
  }

  drawGround(sx, sz, W, H, scale) {
    const { ctx, colors, dpr } = this;
    const t = this.tx;
    ctx.beginPath();
    let started = false, firstX = 0, lastX = 0;
    const left = t.cx - W / 2 / scale - 0.5, right = t.cx + W / 2 / scale + 0.5;
    for (let i = 0; i < this.terrainX.length; i++) {
      const x = this.terrainX[i];
      if (x < left && this.terrainX[i + 1] < left) continue;
      if (!started) { ctx.moveTo(sx(x), sz(this.terrainZ[i])); started = true; firstX = x; } else ctx.lineTo(sx(x), sz(this.terrainZ[i]));
      lastX = x;
      if (x > right) break;
    }
    if (!started) return;
    ctx.strokeStyle = colors["ground-line"];
    ctx.lineWidth = 3 * dpr;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.lineTo(sx(lastX), H + 10);
    ctx.lineTo(sx(firstX), H + 10);
    ctx.closePath();
    ctx.fillStyle = colors.ground;
    ctx.fill();
  }

  drawWheel(casing, x, z, angle, rim, sx, sz, scale) {
    const { ctx, colors, dpr } = this;
    ctx.beginPath();
    for (let i = 0; i < casing.length; i += 2) {
      const px = sx(casing[i]), pz = sz(casing[i + 1]);
      if (i === 0) ctx.moveTo(px, pz); else ctx.lineTo(px, pz);
    }
    ctx.closePath();
    ctx.lineJoin = "round";
    ctx.strokeStyle = colors.tyre;
    ctx.lineWidth = Math.max(3 * dpr, 0.05 * scale);
    ctx.stroke();
    const cx = sx(x), cz = sz(z);
    ctx.lineCap = "butt";
    ctx.strokeStyle = colors.spoke;
    ctx.lineWidth = Math.max(1 * dpr, 0.004 * scale);
    // 24 spokes in two interleaved sets (a crossed lacing), so the rotation reads at any speed; the world rotation about +y
    // is nose-down positive, which on a screen with z up is clockwise.
    const spokes = 12;
    ctx.beginPath();
    for (let k = 0; k < spokes; k++) {
      const a = angle + (k * 2 * Math.PI) / spokes;
      const lean = k % 2 ? 0.28 : -0.28;
      const ex = x + rim * Math.cos(a), ez = z - rim * Math.sin(a);
      const hx = 0.03 * Math.cos(a + lean), hz = 0.03 * Math.sin(a + lean);
      ctx.moveTo(cx + hx * scale, cz - hz * scale);
      ctx.lineTo(sx(ex), sz(ez));
    }
    ctx.stroke();
    this.circle(cx, cz, rim * scale, null, colors.rim, Math.max(2 * dpr, 0.014 * scale));
    // The valve: one mark on the rim that turns with the wheel.
    this.circle(sx(x + 0.93 * rim * Math.cos(angle)), sz(z - 0.93 * rim * Math.sin(angle)), Math.max(2.2 * dpr, 0.012 * scale), colors.danger, null, 0);
    this.circle(cx, cz, Math.max(3 * dpr, 0.022 * scale), colors.rim, null, 0);
    ctx.lineCap = "round";
  }

  // The swingarm about the real pivot, the shock between its real eyes (full suspension); the rigid rear (hardtail).
  drawRear(obs) {
    const { ctx, colors, g, dpr } = this;
    const sc = this.tx.scale;
    if (!g.full) {
      // A rigid rear: chain stay and seat stay welded to the frame.
      this.seg(g.bb[0], g.bb[1], g.rearAxle[0], g.rearAxle[1], 0.032, colors.swingarm);
      this.seg(g.seatJoint[0], g.seatJoint[1], g.rearAxle[0], g.rearAxle[1], 0.026, colors.swingarm);
      return;
    }
    const { rx, rz, ex, ez } = this.swingPoints(obs[OBS.swingAngle]);
    const [px, pz] = g.pivot;
    // The swingarm is one rigid member: chain stay (pivot to axle), the extension (pivot to the shock eye) and a brace (axle
    // to the eye), all turning with the swing angle about the main pivot.
    ctx.beginPath();
    this.m(px, pz); this.l(ex, ez); this.l(rx, rz); this.l(px, pz);
    ctx.closePath();
    ctx.fillStyle = colors.plate;
    ctx.globalAlpha = 0.3;
    ctx.fill();
    ctx.globalAlpha = 1;
    this.seg(px, pz, rx, rz, 0.034, colors.swingarm);
    this.seg(px, pz, ex, ez, 0.034, colors.swingarm);
    this.seg(rx, rz, ex, ez, 0.022, colors.swingarm);
    this.drawShock(g.shockFrame[0], g.shockFrame[1], ex, ez);
    this.loc(rx, rz);
    this.circle(this.px, this.py, Math.max(3 * dpr, 0.02 * sc), colors.swingarm, null, 0);
    this.loc(px, pz);
    this.circle(this.px, this.py, Math.max(4 * dpr, 0.03 * sc), colors.fg, null, 0);
  }

  // The swingarm's moving points, frame-local: the rear axle and the shock eye, both rotated rigidly about the main pivot by
  // the swing angle (rotation about +y: x' = x c + z s, z' = -x s + z c, the same turn as the pitch). Written into this.sw.
  swingPoints(a) {
    const g = this.g, c = Math.cos(a), s = Math.sin(a), [px, pz] = g.pivot;
    const ax = g.rearAxle[0] - px, az = g.rearAxle[1] - pz;
    const out = this.sw;
    out.rx = px + ax * c + az * s; out.rz = pz - ax * s + az * c;
    out.ex = px + g.shockArm[0] * c + g.shockArm[1] * s; out.ez = pz - g.shockArm[0] * s + g.shockArm[1] * c;
    return out;
  }

  // Per published state: the drawn shock's eye-to-eye length must equal shock rest less the rear travel, and the swingarm eye
  // must turn rigidly with the axle (their distances from the pivot, and the angle between them, stay as built). Worst errors [m].
  checkLinkage(o) {
    const g = this.g, k = this.linkCheck;
    if (!g.full) return;
    const w = this.swingPoints(o[OBS.swingAngle]);
    const len = Math.hypot(w.ex - g.shockFrame[0], w.ez - g.shockFrame[1]);
    k.maxShock = Math.max(k.maxShock, Math.abs(len - (this.info[INFO.shockRest] - o[OBS.rearTravel])));
    const [px, pz] = g.pivot;
    const a0x = g.rearAxle[0] - px, a0z = g.rearAxle[1] - pz, e0x = g.shockArm[0], e0z = g.shockArm[1];
    const ax = w.rx - px, az = w.rz - pz, ex = w.ex - px, ez = w.ez - pz;
    const rotated = Math.atan2(ax * ez - az * ex, ax * ex + az * ez), built = Math.atan2(a0x * e0z - a0z * e0x, a0x * e0x + a0z * e0z);
    k.maxRigid = Math.max(k.maxRigid, Math.abs(Math.hypot(ax, az) - Math.hypot(a0x, a0z)), Math.abs(Math.hypot(ex, ez) - Math.hypot(e0x, e0z)),
      Math.abs(rotated - built) * Math.hypot(e0x, e0z));
    // And against the engine's rear hub: the axle must be where the engine says it is (frame-local from the hub's world position).
    const c = Math.cos(o[OBS.pitch]), sn = Math.sin(o[OBS.pitch]);
    const dx = o[OBS.rearX] - o[OBS.frameX], dz = o[OBS.rearZ] - o[OBS.frameZ];
    k.maxAxle = Math.max(k.maxAxle, Math.hypot(dx * c - dz * sn - w.rx, dx * sn + dz * c - w.rz));
    k.n++;
  }


  // The shock: a damper body and shaft with a coil spring between the eyes; it shortens as the swingarm rises.
  drawShock(x0, z0, x1, z1) {
    const { ctx, colors, dpr } = this;
    const sc = this.tx.scale;
    const lx = x1 - x0, lz = z1 - z0, len = Math.hypot(lx, lz) || 1;
    const ux = lx / len, uz = lz / len, nx = -uz, nz = ux;
    const at = (f, off) => this.loc(x0 + lx * f + nx * off, z0 + lz * f + nz * off);
    // Body from the frame eye, shaft to the arm eye.
    this.seg(x0, z0, x0 + lx * 0.5, z0 + lz * 0.5, 0.03, colors["shock-body"]);
    this.seg(x0 + lx * 0.5, z0 + lz * 0.5, x1, z1, 0.012, colors.stanchion);
    // Coil spring between 8% and 92% of the eye-to-eye length, on a fixed number of turns.
    const turns = 9, amp = 0.021;
    ctx.beginPath();
    for (let k = 0; k <= turns * 2; k++) {
      at(0.08 + (0.84 * k) / (turns * 2), k === 0 || k === turns * 2 ? 0 : (k % 2 ? amp : -amp));
      if (k === 0) ctx.moveTo(this.px, this.py); else ctx.lineTo(this.px, this.py);
    }
    ctx.strokeStyle = colors.spring;
    ctx.lineWidth = Math.max(1.5 * dpr, 0.007 * sc);
    ctx.stroke();
    for (const [x, z] of [[x0, z0], [x1, z1]]) {
      this.loc(x, z);
      this.circle(this.px, this.py, Math.max(3 * dpr, 0.016 * sc), colors.fg, null, 0);
    }
  }

  drawFrame() {
    const { colors, g } = this;
    this.seg(g.headBottom[0], g.headBottom[1], g.bb[0], g.bb[1], 0.045, colors.frame);    // down tube
    this.seg(g.bb[0], g.bb[1], g.seatTop[0], g.seatTop[1], 0.034, colors.frame);          // seat tube
    this.seg(g.headTop[0], g.headTop[1], g.seatJoint[0], g.seatJoint[1], 0.036, colors.frame); // top tube
    this.seg(g.headBottom[0], g.headBottom[1], g.headTop[0], g.headTop[1], 0.055, colors.frame); // head tube
    if (g.full) {
      // The shock's frame eye is the model's; the down tube carries it on a short gusset (two legs to the tube, about 9 cm).
      const [a, b] = g.mount;
      this.seg(a[0], a[1], g.shockFrame[0], g.shockFrame[1], 0.026, colors.frame);
      this.seg(b[0], b[1], g.shockFrame[0], g.shockFrame[1], 0.026, colors.frame);
    }
  }

  // Stanchions (fixed to the crown) slide in the lowers (on the axle) along the fork axis by the reported travel.
  drawFork(travel) {
    const { colors, g } = this;
    const [ux, uz] = g.axis;
    const [ax, az] = g.frontAxle;
    const cx = ax + travel * ux, cz = az + travel * uz; // axle now
    const crownU = g.crownReach;                        // crown, along the axis from the unloaded axle
    const lowersTop = travel + LOWERS_LENGTH;
    const stanchionBottom = Math.max(crownU - 0.28, travel + 0.04);
    this.seg(ax + crownU * ux, az + crownU * uz, ax + stanchionBottom * ux, az + stanchionBottom * uz, 0.032, colors.stanchion);
    this.seg(cx, cz, ax + lowersTop * ux, az + lowersTop * uz, 0.044, colors.lowers);
    // The crown and steerer.
    this.seg(ax + crownU * ux, az + crownU * uz, g.headBottom[0], g.headBottom[1], 0.05, colors.fg);
  }

  // Ground force arrows at the mean contact point of each tyre: vertical load and horizontal drag, scaled.
  drawLoads(obs, sx, sz) {
    const { colors } = this;
    const pairs = [
      [OBS.frontContacts, OBS.frontContactX, OBS.frontContactZ, OBS.frontLoad, OBS.frontDrag],
      [OBS.rearContacts, OBS.rearContactX, OBS.rearContactZ, OBS.rearLoad, OBS.rearDrag],
    ];
    for (const [n, ix, iz, il, id] of pairs) {
      if (obs[n] < 0.5) continue;
      const load = Math.max(0, obs[il]), drag = obs[id];
      this.arrow(obs[ix], obs[iz], 0, Math.min(1.0, load * LOAD_ARROW), colors.arrow);
      if (Math.abs(drag) > 8) this.arrow(obs[ix], obs[iz], Math.max(-0.6, Math.min(0.6, drag * LOAD_ARROW)), 0, colors.arrow);
    }
  }

  drawHud(obs, hud) {
    const { ctx, canvas, colors, info } = this;
    const d = this.dpr, W = canvas.width, H = canvas.height;
    const narrow = this.canvas.clientWidth < 600;
    const rows = this.g.full ? 4 : 3;
    const barW = (narrow ? 96 : 160) * d;
    ctx.save();
    ctx.lineCap = "butt";
    ctx.font = `${12 * d}px ui-monospace, monospace`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = colors.plate;
    ctx.globalAlpha = 0.8;
    const boxW = (narrow ? W / d - 20 : 330) * d;
    ctx.fillRect(8 * d, 8 * d, boxW, (rows * 20 + 10) * d);
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.fg;
    ctx.fillText(`${(obs[OBS.speed] * 3.6).toFixed(1)} km/h   x ${obs[OBS.frameX].toFixed(1)} m`, 16 * d, 22 * d);
    ctx.fillText(`ground load  front ${obs[OBS.frontLoad].toFixed(0)} N   rear ${obs[OBS.rearLoad].toFixed(0)} N`, 16 * d, 40 * d);
    this.gauge("fork ", obs[OBS.forkTravel], info[INFO.forkTravel], this.sag[0], 60 * d, barW);
    if (this.g.full) this.gauge("shock", obs[OBS.rearTravel], info[INFO.shockTravel], this.sag[1], 80 * d, barW);
    ctx.restore();
    if (hud.banner) {
      ctx.fillStyle = colors.danger;
      ctx.font = `${16 * d}px system-ui, sans-serif`;
      ctx.fillText(hud.banner, 14 * d, H - 16 * d);
    }
  }

  // A travel gauge: fill to the travel, a tick at the running mean (the sag), a bottom-out mark at the end that lights near it.
  gauge(label, value, max, sag, y, w) {
    const { ctx, colors } = this;
    const d = this.dpr, x0 = 16 * d, h = 9 * d, top = y - h / 2;
    const frac = Math.min(1, Math.max(0, value / max));
    const bottomed = value > 0.95 * max;
    ctx.fillStyle = colors.gauge;
    ctx.fillRect(x0, top, w, h);
    ctx.fillStyle = bottomed ? colors.danger : colors.arrow;
    ctx.fillRect(x0, top, w * frac, h);
    const sagX = x0 + w * Math.min(1, Math.max(0, sag / max));
    ctx.fillStyle = colors.fg;
    ctx.fillRect(sagX - 1 * d, top - 3 * d, 2 * d, h + 6 * d);
    ctx.fillStyle = colors.danger;
    ctx.fillRect(x0 + w - 2 * d, top - 3 * d, 3 * d, h + 6 * d);
    ctx.fillStyle = colors.fg;
    ctx.fillText(`${label} ${(value * 1000).toFixed(0)}/${(max * 1000).toFixed(0)} mm  sag ${(100 * sag / max).toFixed(0)}%${bottomed ? "  BOTTOM" : ""}`, x0 + w + 8 * d, y);
  }
}

// The named static geometry out of flow_info, frame-local metres.
function geometryFrom(info) {
  const pair = (x, z) => [info[x], info[z]];
  const frontAxle = pair(INFO.frontAxleX, INFO.frontAxleZ);
  const headBottom = pair(INFO.headBottomX, INFO.headBottomZ);
  // Where the frame's shock eye meets the down tube: the nearest point on the tube and two feet 4 cm either side of it.
  const bb = pair(INFO.bbX, INFO.bbZ), eye = pair(INFO.shockFrameX, INFO.shockFrameZ);
  const tx = headBottom[0] - bb[0], tz = headBottom[1] - bb[1], tl = Math.hypot(tx, tz);
  const ux = tx / tl, uz = tz / tl;
  const along = Math.min(tl - 0.04, Math.max(0.04, (eye[0] - bb[0]) * ux + (eye[1] - bb[1]) * uz));
  const mount = [[bb[0] + (along - 0.04) * ux, bb[1] + (along - 0.04) * uz], [bb[0] + (along + 0.04) * ux, bb[1] + (along + 0.04) * uz]];
  return {
    mount,
    full: info[INFO.full] > 0.5,
    frontAxle, headBottom,
    axis: [info[INFO.headAxisX], info[INFO.headAxisZ]],
    crownReach: Math.hypot(headBottom[0] - frontAxle[0], headBottom[1] - frontAxle[1]),
    rearAxle: pair(INFO.rearAxleX, INFO.rearAxleZ),
    pivot: pair(INFO.pivotX, INFO.pivotZ),
    shockFrame: pair(INFO.shockFrameX, INFO.shockFrameZ),
    shockArm: pair(INFO.shockArmX, INFO.shockArmZ),
    bb: pair(INFO.bbX, INFO.bbZ),
    headTop: pair(INFO.headTopX, INFO.headTopZ),
    seatJoint: pair(INFO.seatJointX, INFO.seatJointZ),
    seatTop: pair(INFO.seatTopX, INFO.seatTopZ),
  };
}
