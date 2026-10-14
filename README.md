# PhantomFlow.uk

Public website for **PhantomFlow** by KismoTech. It's a static site with no build step, deployed to
GitHub Pages by the Actions workflow.

```text
site/                    ← everything published (and nothing else)
├── index.html           landing page
├── flow.html            "Find your flow" interactive setup simulator
├── styles.css           shared styles (dark theme)
├── main.js              hero telemetry animation, header, scroll reveals
├── interactive.js       simulator, flow field, phantom cursor
├── favicon.svg
└── 404.html             self-contained (works at any path depth)
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

- Dark-only, system fonts, no third-party scripts, fonts or trackers, so no cookie banner is needed.
- All motion respects `prefers-reduced-motion`. Canvases pause when off-screen.
- The phantom cursor only runs on devices with a fine pointer that can hover.

## Go-live checklist

- [ ] Set Pages source to **GitHub Actions** (see above).
- [ ] Register `phantomflow.uk` / `phantomflow.co.uk`.
- [ ] Add `site/CNAME` containing `phantomflow.uk`, set the DNS records, and tick *Enforce HTTPS*.
- [ ] Replace the contact placeholder in `site/index.html` (search for `CONTACT:`) with a mailbox or form link.
- [ ] Add `og:image` and `og:url` once the domain is live.
- [ ] Consider self-hosting a display typeface (e.g. Inter) for a consistent look across platforms.
