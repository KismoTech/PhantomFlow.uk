// Shared helpers for PhantomFlow.uk. ES module, no dependencies.

export const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Brand palette (Contour). Mirrors the CSS custom properties in styles.css. */
export const COLOR = {
  forest: "#15241D",
  sand: "#E9E2D2",
  sandLight: "#F3EEE3",
  oxide: "#E2602C",
  moss: "#A9C79C",
  loss: "#FF7A70",
};

/** `rgba()` string from a #RRGGBB colour and an alpha. */
export const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Small, fast, seedable PRNG (mulberry32). Returns a function yielding [0, 1). */
export const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Size a canvas's backing store for the device pixel ratio (capped at 2×) and scale its context. */
export const fitCanvas = (canvas, ctx, width, height) => {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
};

/** Signed time for display: "−0.12 s" / "+0.40 s" (true minus sign). */
export const formatDelta = (s) => `${s < 0 ? "−" : "+"}${Math.abs(s).toFixed(2)} s`;

/** Run `onShow` / `onHide` as an element enters / leaves the viewport. */
export const whenVisible = (el, onShow, onHide = () => {}, options) => {
  if (!("IntersectionObserver" in window)) { onShow(); return; }
  new IntersectionObserver(([e]) => (e.isIntersecting ? onShow() : onHide()), options).observe(el);
};
