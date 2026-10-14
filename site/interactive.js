// PhantomFlow.uk: interactive "flow" effects.
// 1. Find your flow: an illustrative suspension + speed sim, your setup vs the phantom setup.
// 2. Flow field: particles streaming along a trail-like field, swirled by the pointer.
// No dependencies. Everything respects prefers-reduced-motion.

const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const fitCanvas = (canvas, ctx, width, height) => {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
};

// ── 1. Find your flow ─────────────────────────────────────────────
// A spring-damper fork rides a fixed section of track. Bad setup bleeds bike speed
// (harshness, bottom-outs, packing down, kick-back), and lost speed becomes lost time.
(() => {
  const root = document.querySelector("[data-tuner]");
  if (!root) return;
  const canvas = root.querySelector("[data-tuner-canvas]");
  const ctx = canvas.getContext("2d");
  const inputs = { comp: root.querySelector('[data-in="comp"]'), reb: root.querySelector('[data-in="reb"]') };
  const out = (k) => root.querySelector(`[data-out="${k}"]`);
  const val = (k) => root.querySelector(`[data-val="${k}"]`);
  const splitsEl = root.querySelector("[data-splits]");

  const DUR = 6, DT = 1 / 400, SAG = 0.28, K = 110;
  const V0 = 34 / 3.6, VMIN = 15 / 3.6;      // free-running speed and floor, m/s
  const GAIN = 1, RECOVER = 0.5;             // speed-loss gain, recovery rate (1/s)
  // Speed-loss weights per cause. Tuned so the sweet spot sits near comp 9 / reb 6.
  const W = { bottom: 0.9, depth: 9, harsh: 0.144, pack: 4, kick: 40 };
  const PHANTOM = { comp: 8, reb: 7 };       // close to ideal, but beatable
  const FLOAT_KMH = 24.8;                    // carry this into the roots and the bike skims them
  const ROOTS = [1.95, 3.6];                 // the root section, s

  const SECTORS = [
    { name: "Braking bumps", end: 1.85 },
    { name: "Roots", end: 3.75 },
    { name: "Drop", end: 4.5 },
    { name: "Landing", end: 6 },
  ];

  // Terrain impulses [time s, strength, width s].
  const events = [];
  for (let t = 0.25; t < 1.7; t += 0.11) events.push([t, 26, 0.03]);
  for (const [t, a] of [[2.05, 70], [2.32, 60], [2.55, 85], [2.8, 65], [3.02, 75], [3.25, 70]]) events.push([t, a, 0.04]);
  events.push([4.25, 170, 0.06]);
  for (let t = 4.6; t < 5.9; t += 0.09) events.push([t, 22, 0.025]);

  const force = (t) => {
    let f = 0;
    for (const [at, a, w] of events) {
      const d = t - at;
      if (d > 0 && d < w) f += (a * Math.sin((Math.PI * d) / w) / w) * 0.12;
    }
    return f;
  };
  const coef = (s) => 2 + s * 1.2;

  const simulate = ({ comp, reb }) => {
    const cc = coef(comp), cr = coef(reb);
    const n = Math.round(DUR / DT), rockN = Math.round(1.6 / DT);
    let x = SAG, v = 0, spd = V0, time = 0, sumSpd = 0, bottoms = 0, lastBottom = -1, sector = 0, rootsKmh = Infinity, rootsAt = ROOTS[0];
    const xs = [], vs = [], marks = [], splits = SECTORS.map(() => 0);
    const lost = { bottom: 0, harsh: 0, pack: 0, kick: 0 };
    for (let i = 0; i < n; i++) {
      const t = i * DT;
      const damp = (v > 0 ? cc : cr) * v;
      v += (force(t) - K * (x - SAG) - damp) * DT;
      x += v * DT;
      if (x >= 1) {
        x = 1; v = Math.min(v, 0);
        if (t - lastBottom > 0.15) { bottoms++; marks.push(t); spd -= GAIN * W.bottom; lost.bottom += GAIN * W.bottom; }
        lastBottom = t;
      }
      if (x <= 0) { x = 0; v = Math.max(v, 0); }

      const rate = {
        harsh: v > 0 ? W.harsh * Math.abs(damp) : 0,                          // force fed through to the rider
        kick: x < SAG - 0.04 ? W.kick * (SAG - 0.04 - x) : 0,                 // rebound overshoot, unweights the wheel
        pack: t > 2 && t < 3.6 ? (W.pack * Math.max(0, x - 0.42) * n) / rockN : 0, // riding deep, steep geometry
        bottom: W.depth * Math.max(0, x - 0.88) * 40,                          // deep in the travel
      };
      let total = 0;
      for (const k in rate) { const d = GAIN * rate[k] * DT; lost[k] += d; total += d; }
      spd = Math.max(VMIN, spd + (V0 - spd) * RECOVER * DT - total);

      const dt = (DT * V0) / spd;                 // same distance, slower speed → more time
      time += dt;
      while (sector < SECTORS.length - 1 && t >= SECTORS[sector].end) sector++;
      splits[sector] += dt;
      sumSpd += spd;
      if (t >= ROOTS[0] && t <= ROOTS[1] && spd * 3.6 < rootsKmh) { rootsKmh = spd * 3.6; rootsAt = t; }
      if (i % 8 === 0) { xs.push(x); vs.push(spd); }
    }
    return { xs, vs, marks, bottoms, time, splits, lost, rootsKmh, rootsAt, avgKmh: (sumSpd / n) * 3.6 };
  };

  const phantom = simulate(PHANTOM);

  // ── drawing ──
  let target = null, shown = null, anim = 0, progress = 1, w = 0, h = 0;
  const pad = { l: 12, r: 12, t: 16 };
  const geo = () => {
    const labelH = 22, gap = 26;
    const travelH = (h - pad.t - labelH - gap) * 0.6;
    const speedTop = pad.t + travelH + gap;
    return { travelTop: pad.t, travelH, speedTop, speedH: h - speedTop - labelH, labelY: h - 7 };
  };
  const Xi = (i, len) => pad.l + (i / (len - 1)) * (w - pad.l - pad.r);
  const Xt = (t) => pad.l + (t / DUR) * (w - pad.l - pad.r);
  const KMH_LO = 13, KMH_HI = 36;
  const Ytravel = (g, x) => g.travelTop + x * g.travelH;                     // compression plotted downwards
  const Yspeed = (g, mps) => g.speedTop + (1 - (mps * 3.6 - KMH_LO) / (KMH_HI - KMH_LO)) * g.speedH;

  const line = (arr, X, Y) => {
    ctx.beginPath();
    arr.forEach((p, i) => (i ? ctx.lineTo(X(i, arr.length), Y(p)) : ctx.moveTo(X(i, arr.length), Y(p))));
  };
  const strokePhantom = () => {
    ctx.save(); ctx.setLineDash([2, 6]); ctx.lineWidth = 2; ctx.strokeStyle = "rgba(233,226,210,0.75)";
    ctx.stroke(); ctx.restore();
  };
  const strokeLive = () => {
    ctx.save(); ctx.lineWidth = 2.4; ctx.lineJoin = "round"; ctx.strokeStyle = "#E2602C";
    ctx.shadowColor = "rgba(226,96,44,0.45)"; ctx.shadowBlur = 8; ctx.stroke(); ctx.restore();
  };
  const hline = (y, color) => {
    ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(pad.l, Math.round(y) + 0.5); ctx.lineTo(w - pad.r, Math.round(y) + 0.5); ctx.stroke();
  };
  const tag = (text, x, y, color) => { ctx.fillStyle = color; ctx.fillText(text, x, y); };

  const draw = () => {
    if (!w || !shown) return;
    const g = geo();
    ctx.clearRect(0, 0, w, h);
    ctx.font = "500 10px ui-monospace, Menlo, Consolas, monospace";

    // sector bands + labels
    let from = 0;
    SECTORS.forEach(({ name, end }, i) => {
      ctx.fillStyle = i % 2 ? "rgba(255,255,255,0.018)" : "rgba(255,255,255,0.035)";
      ctx.fillRect(Xt(from), g.travelTop, Xt(end) - Xt(from), g.speedTop + g.speedH - g.travelTop);
      const text = name.toUpperCase();
      if (ctx.measureText(text).width + 10 <= Xt(end) - Xt(from)) tag(text, Xt(from) + 6, g.labelY, "rgba(255,255,255,0.38)");
      from = end;
    });

    // reference lines
    ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
    hline(Ytravel(g, 1), "rgba(255,122,112,0.4)");
    hline(Ytravel(g, SAG), "rgba(255,255,255,0.12)");
    hline(Yspeed(g, V0), "rgba(255,255,255,0.10)");
    ctx.strokeStyle = "rgba(169,199,156,0.7)";
    const rootsSector = SECTORS.findIndex((s) => s.name === "Roots");
    const fx0 = Xt(SECTORS[rootsSector - 1].end), fx1 = Xt(SECTORS[rootsSector].end);
    const fy = Math.round(Yspeed(g, FLOAT_KMH / 3.6)) + 0.5;
    ctx.beginPath(); ctx.moveTo(fx0, fy); ctx.lineTo(fx1, fy); ctx.stroke();
    ctx.setLineDash([]);
    tag(`FLOAT ${FLOAT_KMH} KM/H`, fx0 + 6, fy - 5, "rgba(169,199,156,0.95)");
    tag("SUSPENSION TRAVEL", pad.l + 6, g.travelTop + 12, "rgba(255,255,255,0.5)");
    tag("BOTTOM-OUT", w - pad.r - 74, Ytravel(g, 1) - 6, "rgba(255,122,112,0.75)");
    tag("SAG", w - pad.r - 24, Ytravel(g, SAG) - 6, "rgba(255,255,255,0.32)");
    tag("BIKE SPEED", pad.l + 6, g.speedTop - 8, "rgba(255,255,255,0.5)");
    tag(`${Math.round(V0 * 3.6)} KM/H`, w - pad.r - 50, Yspeed(g, V0) - 5, "rgba(255,255,255,0.32)");

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, pad.l + progress * (w - pad.l - pad.r), h); ctx.clip();

    line(phantom.xs, Xi, (x) => Ytravel(g, x)); strokePhantom();
    line(shown.xs, Xi, (x) => Ytravel(g, x)); strokeLive();
    line(phantom.vs, Xi, (s) => Yspeed(g, s)); strokePhantom();
    line(shown.vs, Xi, (s) => Yspeed(g, s)); strokeLive();

    // shade speed lost vs phantom
    ctx.beginPath();
    shown.vs.forEach((s, i) => (i ? ctx.lineTo(Xi(i, shown.vs.length), Yspeed(g, s)) : ctx.moveTo(Xi(i, shown.vs.length), Yspeed(g, s))));
    for (let i = phantom.vs.length - 1; i >= 0; i--) ctx.lineTo(Xi(i, phantom.vs.length), Yspeed(g, phantom.vs[i]));
    ctx.closePath(); ctx.fillStyle = "rgba(255,122,112,0.12)"; ctx.fill();

    {
      const ok = target.rootsKmh >= FLOAT_KMH;
      const y = Yspeed(g, target.rootsKmh / 3.6), x = Xt(target.rootsAt);
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fillStyle = ok ? "rgba(169,199,156,0.25)" : "rgba(255,122,112,0.22)"; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fillStyle = ok ? "#A9C79C" : "#FF7A70"; ctx.fill();
    }
    for (const t of target.marks) {
      const y = Ytravel(g, 1);
      ctx.beginPath(); ctx.arc(Xt(t), y, 9, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,122,112,0.2)"; ctx.fill();
      ctx.beginPath(); ctx.arc(Xt(t), y, 3.5, 0, Math.PI * 2); ctx.fillStyle = "#FF7A70"; ctx.fill();
    }
    ctx.restore();
  };

  // ── readouts ──
  const fmtDelta = (d) => `${d < 0 ? "−" : "+"}${Math.abs(d).toFixed(2)}`;
  const verdict = (m, setup) => {
    const d = m.time - phantom.time;
    if (d < -0.01) return "<strong>You beat your phantom.</strong> That setup is now the line to chase.";
    if (d < 0.04) return "<strong>Locked on.</strong> You're carrying the same speed as your phantom and floating the roots.";
    const worstSector = m.splits.map((s, i) => [s - phantom.splits[i], i]).sort((a, b) => b[0] - a[0])[0][1];
    const where = SECTORS[worstSector].name.toLowerCase();
    const cause = Object.keys(m.lost).sort((a, b) => (m.lost[b] - phantom.lost[b]) - (m.lost[a] - phantom.lost[a]))[0];
    const msg = {
      bottom: setup.reb > PHANTOM.reb + 4
        ? `<strong>${m.bottoms ? "Bottoming out" : "Riding too deep"}.</strong> Rebound is too slow, so the fork is still packed down when you hit the drop.`
        : `<strong>${m.bottoms ? "Bottoming out" : "Riding too deep"}</strong> and losing speed. Add compression to hold the fork up.`,
      harsh: "<strong>Too harsh.</strong> The fork can't move through the chatter, so the bike skips and scrubs speed. Ease off the compression.",
      pack: "<strong>Packing down</strong> and riding deep in the travel. Speed up the rebound.",
      kick: "<strong>Kicking back</strong> off every hit and unweighting the wheel. Slow down the rebound.",
    }[cause];
    const float = m.rootsKmh < FLOAT_KMH
      ? ` You drop to ${m.rootsKmh.toFixed(1)} km/h in the roots, too slow to float them.`
      : "";
    return `${msg} Biggest loss: the ${where}.${float}`;
  };

  const setFill = (el) => el.style.setProperty("--p", `${((el.value - el.min) / (el.max - el.min)) * 100}%`);

  const renderSplits = (m) => {
    if (!splitsEl) return;
    splitsEl.innerHTML = SECTORS.map((s, i) => {
      const d = m.splits[i] - phantom.splits[i];
      const cls = d <= 0.005 ? "gain" : "loss";
      return `<li><span>S${i + 1} · ${s.name}</span><b class="${cls}">${fmtDelta(d)}</b></li>`;
    }).join("");
  };

  const update = (animate) => {
    const setup = { comp: +inputs.comp.value, reb: +inputs.reb.value };
    for (const k of ["comp", "reb"]) { val(k).textContent = setup[k]; setFill(inputs[k]); }
    const m = simulate(setup);
    const from = shown ? { xs: shown.xs.slice(), vs: shown.vs.slice() } : { xs: m.xs, vs: m.vs };
    target = m;

    const delta = m.time - phantom.time;
    out("delta").textContent = `${fmtDelta(delta)} s`;
    out("delta").className = delta <= 0.04 ? "gain" : "loss";
    out("speed").textContent = `${m.avgKmh.toFixed(1)} km/h`;
    out("speed").className = m.avgKmh >= phantom.avgKmh - 0.1 ? "gain" : "";
    out("roots").textContent = `${m.rootsKmh.toFixed(1)} km/h`;
    out("roots").className = m.rootsKmh >= FLOAT_KMH ? "gain" : "loss";
    out("bottoms").textContent = m.bottoms;
    out("bottoms").className = m.bottoms > phantom.bottoms ? "loss" : "";
    out("verdict").innerHTML = verdict(m, setup);
    renderSplits(m);

    cancelAnimationFrame(anim);
    if (!animate || REDUCED) { shown = { xs: m.xs, vs: m.vs }; draw(); return; }
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 380), e = 1 - Math.pow(1 - p, 3);
      shown = {
        xs: from.xs.map((x, i) => x + (m.xs[i] - x) * e),
        vs: from.vs.map((s, i) => s + (m.vs[i] - s) * e),
      };
      draw();
      if (p < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  };

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    w = r.width; h = r.height;
    fitCanvas(canvas, ctx, w, h);
    draw();
  };

  for (const el of Object.values(inputs)) el.addEventListener("input", () => update(true));
  window.addEventListener("resize", resize);
  update(false);
  resize();

  // Draw the traces on the first time the panel scrolls into view.
  if ("IntersectionObserver" in window && !REDUCED) {
    progress = 0; draw();
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const t0 = performance.now();
      const step = (now) => {
        const p = Math.min(1, (now - t0) / 1600);
        progress = 1 - Math.pow(1 - p, 3);
        draw();
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }, { threshold: 0.3 });
    io.observe(canvas);
  }
})();

