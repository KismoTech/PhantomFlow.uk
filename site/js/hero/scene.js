// Hero scene: one terrain, seen from above. A fresh trail and hill per page load (?seed=N
// pins one); contour lines drawn from the terrain; particles flowing along the contours;
// your run (oxide) racing your phantom (dashed) down the trail. The pointer stirs the flow
// and picks your line. The fastest run becomes the next phantom.
import { REDUCED_MOTION, COLOR, rgba, mulberry32, fitCanvas, formatDelta, whenVisible } from "../util.js";
import { createTrail } from "./trail.js";
import { createTerrain } from "./terrain.js";
import { createRace, replayAt, timeAtProgress, PHYS } from "./race.js";

const STEP = 1 / 120;          // fixed physics step, so live runs match simulated ones
const HOLD = 1.8;              // seconds the finish result stays up
const NARROW = 900;            // px: below this the race runs through a band under the buttons
const REVEAL_SETTLE_MS = 1300; // the hero copy's reveal transition; the phone band is final after it
const MIN_BAND = 90;           // px: smallest race band on phones
const MAX_ASPECT = 0.75;       // course box width ≤ this × its height (ultra-wide screens)

const hero = document.querySelector("[data-hero]");
if (hero) initHero(hero);

function initHero(hero) {
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

  const seedParam = /[?&]seed=(\d+)/.exec(location.search);
  const SEED = seedParam ? +seedParam[1] : crypto.getRandomValues(new Uint32Array(1))[0];

  const pointer = { x: 0, y: 0, active: false };
  let w = 0, h = 0, narrow = false;
  let trail, terrain, race, box;
  let rider, phantom, best, result, runNo = 0, runRand;
  let particles = [];

  // ── Layout: where the race may run ──
  const courseBox = () => {
    const r = hero.getBoundingClientRect();
    if (narrow) { // the band between the buttons and the HUD
      const actions = hero.querySelector(".hero-actions"), hudEl = hero.querySelector(".hud");
      const bottom = (hudEl ? hudEl.getBoundingClientRect().top - r.top : h) - 24;
      let top = (actions ? actions.getBoundingClientRect().bottom - r.top : h * 0.6) + 30;
      top = Math.min(top, bottom - MIN_BAND); // short screens: keep a usable band, even under the buttons
      return { x0: w * 0.04, x1: w * 0.96, y0: top + 4, y1: bottom - 4 };
    }
    // right of the copy: measure the text itself, not its full-width blocks
    const range = document.createRange();
    const textRight = Math.max(0, ...[...hero.querySelectorAll("h1, .lede, .hero-actions .btn")].map((el) => {
      range.selectNodeContents(el);
      return range.getBoundingClientRect().right - r.left;
    }));
    // Beside the copy, but never wider than the hill is tall (ultra-wide screens), sat in the
    // free space a little toward the text.
    const y0 = h * 0.07, y1 = h * 0.86;
    const left = Math.min(w * 0.67, Math.max(w * 0.5, textRight + 36)), right = w * 0.97;
    const width = Math.min(right - left, (y1 - y0) * MAX_ASPECT);
    const x0 = left + (right - left - width) * 0.35;
    return { x0, x1: x0 + width, y0, y1 };
  };

  // ── Build the world (deterministic for a given seed and size) ──
  const build = () => {
    performance.mark("hero:build");
    const rand = mulberry32(SEED);
    box = courseBox();
    trail = createTrail(box, narrow, rand);
    terrain = createTerrain({ w, h, narrow, trail, rand });
    race = createRace({ trail, terrain, box });
    terrain.draw(ctx.terrain);
    runRand = mulberry32(SEED ^ 0x9e3779b9);
    best = race.simulate(runRand() * 10); // a first phantom to race
    runNo = 0;
    startRun();
    performance.measure("hero:build", "hero:build");
  };
  const startRun = () => {
    runNo++;
    rider = race.newRider(runNo * 3.1 + runRand() * 10);
    phantom = best;
    result = null;
  };

  const spawn = (p = {}) => Object.assign(p, {
    x: Math.random() * w, y: Math.random() * h, life: 60 + Math.random() * 240, oxide: Math.random() < 0.22,
  });
  const resize = () => {
    const r = hero.getBoundingClientRect();
    w = r.width; h = r.height; narrow = w < NARROW;
    for (const k in layers) fitCanvas(layers[k], ctx[k], w, h);
    build();
    // fixed-size streaks, so keep the same density per pixel (more of them on big screens)
    particles = Array.from({ length: Math.min(2200, Math.round((w * h) / 1000)) }, () => spawn());
    ctx.flow.fillStyle = COLOR.forest;
    ctx.flow.fillRect(0, 0, w, h);
  };

  // ── Drawing ──
  const strokePath = (c, P, endIdx, end) => {
    c.beginPath(); c.moveTo(P[0].x, P[0].y);
    for (let i = 1; i <= endIdx; i++) c.lineTo(P[i].x, P[i].y);
    if (end) c.lineTo(end.x, end.y);
  };
  const dot = (c, p, fill, ring) => {
    const U = trail.unit;
    c.beginPath(); c.arc(p.x, p.y, 11 * U, 0, Math.PI * 2); c.fillStyle = ring; c.fill();
    c.beginPath(); c.arc(p.x, p.y, 4 * U, 0, Math.PI * 2); c.fillStyle = fill; c.fill();
  };

  // Particles follow the contours (perpendicular to the gradient) and drift downhill; the
  // pointer swirls them and the rider leaves a wake.
  // Time-based (not per frame), so the flow looks the same at 60, 144 or 240 Hz.
  const drawFlow = (dt) => {
    const f = ctx.flow;
    const k = Math.max(0.25, Math.min(3, dt * 60)); // elapsed time in 60 Hz frames
    f.fillStyle = rgba(COLOR.forest, 1 - Math.pow(1 - 0.08, k)); // trails fade at a fixed rate per second
    f.fillRect(0, 0, w, h);
    const U = trail.unit;
    f.lineWidth = 1.28; // fine texture: a fixed pixel size at any screen size (motion still scales)
    for (const p of particles) {
      const [gx, gy] = terrain.grad(p.x, p.y);
      const gl = Math.hypot(gx, gy) || 1;
      let vx = ((gy / gl) * 1.25 - (gx / gl) * 0.3) * U;
      let vy = ((-gx / gl) * 1.25 - (gy / gl) * 0.3) * U;
      if (pointer.active) {
        const dx = p.x - pointer.x, dy = p.y - pointer.y, d = Math.hypot(dx, dy);
        if (d < 190 * U) { const k = (1 - d / (190 * U)) * 2.6 * U; vx += (-dy / (d + 1)) * k; vy += (dx / (d + 1)) * k; }
      }
      if (!rider.done) {
        const rd = Math.hypot(p.x - rider.x, p.y - rider.y);
        if (rd < 90 * U) { const k = (1 - rd / (90 * U)) * 2.2 * U; vx += rider.hx * k; vy += rider.hy * k; }
      }
      f.strokeStyle = p.oxide ? rgba(COLOR.oxide, 0.46) : rgba(COLOR.moss, 0.42);
      vx *= k; vy *= k;
      f.beginPath(); f.moveTo(p.x, p.y); f.lineTo(p.x + vx, p.y + vy); f.stroke();
      p.x += vx; p.y += vy;
      if ((p.life -= k) < 0 || p.x < -5 || p.x > w + 5 || p.y < -5 || p.y > h + 5) spawn(p);
    }
  };

  const drawRun = (fade) => {
    const c = ctx.run, U = trail.unit;
    c.clearRect(0, 0, w, h);
    c.save();
    c.globalAlpha = fade;
    c.lineCap = "round"; c.lineJoin = "round";
    let ph = null;
    if (phantom) { // dashed replay of your best run
      ph = replayAt(phantom, rider.t);
      c.setLineDash([2 * U, 7 * U]); c.lineWidth = 2 * U; c.strokeStyle = rgba(COLOR.sand, 0.8);
      strokePath(c, phantom.pts, ph.i, ph); c.stroke();
      c.setLineDash([]);
    }
    c.lineWidth = 3 * U; c.strokeStyle = COLOR.oxide;
    c.shadowColor = rgba(COLOR.oxide, 0.5); c.shadowBlur = 10 * U;
    strokePath(c, rider.pts, rider.pts.length - 1, rider); c.stroke();
    c.shadowBlur = 0;
    if (ph) dot(c, ph, COLOR.sand, rgba(COLOR.sand, 0.14));
    dot(c, rider, COLOR.sandLight, rgba(COLOR.oxide, 0.35));
    c.beginPath(); c.arc(trail.start.x, trail.start.y, 3.2 * U, 0, Math.PI * 2); c.fillStyle = COLOR.oxide; c.fill();
    if (result) {
      c.font = `600 ${Math.round(11 * U)}px 'IBM Plex Mono', ui-monospace, monospace`;
      c.textAlign = narrow ? "left" : "right";
      const ox = (narrow ? 14 : -16) * U;
      c.fillStyle = result.newBest ? COLOR.moss : COLOR.sand;
      c.fillText(result.newBest ? "NEW PHANTOM" : "PHANTOM HOLDS", result.x + ox, result.y - 4 * U);
      c.fillStyle = result.delta <= 0 ? COLOR.moss : COLOR.loss;
      c.fillText(formatDelta(result.delta), result.x + ox, result.y + 12 * U);
    }
    c.restore();
  };

  let lastHud = 0;
  const updateHud = (now) => {
    if (now - lastHud < 120) return;
    lastHud = now;
    const p = Math.min(0.999, trail.progressAt(rider.ri));
    const delta = phantom ? rider.t - timeAtProgress(phantom, p) : 0; // + means behind the phantom
    if (hud.sector) hud.sector.textContent = `S${1 + Math.floor(p * 4)}`;
    if (hud.speed) hud.speed.textContent = `${(16 + (rider.v / race.BASE) * 18).toFixed(1)} km/h`;
    if (hud.delta) {
      hud.delta.textContent = formatDelta(delta);
      hud.delta.classList.toggle("ahead", delta < 0);
      hud.delta.classList.toggle("behind", delta >= 0);
    }
  };

  // ── Loop ──
  let last = performance.now(), lag = 0, hold = 0, raf = 0;
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!rider.done) {
      lag += dt;
      while (lag >= STEP && !rider.done) { race.step(rider, STEP, pointer.active ? pointer : null); lag -= STEP; }
    } else if (!result) {
      const newBest = !best || rider.t < best.t;
      result = { x: rider.x, y: rider.y, newBest, delta: phantom ? rider.t - phantom.t : 0 };
      if (newBest) best = rider;
      hold = HOLD;
    } else if ((hold -= dt) <= 0) {
      startRun();
    }
    const fade = rider.done ? Math.max(0, Math.min(1, hold / 0.5)) : Math.min(1, rider.t / 0.4);
    drawFlow(dt);
    drawRun(fade);
    updateHud(now);
    if (!REDUCED_MOTION) raf = requestAnimationFrame(frame);
  };

  // ── Input and lifecycle ──
  hero.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return; // touch scrolls the page instead
    const r = hero.getBoundingClientRect();
    pointer.x = e.clientX - r.left; pointer.y = e.clientY - r.top; pointer.active = true;
  });
  hero.addEventListener("pointerleave", () => { pointer.active = false; });

  resize();
  setTimeout(() => { if (narrow) build(); }, REVEAL_SETTLE_MS);
  let resizeTimer = 0, lastWidth = w;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const width = hero.getBoundingClientRect().width;
      // phones fire resize as the URL bar shows/hides; only rebuild for real width changes there
      if (!narrow || Math.abs(width - lastWidth) > 2) { lastWidth = width; resize(); }
    }, 150);
  });

  if (/[?&]debug\b/.test(location.search)) { // tuning hook
    window.__pf = { PHYS, SEED, pointer, get race() { return race; }, get trail() { return trail; }, get terrain() { return terrain; } };
  }

  if (REDUCED_MOTION) { // a single still frame, mid-run
    for (let i = 0; i < 800 && !rider.done; i++) race.step(rider, STEP, null);
    frame(performance.now());
    return;
  }
  raf = requestAnimationFrame(frame);
  whenVisible(hero,
    () => { cancelAnimationFrame(raf); last = performance.now(); raf = requestAnimationFrame(frame); },
    () => cancelAnimationFrame(raf));
}
