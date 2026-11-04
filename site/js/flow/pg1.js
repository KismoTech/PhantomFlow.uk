// Page script for site/dev/ride-pg1.html: starts the physics worker, feeds the view, wires the controls and readouts.
import { RideView } from "./view.js";
import { OBS, GUARD_NAMES } from "./engine.js";

const $ = (id) => document.getElementById(id);
const MODULE_URL = new URL("../../dev/wasm/phantomflow_engine.mjs", import.meta.url).href;

const view = new RideView($("view"));
const logEl = $("log");
const state = { last: null, restartTimer: 0, loaded: false, paused: false, input: { drive: 0, frontBrake: 0, rearBrake: 0 }, readoutAt: 0 };
// For automated checks from the browser tools.
window.__pg1 = state;
state.view = view;

const log = (text, cls = "") => {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `${(performance.now() / 1000).toFixed(1).padStart(6)}  ${text}`;
  logEl.append(line);
  logEl.scrollTop = logEl.scrollHeight;
};

const config = () => ({
  profileMode: $("profile").value,
  suspension: Number($("suspension").value),
  tyre: Number($("tyre").value),
  forkRate: Number($("forkRate").value),
  shockRate: Number($("shockRate").value),
  damping: Number($("damping").value),
  speed: 3,
});

function showSliders() {
  $("forkRateOut").textContent = `${$("forkRate").value} N/m`;
  $("shockRateOut").textContent = `${$("shockRate").value} N/m`;
  $("dampingOut").textContent = `x ${Number($("damping").value).toFixed(2)}`;
}

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
worker.onerror = (event) => log(`worker error: ${event.message}`, "bad");
worker.onmessage = (event) => {
  const m = event.data;
  switch (m.type) {
    case "loaded":
      state.loaded = true;
      log("engine module loaded");
      start();
      break;
    case "started":
      state.info = m.info;
      state.profile = m.profile;
      view.reset(m.info);
      view.setTerrain(m.window);
      $("o-profile").textContent = `${m.profile} (${m.nodes} nodes, step ${(m.dt * 1e6).toFixed(2)} us)`;
      break;
    case "terrain": view.appendTerrain(m.points); break;
    case "drop": view.dropTerrain(m.x); break;
    case "terrain-reset": view.setTerrain(m.points); view.frames = []; break;
    case "frame": onFrame(m); break;
    case "log": log(m.message); break;
    case "error": log(m.message, "bad"); break;
    case "verify": log(`verify replay: ${m.ok ? "digests equal" : "DIGESTS DIFFER"}`, m.ok ? "ok" : "bad"); state.verify = m; break;
    case "reference": showReference(m.results); break;
    default: break;
  }
};

async function boot() {
  try {
    const head = await fetch(MODULE_URL, { method: "HEAD" });
    if (!head.ok) throw new Error(String(head.status));
  } catch (error) {
    log("The engine module is not built here. Build it and copy it to site/dev/wasm/ (see site/dev/README.md).", "bad");
    return;
  }
  worker.postMessage({ type: "init", moduleUrl: MODULE_URL });
}

function onFrame(m) {
  state.last = { ...m, obs: Array.from(m.obs) };
  view.push({ obs: m.obs, casings: m.casings, simTime: m.obs[OBS.time], ground: m.ground });
  const now = performance.now();
  if (now - state.readoutAt < 100) return;
  state.readoutAt = now;
  const slot = Math.floor(m.obs[OBS.time] / 10);
  if (slot !== state.groundSlot) {
    state.groundSlot = slot;
    const gc = view.groundCheck;
    if (gc.n > 0) {
      const good = gc.maxDrawn < 0.002;
      log(`ground check: drawn ground vs the engine's ground under the contacts, worst ${(gc.maxDrawn * 1000).toFixed(2)} mm; contact vs ground, worst ${(gc.maxContact * 1000).toFixed(1)} mm (${gc.n} samples)`, good ? "ok" : "bad");
    }
    const lc = view.linkCheck;
    if (lc.n > 0) {
      const good = lc.maxShock < 1e-6 && lc.maxRigid < 1e-6 && lc.maxAxle < 1e-6;
      log(`linkage check: drawn shock length vs rest minus travel, worst ${(lc.maxShock * 1e6).toFixed(2)} um; swingarm rigid, worst ${(lc.maxRigid * 1e6).toFixed(2)} um; axle vs engine hub, worst ${(lc.maxAxle * 1e6).toFixed(2)} um (${lc.n} samples)`, good ? "ok" : "bad");
    }
  }
  $("o-time").textContent = `${m.obs[OBS.time].toFixed(2)} s`;
  $("o-tick").textContent = String(m.tick);
  $("o-digest").textContent = m.digest;
  const ms = (v) => `${(v * 1000).toFixed(0)} ms/s`;
  $("o-cost").textContent = `${ms(m.costStep)} (budget ${ms(m.budget)})`;
  $("o-busy").textContent = ms(m.costBusy);
  $("o-busy").className = m.costBusy > m.budget ? "bad" : "ok";
  $("o-ratio").textContent = m.ratio.toFixed(3);
  $("o-terrain").textContent = `${m.terrainBuilds} (${m.terrainMs.toFixed(1)} ms total)`;
  $("o-guard").textContent = m.guard ? `${GUARD_NAMES[m.guard]}: ${m.guardReason}` : "none";
  $("o-guard").className = m.guard ? "bad" : "";
  $("pause").textContent = m.paused ? "Resume" : "Pause";
}

function showReference(results) {
  const dl = $("ref");
  dl.replaceChildren();
  for (const r of results) {
    const dt = document.createElement("dt");
    dt.textContent = r.profile;
    const dd = document.createElement("dd");
    dd.textContent = `${r.digest} vs native ${r.expected}: ${r.match ? "EQUAL" : "DIFFERENT"}`;
    dd.className = r.match ? "ok" : "bad";
    dl.append(dt, dd);
  }
  state.reference = results;
}

function start() {
  worker.postMessage({ type: "start", config: config() });
}

function scheduleRestart() {
  showSliders();
  clearTimeout(state.restartTimer);
  state.restartTimer = setTimeout(() => { if (state.loaded) start(); }, 250);
}

for (const id of ["profile", "suspension", "tyre", "forkRate", "shockRate", "damping"]) $(id).addEventListener("input", scheduleRestart);
$("restart").addEventListener("click", start);
$("pause").addEventListener("click", () => { state.paused = !state.paused; worker.postMessage({ type: "pause", paused: state.paused }); });
$("rewind").addEventListener("click", () => worker.postMessage({ type: "rewind", seconds: 3 }));
$("verify").addEventListener("click", () => worker.postMessage({ type: "verify" }));
$("reference").addEventListener("click", () => { log("running the reference ride (about a second)..."); worker.postMessage({ type: "reference" }); });

const keys = { d: "drive", ArrowRight: "drive", f: "frontBrake", r: "rearBrake", ArrowDown: "rearBrake" };
const torque = { drive: 40, frontBrake: 60, rearBrake: 80 };
function key(event, down) {
  const which = keys[event.key.length === 1 ? event.key.toLowerCase() : event.key];
  if (!which) return;
  event.preventDefault();
  state.input[which] = down ? torque[which] : 0;
  worker.postMessage({ type: "input", ...state.input });
}
window.addEventListener("keydown", (e) => { if (!e.repeat) key(e, true); });
window.addEventListener("keyup", (e) => key(e, false));

function frame(now) {
  view.draw(now, { banner: state.last?.ended ? `Ride ended: ${state.last.guardReason || "guard"}. Rewind or restart.` : "" });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
showSliders();
boot();