// ── 2. Flow field ─────────────────────────────────────────────────
(() => {
  const canvas = document.querySelector("[data-flowfield]");
  if (!canvas || REDUCED) return;
  const ctx = canvas.getContext("2d");
  const host = canvas.parentElement;
  const pointer = { x: -1e4, y: -1e4 };
  let w = 0, h = 0, parts = [], raf = 0, running = false;

  const spawn = (p = {}, edge = false) => Object.assign(p, {
    x: edge ? -2 : Math.random() * w,
    y: Math.random() * h,
    life: 80 + Math.random() * 220,
    blue: Math.random() > 0.72,
  });

  const resize = () => {
    w = host.clientWidth; h = host.clientHeight;
    fitCanvas(canvas, ctx, w, h);
    parts = Array.from({ length: Math.min(1400, Math.round((w * h) / 900)) }, () => spawn());
  };

  const field = (x, y, t) =>
    Math.sin(x * 0.0032 + t * 0.00011) * 1.1 + Math.cos(y * 0.0045 - t * 0.00007) * 0.9 + Math.sin((x + y) * 0.0017) * 0.6;

  const frame = (t) => {
    ctx.fillStyle = "rgba(21,36,29,0.075)";
    ctx.fillRect(0, 0, w, h);
    ctx.lineWidth = 1.1;
    for (const p of parts) {
      const a = field(p.x, p.y, t);
      let vx = Math.cos(a) * 1.15 + 0.55, vy = Math.sin(a) * 0.9;
      const dx = p.x - pointer.x, dy = p.y - pointer.y, d = Math.hypot(dx, dy);
      if (d < 200) { const f = (1 - d / 200) * 2.4; vx += (-dy / (d + 1)) * f; vy += (dx / (d + 1)) * f; }
      ctx.strokeStyle = p.blue ? "rgba(169,199,156,0.4)" : "rgba(226,96,44,0.45)";
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + vx, p.y + vy); ctx.stroke();
      p.x += vx; p.y += vy;
      if (--p.life < 0 || p.x > w + 5 || p.x < -5 || p.y < -5 || p.y > h + 5) spawn(p, Math.random() < 0.6);
    }
    raf = requestAnimationFrame(frame);
  };

  host.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    pointer.x = e.clientX - r.left; pointer.y = e.clientY - r.top;
  });
  host.addEventListener("pointerleave", () => { pointer.x = pointer.y = -1e4; });
  window.addEventListener("resize", resize);
  resize();
  new IntersectionObserver(([e]) => {
    if (e.isIntersecting && !running) { running = true; raf = requestAnimationFrame(frame); }
    else if (!e.isIntersecting && running) { running = false; cancelAnimationFrame(raf); }
  }).observe(canvas);
})();
