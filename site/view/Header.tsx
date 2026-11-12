// [CTO] T-033 · header: wordmark, 5-step demo rail, honesty chips (build spec 3, row 1). No motion.
import { Mark } from "./icons.tsx";
import s from "./header.module.css";

const STEPS = ["1 Start", "2 Pick & haggle", "3 Hire", "4 Repeat buyer", "5 Verify"];

export function Header({ railStep, placeholder, sandbox }: { railStep: number; placeholder: boolean; sandbox: boolean }) {
  return (
    <header className={s.bar}>
      <Mark className={s.mark} />
      <span className={s.wordmark}>Earned Price</span>
      <ol className={s.rail} aria-label="Demo steps">
        {STEPS.map((t, i) => {
          const n = i + 1;
          const cls = n < railStep ? s.done : n === railStep ? s.on : undefined;
          return <li key={t} className={cls} aria-current={n === railStep ? "step" : undefined}>{t}</li>;
        })}
      </ol>
      <span className={s.chips}>
        {sandbox
          ? <span className={`${s.chip} ${s.sandbox}`}>CONTRACT TEST · LOCAL SANDBOX</span>
          : <span className={s.chip} data-chip="network">TESTNET · RECORDED</span>}
        {placeholder && (
          <span className={`${s.chip} ${s.placeholder}`} title="This page shows placeholder values. They can never ship." data-chip="placeholder">
            PLACEHOLDER DATA
          </span>
        )}
      </span>
    </header>
  );
}
