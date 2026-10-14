// The guide trail: a seeded, meandering route through a box, generated before the terrain.
// Progress is measured ALONG the trail, so arcs and switchbacks can double back up the
// screen and still run downhill.
import { clamp } from "../util.js";

const STEP = 0.025;          // Catmull-Rom sample step per segment
const MIN_GAP = 0.17;        // control points this far apart (box units) so loops never touch
const JUMP_AHEAD = 200;      // how far a shortcut may move progress forward (× unit px)
const REF_SPAN = 785;        // course span (px) the hero was tuned at: unit = 1

/**
 * @param {{x0:number,x1:number,y0:number,y1:number}} box  area the trail may use (px)
 * @param {boolean} narrow  phone layout: the trail runs right to left through a band
 * @param {() => number} rand  seeded PRNG
 */
export function createTrail(box, narrow, rand) {
  const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
  // a: progress axis 0..1 (down on desktop, right to left on phones); c: cross axis 0..1
  const toXY = (a, c) => narrow ? [box.x1 - a * bw, box.y0 + c * bh] : [box.x0 + c * bw, box.y0 + a * bh];

  // Control points wander forward in big arcs; a step may go back up (a switchback).
  const K = narrow ? 6 : 8;
  const aspect = narrow ? bh / bw : bw / bh;
  const ctrl = [[0, narrow ? 0.5 : 0.72]];
  let side = rand() < 0.5 ? 0 : 1;
  for (let i = 1; i < K - 1; i++) {
    let pick = null;
    for (let tries = 0; tries < 40 && !pick; tries++) {
      const s = tries % 2 ? side : 1 - side;
      const a = clamp(i / (K - 1) + (rand() - 0.6) * 0.42, 0.03, 0.93);
      const c = s ? 0.6 + rand() * 0.36 : 0.04 + rand() * 0.36;
      const clear = ctrl.slice(0, -1).every(([pa, pc]) => Math.hypot(pa - a, (pc - c) * aspect) > MIN_GAP);
      if (clear || tries === 39) { pick = [a, c]; side = s; }
    }
    ctrl.push(pick);
  }
  ctrl.push([1, 0.2 + rand() * 0.6]);

  // Smooth with Catmull-Rom, clamp into the box, and index by arc length.
  const P = ctrl.map(([a, c]) => toXY(a, c));
  const padded = [P[0], ...P, P[P.length - 1]];
  const raw = [];
  for (let i = 1; i < padded.length - 2; i++) {
    const [a, b, c, d] = [padded[i - 1], padded[i], padded[i + 1], padded[i + 2]];
    for (let t = 0; t < 1; t += STEP) {
      const t2 = t * t, t3 = t2 * t;
      raw.push([0, 1].map((k) => 0.5 * (2 * b[k] + (-a[k] + c[k]) * t + (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * t2 + (-a[k] + 3 * b[k] - 3 * c[k] + d[k]) * t3)));
    }
  }
  raw.push(P[P.length - 1]);
  const points = [{ x: raw[0][0], y: raw[0][1], d: 0 }];
  for (let i = 1; i < raw.length; i++) {
    const q = points[points.length - 1];
    const x = clamp(raw[i][0], box.x0, box.x1), y = clamp(raw[i][1], box.y0, box.y1);
    const dd = Math.hypot(x - q.x, y - q.y);
    if (dd > 0.5) points.push({ x, y, d: q.d + dd });
  }
  const length = points[points.length - 1].d;
  // One scale unit for every distance in the hero (pointer reach, look-ahead, particle speed,
  // stroke widths…): the same scene, just bigger on bigger screens. Floored so small screens
  // keep the tuned values.
  const span = narrow ? bw : bh;
  const unit = Math.max(0.85, span / REF_SPAN);
  const width = narrow ? Math.max(18, bh * 0.16) : 30 * unit; // half-width of the trail valley (px)

  /** Point and unit tangent at arc length `d`. */
  const at = (d) => {
    d = clamp(d, 0, length);
    let lo = 0, hi = points.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (points[m].d < d) lo = m; else hi = m; }
    const a = points[lo], b = points[hi], k = (d - a.d) / (b.d - a.d || 1);
    const tx = b.x - a.x, ty = b.y - a.y, tl = Math.hypot(tx, ty) || 1;
    return { x: a.x + tx * k, y: a.y + ty * k, tx: tx / tl, ty: ty / tl, i: lo };
  };

  /**
   * Index of the trail point the rider is on, searching from `from`. Normally local; after a
   * shortcut it may jump forward to where the rider genuinely rejoined, but only within
   * JUMP_AHEAD_PX of trail, only when close to that later point, and only when clearly closer
   * than the local match, so nearby switchback legs are never skipped by accident.
   */
  const nearest = (x, y, from) => {
    let best = from, bd = Infinity;
    for (let i = Math.max(0, from - 3); i < Math.min(points.length, from + 14); i++) {
      const d = (points[i].x - x) ** 2 + (points[i].y - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    const limit = points[from].d + JUMP_AHEAD * unit, reach2 = (width * 1.1) ** 2;
    for (let i = from + 14; i < points.length && points[i].d < limit; i++) {
      const d = (points[i].x - x) ** 2 + (points[i].y - y) ** 2;
      if (d < reach2 && d < bd * 0.5) { bd = d; best = i; }
    }
    // Lost (far from the trail): re-find the nearest trail ahead so the rider can't wander.
    if (bd > (width * 4) ** 2) {
      for (let i = from; i < points.length; i++) {
        const d = (points[i].x - x) ** 2 + (points[i].y - y) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best;
  };

  // Finish line: across the trail at its end. Crossed once the rider is past it along the
  // final direction of travel (and genuinely near the end of the trail).
  const finishDir = at(length - 2);
  const finishLine = {
    x: points[points.length - 1].x, y: points[points.length - 1].y, tx: finishDir.tx, ty: finishDir.ty, half: width * 1.2,
  };
  const crossedFinish = (x, y, i) =>
    points[i].d > length - width * 6 && (x - finishLine.x) * finishLine.tx + (y - finishLine.y) * finishLine.ty >= 0;

  return {
    points, length, width, at, nearest, finishLine, crossedFinish,
    start: points[0],
    end: points[points.length - 1],
    span, unit,                                      // box extent along the progress axis; scale unit
    progressAt: (i) => points[Math.min(points.length - 1, i)].d / length,
  };
}
