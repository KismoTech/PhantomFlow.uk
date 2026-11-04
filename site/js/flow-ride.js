// "Find your flow": a simplified ride for flow.html. The PhantomFlow engine's bike (a vendored, versioned release in
// js/flow/engine/) rides one fixed trail section in a worker; the page draws it side-on, times it in sectors, and races the
// phantom: the best finished run so far, replayed exactly from its recorded inputs in a second bike.
//
// - No build step. The page needs WebAssembly, module workers and canvas; without them it says so and does nothing else.
// - The profile is Ambient. The section is the engine's proving loop's first part (roll-in, rollers, rough, step-up and jump),
//   and the engine's Interactive profile does not yet finish that course (a known numerics item upstream), so the page does not
//   pick it. The worker still measures its own cost; if this device cannot keep up, the page says so (times stay exact either way).
// - The auto rider is on: a simple scripted rider (js/flow/engine/rider_mvp.js) that soaks up the jump's lip and levels the
//   bike in the air with the pedals and the rear brake. It acts only through the bike, within force and power limits, and its
//   actions are part of the recorded inputs, so the phantom replays them exactly. The page draws a figure for it, on the bike's saddle,
//   pedals and grips, moved by the rider slide.
// - Nothing leaves the browser. The best run is kept in this browser's local storage only (js/flow/engine/session.js).
import { RideView, simpleRider } from "./flow/engine/view.js";
import { OBS, STOP_KIND_NAMES } from "./flow/engine/engine.js";
import { BestRun } from "./flow/engine/session.js";
import { formatDelta } from "./util.js";

const ENGINE_DIR = new URL("./flow/engine/", import.meta.url);
const BASE = { forkRate: 9000, shockRate: 70000 };           // the engine's default springs [N/m]; the firmness slider scales both
const TORQUE = { drive: 40, frontBrake: 60, rearBrake: 80 };   // N m while a control is held
const KEYS = { d: "drive", r: "rearBrake", f: "frontBrake" };
const SECTOR_NAMES = { "lead-in": "Roll-in", rollers: "Rollers", rough: "Rough", "step-up": "Step-up", jump: "Jump" };
const RIDER_PHASES = { idle: "riding", ready: "setting up for the jump", absorb: "soaking up the lip", air: "levelling in the air" };
const CLOSE = 0.04;                                           // s: within this of the phantom counts as locked on

// What a stop gate means in a rider's words. The engine names the gate; the sentence is the page's.
const ENDINGS = {
  "loop-out": ["Looped out", "The bike pitched over past the point of no return."],
  "rim-strike": ["Rim strike", "A rim met the ground through the tyre: a hit this hard is beyond what the tyre model carries."],
  "fork-travel-limit": ["Fork broke", "The fork was driven through its end stop."],
  "shock-travel-limit": ["Shock broke", "The shock was driven through its end stop."],
  "casing-break": ["Tyre failed", "The tyre casing was strained past its limit."],
  "frame-ground": ["Frame on the ground", "The frame hit the ground."],
  "wheel-separation-limit": ["Wheels collided", "The wheels were driven together."],
  "world-exit": ["Off the course", "The bike left the ground the section provides."],
  "solver-fault": ["Model limit", "The solver could not continue from this state. That is a limit of the model, not a verdict on your setup."],
  "nonfinite-state": ["Model limit", "The solver could not continue from this state. That is a limit of the model, not a verdict on your setup."],
  "contact-lost": ["Model limit", "The tyre contact could not be resolved from this state. That is a limit of the model, not a verdict on your setup."],
};

