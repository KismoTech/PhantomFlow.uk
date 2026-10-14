// PhantomFlow.uk: header state, scroll reveals, and the hero terrain scene.
// No dependencies. Respects prefers-reduced-motion.
(() => {
  "use strict";
  document.documentElement.classList.add("js");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── Header background once scrolled ───────────────────────────
  const header = document.querySelector("[data-header]");
  const onScroll = () => header && header.classList.toggle("is-scrolled", window.scrollY > 24);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  // ── Reveal on scroll (staggered within each parent) ───────────
  const reveals = [...document.querySelectorAll(".reveal")];
  const groups = new Map();
  for (const el of reveals) {
    const parent = el.parentElement;
    const i = groups.get(parent) || 0;
    el.style.setProperty("--d", `${Math.min(i, 6) * 0.08}s`);
    groups.set(parent, i + 1);
  }
  if ("IntersectionObserver" in window && !reduced) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { e.target.classList.add("is-visible"); io.unobserve(e.target); }
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add("is-visible"));
  }

  // ── Hero: one terrain, seen from above ────────────────────────
  // Route first: every page load lays out a fresh meandering trail, then the hill is
  // shaped around it: a fall along the course, a valley carved along the trail, mounds
  // on and beside the line, and scenery hills away from it. Contours are the isolines,
  // particles flow along them, and you race your phantom down the trail. Leaving the
  // valley means climbing its banks, so the terrain really decides the fast line.
  const hero = document.querySelector("[data-hero]");
  if (!hero) return;
  const layers = {
    flow: hero.querySelector("[data-flow]"),
    terrain: hero.querySelector("[data-terrain]"),
    run: hero.querySelector("[data-run]"),
  };
  const ctx = Object.fromEntries(Object.entries(layers).map(([k, c]) => [k, c.getContext("2d")]));
  const hud = {
    sector: hero.querySelector('[data-hud="sector"]'),
    speed: hero.querySelector('[data-hud="speed"]'),
    delta: hero.querySelector('[data-hud="delta"]'),
  };

  // Seeded randomness: a new trail per page load (add ?seed=N to pin one).
  const seedParam = /[?&]seed=(\d+)/.exec(location.search);
  const SEED = seedParam ? +seedParam[1] : (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0);
  const mulberry = (a) => () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  let w = 0, h = 0, S = 1, narrow = false;
  const band = { top: 0, bottom: 0, textRight: 0 };

  // ── Course area and the guide route ──
  // The trail wanders through a box (right of the copy on desktop, the band under the
  // buttons on phones). Progress and the fall are measured ALONG the trail, so arcs and
  // switchbacks can double back up the screen and still run downhill.
  const course = { sx: 0, sy: 0, len: 1, span: 1, x0: 0, x1: 0, y0: 0, y1: 0 };
  const setCourse = () => {
    if (narrow) Object.assign(course, { x0: w * 0.04, x1: w * 0.96, y0: band.top + 4, y1: band.bottom - 4 });
    else {
      const x0 = Math.min(w * 0.97 - w * 0.3, Math.max(w * 0.5, band.textRight + 36)); // keep clear of the copy
      Object.assign(course, { x0, x1: w * 0.97, y0: h * 0.07, y1: h * 0.86 });
    }
    course.span = narrow ? course.x1 - course.x0 : course.y1 - course.y0;
  };
  // a: progress axis 0..1 (down on desktop, right to left on phones); c: cross axis 0..1
  const boxXY = (a, c) => narrow
    ? [course.x1 - a * (course.x1 - course.x0), course.y0 + c * (course.y1 - course.y0)]
    : [course.x0 + c * (course.x1 - course.x0), course.y0 + a * (course.y1 - course.y0)];

  let route = [], routeLen = 0, CW = 30; // CW: valley half-width (px)
  const buildRoute = (rand) => {
    // Control points wander forward in big arcs; a step may go back up (a switchback),
    // and loops are kept apart so the trail never crosses itself.
    const K = narrow ? 6 : 8;
    const ctrl = [[0, narrow ? 0.5 : 0.72]];
    let side = rand() < 0.5 ? 0 : 1;
    const aspect = narrow ? (course.y1 - course.y0) / (course.x1 - course.x0) : (course.x1 - course.x0) / (course.y1 - course.y0);
    for (let i = 1; i < K - 1; i++) {
      let pick = null;
      for (let tries = 0; tries < 40 && !pick; tries++) {
        const s = tries % 2 ? side : 1 - side;
        const a = Math.max(0.03, Math.min(0.93, i / (K - 1) + (rand() - 0.6) * 0.42));
        const c = s ? 0.6 + rand() * 0.36 : 0.04 + rand() * 0.36;
        const clear = ctrl.slice(0, -1).every(([pa, pc]) => Math.hypot(pa - a, (pc - c) * aspect) > 0.17);
        if (clear || tries === 39) { pick = [a, c]; side = s; }
      }
      ctrl.push(pick);
    }
    ctrl.push([1, 0.2 + rand() * 0.6]);
    const P = ctrl.map(([a, c]) => boxXY(a, c));
    const pts = [P[0], ...P, P[P.length - 1]];
    const raw = [];
    for (let i = 1; i < pts.length - 2; i++) {
      const [a, b, c, d] = [pts[i - 1], pts[i], pts[i + 1], pts[i + 2]];
      for (let t = 0; t < 1; t += 0.025) {
        const t2 = t * t, t3 = t2 * t;
        raw.push([0, 1].map((k) => 0.5 * (2 * b[k] + (-a[k] + c[k]) * t + (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * t2 + (-a[k] + 3 * b[k] - 3 * c[k] + d[k]) * t3)));
      }
    }
    raw.push(P[P.length - 1]);
    route = [{ x: raw[0][0], y: raw[0][1], d: 0 }];
    for (let i = 1; i < raw.length; i++) {
      const q = route[route.length - 1];
      const x = Math.max(course.x0, Math.min(course.x1, raw[i][0])), y = Math.max(course.y0, Math.min(course.y1, raw[i][1]));
      const dd = Math.hypot(x - q.x, y - q.y);
      if (dd > 0.5) route.push({ x, y, d: q.d + dd });
    }
    routeLen = route[route.length - 1].d;
    course.sx = route[0].x; course.sy = route[0].y; course.len = routeLen;
  };
  const progressAt = (i) => route[Math.min(route.length - 1, i)].d / routeLen;
  const routeAt = (d) => {
    d = Math.max(0, Math.min(routeLen, d));
    let lo = 0, hi = route.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (route[m].d < d) lo = m; else hi = m; }
    const a = route[lo], b = route[hi], k = (d - a.d) / (b.d - a.d || 1);
    const tx = b.x - a.x, ty = b.y - a.y, tl = Math.hypot(tx, ty) || 1;
    return { x: a.x + tx * k, y: a.y + ty * k, tx: tx / tl, ty: ty / tl, i: lo };
  };
  const nearestOnRoute = (x, y, from) => { // search forward from a hint index
    let best = from, bd = Infinity;
    for (let i = Math.max(0, from - 3); i < Math.min(route.length, from + 14); i++) { // narrow window: never jump to a nearby switchback
      const d = (route[i].x - x) ** 2 + (route[i].y - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };

  // ── Height grid built around the route ──
  const FALL = 1.6, BANK = 0.45, CELL = 6;
  let Z = null, RG = null, gw = 0, gh = 0, zlo = 0, zhi = 1, mounds = [];
  const buildTerrain = (rand) => {
    CW = Math.max(18, narrow ? (course.y1 - course.y0) * 0.16 : (course.x1 - course.x0) * 0.095);
    // mounds: on or beside the line, so riders choose to take them or skirt them
    mounds = [];
    const count = narrow ? 3 : 5;
    for (let i = 0; i < count; i++) {
      const at = routeAt(routeLen * (0.14 + (0.76 * (i + 0.2 + rand() * 0.6)) / count));
      const off = (rand() - 0.5) * 1.3 * CW;
      mounds.push([at.x - at.ty * off, at.y + at.tx * off, CW * (0.75 + rand() * 0.35), 0.12 + rand() * 0.08]);
    }
    const scenery = [];
    for (let i = 0; i < 6; i++) scenery.push([rand() * w, rand() * h, S * (0.07 + rand() * 0.12), 0.25 + rand() * 0.4]);

    gw = Math.ceil(w / CELL) + 2; gh = Math.ceil(h / CELL) + 2;
    Z = new Float32Array(gw * gh);
    RG = new Float32Array(gw * gh); // off-trail roughness 0..1 (roots, rocks, trees)
    zlo = Infinity; zhi = -Infinity;
    const R = route.filter((_, i) => i % 2 === 0);
    const RD = new Float32Array(R.length);
    const sig2 = 2 * (2.4 * CW) ** 2;
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const x = i * CELL, y = j * CELL;
      let d2 = Infinity;
      for (let k = 0; k < R.length; k++) { // distances² to route samples
        const dd = (x - R[k].x) ** 2 + (y - R[k].y) ** 2;
        RD[k] = dd; if (dd < d2) d2 = dd;
      }
      // fall along the trail: a soft-nearest blend of trail progress (smooth where loops pass close)
      let num = 0, den = 0;
      for (let k = 0; k < R.length; k++) {
        const wgt = Math.exp(-(RD[k] - d2) / sig2);
        if (wgt < 1e-3) continue;
        num += wgt * (1 - R[k].d / routeLen); den += wgt;
      }
      let z = FALL * (num / den) + BANK * (1 - Math.exp(-d2 / (2 * CW * CW)));
      const far = 1 - Math.exp(-d2 / (2 * (4 * CW) ** 2)); // keep scenery out of the valley
      for (const [cx, cy, s, a] of scenery) z += far * a * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s));
      for (const [cx, cy, s, a] of mounds) z += a * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s));
      Z[j * gw + i] = z;
      RG[j * gw + i] = 1 - Math.exp(-((Math.max(0, Math.sqrt(d2) - 0.7 * CW)) ** 2) / (2 * (1.1 * CW) ** 2)); // rough beyond the trail edge
      if (z < zlo) zlo = z; if (z > zhi) zhi = z;
    }
  };
  const height = (x, y) => {
    const fx = Math.max(0, Math.min(gw - 1.001, x / CELL)), fy = Math.max(0, Math.min(gh - 1.001, y / CELL));
    const i = fx | 0, j = fy | 0, u = fx - i, v = fy - j, k = j * gw + i;
    return (Z[k] * (1 - u) + Z[k + 1] * u) * (1 - v) + (Z[k + gw] * (1 - u) + Z[k + gw + 1] * u) * v;
  };
  const rough = (x, y) => {
    const i = Math.max(0, Math.min(gw - 1, Math.round(x / CELL))), j = Math.max(0, Math.min(gh - 1, Math.round(y / CELL)));
    return RG[j * gw + i];
  };
  const grad = (x, y) => [ // height per px
    (height(x + CELL, y) - height(x - CELL, y)) / (2 * CELL),
    (height(x, y + CELL) - height(x, y - CELL)) / (2 * CELL),
  ];

  const fit = (c, k) => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    ctx[k].setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  // Contours (marching squares on the grid) and the trail, drawn once per build.
  const drawTerrain = () => {
    const c = ctx.terrain;
    c.clearRect(0, 0, w, h);
    const LEVELS = 26, step = (zhi - zlo) / (LEVELS + 1);
    const lerp = (a, b, l) => (l - a) / (b - a);
    for (let k = 1; k <= LEVELS; k++) {
      const l = zlo + k * step;
      c.beginPath();
      for (let j = 0; j < gh - 1; j++) for (let i = 0; i < gw - 1; i++) {
        const a = Z[j * gw + i], b = Z[j * gw + i + 1], d = Z[(j + 1) * gw + i], e = Z[(j + 1) * gw + i + 1];
        const idx = (a > l) | ((b > l) << 1) | ((e > l) << 2) | ((d > l) << 3);
        if (idx === 0 || idx === 15) continue;
        const x0 = i * CELL, y0 = j * CELL;
        const T = [x0 + lerp(a, b, l) * CELL, y0], Rr = [x0 + CELL, y0 + lerp(b, e, l) * CELL];
        const B = [x0 + lerp(d, e, l) * CELL, y0 + CELL], L = [x0, y0 + lerp(a, d, l) * CELL];
        const seg = {
          1: [L, T], 2: [T, Rr], 3: [L, Rr], 4: [Rr, B], 5: [L, T, Rr, B], 6: [T, B], 7: [L, B],
          8: [L, B], 9: [T, B], 10: [L, B, T, Rr], 11: [Rr, B], 12: [L, Rr], 13: [T, Rr], 14: [L, T],
        }[idx];
        for (let s = 0; s < seg.length; s += 2) { c.moveTo(seg[s][0], seg[s][1]); c.lineTo(seg[s + 1][0], seg[s + 1][1]); }
      }
      const index = k % 5 === 0;
      c.strokeStyle = index ? "rgba(169,199,156,0.32)" : "rgba(169,199,156,0.15)";
      c.lineWidth = index ? 1.3 : 1;
      c.stroke();
    }
    // the trail: a soft worn corridor with a faint centre line
    c.lineCap = "round"; c.lineJoin = "round";
    c.beginPath(); route.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
    c.strokeStyle = "rgba(233,226,210,0.045)"; c.lineWidth = CW * 1.4; c.stroke();
    c.setLineDash([1, 8]); c.strokeStyle = "rgba(233,226,210,0.22)"; c.lineWidth = 1.4; c.stroke();
    c.setLineDash([]);
    const end = route[route.length - 1];
    c.fillStyle = "rgba(233,226,210,0.55)";
    const tan = routeAt(routeLen - 2);
    for (const o of [-7, 7]) { c.beginPath(); c.arc(end.x - tan.ty * o, end.y + tan.tx * o, 2, 0, Math.PI * 2); c.fill(); } // finish posts
  };

  // ── The race ──
  // Physics in course-relative units so it behaves the same at any size: gravity turns
  // height drop into speed (climbs cost it), descents steeper than the course fall only
  // partly pay back (braking, scrub), drag caps speed, grip limits speed through turns.
  const PHYS = { gravity: 1.8, drag: 1.4, pedal: 0.18, grip: 5, downEff: 0.3, rough: 4, inertia: 3, brake: 2.4, accel: 1.2, relief: 0.25, anticipate: 0.8, look: 0.07, guide: 0.9, wander: 0.4 };
  const BASE = () => course.len / 9.6; // speed reference; a run lands around 10-11 s

  let rider = null, phantom = null, best = null, flash = 0, flashAt = null, runNo = 0, runRand = null;
  const newRider = (seed) => ({
    x: course.sx, y: course.sy, ...(() => { const a = routeAt(4); return { hx: a.tx, hy: a.ty }; })(), v: 0, t: 0, done: false, ri: 0,
    pts: [{ x: course.sx, y: course.sy, t: 0, p: 0 }],
    ph: [seed * 1.7, seed * 2.9 + 1, seed * 0.6 + 2],
    ...(() => { const rr = mulberry(Math.floor(seed * 1e4) + 7); // this run's rider personality
      return { line: 0.4 + rr() * 1.4, push: 0.86 + rr() * 0.26 }; })(),
  });

  const stepRider = (r, dt, steer, policy) => {
    const n = Math.sin(r.t * 0.9 + r.ph[0]) + 0.6 * Math.sin(r.t * 2.3 + r.ph[1]) + 0.3 * Math.sin(r.t * 4.1 + r.ph[2]);
    r.ri = nearestOnRoute(r.x, r.y, r.ri);
    const end = route[route.length - 1];
    let tx = end.x - r.x, ty = end.y - r.y; // "beeline" test policy: straight at the finish
    if (policy !== "beeline") {
      // pursue a point down the trail, offset by this run's line choice (inside/outside)
      // chase point: closer when slow so the rider follows hairpins instead of cutting across
      const reach = Math.max(22, Math.min(course.span * 0.09, r.v * 0.3));
      const here = routeAt(route[r.ri].d + 2), goal = routeAt(route[r.ri].d + reach);
      const bend = 1 - (here.tx * goal.tx + here.ty * goal.ty); // 0 straight .. 2 hairpin
      const offTrail = rough(r.x, r.y);
      // inside / outside line choice, tightened in bends and dropped when off the trail
      let swing = Math.max(-1, Math.min(1, n * PHYS.wander * r.line)); // stays within the trail width
      r.aim = null;
      if (steer) {
        // The pointer picks the LINE, not the direction: its side of the trail (projected
        // onto the trail normal) sets how tight or wide you ride. The bike stays on the trail.
        const d = Math.hypot(pointer.x - r.x, pointer.y - r.y);
        if (d < 280) {
          const side = (pointer.x - goal.x) * -goal.ty + (pointer.y - goal.y) * goal.tx;
          const want = Math.max(-1, Math.min(1, side / (CW * 0.6)));
          const k = Math.min(1, (1 - d / 280) * 2);
          swing = swing * (1 - k) + want * k;
          r.aim = { k };
        }
      }
      const off = swing * CW * 0.6 * Math.max(0, 1 - bend * 1.5) * (1 - offTrail);
      if (r.aim) Object.assign(r.aim, { x: goal.x - goal.ty * off, y: goal.y + goal.tx * off });
      const gx0 = goal.x - goal.ty * off - r.x, gy0 = goal.y + goal.tx * off - r.y;
      const gl0 = Math.hypot(gx0, gy0) || 1;
      const ux = gx0 / gl0, uy = gy0 / gl0;
      // look ahead around that bearing: avoid climbs (banks, mounds), keep near the bearing
      let bestCost = Infinity;
      const look = course.span * PHYS.look, z0 = height(r.x, r.y);
      for (let a = -0.9; a <= 0.9001; a += 0.15) {
        const ca = Math.cos(a), sa = Math.sin(a);
        const dx = ux * ca - uy * sa, dy = ux * sa + uy * ca;
        let climb = 0, prev = z0, rgh = 0;
        for (let k = 1; k <= 3; k++) {
          const px = r.x + dx * look * k / 3, py = r.y + dy * look * k / 3, z = height(px, py);
          climb += Math.max(0, z - prev); prev = z; rgh += rough(px, py);
        }
        const cost = climb * 8 + rgh * 0.6 + (1 - ca) * PHYS.guide;
        if (cost < bestCost) { bestCost = cost; tx = dx; ty = dy; }
      }
      // trail magnet: beyond the trail edge, steer back on with growing force
      const near = route[r.ri], dTrail = Math.hypot(near.x - r.x, near.y - r.y);
      if (dTrail > CW * 0.7) {
        const back = routeAt(near.d + Math.max(10, r.v * 0.12));
        const bx = back.x - r.x, by = back.y - r.y, bl = Math.hypot(bx, by) || 1;
        const k = Math.min(4, ((dTrail - CW * 0.7) / CW) * 3);
        tx += (bx / bl) * k; ty += (by / bl) * k;
      }
    }
    { const tl0 = Math.hypot(tx, ty) || 1; tx /= tl0; ty /= tl0; }
    // soft walls on the course box, and never ride back against the trail direction
    const m = 24;
    if (r.x < course.x0 + m) tx += ((course.x0 + m - r.x) / m) * 2;
    if (r.x > course.x1 - m) tx -= ((r.x - course.x1 + m) / m) * 2;
    if (r.y < course.y0 + m) ty += ((course.y0 + m - r.y) / m) * 2;
    if (r.y > course.y1 - m) ty -= ((r.y - course.y1 + m) / m) * 2;
    if (policy !== "beeline") {
      const tan = routeAt(route[r.ri].d + 4), along = tx * tan.tx + ty * tan.ty;
      if (along < 0.15) { tx += tan.tx * (0.15 - along); ty += tan.ty * (0.15 - along); }
    }
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;

    // Smooth the chosen line first (riders commit to a line; they don't flick between
    // candidates), then turn the bike toward it.
    const sm = Math.min(1, dt * 10);
    r.gx = (r.gx ?? tx) + (tx - (r.gx ?? tx)) * sm; r.gy = (r.gy ?? ty) + (ty - (r.gy ?? ty)) * sm;
    const gl1 = Math.hypot(r.gx, r.gy) || 1;
    const ox = r.hx, oy = r.hy, rate = Math.min(1, dt * (5 + 4 * Math.max(0, 1 - r.v / BASE()))); // sharper steering when slow
    r.hx += (r.gx / gl1 - r.hx) * rate; r.hy += (r.gy / gl1 - r.hy) * rate;
    const hl = Math.hypot(r.hx, r.hy) || 1; r.hx /= hl; r.hy /= hl;
    const omega = Math.acos(Math.max(-1, Math.min(1, ox * r.hx + oy * r.hy))) / dt;

    // Speed has momentum: the bike responds to the slope it's been riding, not every
    // ripple under the wheel, and braking / acceleration are limited to rider-like rates.
    const B = BASE();
    const [gx, gy] = grad(r.x, r.y);
    // The trail's own fall (along the direction of travel) plus the bumps, which are felt
    // at reduced relief: the map shows them at full height, but the bike rides over them.
    const tan = routeAt(route[r.ri].d + 2);
    const fallHere = FALL * (r.hx * tan.tx + r.hy * tan.ty);
    const slopeNow = fallHere + PHYS.relief * (-(gx * r.hx + gy * r.hy) * course.len - fallHere); // + downhill
    r.sl = (r.sl ?? slopeNow) + (slopeNow - (r.sl ?? slopeNow)) * Math.min(1, dt * PHYS.inertia);
    const eff = r.sl > FALL ? FALL + (r.sl - FALL) * PHYS.downEff : r.sl;
    const drag = PHYS.drag * (1 + PHYS.rough * rough(r.x, r.y)); // off the trail is slow going
    let acc = PHYS.gravity * B * eff - drag * r.v + PHYS.pedal * r.push * B;
    // grip: carrying too much speed into a turn means braking for it (at a braking rate)
    const aLatMax = PHYS.grip * r.push * B;
    if (omega > 1e-3 && r.v * omega > aLatMax) acc = Math.min(acc, (aLatMax / omega - r.v) * 6);
    // look ahead along the trail and brake for the corner coming up (v² ≤ grip · radius)
    for (const k of [0.35, 0.7, 1]) {
      const L = Math.max(20, r.v * PHYS.anticipate * k);
      const t1 = routeAt(route[r.ri].d + 2), t2 = routeAt(route[r.ri].d + L);
      const turn = Math.acos(Math.max(-1, Math.min(1, t1.tx * t2.tx + t1.ty * t2.ty)));
      if (turn > 0.05) {
        const vmax = (0.62 + 0.28 * (r.push - 0.86) / 0.26) * Math.sqrt(aLatMax * (L / turn)); // braver riders carry more
        if (r.v > vmax) acc = Math.min(acc, (vmax - r.v) * 3);
      }
    }
    if (r.dbg) Object.assign(r.dbg, { sl: r.sl, rough: rough(r.x, r.y), omega, acc: acc / B });
    acc = Math.max(-PHYS.brake * B, Math.min(PHYS.accel * B, acc));
    r.v = Math.max(B * 0.35, r.v + acc * dt);
    r.x += r.hx * r.v * dt; r.y += r.hy * r.v * dt; r.t += dt;

    const p = progressAt(r.ri);
    const lastPt = r.pts[r.pts.length - 1];
    if (Math.hypot(r.x - lastPt.x, r.y - lastPt.y) > 3) r.pts.push({ x: r.x, y: r.y, t: r.t, p });
    if (p > 0.985) r.done = true; // only by following the trail: cutting across never counts
  };

  // Phantom replay, and comparison at the same point down the hill.
  const replayAt = (run, t) => {
    const P = run.pts;
    if (t >= P[P.length - 1].t) return { x: P[P.length - 1].x, y: P[P.length - 1].y, i: P.length - 1 };
    let lo = 0, hi = P.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m].t < t) lo = m; else hi = m; }
    const a = P[lo], b = P[hi], k = (t - a.t) / (b.t - a.t || 1);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, i: lo };
  };
  const timeAtProgress = (run, p) => {
    const P = run.pts;
    for (let i = 1; i < P.length; i++) if (P[i].p >= p) {
      const a = P[i - 1], b = P[i], k = (p - a.p) / (b.p - a.p || 1);
      return a.t + (b.t - a.t) * k;
    }
    return P[P.length - 1].t;
  };
  const strokeRun = (c, P, endIdx, end) => {
    c.beginPath(); c.moveTo(P[0].x, P[0].y);
    for (let i = 1; i <= endIdx; i++) c.lineTo(P[i].x, P[i].y);
    if (end) c.lineTo(end.x, end.y);
  };

  const simulateRun = (seed, policy) => {
    const r = newRider(seed);
    for (let i = 0; i < 12000 && !r.done; i++) stepRider(r, 1 / 120, false, policy);
    return r;
  };
  const startRace = () => {
    runNo++;
    rider = newRider(runNo * 3.1 + runRand() * 10);
    phantom = best;
    flashAt = null;
  };
  const resetRace = () => {
    runRand = mulberry(SEED ^ 0x9e3779b9);
    best = simulateRun(runRand() * 10);
    runNo = 0;
    startRace();
  };
  if (/[?&]debug\b/.test(location.search)) {
    window.__pf = { PHYS, simulateRun, stepRider, newRider, course, BASE, height, grad, SEED, pointer: () => pointer, get route() { return route; } };
  }

  // ── Flow particles ──
  let parts = [];
  const spawn = (p = {}) => Object.assign(p, { x: Math.random() * w, y: Math.random() * h, life: 60 + Math.random() * 240, oxide: Math.random() < 0.22 });
  const pointer = { x: -1e4, y: -1e4 };

  const measure = () => {
    const r = hero.getBoundingClientRect();
    const actions = hero.querySelector(".hero-actions"), hudEl = hero.querySelector(".hud");
    if (actions && hudEl) {
      band.top = actions.getBoundingClientRect().bottom - r.top + 30;
      band.bottom = hudEl.getBoundingClientRect().top - r.top - 24;
    }
    const range = document.createRange(); // measure the text itself, not its full-width block
    band.textRight = Math.max(0, ...[...hero.querySelectorAll("h1, .lede, .hero-actions .btn")].map((el) => {
      range.selectNodeContents(el);
      return range.getBoundingClientRect().right - r.left;
    }));
  };
  const build = () => {
    const rand = mulberry(SEED);
    setCourse();
    buildRoute(rand);
    buildTerrain(rand);
    drawTerrain();
    resetRace();
  };
  const resize = () => {
    const r = hero.getBoundingClientRect();
    w = r.width; h = r.height; S = Math.max(w, h); narrow = w < 900;
    for (const k in layers) fit(layers[k], k);
    measure();
    build();
    parts = Array.from({ length: Math.min(1300, Math.round((w * h) / 1000)) }, () => spawn());
    ctx.flow.fillStyle = "#15241D"; ctx.flow.fillRect(0, 0, w, h);
  };

  const drawRider = (c, p, fill, ring) => {
    c.beginPath(); c.arc(p.x, p.y, 11, 0, Math.PI * 2); c.fillStyle = ring; c.fill();
    c.beginPath(); c.arc(p.x, p.y, 4, 0, Math.PI * 2); c.fillStyle = fill; c.fill();
  };

  let last = performance.now(), lastHud = 0, hold = 0, raf = 0, acc = 0;
  const STEP = 1 / 120;
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;

    if (!rider.done) { // fixed substeps so live runs behave exactly like simulated ones
      acc += dt;
      while (acc >= STEP && !rider.done) { stepRider(rider, STEP, pointer.x > -1e3); acc -= STEP; }
    }
    else if (!flashAt) {
      flash = !best || rider.t < best.t ? 1 : -1;
      flashAt = { x: rider.x, y: rider.y, delta: phantom ? rider.t - phantom.t : 0 };
      if (flash > 0) best = rider;
      hold = 1.8;
    } else if ((hold -= dt) <= 0) startRace();
    const fade = rider.done ? Math.max(0, Math.min(1, hold / 0.5)) : Math.min(1, rider.t / 0.4);

    // flow: particles follow the contours (perpendicular to the gradient), drift downhill
    const f = ctx.flow;
    f.fillStyle = "rgba(21,36,29,0.08)"; f.fillRect(0, 0, w, h);
    f.lineWidth = 1.1;
    for (const p of parts) {
      const [gx, gy] = grad(p.x, p.y);
      const gl = Math.hypot(gx, gy) || 1;
      let vx = (gy / gl) * 1.25 - (gx / gl) * 0.3;
      let vy = (-gx / gl) * 1.25 - (gy / gl) * 0.3;
      const dx = p.x - pointer.x, dy = p.y - pointer.y, d = Math.hypot(dx, dy);
      if (d < 190) { const k = (1 - d / 190) * 2.6; vx += (-dy / (d + 1)) * k; vy += (dx / (d + 1)) * k; }
      const rx = p.x - rider.x, ry = p.y - rider.y, rd = Math.hypot(rx, ry);
      if (rd < 90 && !rider.done) { const k = (1 - rd / 90) * 2.2; vx += rider.hx * k; vy += rider.hy * k; }
      f.strokeStyle = p.oxide ? "rgba(226,96,44,0.42)" : "rgba(169,199,156,0.38)";
      f.beginPath(); f.moveTo(p.x, p.y); f.lineTo(p.x + vx, p.y + vy); f.stroke();
      p.x += vx; p.y += vy;
      if (--p.life < 0 || p.x < -5 || p.x > w + 5 || p.y < -5 || p.y > h + 5) spawn(p);
    }

    // run layer: phantom (dashed replay of your best run), your line, riders
    const c = ctx.run;
    c.clearRect(0, 0, w, h);
    c.save();
    c.globalAlpha = fade;
    c.lineCap = "round"; c.lineJoin = "round";
    let ph = null;
    if (phantom) {
      ph = replayAt(phantom, rider.t);
      c.setLineDash([2, 7]); c.lineWidth = 2; c.strokeStyle = "rgba(233,226,210,0.8)";
      strokeRun(c, phantom.pts, ph.i, ph); c.stroke();
      c.setLineDash([]);
    }
    c.lineWidth = 3; c.strokeStyle = "#E2602C";
    c.shadowColor = "rgba(226,96,44,0.5)"; c.shadowBlur = 10;
    strokeRun(c, rider.pts, rider.pts.length - 1, rider); c.stroke();
    c.shadowBlur = 0;
    if (ph) drawRider(c, ph, "#E9E2D2", "rgba(233,226,210,0.14)");
    drawRider(c, rider, "#F3EEE3", "rgba(226,96,44,0.35)");
    if (rider.aim && !rider.done) { // the line you're asking for
      c.globalAlpha = fade * (0.35 + 0.65 * rider.aim.k);
      c.beginPath(); c.arc(rider.aim.x, rider.aim.y, 6, 0, Math.PI * 2);
      c.strokeStyle = "#E2602C"; c.lineWidth = 1.5; c.stroke();
      c.beginPath(); c.moveTo(rider.x, rider.y); c.lineTo(rider.aim.x, rider.aim.y);
      c.setLineDash([2, 4]); c.strokeStyle = "rgba(226,96,44,0.55)"; c.lineWidth = 1; c.stroke(); c.setLineDash([]);
      c.globalAlpha = fade;
    }
    c.beginPath(); c.arc(course.sx, course.sy, 3.2, 0, Math.PI * 2); c.fillStyle = "#E2602C"; c.fill(); // start gate
    if (flashAt) {
      c.font = "600 11px 'IBM Plex Mono', ui-monospace, monospace";
      c.textAlign = narrow ? "left" : "right";
      const ox = narrow ? 14 : -16;
      c.fillStyle = flash > 0 ? "#A9C79C" : "#E9E2D2";
      c.fillText(flash > 0 ? "NEW PHANTOM" : "PHANTOM HOLDS", flashAt.x + ox, flashAt.y - 4);
      const d = flashAt.delta;
      c.fillStyle = d <= 0 ? "#A9C79C" : "#FF7A70";
      c.fillText(`${d <= 0 ? "−" : "+"}${Math.abs(d).toFixed(2)} s`, flashAt.x + ox, flashAt.y + 12);
    }
    c.restore();

    if (now - lastHud > 120) {
      lastHud = now;
      const p = Math.max(0, Math.min(0.999, progressAt(rider.ri)));
      const delta = phantom ? rider.t - timeAtProgress(phantom, p) : 0; // + means behind the phantom
      if (hud.sector) hud.sector.textContent = `S${1 + Math.floor(p * 4)}`;
      if (hud.speed) hud.speed.textContent = `${(16 + (rider.v / BASE()) * 18).toFixed(1)} km/h`;
      if (hud.delta) {
        hud.delta.textContent = `${delta < 0 ? "−" : "+"}${Math.abs(delta).toFixed(2)} s`;
        hud.delta.classList.toggle("ahead", delta < 0);
        hud.delta.classList.toggle("behind", delta >= 0);
      }
    }
    if (!reduced) raf = requestAnimationFrame(frame);
  };

  hero.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
    const r = hero.getBoundingClientRect();
    pointer.x = e.clientX - r.left; pointer.y = e.clientY - r.top;
  });
  hero.addEventListener("pointerleave", () => { pointer.x = pointer.y = -1e4; });

  resize();
  setTimeout(() => { if (narrow) { measure(); build(); } }, 1300); // the mobile band is final once reveals settle
  let rt = 0, lastW = w;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (Math.abs(hero.getBoundingClientRect().width - lastW) > 2 || !narrow) { lastW = hero.getBoundingClientRect().width; resize(); } }, 150);
  });

  if (reduced) {
    for (let i = 0; i < 800 && !rider.done; i++) stepRider(rider, 1 / 120, false); // a still frame mid-run
    frame(performance.now());
    return;
  }
  raf = requestAnimationFrame(frame);
  new IntersectionObserver(([e]) => {
    cancelAnimationFrame(raf);
    if (e.isIntersecting) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }).observe(hero);
})();
