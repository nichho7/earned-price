// [CTO] T-033 · authored SVG icons (no icon font, no emoji). Paths from the /lab (T-053).
export const Mark = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 20 20" aria-hidden="true">
    <path d="M4.5 2h11v16l-1.8-1.3-1.9 1.3-1.8-1.3-1.8 1.3-1.9-1.3-1.8 1.3z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M7.3 9.4l1.9 1.9 3.6-3.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);
export const Check = ({ className, bold }: { className?: string; bold?: boolean }) => (
  <svg className={className} viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth={bold ? 2.4 : 1.8} /></svg>
);
export const Cross = ({ className, bold }: { className?: string; bold?: boolean }) => (
  <svg className={className} viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth={bold ? 2.4 : 1.8} /></svg>
);
export const Dash = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
);
export const Seal = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
    <path d="M5 7V5.2a3 3 0 0 1 6 0V7" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <rect x="3.5" y="7" width="9" height="6.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);
export const Lock = ({ className, shackleClassName, open }: { className?: string; shackleClassName?: string; open: boolean }) => (
  <svg className={className} viewBox="0 0 20 20" aria-hidden="true" data-open={open ? "" : undefined}>
    <path className={shackleClassName} d="M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <rect x="4.5" y="9" width="11" height="8" rx="1" fill="currentColor" />
  </svg>
);

/** One postal-cancel wave line across a 1000-wide box (lab wavePath). */
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
