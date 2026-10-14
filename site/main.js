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

  // ── The race ──
  // The rider steers live: downhill along the fall line, carried by the terrain flow, with a
  // little personality noise, and pulled toward the pointer when it is near. Every run is a new
  // line. The fastest run so far is the phantom the next run races.
  const course = { sx: 0, sy: 0, ax: 0, ay: 1, len: 1, lo: 0, hi: 0 };
  const setCourse = () => {
    if (narrow) {
      const mid = (band.top + band.bottom) / 2;
      Object.assign(course, { sx: w * 0.95, sy: mid, ax: -1, ay: 0, len: w * 0.9, lo: band.top + 8, hi: band.bottom - 8 });
    } else {
      Object.assign(course, { sx: w * 0.82, sy: h * 0.09, ax: 0, ay: 1, len: h * 0.78, lo: w * 0.56, hi: w * 0.97 });
    }
  };
  const progressOf = (x, y) => ((x - course.sx) * course.ax + (y - course.sy) * course.ay) / course.len;
  const lateral = (x, y) => (course.ay ? x : y); // the free axis, bounded by lo / hi

  let rider = null, phantom = null, best = null, flash = 0, flashAt = null, runNo = 0;
  const newRider = (seed) => ({
    x: course.sx, y: course.sy, hx: course.ax, hy: course.ay, v: 0, t: 0, done: false,
    pts: [{ x: course.sx, y: course.sy, t: 0, p: 0 }],
    ph: [seed * 1.7, seed * 2.9 + 1, seed * 0.6 + 2],
  });

  const BASE = () => course.len / 10.5; // px/s, so a run takes ~10-13 s
  const stepRider = (r, dt, steer) => {
    const [gx, gy] = grad(r.x, r.y);
    const gl = Math.hypot(gx, gy) || 1;
    const n = Math.sin(r.t * 0.9 + r.ph[0]) + 0.6 * Math.sin(r.t * 2.3 + r.ph[1]) + 0.3 * Math.sin(r.t * 4.1 + r.ph[2]);
    // desired heading: course axis + downhill + along-contour flow + noise
    let tx = course.ax - (gx / gl) * 0.55 + (gy / gl) * 0.35 * n;
    let ty = course.ay - (gy / gl) * 0.55 - (gx / gl) * 0.35 * n;
    tx += -course.ay * 0.55 * n; ty += course.ax * 0.55 * n; // lateral wander
    if (steer) {
      const dx = pointer.x - r.x, dy = pointer.y - r.y, d = Math.hypot(dx, dy);
      if (d < 260 && d > 4) { const k = (1 - d / 260) * 2.4; tx += (dx / d) * k; ty += (dy / d) * k; }
    }
    // soft walls on the free axis
    const lat = lateral(r.x, r.y), m = 40;
    if (lat < course.lo + m) { const k = ((course.lo + m - lat) / m) * 2; if (course.ay) tx += k; else ty += k; }
    if (lat > course.hi - m) { const k = ((lat - course.hi + m) / m) * 2; if (course.ay) tx -= k; else ty -= k; }
    // never ride back up the course
    const along = tx * course.ax + ty * course.ay;
    if (along < 0.25) { tx += course.ax * (0.25 - along); ty += course.ay * (0.25 - along); }
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    // turn toward it; sharp turns cost speed
    const turn = 1 - (r.hx * tx + r.hy * ty);
    const rate = Math.min(1, dt * 3.2);
    r.hx += (tx - r.hx) * rate; r.hy += (ty - r.hy) * rate;
    const hl = Math.hypot(r.hx, r.hy) || 1; r.hx /= hl; r.hy /= hl;
    // speed: steeper ground is faster, turning bleeds speed
    const drop = -(gx * r.hx + gy * r.hy) / Math.max(gl, 0.5);
    const target = BASE() * (0.85 + 0.45 * Math.max(-0.4, Math.min(1, drop)) - 1.4 * turn);
    r.v += (Math.max(BASE() * 0.45, target) - r.v) * Math.min(1, dt * 1.6);
    r.x += r.hx * r.v * dt; r.y += r.hy * r.v * dt; r.t += dt;
    const p = progressOf(r.x, r.y);
    const lastPt = r.pts[r.pts.length - 1];
    if (Math.hypot(r.x - lastPt.x, r.y - lastPt.y) > 3) r.pts.push({ x: r.x, y: r.y, t: r.t, p });
    if (p >= 1) r.done = true;
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

  const simulateRun = (seed) => {
    const r = newRider(seed);
    for (let i = 0; i < 6000 && !r.done; i++) stepRider(r, 1 / 60, false);
    return r;
  };
  const startRace = () => {
    runNo++;
    rider = newRider(runNo + Math.random() * 10);
    phantom = best;
    flashAt = null;
  };
  const resetRace = () => {
    setCourse();
    best = simulateRun(0.5);
    runNo = 0;
    startRace();
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
    parts = Array.from({ length: Math.min(1300, Math.round((w * h) / 1000)) }, () => spawn());
    ctx.flow.fillStyle = "#15241D"; ctx.flow.fillRect(0, 0, w, h);
    resetRace();
  };

  const drawRider = (c, p, fill, ring) => {
    c.beginPath(); c.arc(p.x, p.y, 11, 0, Math.PI * 2); c.fillStyle = ring; c.fill();
    c.beginPath(); c.arc(p.x, p.y, 4, 0, Math.PI * 2); c.fillStyle = fill; c.fill();
  };

  let last = performance.now(), lastHud = 0, hold = 0, raf = 0;
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;

    // advance the race
    if (!rider.done) stepRider(rider, dt, pointer.x > -1e3);
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
      let vx = (gy / gl) * 1.25 - (gx / gl) * 0.25;
      let vy = (-gx / gl) * 1.25 - (gy / gl) * 0.25;
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
      c.setLineDash([2, 7]); c.lineWidth = 2; c.strokeStyle = "rgba(233,226,210,0.75)";
      strokeRun(c, phantom.pts, ph.i, ph); c.stroke();
      c.setLineDash([]);
    }
    c.lineWidth = 3; c.strokeStyle = "#E2602C";
    c.shadowColor = "rgba(226,96,44,0.5)"; c.shadowBlur = 10;
    strokeRun(c, rider.pts, rider.pts.length - 1, rider); c.stroke();
    c.shadowBlur = 0;
    if (ph) drawRider(c, ph, "#E9E2D2", "rgba(233,226,210,0.14)");
    drawRider(c, rider, "#F3EEE3", "rgba(226,96,44,0.35)");
    c.beginPath(); c.arc(course.sx, course.sy, 3, 0, Math.PI * 2); c.fillStyle = "#E2602C"; c.fill(); // start gate
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
      const p = Math.max(0, Math.min(0.999, progressOf(rider.x, rider.y)));
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
  setTimeout(() => { measure(); if (narrow) resetRace(); }, 1300); // after reveal transitions settle
  let rt = 0;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(resize, 120); });

  if (reduced) {
    for (let i = 0; i < 400 && !rider.done; i++) stepRider(rider, 1 / 60, false); // a still frame mid-run
    frame(performance.now());
    return;
  }
  raf = requestAnimationFrame(frame);
  new IntersectionObserver(([e]) => {
    cancelAnimationFrame(raf);
    if (e.isIntersecting) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }).observe(hero);
})();
