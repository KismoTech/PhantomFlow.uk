// The hill, shaped around the trail: a fall along the trail, a shallow valley carved along
// it, mounds on and beside the line, and scenery hills away from it. Stored as a height
// grid that the contours, the particle flow and the rider physics all sample.
import { COLOR, rgba } from "../util.js";

export const FALL = 1.6;      // total height lost from start to finish
const BANK = 0.14;            // valley depth (how much the ground rises off the trail)
const CELL = 6;               // grid spacing (px)
const LEVELS = 44;            // contour levels drawn
const NEGLIGIBLE = 6.907755;  // -ln(1e-3): blend weights below 1e-3 are skipped

// Marching-squares segments per corner mask, as pairs of edges (0 top, 1 right, 2 bottom, 3 left).
const SEGMENTS = [
  [], [3, 0], [0, 1], [3, 1], [1, 2], [3, 0, 1, 2], [0, 2], [3, 2],
  [3, 2], [0, 2], [3, 2, 0, 1], [1, 2], [3, 1], [0, 1], [3, 0], [],
];

/**
 * @param {{w:number,h:number,narrow:boolean,trail:ReturnType<import('./trail.js').createTrail>,rand:()=>number}} o
 */
export function createTerrain({ w, h, narrow, trail, rand }) {
  const S = Math.max(w, h);
  const W = trail.width;

  // Mounds sit on or beside the line, so riders choose to take them or skirt them.
  const mounds = [];
  const count = narrow ? 3 : 5;
  for (let i = 0; i < count; i++) {
    const at = trail.at(trail.length * (0.14 + (0.76 * (i + 0.2 + rand() * 0.6)) / count));
    const off = (rand() - 0.5) * 1.3 * W;
    mounds.push([at.x - at.ty * off, at.y + at.tx * off, W * (0.75 + rand() * 0.35), 0.035 + rand() * 0.03]);
  }
  const scenery = [];
  for (let i = 0; i < 6; i++) scenery.push([rand() * w, rand() * h, S * (0.07 + rand() * 0.12), 0.25 + rand() * 0.4]);

  const gw = Math.ceil(w / CELL) + 2, gh = Math.ceil(h / CELL) + 2;
  const Z = new Float32Array(gw * gh);   // height
  const RG = new Float32Array(gw * gh);  // off-trail roughness 0..1 (roots, rocks, trees)
  let zlo = Infinity, zhi = -Infinity;

  const R = trail.points.filter((_, i) => i % 2 === 0);
  const RD = new Float32Array(R.length);
  const sig2 = 2 * (2.4 * W) ** 2;
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const x = i * CELL, y = j * CELL;
    let d2 = Infinity;
    for (let k = 0; k < R.length; k++) {
      const dd = (x - R[k].x) ** 2 + (y - R[k].y) ** 2;
      RD[k] = dd; if (dd < d2) d2 = dd;
    }
    // The fall follows trail progress, blended softly so it stays smooth where loops pass close.
    let num = 0, den = 0;
    for (let k = 0; k < R.length; k++) {
      const x2 = (RD[k] - d2) / sig2;
      if (x2 > NEGLIGIBLE) continue;
      const wgt = Math.exp(-x2);
      num += wgt * (1 - R[k].d / trail.length); den += wgt;
    }
    let z = FALL * (num / den) + BANK * (1 - Math.exp(-d2 / (2 * W * W)));
    const far = 1 - Math.exp(-d2 / (2 * (4 * W) ** 2)); // keep scenery out of the valley
    for (const [cx, cy, s, a] of scenery) z += far * a * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s));
    for (const [cx, cy, s, a] of mounds) z += a * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s));
    Z[j * gw + i] = z;
    RG[j * gw + i] = 1 - Math.exp(-((Math.max(0, Math.sqrt(d2) - 0.7 * W)) ** 2) / (2 * (1.1 * W) ** 2));
    if (z < zlo) zlo = z;
    if (z > zhi) zhi = z;
  }

  /** Bilinear height at (x, y). */
  const height = (x, y) => {
    const fx = Math.max(0, Math.min(gw - 1.001, x / CELL)), fy = Math.max(0, Math.min(gh - 1.001, y / CELL));
    const i = fx | 0, j = fy | 0, u = fx - i, v = fy - j, k = j * gw + i;
    return (Z[k] * (1 - u) + Z[k + 1] * u) * (1 - v) + (Z[k + gw] * (1 - u) + Z[k + gw + 1] * u) * v;
  };
  /** Height gradient per px. */
  const grad = (x, y) => [
    (height(x + CELL, y) - height(x - CELL, y)) / (2 * CELL),
    (height(x, y + CELL) - height(x, y - CELL)) / (2 * CELL),
  ];
  /** Off-trail roughness 0..1 (nearest grid cell). */
  const rough = (x, y) => {
    const i = Math.max(0, Math.min(gw - 1, Math.round(x / CELL))), j = Math.max(0, Math.min(gh - 1, Math.round(y / CELL)));
    return RG[j * gw + i];
  };

  /** Draw the map: contour lines (every 5th emphasised), the worn trail, and the finish posts. */
  const draw = (c) => {
    c.clearRect(0, 0, w, h);
    const step = (zhi - zlo) / (LEVELS + 1);
    const frac = (a, b, l) => (l - a) / (b - a);
    const edge = [[0, 0], [0, 0], [0, 0], [0, 0]];
    for (let k = 1; k <= LEVELS; k++) {
      const l = zlo + k * step;
      c.beginPath();
      for (let j = 0; j < gh - 1; j++) for (let i = 0; i < gw - 1; i++) {
        const a = Z[j * gw + i], b = Z[j * gw + i + 1], d = Z[(j + 1) * gw + i], e = Z[(j + 1) * gw + i + 1];
        const seg = SEGMENTS[(a > l) | ((b > l) << 1) | ((e > l) << 2) | ((d > l) << 3)];
        if (!seg.length) continue;
        const x0 = i * CELL, y0 = j * CELL;
        edge[0][0] = x0 + frac(a, b, l) * CELL; edge[0][1] = y0;
        edge[1][0] = x0 + CELL;                 edge[1][1] = y0 + frac(b, e, l) * CELL;
        edge[2][0] = x0 + frac(d, e, l) * CELL; edge[2][1] = y0 + CELL;
        edge[3][0] = x0;                        edge[3][1] = y0 + frac(a, d, l) * CELL;
        for (let s = 0; s < seg.length; s += 2) {
          c.moveTo(edge[seg[s]][0], edge[seg[s]][1]);
          c.lineTo(edge[seg[s + 1]][0], edge[seg[s + 1]][1]);
        }
      }
      const major = k % 5 === 0;
      c.strokeStyle = rgba(COLOR.moss, major ? 0.32 : 0.15);
      c.lineWidth = major ? 1.3 : 1;
      c.stroke();
    }

    c.lineCap = "round"; c.lineJoin = "round";
    c.beginPath();
    trail.points.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
    c.strokeStyle = rgba(COLOR.sand, 0.045); c.lineWidth = W * 1.4; c.stroke();
    c.setLineDash([1, 8]); c.strokeStyle = rgba(COLOR.sand, 0.22); c.lineWidth = 1.4; c.stroke();
    c.setLineDash([]);

    const end = trail.end, tan = trail.at(trail.length - 2);
    c.fillStyle = rgba(COLOR.sand, 0.55);
    for (const o of [-7, 7]) { c.beginPath(); c.arc(end.x - tan.ty * o, end.y + tan.tx * o, 2, 0, Math.PI * 2); c.fill(); }
  };

  return { height, grad, rough, draw };
}
