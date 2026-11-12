// [CTO] T-033 · authored SVG icons (no icon font, no emoji). Paths from the /lab (T-053).
export const Mark = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 20 20" aria-hidden="true">
    <path d="M4.5 2h11v16l-1.8-1.3-1.9 1.3-1.8-1.3-1.8 1.3-1.9-1.3-1.8 1.3z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M7.3 9.4l1.9 1.9 3.6-3.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);
export function wavePath(y: number, amp: number, x0 = -40, x1 = 1040): string {
  let d = `M${x0} ${y} q 35 ${-amp} 70 0`;
  for (let x = x0 + 70; x < x1; x += 70) d += " t 70 0";
  return d;
}
export const Waves = ({ className, n, y0, gap, amp, viewH }: { className?: string; n: number; y0: number; gap: number; amp: number; viewH: number }) => (
  <svg className={className} viewBox={`0 0 1000 ${viewH}`} preserveAspectRatio="none" aria-hidden="true">
    {Array.from({ length: n }, (_, i) => <path key={i} d={wavePath(y0 + i * gap, amp)} />)}
  </svg>
);
