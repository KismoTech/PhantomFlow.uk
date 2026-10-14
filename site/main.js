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
  // A height field drives everything: contour lines are its isolines, particles
  // flow along those contours, and two riders (you and your phantom) race down
  // a line across it. The pointer stirs the flow; the rider leaves a wake.
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

  let w = 0, h = 0, S = 1, narrow = false;
  const band = { top: 0, bottom: 0 };

  // Hills in relative coordinates [u, v, spread, height]; plus a fall line toward the bottom.
  const HILLS = [
    [0.80, 0.26, 0.15, 1.0], [0.60, 0.58, 0.17, 0.75], [0.95, 0.66, 0.11, 0.55],
    [0.42, 0.20, 0.16, 0.5], [0.18, 0.78, 0.20, 0.45], [0.70, 0.92, 0.10, 0.35],
  ];
  const FALL = 0.55;
  const height = (x, y) => {
    let z = FALL * (1 - y / h);
    for (const [u, v, s, a] of HILLS) {
      const dx = (x - u * w) / S, dy = (y - v * h) / S;
      z += a * Math.exp(-(dx * dx + dy * dy) / (2 * s * s));
    }
    return z;
  };
  const grad = (x, y) => {
    let gx = 0, gy = -FALL * S / h;
    for (const [u, v, s, a] of HILLS) {
      const dx = (x - u * w) / S, dy = (y - v * h) / S;
      const e = a * Math.exp(-(dx * dx + dy * dy) / (2 * s * s)) / (s * s);
      gx -= e * dx; gy -= e * dy;
    }
    return [gx, gy];
  };

  const fit = (c, k) => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    ctx[k].setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  // Contours via marching squares, drawn once per resize.
  const drawTerrain = () => {
    const c = ctx.terrain, cell = 7;
    c.clearRect(0, 0, w, h);
    const cols = Math.ceil(w / cell) + 1, rows = Math.ceil(h / cell) + 1;
    const z = new Float32Array(cols * rows);
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const v = height(i * cell, j * cell);
      z[j * cols + i] = v; if (v < lo) lo = v; if (v > hi) hi = v;
    }
    const LEVELS = 22, step = (hi - lo) / (LEVELS + 1);
    const lerp = (a, b, l) => (l - a) / (b - a);
    for (let k = 1; k <= LEVELS; k++) {
      const l = lo + k * step;
      c.beginPath();
      for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
        const a = z[j * cols + i], b = z[j * cols + i + 1], d = z[(j + 1) * cols + i], e = z[(j + 1) * cols + i + 1];
        const idx = (a > l) | ((b > l) << 1) | ((e > l) << 2) | ((d > l) << 3);
        if (idx === 0 || idx === 15) continue;
        const x0 = i * cell, y0 = j * cell;
        const T = [x0 + lerp(a, b, l) * cell, y0], R = [x0 + cell, y0 + lerp(b, e, l) * cell];
        const B = [x0 + lerp(d, e, l) * cell, y0 + cell], L = [x0, y0 + lerp(a, d, l) * cell];
        const seg = {
          1: [L, T], 2: [T, R], 3: [L, R], 4: [R, B], 5: [L, T, R, B], 6: [T, B], 7: [L, B],
          8: [L, B], 9: [T, B], 10: [L, B, T, R], 11: [R, B], 12: [L, R], 13: [T, R], 14: [L, T],
        }[idx];
        for (let s = 0; s < seg.length; s += 2) { c.moveTo(seg[s][0], seg[s][1]); c.lineTo(seg[s + 1][0], seg[s + 1][1]); }
      }
      const index = k % 5 === 0;
      c.strokeStyle = index ? "rgba(169,199,156,0.32)" : "rgba(169,199,156,0.16)";
      c.lineWidth = index ? 1.3 : 1;
      c.stroke();
    }
  };

  // The run line: Catmull-Rom through waypoints, resampled by arc length.
  let path = [], pathLen = 0;
  const buildPath = () => {
    const pts = narrow
      ? [[1.06, 0.15], [0.82, 0.05], [0.62, 0.42], [0.40, 0.18], [0.22, 0.62], [0.05, 0.40], [-0.08, 0.85]]
          .map(([u, t]) => [u * w, band.top + t * (band.bottom - band.top)])
      : [[0.98, 0.10], [0.84, 0.30], [0.90, 0.48], [0.72, 0.56], [0.80, 0.74], [0.60, 0.80], [0.66, 0.98]]
          .map(([u, v]) => [u * w, v * h]);
    const P = [pts[0], ...pts, pts[pts.length - 1]];
    const raw = [];
    for (let i = 1; i < P.length - 2; i++) {
      const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
      for (let t = 0; t < 1; t += 0.02) {
        const t2 = t * t, t3 = t2 * t;
        raw.push([0, 1].map((k) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
      }
    }
    raw.push(pts[pts.length - 1]);
    path = [{ x: raw[0][0], y: raw[0][1], d: 0 }];
    for (let i = 1; i < raw.length; i++) {
      const p = path[path.length - 1], d = Math.hypot(raw[i][0] - p.x, raw[i][1] - p.y);
      path.push({ x: raw[i][0], y: raw[i][1], d: p.d + d });
    }
    pathLen = path[path.length - 1].d;
  };
  const at = (s) => {
    const target = Math.max(0, Math.min(1, s)) * pathLen;
    let lo = 0, hi = path.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (path[m].d < target) lo = m; else hi = m; }
    const a = path[lo], b = path[hi], k = (target - a.d) / (b.d - a.d || 1);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, i: lo };
  };
  // The phantom takes a slightly different line: offset along the path normal.
  const LINE_OFFSET = (u) => 16 * Math.sin(Math.PI * u * 3) * Math.sin(Math.PI * u);
  const shifted = (i, off) => {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    const tx = b.x - a.x, ty = b.y - a.y, tl = Math.hypot(tx, ty) || 1;
    const k = off ? off(path[i].d / pathLen) : 0;
    return { x: path[i].x - (ty / tl) * k, y: path[i].y + (tx / tl) * k };
  };
  const atLine = (s, off) => {
    const p = at(s);
    if (!off) return p;
    const q = shifted(p.i, off);
    return { x: q.x + (p.x - path[p.i].x), y: q.y + (p.y - path[p.i].y), i: p.i };
  };
  const strokeTo = (c, s, off) => {
    const end = atLine(s, off);
    c.beginPath(); c.moveTo(path[0].x, path[0].y);
    for (let i = 1; i <= end.i; i++) { const q = shifted(i, off); c.lineTo(q.x, q.y); }
    c.lineTo(end.x, end.y);
  };

  // Flow particles.
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
  };
  const resize = () => {
    const r = hero.getBoundingClientRect();
    w = r.width; h = r.height; S = Math.max(w, h); narrow = w < 900;
    for (const k in layers) fit(layers[k], k);
    measure();
    drawTerrain();
    buildPath();
    parts = Array.from({ length: Math.min(1300, Math.round((w * h) / 1000)) }, () => spawn());
    ctx.flow.fillStyle = "#15241D"; ctx.flow.fillRect(0, 0, w, h);
  };

  // Run timing: one descent every RUN seconds; phantom gap breathes so the lead changes.
  const RUN = 13;
  let start = performance.now(), lastHud = 0;
  const riderS = (t) => { const p = (t % RUN) / RUN; return p + 0.035 * Math.sin(p * Math.PI * 4) * p * (1 - p) * 4; };
  const phantomS = (t) => { const p = (t % RUN) / RUN; return p + (0.022 * Math.sin(t * 0.45 + 1) + 0.006) * Math.sin(Math.PI * p); };

  const drawRider = (c, p, fill, ring) => {
    c.beginPath(); c.arc(p.x, p.y, 11, 0, Math.PI * 2); c.fillStyle = ring; c.fill();
    c.beginPath(); c.arc(p.x, p.y, 4, 0, Math.PI * 2); c.fillStyle = fill; c.fill();
  };

  const frame = (now) => {
    const t = (now - start) / 1000;
    const s = riderS(t), sp = phantomS(t);
    const me = at(s), ph = atLine(sp, LINE_OFFSET);
    const cycle = (t % RUN) / RUN;
    const fade = cycle > 0.94 ? 1 - (cycle - 0.94) / 0.06 : cycle < 0.04 ? cycle / 0.04 : 1;

    // flow: particles follow the contours (perpendicular to the gradient), drift downhill
    const f = ctx.flow;
    f.fillStyle = "rgba(21,36,29,0.08)"; f.fillRect(0, 0, w, h);
    f.lineWidth = 1.1;
    const ahead = at(Math.min(1, s + 0.01));
    const hx0 = ahead.x - me.x, hy0 = ahead.y - me.y, hl = Math.hypot(hx0, hy0) || 1;
    for (const p of parts) {
      const [gx, gy] = grad(p.x, p.y);
      const gl = Math.hypot(gx, gy) || 1;
      let vx = (gy / gl) * 1.25 - (gx / gl) * 0.25;
      let vy = (-gx / gl) * 1.25 - (gy / gl) * 0.25;
      const dx = p.x - pointer.x, dy = p.y - pointer.y, d = Math.hypot(dx, dy);
      if (d < 190) { const k = (1 - d / 190) * 2.6; vx += (-dy / (d + 1)) * k; vy += (dx / (d + 1)) * k; }
      const rx = p.x - me.x, ry = p.y - me.y, rd = Math.hypot(rx, ry);
      if (rd < 90) { const k = (1 - rd / 90) * 2.2 * fade; vx += (hx0 / hl) * k; vy += (hy0 / hl) * k; }
      f.strokeStyle = p.oxide ? "rgba(226,96,44,0.42)" : "rgba(169,199,156,0.38)";
      f.beginPath(); f.moveTo(p.x, p.y); f.lineTo(p.x + vx, p.y + vy); f.stroke();
      p.x += vx; p.y += vy;
      if (--p.life < 0 || p.x < -5 || p.x > w + 5 || p.y < -5 || p.y > h + 5) spawn(p);
    }

    // run layer: course ahead (faint), phantom line (dashed), your line (oxide), riders
    const c = ctx.run;
    c.clearRect(0, 0, w, h);
    c.save();
    c.globalAlpha = fade;
    c.lineCap = "round"; c.lineJoin = "round";
    c.setLineDash([1, 9]); c.lineWidth = 1.5; c.strokeStyle = "rgba(233,226,210,0.22)";
    strokeTo(c, 1); c.stroke();
    c.setLineDash([2, 7]); c.lineWidth = 2; c.strokeStyle = "rgba(233,226,210,0.75)";
    strokeTo(c, sp, LINE_OFFSET); c.stroke();
    c.setLineDash([]); c.lineWidth = 3; c.strokeStyle = "#E2602C";
    c.shadowColor = "rgba(226,96,44,0.5)"; c.shadowBlur = 10;
    strokeTo(c, s); c.stroke();
    c.shadowBlur = 0;
    drawRider(c, ph, "#E9E2D2", "rgba(233,226,210,0.14)");
    drawRider(c, me, "#F3EEE3", "rgba(226,96,44,0.35)");
    c.beginPath(); c.arc(path[0].x, path[0].y, 3, 0, Math.PI * 2); c.fillStyle = "#E2602C"; c.fill(); // summit / start
    c.restore();

    if (now - lastHud > 120) {
      lastHud = now;
      const delta = (s - sp) * RUN * 1.6;               // + means the phantom is ahead
      const slope = Math.hypot(...grad(me.x, me.y));
      if (hud.sector) hud.sector.textContent = `S${Math.min(4, 1 + Math.floor(Math.min(0.999, s) * 4))}`;
      if (hud.speed) hud.speed.textContent = `${(27 + Math.min(12, slope * 9) + 2 * Math.sin(t * 1.3)).toFixed(1)} km/h`;
      if (hud.delta) {
        const lead = -delta;
        hud.delta.textContent = `${lead < 0 ? "−" : "+"}${Math.abs(lead).toFixed(2)} s`;
        hud.delta.classList.toggle("ahead", lead < 0);
        hud.delta.classList.toggle("behind", lead >= 0);
      }
    }
    if (!reduced) raf = requestAnimationFrame(frame);
  };

  hero.addEventListener("pointermove", (e) => {
    const r = hero.getBoundingClientRect();
    pointer.x = e.clientX - r.left; pointer.y = e.clientY - r.top;
  });
  hero.addEventListener("pointerleave", () => { pointer.x = pointer.y = -1e4; });

  resize();
  setTimeout(() => { measure(); if (narrow) buildPath(); }, 1300); // after reveal transitions settle
  let rt = 0;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(resize, 120); });

  if (reduced) {
    start = performance.now() - RUN * 0.55 * 1000; // a still frame mid-run
    frame(performance.now());
    return;
  }
  let raf = requestAnimationFrame(frame);
  new IntersectionObserver(([e]) => {
    cancelAnimationFrame(raf);
    if (e.isIntersecting) raf = requestAnimationFrame(frame);
  }).observe(hero);
})();
