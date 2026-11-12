// [CTO] T-039 · the verify panel's three marks (authored SVG, currentColor, no icon font). State is never
// colour only: every mark sits next to a word (PASS / FAIL / not run).
export const Tick = () => (
  <svg viewBox="0 0 14 14" aria-hidden="true">
    <path d="M2.5 7.4l2.9 2.9 6-6.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
  </svg>
);
export const Cross = () => (
  <svg viewBox="0 0 14 14" aria-hidden="true">
    <path d="M3 3l8 8M11 3l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
  </svg>
);
export const Dash = () => (
  <svg viewBox="0 0 14 14" aria-hidden="true">
    <path d="M3.5 7h7" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);
