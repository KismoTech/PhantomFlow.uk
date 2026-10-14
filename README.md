# PhantomFlow.uk

Public website for **PhantomFlow** by KismoTech. It's a static site with no build step, deployed to
GitHub Pages by the Actions workflow.

```text
site/                         everything published (and nothing else)
├── index.html                landing page
├── flow.html                 "Find your flow" setup simulator
├── 404.html                  self-contained (works at any path depth)
├── styles.css                Contour brand tokens; light sand + .dark forest themes
├── favicon.svg               brand mark (source: design repo docs/brand/assets/mark.svg)
├── fonts/                    self-hosted Archivo + IBM Plex Mono (woff2, SIL OFL; licences included)
└── js/                       native ES modules, no build step
    ├── util.js               palette, PRNG, canvas sizing, formatting, visibility helper
    ├── page.js               header state and scroll reveals (every page)
    ├── simulator.js          flow.html simulator
    └── hero/                 index.html hero: one terrain, seen from above
        ├── trail.js          seeded meandering trail and queries along it
        ├── terrain.js        height grid built around the trail; contours and map drawing
        ├── race.js           rider physics, line choice, pointer steering, phantom replay
        └── scene.js          layout, canvases, particle flow, render loop, HUD, input
.github/workflows/pages.yml   deploys site/ on push to main
```

## Preview locally

```bash
python -m http.server 8000 -d site
```

Then open <http://localhost:8000>.

## Deploy

Every push to `main` that touches `site/` triggers **Deploy site to GitHub Pages**. You can also run it
manually from the Actions tab.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Content rules

This repo is **public**. Content describes **benefits only**. Do not mention:

- the sensing technology (radar, frequencies, reflectors / targets),
- part numbers or vendors,
- anything from the private design repo.

The core approach may be patentable, and public disclosure before filing can destroy novelty.
The simulator is a generic spring-damper model, so it reveals nothing about how PhantomFlow measures.

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
