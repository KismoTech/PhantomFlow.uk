// The race: rider physics and line choice on the terrain, plus phantom replay helpers.
//
// Units are relative so behaviour is the same at any screen size: distances and speeds scale
// with the trail's unit (BASE = 170 unit-px/s), slopes with the trail length.
//   - Gravity comes from the real ground slope in the direction ridden (the trail has no
//     special status; it's simply where the ground is kindest). Descents steeper than the
//     course fall only partly pay back (braking, scrub). Drag caps speed; rough ground off
//     the trail adds drag.
//   - Speed has momentum: slope response is smoothed, braking / acceleration rates are
//     capped, grip limits cornering speed, and riders brake ahead of corners.
//   - Each run has a personality (line choice, commitment), so lines and times differ.
//   - A pointer near the rider picks the line: tighter / wider, or up to ~1.4 trail
//     half-widths beyond the edge to cut a corner.
import { mulberry32, clamp } from "../util.js";
import { FALL } from "./terrain.js";

export const PHYS = {
  gravity: 1.8,    // slope → acceleration
  drag: 1.4,       // speed-proportional drag (1/s)
  pedal: 0.18,     // constant drive (× BASE)
  grip: 5,         // lateral acceleration limit (× BASE)
  downEff: 0.3,    // share of extra steepness (beyond the course fall) that becomes speed
  rough: 4,        // extra drag multiplier at full roughness
  inertia: 3,      // slope response rate (1/s)
  brake: 2.4,      // max braking (× BASE per s)
  accel: 1.2,      // max acceleration (× BASE per s)
  anticipate: 0.8, // corner look-ahead (s of travel)
  look: 0.07,      // line-choice look-ahead (× box span)
  guide: 0.9,      // preference for the trail bearing over terrain-avoiding detours
  wander: 0.4,     // personality line swing
};

const POINTER_RADIUS = 280;     // × unit px within which the pointer influences the line
const CUT_REACH = 1.4;          // how far past the trail edge the pointer may pull (× half-width)
const MIN_SPEED = 0.35;         // × BASE: riders never quite stop

