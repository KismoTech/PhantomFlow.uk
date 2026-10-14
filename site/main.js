// PhantomFlow.uk: hero telemetry animation, header state, scroll reveals.
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

  // ── Hero telemetry trace ──────────────────────────────────────
  const canvas = document.querySelector("[data-trace]");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const hud = {
    travel: document.querySelector('[data-hud="travel"]'),
    speed: document.querySelector('[data-hud="speed"]'),
    delta: document.querySelector('[data-hud="delta"]'),
  };

  // Deterministic pseudo-suspension signal: low-frequency terrain + chatter + sharp hits.
  const hits = Array.from({ length: 64 }, (_, i) => ({ at: i * 2.3 + ((i * 7919) % 13) / 10, amp: 0.25 + ((i * 104729) % 50) / 100 }));
  const signal = (t, k) => {
    let v = 0.42
      + 0.16 * Math.sin(t * 0.9 + 0.4)
      + 0.08 * Math.sin(t * 2.3 + 1.1)
      + 0.035 * Math.sin(t * 13.0) * (0.6 + 0.4 * Math.sin(t * 0.7));
    for (const h of hits) {
      const dt = (t % 148) - h.at;
      if (dt > 0 && dt < 1.4) v += h.amp * k * Math.exp(-dt * 4.2) * Math.sin(dt * 9);
    }
    return Math.max(0.03, Math.min(0.97, v));
  };
  const live = (t) => signal(t, 1);
  const phantom = (t) => signal(t + 0.16, 0.88) * 0.97 + 0.012;

  let w = 0, h = 0, dpr = 1;
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    w = r.width; h = r.height;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const layout = { gapTop: 0, gapBottom: 0 };
  const measure = () => {
    const c = canvas.getBoundingClientRect();
    const actions = document.querySelector(".hero-actions");
    const hudEl = document.querySelector(".hud");
    if (!actions || !hudEl) return;
    layout.gapTop = actions.getBoundingClientRect().bottom - c.top + 36;
    layout.gapBottom = hudEl.getBoundingClientRect().top - c.top - 28;
  };
  resize();
  measure();
  setTimeout(measure, 1300); // re-measure once the reveal transitions settle
  window.addEventListener("resize", () => { resize(); measure(); });

  const WINDOW = 7;           // seconds visible
  const yOf = (v, top, band) => top + band * (1 - v);


  const trace = (fn, t0, top, band, end) => {
    ctx.beginPath();
    const n = Math.max(120, Math.floor(w / 3));
    for (let i = 0; i <= n; i++) {
      const x = (i / n) * end;
      const t = t0 + (x / w) * WINDOW;
      const y = yOf(fn(t), top, band);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
  };

  let start = performance.now();
  let lastHud = 0;
  const frame = (now) => {
    const t = (now - start) / 1000;
    const t0 = t;                          // left edge time
    const head = w * 0.78;                 // playhead x
    // Wide screens: trace sits behind the copy (vignetted). Narrow: it fills the gap
    // between the CTAs and the HUD, measured from the layout.
    let top = h * 0.30, band = h * 0.46;
    if (w < 900 && layout.gapTop) { top = layout.gapTop; band = Math.max(60, layout.gapBottom - layout.gapTop); }

    ctx.clearRect(0, 0, w, h);

    // phantom: full width, dashed, cool
    ctx.save();
    ctx.setLineDash([2, 7]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(233,226,210,0.6)";
    ctx.shadowBlur = 0;
    trace(phantom, t0, top, band, w);
    ctx.stroke();
    ctx.restore();

    // live: up to playhead, glowing gradient
    const g = ctx.createLinearGradient(0, 0, head, 0);
    g.addColorStop(0, "rgba(226,96,44,0)");
    g.addColorStop(0.35, "rgba(226,96,44,0.6)");
    g.addColorStop(1, "rgba(238,122,72,1)");
    ctx.save();
    ctx.lineWidth = 2.6;
    ctx.lineJoin = "round";
    ctx.strokeStyle = g;
    ctx.shadowColor = "rgba(226,96,44,0.45)"; ctx.shadowBlur = 8;
    trace(live, t0, top, band, head);
    ctx.stroke();
    ctx.restore();

    // area fill under live trace
    ctx.save();
    trace(live, t0, top, band, head);
    ctx.lineTo(head, top + band); ctx.lineTo(0, top + band); ctx.closePath();
    const fill = ctx.createLinearGradient(0, top, 0, top + band);
    fill.addColorStop(0, "rgba(226,96,44,0.12)"); fill.addColorStop(1, "rgba(226,96,44,0)");
    ctx.fillStyle = fill; ctx.fill();
    ctx.restore();

    // playhead
    const tHead = t0 + (head / w) * WINDOW;
    const vHead = live(tHead);
    const yHead = yOf(vHead, top, band);
    window.PF_HEAD = { x: head, y: yHead }; // lets the hero flow field react to the rider
    const lg = ctx.createLinearGradient(0, top - 40, 0, top + band + 40);
    lg.addColorStop(0, "rgba(255,255,255,0)"); lg.addColorStop(0.5, "rgba(255,255,255,0.22)"); lg.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = lg; ctx.fillRect(Math.round(head), top - 40, 1, band + 80);
    ctx.beginPath(); ctx.arc(head, yHead, 9, 0, Math.PI * 2); ctx.fillStyle = "rgba(226,96,44,0.22)"; ctx.fill();
    ctx.beginPath(); ctx.arc(head, yHead, 3.6, 0, Math.PI * 2); ctx.fillStyle = "#F3EEE3"; ctx.fill();

    // HUD (throttled)
    if (now - lastHud > 110) {
      lastHud = now;
      const dv = (live(tHead + 0.01) - live(tHead - 0.01)) / 0.02;
      const delta = Math.sin(t * 0.21) * 0.35 - 0.06;
      if (hud.travel) hud.travel.textContent = `${Math.round(vHead * 100)}%`;
      if (hud.speed) hud.speed.textContent = `${(31 + 4 * Math.sin(t * 0.37) - Math.abs(dv) * 0.6).toFixed(1)} km/h`;
      if (hud.delta) {
        hud.delta.textContent = `${delta < 0 ? "−" : "+"}${Math.abs(delta).toFixed(2)} s`;
        hud.delta.classList.toggle("ahead", delta < 0);
        hud.delta.classList.toggle("behind", delta >= 0);
      }
    }
    if (!reduced) raf = requestAnimationFrame(frame);
  };

  let raf = requestAnimationFrame(frame);
  // Pause when the hero is off-screen to save battery.
  if ("IntersectionObserver" in window && !reduced) {
    new IntersectionObserver(([e]) => {
      cancelAnimationFrame(raf);
      if (e.isIntersecting) raf = requestAnimationFrame(frame);
    }).observe(canvas);
  }
})();
