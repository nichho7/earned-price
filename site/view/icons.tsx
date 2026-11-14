// [CTO] T-033 · authored SVG icons (no icon font, no emoji). Paths from the /lab (T-053).
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