function init(root) {
  const q = (selector) => root.querySelector(selector);
  const out = (name) => q(`[data-out="${name}"]`);
  const canvas = q("[data-ride-canvas]");
  const card = { box: q("[data-card]"), title: q("[data-card-title]"), text: q("[data-card-text]"), button: q("[data-restart]") };
  const splitsEl = q("[data-splits]");
  const fallback = q("[data-fallback]");
  const inputs = { firm: q('[data-in="firm"]'), damp: q('[data-in="damp"]') };
  const state = { frame: 0, input: { drive: 0, frontBrake: 0, rearBrake: 0 }, section: null, phantom: null, started: false, ended: false, readoutAt: 0,
    status: { phantom: "" }, engine: "", profile: "", visible: true, restartTimer: 0, slow: 0 };
  if (new URLSearchParams(location.search).has("debug")) window.__flowRide = state;

  const showCard = (title, text, { button = "", tone = "" } = {}) => {
    card.title.textContent = title;
    card.text.textContent = text;
    card.box.className = `ride-card${tone ? ` is-${tone}` : ""}`;
    card.box.hidden = false;
    card.button.hidden = !button;
    if (button) card.button.textContent = button;
  };
  const hideCard = () => { card.box.hidden = true; };

  const unsupported = (why) => {
    fallback.hidden = false;
    fallback.textContent = `${why} The ride runs a real physics model in a background worker, so it needs a current browser with WebAssembly and web workers (any recent Chrome, Edge, Firefox or Safari). The rest of the site works without it.`;
    card.box.hidden = true;
    root.classList.add("is-unsupported");
  };
  if (typeof WebAssembly !== "object" || typeof Worker !== "function" || !canvas.getContext) {
    unsupported("This browser can't run the ride.");
    return;
  }

  const view = new RideView(canvas);
  view.showHud = false;
  state.view = view;
  let best = null;
  let worker = null;

  const setFill = (el) => el.style.setProperty("--p", `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
  const showSliders = () => {
    for (const [key, el] of Object.entries(inputs)) {
      q(`[data-val="${key}"]`).textContent = `×${Number(el.value).toFixed(2)}`;
      setFill(el);
    }
  };
  const frameValue = () => Number(q("[data-frame][aria-pressed='true']").dataset.frame);

  const config = () => {
    const k = Number(inputs.firm.value);
    return {
      profileMode: "ambient", course: "section", suspension: frameValue(), tyre: 1, forkRate: BASE.forkRate * k, shockRate: BASE.shockRate * k,
      damping: Number(inputs.damp.value), speed: 3, governor: false, autoRider: true, phantom: best.get(),
    };
  };

  const start = () => {
    clearTimeout(state.restartTimer);
    worker.postMessage({ type: "start", config: config() });
  };
  const scheduleRestart = () => {
    showSliders();
    clearTimeout(state.restartTimer);
    state.restartTimer = setTimeout(() => { if (state.loaded) start(); }, 220);
  };

  // --- the worker ---
  const boot = async () => {
    let manifest;
    try {
      const response = await fetch(new URL("manifest.json", ENGINE_DIR));
      if (!response.ok) throw new Error(String(response.status));
      manifest = await response.json();
    } catch {
      unsupported("The engine files could not be loaded.");
      return;
    }
    state.engine = manifest.engine.version;
    best = new BestRun(state.engine);
    try {
      worker = new Worker(new URL("worker.js", ENGINE_DIR), { type: "module" });
    } catch {
      unsupported("This browser can't start the ride's worker.");
      return;
    }
    worker.onerror = () => { if (!state.loaded) unsupported("The ride's worker could not start."); };
    worker.onmessage = onMessage;
    worker.postMessage({ type: "init", moduleUrl: new URL("phantomflow_engine.mjs", ENGINE_DIR).href });
  };

  function onMessage(event) {
    const m = event.data;
    switch (m.type) {
      case "loaded":
        state.loaded = true;
        start();
        break;
      case "started": onStarted(m); break;
      case "frame": onFrame(m); break;
      case "section-done": onFinished(m.result); break;
      case "phantom-check":
        state.status.phantom = m.ok
          ? `Phantom replayed exactly from its recorded inputs: digest ${m.digest} equals the recording.`
          : `Phantom replay DIFFERS from its recording (${m.digest}, recorded ${m.recorded}). Clearing it.`;
        if (!m.ok) best.clear();
        renderStatus();
        break;
      case "error": showCard("The ride stopped", m.message, { button: "Ride again", tone: "bad" }); break;
      case "terrain": view.appendTerrain(m.points); break;
      case "drop": view.dropTerrain(m.x); break;
      default: break;
    }
  }

  function onStarted(m) {
    state.section = m.section;
    state.phantom = best.get();
    state.started = true;
    state.ended = false;
    state.slow = 0;
    state.profile = m.profile;
    state.input = { drive: 0, frontBrake: 0, rearBrake: 0 };
    root.querySelectorAll("[data-hold]").forEach((b) => b.classList.remove("is-held"));
    state.status.phantom = state.phantom ? "Phantom replaying…" : "";
    view.reset(m.info);
    view.setTerrain(m.window);
    view.riderLayer = m.autoRider ? simpleRider : null;
    out("rider").textContent = m.autoRider ? "Auto rider: on" : "Auto rider: off";
    view.markers = [{ x: m.section.start, label: "start" }, ...m.section.sectors.map((s, i) => ({ x: s.end, label: i === m.section.sectors.length - 1 ? "finish" : SECTOR_NAMES[s.name] ?? s.name }))];
    out("delta").textContent = "—"; out("delta").className = "";
    out("speed").textContent = "—"; out("travel").textContent = "—"; out("bottoms").textContent = "—"; out("bottoms").className = "";
    out("verdict").textContent = " ";
    renderSplits(null);
    renderStatus();
    hideCard();
    applyVisibility();
  }

  function onFrame(m) {
    view.push({ obs: m.obs, casings: m.casings, simTime: m.obs[OBS.time], ground: m.ground, ghost: m.ghost });
    state.last = m;
    if (m.ratio < 0.85 && m.obs[OBS.time] > 3) state.slow++; else state.slow = 0;
    const now = performance.now();
    if (now - state.readoutAt >= 100 || (m.ended && !state.ended)) {
      state.readoutAt = now;
      renderReadouts(m);
      renderSplits(m.section);
      if (state.slow === 30) renderStatus();
    }
    if (m.ended && !m.completed && !state.ended) {
      state.ended = true;
      onCrash(m);
    }
  }

  // --- readouts ---
  function renderReadouts(m) {
    const sec = m.section;
    out("speed").textContent = `${(m.obs[OBS.speed] * 3.6).toFixed(1)} km/h`;
    if (m.rider) out("rider").title = `Auto rider: ${RIDER_PHASES[m.rider] ?? m.rider}`;
    if (!sec) return;
    const travel = Math.max(sec.forkMax, sec.shockMax);
    out("travel").textContent = sec.started ? `${Math.round(travel * 100)}%` : "—";
    out("bottoms").textContent = sec.started ? String(sec.bottomOuts) : "—";
    const ref = state.phantom;
    out("bottoms").className = ref && sec.bottomOuts > ref.bottomOuts ? "loss" : "";
    if (Number.isFinite(sec.delta) && !state.ended) {
      out("delta").textContent = formatDelta(sec.delta);
      out("delta").className = sec.delta <= CLOSE ? "gain" : "loss";
    }
  }

  function renderSplits(sec) {
    const sectors = state.section?.sectors;
    if (!sectors) { splitsEl.innerHTML = ""; return; }
    const ref = state.phantom;
    const rows = sectors.map((s, i) => ({ name: `S${i + 1} · ${SECTOR_NAMES[s.name] ?? s.name}`, time: sec?.splits?.[i], phantom: ref?.splits?.[i] }));
    rows.push({ name: "Total", time: sec?.finished ? sec.time : NaN, phantom: ref?.time });
    splitsEl.innerHTML = rows.map(({ name, time, phantom }) => {
      const done = Number.isFinite(time);
      const delta = done && Number.isFinite(phantom) ? time - phantom : NaN;
      const cls = Number.isFinite(delta) ? (delta <= 0.005 ? "gain" : "loss") : "";
      const hint = Number.isFinite(delta) ? formatDelta(delta, "") : Number.isFinite(phantom) ? `phantom ${phantom.toFixed(2)}` : "";
      return `<li><span>${name}</span><b>${done ? time.toFixed(2) : "—"}<i class="d ${cls}">${hint}</i></b></li>`;
    }).join("");
  }

  function renderStatus() {
    const parts = [`Engine ${state.engine}`, `${state.profile ? state.profile[0].toUpperCase() + state.profile.slice(1) : "Ambient"} profile`];
    if (state.status.phantom) parts.push(state.status.phantom);
    if (state.slow >= 30) parts.push("This device is running the ride slower than real time: it looks slower, the times stay exact.");
    out("status").textContent = parts.join(" · ");
  }

  // --- endings ---
  function onFinished(result) {
    state.ended = true;
    const before = state.phantom;
    const kept = best.offer(result);
    const total = result.time;
    let verdict;
    let tone = "good";
    if (!before) {
      verdict = "That's your phantom now. Change the setup and ride the same section again: it will replay beside you.";
    } else {
      const d = total - before.time;
      if (kept) verdict = `You beat your phantom by ${Math.abs(d).toFixed(2)} s. That run is the line to chase now.`;
      else if (d < CLOSE) verdict = `Locked on: ${formatDelta(d)} against your phantom.`;
      else {
        tone = "bad";
        const losses = result.splits.map((s, i) => [s - before.splits[i], i]).sort((a, b) => b[0] - a[0]);
        const [loss, at] = losses[0];
        const where = (SECTOR_NAMES[result.sectors[at].name] ?? result.sectors[at].name).toLowerCase();
        const travel = result.bottomOuts > before.bottomOuts
          ? ` You ran out of travel ${result.bottomOuts} time${result.bottomOuts === 1 ? "" : "s"} (phantom ${before.bottomOuts}).` : "";
        verdict = `${formatDelta(d)} behind your phantom. Biggest loss: the ${where} (${formatDelta(loss)}).${travel}`;
      }
    }
    out("verdict").textContent = verdict;
    if (before) {
      out("delta").textContent = formatDelta(total - before.time);
      out("delta").className = total - before.time <= CLOSE ? "gain" : "loss";
    }
    renderSplits({ splits: result.splits, finished: true, time: total });
    showCard(`Finished in ${total.toFixed(2)} s`, kept ? (before ? "A new best: it is now the phantom." : "Your first run is the phantom.") : "Your phantom keeps its time.",
      { button: "Ride again", tone: kept ? "good" : "" });
    if (kept) state.phantom = result;
  }

  function onCrash(m) {
    const r = m.report;
    const [title, why] = ENDINGS[r.stopName] ?? [r.stopName || "Run ended", "The model stopped the run."];
    const sector = state.section.sectors.find((s) => r.stopX >= s.start && r.stopX < s.end);
    const where = sector ? `in the ${(SECTOR_NAMES[sector.name] ?? sector.name).toLowerCase()}` : r.stopX < state.section.start ? "before the start line" : "past the finish";
    const kind = STOP_KIND_NAMES[r.stopKind];
    out("delta").textContent = "—";
    out("delta").className = "";
    out("verdict").textContent = `Run ended ${where}, ${r.stopTime.toFixed(1)} s in (${kind}). Change the setup, or ease off the pedal, and ride again.`;
    showCard(`${title}, ${where}`, `${why} An ended run doesn't count: your phantom is unchanged.`, { button: "Ride again", tone: "bad" });
  }

  // --- input ---
  const send = () => worker.postMessage({ type: "input", ...state.input });
  const setHeld = (which, down) => {
    const value = down ? TORQUE[which] : 0;
    if (state.input[which] === value) return;
    state.input[which] = value;
    root.querySelector(`[data-hold="${which}"]`)?.classList.toggle("is-held", down);
    send();
  };
  root.querySelectorAll("[data-hold]").forEach((button) => {
    const which = button.dataset.hold;
    button.addEventListener("pointerdown", (event) => { event.preventDefault(); button.setPointerCapture(event.pointerId); setHeld(which, true); });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) button.addEventListener(type, () => setHeld(which, false));
    button.addEventListener("keydown", (event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); if (!event.repeat) setHeld(which, true); } });
    button.addEventListener("keyup", (event) => { if (event.key === " " || event.key === "Enter") setHeld(which, false); });
    button.addEventListener("blur", () => setHeld(which, false));
  });
  const keyed = (event, down) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const which = KEYS[event.key.length === 1 ? event.key.toLowerCase() : ""];
    if (!which || !worker) return;
    if (down && event.repeat) return;
    setHeld(which, down);
  };
  window.addEventListener("keydown", (event) => keyed(event, true));
  window.addEventListener("keyup", (event) => keyed(event, false));

  // --- controls ---
  for (const el of Object.values(inputs)) el.addEventListener("input", scheduleRestart);
  root.querySelectorAll("[data-frame]").forEach((button) => button.addEventListener("click", () => {
    root.querySelectorAll("[data-frame]").forEach((b) => {
      const on = b === button;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    scheduleRestart();
  }));
  card.button.addEventListener("click", () => { if (state.loaded) start(); });

  // The ride pauses while the page is hidden or the panel is off screen; it is deterministic, so nothing is lost.
  const applyVisibility = () => worker?.postMessage({ type: "pause", paused: document.hidden || !state.visible });
  document.addEventListener("visibilitychange", applyVisibility);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([entry]) => { state.visible = entry.isIntersecting; applyVisibility(); }, { threshold: 0.05 }).observe(canvas);
  }

  const draw = (now) => {
    view.draw(now, { message: state.loaded ? "" : "Loading the physics engine…" });
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  showSliders();
  boot();
}

const root = document.querySelector("[data-ride]");
if (root) init(root);
