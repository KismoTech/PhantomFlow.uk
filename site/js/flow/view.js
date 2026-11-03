// Side-on view of the ride on a canvas: draws the published states, interpolated between the two that bracket the render
// clock, so the picture is smooth at any display rate while the physics runs at its own fixed step in the worker.
// A schematic bike: wheels from the engine's casing nodes (the tyre really deforms), a frame, fork and rider drawn from the
// poses the engine reports. Nothing here moves on its own: every motion is the simulation's.
import { OBS, INFO } from "./engine.js";

const FRAMES_KEPT = 16;
const MAX_LAG = 0.1;     // seconds the render clock may trail the newest state before it snaps
const TARGET_LAG = 0.034;
const HEAD_REACH = 0.52; // metres from the front hub along the fork axis to the head tube's top (schematic)

const lerp = (a, b, t) => a + (b - a) * t;
const lerpAngle = (a, b, t) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
};

export class RideView {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.frames = [];
    this.renderTime = 0;
    this.lastDraw = 0;
    this.info = null;
    this.terrainX = [];
    this.terrainZ = [];
    this.camera = { x: 0, z: 0, ready: false };
    this.colors = { sky: "#cfe3e8", ground: "#5a4a3a", groundLine: "#2f2418", tyre: "#1b1b1b", rim: "#8a8f94", frame: "#c2410c", rider: "#243b53", text: "#10201a" };
    this.resize();
  }

  /** Fits the canvas backing store to its CSS size. */
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(320, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(200, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
  }

  reset(info) {
    this.info = info;
    this.frames = [];
    this.camera.ready = false;
    this.renderTime = 0;
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

  dropTerrain(x) {
    let i = 0;
    while (i + 1 < this.terrainX.length && this.terrainX[i + 1] <= x) i++;
    if (i > 0) { this.terrainX.splice(0, i); this.terrainZ.splice(0, i); }
  }

  /** Adds a published state: { obs, casings, simTime }. */
  push(frame) {
    this.frames.push(frame);
    if (this.frames.length > FRAMES_KEPT) this.frames.shift();
  }

  // The state at the render clock, interpolated between the bracketing frames.
  current(nowMs) {
    const n = this.frames.length;
    if (n === 0) return null;
    const newest = this.frames[n - 1].simTime;
    const dt = this.lastDraw ? Math.min((nowMs - this.lastDraw) / 1000, 0.1) : 0;
    this.lastDraw = nowMs;
    this.renderTime += dt;
    if (this.renderTime < this.frames[0].simTime || newest - this.renderTime > MAX_LAG) this.renderTime = Math.max(this.frames[0].simTime, newest - TARGET_LAG);
    if (this.renderTime > newest) this.renderTime = newest;
    let i = n - 1;
    while (i > 0 && this.frames[i - 1].simTime >= this.renderTime) i--;
    const a = this.frames[Math.max(0, i - 1)], b = this.frames[i];
    const span = b.simTime - a.simTime;
    const t = span > 1e-9 ? Math.min(1, Math.max(0, (this.renderTime - a.simTime) / span)) : 1;
    const obs = new Float64Array(OBS.count);
    for (let k = 0; k < OBS.count; k++) obs[k] = lerp(a.obs[k], b.obs[k], t);
    obs[OBS.frontAngle] = lerpAngle(a.obs[OBS.frontAngle], b.obs[OBS.frontAngle], t);
    obs[OBS.rearAngle] = lerpAngle(a.obs[OBS.rearAngle], b.obs[OBS.rearAngle], t);
    const casings = b.casings.map((c, w) => c.map((v, k) => lerp(a.casings[w][k], v, t)));
    return { obs, casings, t };
  }

  draw(nowMs, hud = {}) {
    this.resize();
    const state = this.current(nowMs);
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.colors.sky;
    ctx.fillRect(0, 0, W, H);
    if (!state || !this.info) {
      ctx.fillStyle = this.colors.text;
      ctx.font = `${14 * this.dpr}px sans-serif`;
      ctx.fillText(hud.message ?? "waiting for the engine", 16 * this.dpr, 28 * this.dpr);
      return;
    }
    const { obs, casings } = state;
    const scale = Math.max(60, W / 9);
    const target = { x: obs[OBS.frameX] + 1.6, z: obs[OBS.frameZ] };
    if (!this.camera.ready) { this.camera.x = target.x; this.camera.z = target.z; this.camera.ready = true; }
    this.camera.x = lerp(this.camera.x, target.x, 0.2);
    this.camera.z = lerp(this.camera.z, target.z, 0.08);
    const sx = (x) => W / 2 + (x - this.camera.x) * scale;
    const sz = (z) => H * 0.62 - (z - this.camera.z) * scale;

    // Ground.
    ctx.beginPath();
    let started = false;
    const left = this.camera.x - W / 2 / scale - 0.5, right = this.camera.x + W / 2 / scale + 0.5;
    for (let i = 0; i < this.terrainX.length; i++) {
      const x = this.terrainX[i];
      if (x < left && this.terrainX[i + 1] < left) continue;
      if (!started) { ctx.moveTo(sx(x), sz(this.terrainZ[i])); started = true; } else ctx.lineTo(sx(x), sz(this.terrainZ[i]));
      if (x > right) break;
    }
    if (started) {
      ctx.strokeStyle = this.colors.groundLine;
      ctx.lineWidth = 3 * this.dpr;
      ctx.stroke();
      ctx.lineTo(W + 10, H + 10);
      ctx.lineTo(-10, H + 10);
      ctx.closePath();
      ctx.fillStyle = this.colors.ground;
      ctx.fill();
    }

    // Wheels: the casing outline, the rim and the spokes at the wheel's rotation.
    const rim = this.info[INFO.rimRadius];
    const wheels = [
      { x: obs[OBS.rearX], z: obs[OBS.rearZ], angle: obs[OBS.rearAngle], casing: casings[1] },
      { x: obs[OBS.frontX], z: obs[OBS.frontZ], angle: obs[OBS.frontAngle], casing: casings[0] },
    ];
    for (const w of wheels) {
      ctx.beginPath();
      for (let i = 0; i < w.casing.length; i += 2) {
        const px = sx(w.casing[i]), pz = sz(w.casing[i + 1]);
        if (i === 0) ctx.moveTo(px, pz); else ctx.lineTo(px, pz);
      }
      ctx.closePath();
      ctx.strokeStyle = this.colors.tyre;
      ctx.lineWidth = 5 * this.dpr;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx(w.x), sz(w.z), rim * scale, 0, 2 * Math.PI);
      ctx.strokeStyle = this.colors.rim;
      ctx.lineWidth = 2 * this.dpr;
      ctx.stroke();
      for (let k = 0; k < 4; k++) {
        // The world rotation about +y is nose-down positive: on screen (z up) that is clockwise.
        const a = w.angle + (k * Math.PI) / 2;
        ctx.beginPath();
        ctx.moveTo(sx(w.x), sz(w.z));
        ctx.lineTo(sx(w.x + rim * Math.cos(a)), sz(w.z - rim * Math.sin(a)));
        ctx.stroke();
      }
    }

    // Frame, fork and rider from the reported poses (schematic).
    const pitch = obs[OBS.pitch];
    let hx = this.info[INFO.headAxisX], hz = this.info[INFO.headAxisZ];
    const c = Math.cos(pitch), s = Math.sin(pitch);
    let dx = hx * c + hz * s, dz = -hx * s + hz * c;
    if (dz < 0) { dx = -dx; dz = -dz; }
    const head = { x: obs[OBS.frontX] + dx * HEAD_REACH, z: obs[OBS.frontZ] + dz * HEAD_REACH };
    const origin = { x: obs[OBS.frameX], z: obs[OBS.frameZ] };
    ctx.strokeStyle = this.colors.frame;
    ctx.lineWidth = 4 * this.dpr;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(sx(obs[OBS.rearX]), sz(obs[OBS.rearZ]));
    ctx.lineTo(sx(origin.x), sz(origin.z));
    ctx.lineTo(sx(head.x), sz(head.z));
    ctx.lineTo(sx(obs[OBS.frontX]), sz(obs[OBS.frontZ]));
    ctx.stroke();
    ctx.strokeStyle = this.colors.rider;
    ctx.lineWidth = 6 * this.dpr;
    ctx.beginPath();
    ctx.moveTo(sx(origin.x), sz(origin.z));
    ctx.lineTo(sx(obs[OBS.riderX]), sz(obs[OBS.riderZ]));
    ctx.stroke();
    ctx.fillStyle = this.colors.rider;
    ctx.beginPath();
    ctx.arc(sx(obs[OBS.riderX] + 0.05), sz(obs[OBS.riderZ] + 0.2), 0.1 * scale, 0, 2 * Math.PI);
    ctx.fill();

    // Readouts: speed, ground loads, suspension travel bars.
    ctx.fillStyle = this.colors.text;
    ctx.font = `${13 * this.dpr}px ui-monospace, monospace`;
    const line = (text, row) => ctx.fillText(text, 14 * this.dpr, (22 + row * 18) * this.dpr);
    line(`${(obs[OBS.speed] * 3.6).toFixed(1)} km/h   x ${obs[OBS.frameX].toFixed(1)} m`, 0);
    line(`ground load  front ${obs[OBS.frontLoad].toFixed(0)} N   rear ${obs[OBS.rearLoad].toFixed(0)} N`, 1);
    const bar = (label, value, max, row) => {
      const x0 = 14 * this.dpr, y0 = (22 + row * 18 + 4) * this.dpr, w = 160 * this.dpr, h = 8 * this.dpr;
      ctx.fillStyle = "rgba(0,0,0,0.15)";
      ctx.fillRect(x0, y0, w, h);
      ctx.fillStyle = value > 0.95 * max ? "#b91c1c" : this.colors.frame;
      ctx.fillRect(x0, y0, w * Math.min(1, Math.max(0, value / max)), h);
      ctx.fillStyle = this.colors.text;
      ctx.fillText(`${label} ${(value * 1000).toFixed(0)} / ${(max * 1000).toFixed(0)} mm`, x0 + w + 8 * this.dpr, y0 + 8 * this.dpr);
    };
    bar("fork ", obs[OBS.forkTravel], this.info[INFO.forkTravel], 2);
    if (this.info[INFO.shockTravel] > 0) bar("shock", obs[OBS.rearTravel], this.info[INFO.shockTravel], 3);
    if (hud.banner) {
      ctx.fillStyle = "rgba(185,28,28,0.9)";
      ctx.font = `${16 * this.dpr}px sans-serif`;
      ctx.fillText(hud.banner, 14 * this.dpr, H - 16 * this.dpr);
    }
  }
}