export function createRace({ trail, terrain, box }) {
  const BASE = 170 * trail.unit; // reference speed (px/s): the same relative pace at any size
  const W = trail.width, U = trail.unit;

  const newRider = (seed) => {
    const personality = mulberry32(Math.floor(seed * 1e4) + 7);
    const dir = trail.at(4);
    return {
      x: trail.start.x, y: trail.start.y, hx: dir.tx, hy: dir.ty,
      v: 0, t: 0, done: false, ri: 0,
      pts: [{ x: trail.start.x, y: trail.start.y, t: 0, p: 0 }],
      ph: [seed * 1.7, seed * 2.9 + 1, seed * 0.6 + 2],    // phases of this run's line wander
      line: 0.4 + personality() * 1.4,                    // how much it swings inside / outside
      push: 0.86 + personality() * 0.26,                  // commitment: drive and corner speed
    };
  };

  /** Advance rider `r` by `dt` seconds. `pointer` is {x, y} while it's over the hero, else null. */
  const step = (r, dt, pointer) => {
    const n = Math.sin(r.t * 0.9 + r.ph[0]) + 0.6 * Math.sin(r.t * 2.3 + r.ph[1]) + 0.3 * Math.sin(r.t * 4.1 + r.ph[2]);
    r.ri = trail.nearest(r.x, r.y, r.ri);
    const pts = trail.points, here0 = pts[r.ri];

    // ── Where to aim ──
    // The furthest trail point within reach of where the rider actually is (so during and
    // after a shortcut it's the later section), never moving back up the trail.
    const reach = Math.max(22 * U, Math.min(trail.span * 0.09, r.v * 0.3));
    const lookAhead = reach * 1.6 + 70 * U * (r.pull || 0); // riders follow the loops; the pointer can cut more
    let aimD = here0.d + reach;
    for (let i = r.ri; i < pts.length && pts[i].d < here0.d + lookAhead; i++) {
      if ((pts[i].x - r.x) ** 2 + (pts[i].y - r.y) ** 2 <= reach * reach) aimD = Math.max(aimD, pts[i].d);
    }
    r.aimD = Math.max(aimD, r.aimD ?? 0);
    const here = trail.at(here0.d + 2), goal = trail.at(r.aimD);
    const bend = 1 - (here.tx * goal.tx + here.ty * goal.ty); // 0 straight .. 2 hairpin
    const offTrail = terrain.rough(r.x, r.y);

    // ── Which line: personality swing (tightened in bends), or the pointer's choice ──
    let off = clamp(n * PHYS.wander * r.line, -1, 1) * W * 0.6 * Math.max(0, 1 - bend * 1.5) * (1 - offTrail);
    let pull = 0;
    if (pointer) {
      const d = Math.hypot(pointer.x - r.x, pointer.y - r.y);
      if (d < POINTER_RADIUS * U) {
        const side = (pointer.x - goal.x) * -goal.ty + (pointer.y - goal.y) * goal.tx;
        pull = Math.min(1, (1 - d / (POINTER_RADIUS * U)) * 2);
        off = off * (1 - pull) + clamp(side, -CUT_REACH * W, CUT_REACH * W) * pull;
      }
    }
    r.pull = (r.pull ?? 0) + (pull - (r.pull ?? 0)) * Math.min(1, dt * 2.5); // commit to a line smoothly
    const reachOut = r.pull * CUT_REACH * W;

    // ── Steer: look around that bearing, avoiding climbs and (unless cutting) rough ground ──
    const gx0 = goal.x - goal.ty * off - r.x, gy0 = goal.y + goal.tx * off - r.y;
    const gl0 = Math.hypot(gx0, gy0) || 1;
    const ux = gx0 / gl0, uy = gy0 / gl0;
    const look = trail.span * PHYS.look, z0 = terrain.height(r.x, r.y);
    let tx = ux, ty = uy, bestCost = Infinity;
    for (let a = -0.9; a <= 0.9001; a += 0.15) {
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = ux * ca - uy * sa, dy = ux * sa + uy * ca;
      let climb = 0, prev = z0, rgh = 0;
      for (let k = 1; k <= 3; k++) {
        const px = r.x + dx * look * k / 3, py = r.y + dy * look * k / 3, z = terrain.height(px, py);
        climb += Math.max(0, z - prev); prev = z; rgh += terrain.rough(px, py);
      }
      const cost = climb * 8 + rgh * 0.6 * (1 - 0.8 * pull) + (1 - ca) * PHYS.guide;
      if (cost < bestCost) { bestCost = cost; tx = dx; ty = dy; }
    }
    // trail magnet: past the edge (plus any cut allowance), steer back on, rejoining ahead
    const dTrail = Math.hypot(here0.x - r.x, here0.y - r.y);
    if (dTrail > W * 0.7 + reachOut) {
      const back = trail.at(Math.max(here0.d + Math.max(10 * U, r.v * 0.12), r.aimD - 20 * U));
      const bx = back.x - r.x, by = back.y - r.y, bl = Math.hypot(bx, by) || 1;
      const k = Math.min(4, ((dTrail - W * 0.7 - reachOut) / W) * 3);
      tx += (bx / bl) * k; ty += (by / bl) * k;
    }
    let tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    // soft walls keep the rider near the course box (a trail-width of slack around it)
    const m = 24 * U, x0 = box.x0 - W, x1 = box.x1 + W, y0 = box.y0 - W, y1 = box.y1 + W;
    if (r.x < x0 + m) tx += ((x0 + m - r.x) / m) * 2;
    if (r.x > x1 - m) tx -= ((r.x - x1 + m) / m) * 2;
    if (r.y < y0 + m) ty += ((y0 + m - r.y) / m) * 2;
    if (r.y > y1 - m) ty -= ((r.y - y1 + m) / m) * 2;
    // never ride against the trail direction
    const tan = trail.at(r.aimD), along = tx * tan.tx + ty * tan.ty;
    if (along < 0.15) { tx += tan.tx * (0.15 - along); ty += tan.ty * (0.15 - along); }
    tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;

    // Smooth the chosen line (riders commit; they don't flick between candidates), then turn
    // the bike toward it, steering more sharply when slow.
    const sm = Math.min(1, dt * 10);
    r.gx = (r.gx ?? tx) + (tx - (r.gx ?? tx)) * sm; r.gy = (r.gy ?? ty) + (ty - (r.gy ?? ty)) * sm;
    const gl1 = Math.hypot(r.gx, r.gy) || 1;
    const ox = r.hx, oy = r.hy, rate = Math.min(1, dt * (5 + 4 * Math.max(0, 1 - r.v / BASE)));
    r.hx += (r.gx / gl1 - r.hx) * rate; r.hy += (r.gy / gl1 - r.hy) * rate;
    const hl = Math.hypot(r.hx, r.hy) || 1; r.hx /= hl; r.hy /= hl;
    const omega = Math.acos(clamp(ox * r.hx + oy * r.hy, -1, 1)) / dt;

    // ── Speed ──
    const [gx, gy] = terrain.grad(r.x, r.y);
    const slopeNow = -(gx * r.hx + gy * r.hy) * trail.length; // + downhill, in course-fall units
    r.sl = (r.sl ?? slopeNow) + (slopeNow - (r.sl ?? slopeNow)) * Math.min(1, dt * PHYS.inertia);
    const eff = r.sl > FALL ? FALL + (r.sl - FALL) * PHYS.downEff : r.sl;
    const commit = 1 - 0.35 * r.pull; // a chosen cut is ridden as a line: the rough bites a bit less
    const drag = PHYS.drag * (1 + PHYS.rough * commit * terrain.rough(r.x, r.y));
    let accel = PHYS.gravity * BASE * eff - drag * r.v + PHYS.pedal * r.push * BASE;
    // grip: over-cornering means braking for it
    const aLatMax = PHYS.grip * r.push * BASE;
    if (omega > 1e-3 && r.v * omega > aLatMax) accel = Math.min(accel, (aLatMax / omega - r.v) * 6);
    // brake ahead of the corner coming up (v² ≤ grip · radius, with a personal margin)
    const margin = 0.62 + 0.28 * (r.push - 0.86) / 0.26;
    for (const k of [0.35, 0.7, 1]) {
      const L = Math.max(20 * U, r.v * PHYS.anticipate * k);
      const t1 = trail.at(here0.d + 2), t2 = trail.at(here0.d + L);
      const turn = Math.acos(clamp(t1.tx * t2.tx + t1.ty * t2.ty, -1, 1));
      if (turn > 0.05) {
        const vmax = margin * Math.sqrt(aLatMax * (L / turn));
        if (r.v > vmax) accel = Math.min(accel, (vmax - r.v) * 3);
      }
    }
    accel = clamp(accel, -PHYS.brake * BASE, PHYS.accel * BASE);
    r.v = Math.max(BASE * MIN_SPEED, r.v + accel * dt);
    r.x += r.hx * r.v * dt; r.y += r.hy * r.v * dt; r.t += dt;

    const p = trail.progressAt(r.ri);
    const lastPt = r.pts[r.pts.length - 1];
    if (Math.hypot(r.x - lastPt.x, r.y - lastPt.y) > 3 * U) r.pts.push({ x: r.x, y: r.y, t: r.t, p });
    if (trail.crossedFinish(r.x, r.y, r.ri)) r.done = true; // past the line, having ridden the trail
  };

  /** Run a whole race without a pointer (used for the first phantom and for tuning). */
  const simulate = (seed, dt = 1 / 120) => {
    const r = newRider(seed);
    for (let i = 0; i < 12000 && !r.done; i++) step(r, dt, null);
    return r;
  };

  return { BASE, newRider, step, simulate };
}

/** Position of a recorded run at time `t` (index `i` of the segment it's on). */
export const replayAt = (run, t) => {
  const P = run.pts, last = P[P.length - 1];
  if (t >= last.t) return { x: last.x, y: last.y, i: P.length - 1 };
  let lo = 0, hi = P.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m].t < t) lo = m; else hi = m; }
  const a = P[lo], b = P[hi], k = (t - a.t) / (b.t - a.t || 1);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, i: lo };
};

/** Time a recorded run reached trail progress `p`. */
export const timeAtProgress = (run, p) => {
  const P = run.pts;
  for (let i = 1; i < P.length; i++) if (P[i].p >= p) {
    const a = P[i - 1], b = P[i], k = (p - a.p) / (b.p - a.p || 1);
    return a.t + (b.t - a.t) * k;
  }
  return P[P.length - 1].t;
};
