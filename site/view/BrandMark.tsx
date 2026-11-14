// [CTO] T-103 · the Earned Price logo mark (concept A "Face Value", A-033), paths from the Designer's final set
// (deliverables/product-designer/logo/final/mark.svg + mark-reverse.svg, T-101). One inline SVG, server-rendered: no
// request, no client JS, and nothing the /live or /verify CSP has to allow. Its two colourways are not two files: the
// stamp and ink colours come from --mark-stamp / --mark-ink (app/tokens.css), so the mark follows the ground it sits
// on (the home header changes ground on scroll). Violet / night ground = cream stamp, violet ink (mark-reverse);
// cream / paper / lilac = violet stamp, canary ink (mark). Decorative here: the link around it carries the name.
// Skills used: frontend-ui-engineering, karpathy-guidelines
import s from "./brand-mark.module.css";

/** The perforated stamp outline (48 grid). */
const STAMP = "M6 3H7.1 A1.9 1.9 0 0 0 10.9 3H13.1 A1.9 1.9 0 0 0 16.9 3H19.1 A1.9 1.9 0 0 0 22.9 3H25.1 A1.9 1.9 0 0 0 28.9 3H31.1 A1.9 1.9 0 0 0 34.9 3H37.1 A1.9 1.9 0 0 0 40.9 3H42V4.1 A1.9 1.9 0 0 0 42 7.9V10.1 A1.9 1.9 0 0 0 42 13.9V16.1 A1.9 1.9 0 0 0 42 19.9V22.1 A1.9 1.9 0 0 0 42 25.9V28.1 A1.9 1.9 0 0 0 42 31.9V34.1 A1.9 1.9 0 0 0 42 37.9V40.1 A1.9 1.9 0 0 0 42 43.9V45H40.9 A1.9 1.9 0 0 0 37.1 45H34.9 A1.9 1.9 0 0 0 31.1 45H28.9 A1.9 1.9 0 0 0 25.1 45H22.9 A1.9 1.9 0 0 0 19.1 45H16.9 A1.9 1.9 0 0 0 13.1 45H10.9 A1.9 1.9 0 0 0 7.1 45H6V43.9 A1.9 1.9 0 0 0 6 40.1V37.9 A1.9 1.9 0 0 0 6 34.1V31.9 A1.9 1.9 0 0 0 6 28.1V25.9 A1.9 1.9 0 0 0 6 22.1V19.9 A1.9 1.9 0 0 0 6 16.1V13.9 A1.9 1.9 0 0 0 6 10.1V7.9 A1.9 1.9 0 0 0 6 4.1Z";
/** Two postal cancel waves across the top, then the one price step (old price, new price). */
const WAVES = "M12 11 q2 -2.6 4 0 t4 0 t4 0 t4 0 t4 0 t4 0M12 16.6 q2 -2.6 4 0 t4 0 t4 0 t4 0 t4 0 t4 0";
const STEP = "M12 38H24V25H36";

export const BrandMark = ({ className }: { className?: string }) => (
  <svg className={`${s.mark} ${className ?? ""}`} viewBox="0 0 48 48" aria-hidden="true" focusable="false" data-brand-mark="">
    <path className={s.stamp} d={STAMP} />
    <path className={s.ink} d={WAVES} strokeWidth="2.2" strokeLinecap="round" />
    <path className={s.ink} d={STEP} strokeWidth="4.6" strokeLinejoin="miter" />
  </svg>
);
