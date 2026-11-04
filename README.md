# PhantomFlow.uk

Public website for **PhantomFlow** by KismoTech. It's a static site with no build step, deployed to
GitHub Pages by the Actions workflow.

```text
site/                         everything published (and nothing else)
├── index.html                landing page
├── flow.html                 "Find your flow": a simplified ride on the engine release below
├── 404.html                  self-contained (works at any path depth)
├── styles.css                Contour brand tokens; light sand + .dark forest themes
├── favicon.svg               brand mark (source: design repo docs/brand/assets/mark.svg)
├── fonts/                    self-hosted Archivo + IBM Plex Mono (woff2, SIL OFL; licences included)
└── js/                       native ES modules, no build step
    ├── util.js               palette, PRNG, canvas sizing, formatting, visibility helper
    ├── page.js               header state and scroll reveals (every page)
    ├── flow-ride.js          flow.html: the ride page (worker, view, phantom, splits, setup controls)
    ├── flow/engine/          the VENDORED engine release: module, client, manifest, licence (see "The engine release")
    └── hero/                 index.html hero: one terrain, seen from above
        ├── trail.js          seeded meandering trail and queries along it
        ├── terrain.js        height grid built around the trail; contours and map drawing
        ├── race.js           rider physics, line choice, pointer steering, phantom replay
        └── scene.js          layout, canvases, particle flow, render loop, HUD, input
.github/workflows/pages.yml   deploys site/ on push to main
```

## The engine release (flow.html)

`flow.html` runs a real physics model of a generic trail bike in a web worker. The model is a compiled WebAssembly build of
KismoTech's engine. It is **vendored**: `site/js/flow/engine/` holds the release, and it arrives only through the engine's
release script (`publish.py` in the engine repository, run on a local machine). **Never edit
those files by hand**: the manifest's hashes and the Pages workflow's verify step would reject the change.

```text
site/js/flow/engine/
├── phantomflow_engine.mjs/.wasm   the stripped module (no debug info, names or host paths; ~440 KB)
├── engine.js worker.js view.js    the client: module wrapper, physics worker (clock, section timing, phantom), side-on view
│   reference.js session.js
├── manifest.json                  engine version, flow API layout, reference-ride digests, file sizes and SHA-256, licence
├── verify.mjs                     the check the Pages workflow runs (plain Node): hashes, then the reference ride
└── LICENSE.txt                    compiled build, all rights reserved (not the site's open fonts' licence)
```

- **Updating the engine:** `publish.py` builds, proves (Node gate, native digests), copies, writes the manifest, runs the
  private-names guard and leaves the change staged or committed on a local branch. Review it, then push. It refuses to run if
  this folder has uncommitted changes.
- **The Pages workflow** runs `node site/js/flow/engine/verify.mjs` before it uploads: sizes and SHA-256 must match the
  manifest, no unlisted file may sit in the folder, and the reference ride must reproduce the manifest's digests. A mismatch
  fails the deploy.
- **The site's own code** for the page is `js/flow-ride.js` and `flow.html`. It only uses the client's public pieces
  (`RideView`, the worker messages, `BestRun`).
- **The phantom** is the best finished run, kept in this browser's local storage (nothing is sent anywhere) as its setup and
  input log, and replayed exactly in a second bike. It is tied to the engine version that recorded it.
- **Profile:** the page runs the Ambient profile (the section is qualified on it). The ride degrades honestly: if WebAssembly,
  web workers or module workers are missing, it says so and the rest of the site works unchanged.
- The full Ride page (every control, the run report, the proving loop, a replay check) is the engine repository's
  demonstrator; this page is a simplified version of it.

## Preview locally

```bash
python -m http.server 8000 -d site
```

Then open <http://localhost:8000>.

## Deploy

Every push to `main` that touches `site/` triggers **Deploy site to GitHub Pages**. You can also run it
manually from the Actions tab.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Content governance

Every factual or product claim on the site is registered in the private design repo's
**public claims register** (`docs/website/claims.yml`, ADR 0005), which maps it to the design
documents it rests on. Claim-bearing elements carry `data-claim="C-NNN"`:

```html
<li class="reveal" data-claim="C-008"><strong>Unaffected by mud</strong>…</li>
```

- **New or changed claim?** Add or update its register entry (design repo) and tag the element.
- **Removing a claim?** Remove the tag and retire or update the register entry.
- The design repo's *Website sync* workflow cross-checks these tags weekly and whenever design
  docs change, and opens a `site-sync` issue when a claim's sources change.

## Content rules

This repo is **public**. Content describes **benefits only**. Do not mention:

- the sensing technology (radar, frequencies, reflectors / targets),
- part numbers or vendors,
- anything from the private design repo.

The core approach may be patentable, and public disclosure before filing can destroy novelty.
The ride is a physics model of a generic trail bike (suspension, tyres, rigid ground), so it reveals nothing about how
PhantomFlow measures, and the engine files carry no names of private repositories (the guard below checks).

## Design notes

- Brand: **Contour** (forest, sand, oxide; Archivo Expanded + IBM Plex Mono). The spec lives in the
  private design repo (`docs/brand/README.md`). The site copies assets from there.
- Sections default to sand. Add `.dark` for forest; components re-theme via CSS variables.
- No third-party scripts, fonts or trackers (fonts are self-hosted), so no cookie banner is needed.
- All motion respects `prefers-reduced-motion`. Canvases pause when off-screen.
- Hero URL options: `?seed=N` pins a trail; `?debug` exposes `window.__pf` (race, trail,
  terrain, physics constants) for tuning.

## Go-live checklist

- [x] Set Pages source to **GitHub Actions** (see above).
- [ ] Register `phantomflow.uk` / `phantomflow.co.uk`.
- [ ] Add `site/CNAME` containing `phantomflow.uk`, set the DNS records, and tick *Enforce HTTPS*.
- [ ] Replace the contact placeholder in `site/index.html` (search for `CONTACT:`) with a mailbox or form link.
- [ ] Add `og:image` and `og:url` once the domain is live.

## Local push guard

`.githooks/pre-push` refuses a push that names a private repository. Activate it once per clone with
`git config core.hooksPath .githooks`. It needs the family's `tools/ci/private_names.py` (a sibling clone of
`CraigHutchinson/.github`, or `KISMO_CI_DIR`) and a local, untracked list of names; without them it warns and lets the push through.
