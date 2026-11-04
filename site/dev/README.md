# Development pages

Pages here are for developing the ride (proving ground, slice PG1). They are not linked from the site and carry
`noindex`. **The engine's WebAssembly build is a development preview and is never committed or published**: it lives in
`site/dev/wasm/`, which `.gitignore` excludes.

## Build the engine module and run the page

1. Build the module from the PhantomFlow engine source (a private checkout beside this one). The build needs the
   Emscripten SDK, which the script finds and enters for its own processes only:

   ```bash
   python <engine checkout>/bindings/wasm/build.py --copy-to site/dev/wasm
   ```

   This writes `phantomflow_engine.mjs` and `phantomflow_engine.wasm` into `site/dev/wasm/`.
2. Serve the site (the `.wasm` needs a real HTTP server, not `file://`):

   ```bash
   python -m http.server 8000 -d site
   ```

3. Open <http://localhost:8000/dev/ride-pg1.html>. Without the module the page says so and does nothing else.

## What the page does

- `js/flow/worker.js` runs the engine at its fixed 156.25 µs step, in batches of 107 steps (one 16.7 ms frame), and
  publishes a state per batch. `js/flow/view.js` draws the published states, interpolated at display rate.
- **Profile by measured cost.** `auto` times a calibration burst (1 s of riding after 0.25 s of warm-up) on the start's flat
  ground and picks Interactive if the worker's CPU time per simulated second is within the profile's declared budget (120 ms),
  else Ambient (60 ms). During the ride a rolling 2 s cost is checked once a second; three seconds in a row over budget
  restarts the ride on Ambient. Both choices, and the numbers, go to the log panel. A fixed profile skips both.
- **Digest.** The page shows the determinism digest of the live state. *Verify replay* replays the ride's event log (inputs,
  terrain appends and drops by tick) in a second bike and compares digests. *Run reference ride* rides the engine's fixed
  reference ride and compares its digests with the native build's (`js/flow/reference.js` holds the native values).
- **Speed governor.** Above 5 m/s (18 km/h) the worker cuts the drive and holds the brakes (20 and 40 N m). Ungoverned, the
  3% stand-in trail runs the bike up to about 7 m/s, where a landing passes the model's contact-overlap guard
  (`contact-penetration-limit`) and ends the ride. The event log records the input applied, governor included.
- **Rewind 3 s** restores a snapshot taken once a second (a guard ends a ride; this is the recovery).
- Cost numbers measure this device at this moment. They are not a verdict on it.

## Headless check

`node <engine checkout>/bindings/wasm/tests/node_gate.mjs` loads the same module through `js/flow/engine.js` and
`reference.js` under Node and compares with the native digests.
