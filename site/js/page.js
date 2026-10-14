// Page chrome shared by every page: header state and scroll reveals.
import { REDUCED_MOTION } from "./util.js";

document.documentElement.classList.add("js");

// Header gains a background once the page has scrolled.
const header = document.querySelector("[data-header]");
if (header) {
  const onScroll = () => header.classList.toggle("is-scrolled", window.scrollY > 24);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
}

// Reveal on scroll, staggered within each parent.
const reveals = [...document.querySelectorAll(".reveal")];
const order = new Map();
for (const el of reveals) {
  const i = order.get(el.parentElement) || 0;
  el.style.setProperty("--d", `${Math.min(i, 6) * 0.08}s`);
  order.set(el.parentElement, i + 1);
}
if ("IntersectionObserver" in window && !REDUCED_MOTION) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add("is-visible"); io.unobserve(e.target); }
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
  reveals.forEach((el) => io.observe(el));
} else {
  reveals.forEach((el) => el.classList.add("is-visible"));
}
