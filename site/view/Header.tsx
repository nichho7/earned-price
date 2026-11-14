// [CTO] T-033 · header: wordmark, 5-step demo rail, PLACEHOLDER DATA chip (build spec 3, row 1).
// S-028: the network chip moved into the stage's top row, next to the run it describes (Designer M-025 §4);
// the page-wide PLACEHOLDER DATA chip stays here. The rail follows the stage through data-state, which the
// client player sets (site/earn/EarnPlayer.tsx); the server renders the final state's step.
// T-103: the brand is the A-033 logo (BrandMark, inline, server-rendered) + live-text wordmark, one link home, named
// "Earned Price". The header sits on violet, so the mark is the reverse colourway (the token default).
import { BrandMark } from "./BrandMark.tsx";
import s from "./header.module.css";

const STEPS = ["1 Start", "2 Pick & haggle", "3 Hire", "4 Repeat buyer", "5 Verify"];

export function Header({ railStep, placeholder }: { railStep: number; placeholder: boolean }) {
  return (
    <header className={s.bar}>
      <a className={s.brand} href="/" aria-label="Earned Price" data-brand="">
        <BrandMark className={s.mark} />
        <span className={s.wordmark}>Earned Price</span>
      </a>
      <ol className={s.rail} aria-label="Demo steps" data-rail="">
        {STEPS.map((t, i) => {
          const n = i + 1;
          return (
            <li key={t} data-step={n} data-state={n < railStep ? "done" : n === railStep ? "on" : ""} aria-current={n === railStep ? "step" : undefined}>
              {t}
            </li>
          );
        })}
      </ol>
      {placeholder && (
        <span className={s.chips}>
          <span className={`${s.chip} ${s.placeholder}`} title="This page shows placeholder values. They can never ship." data-chip="placeholder">
            PLACEHOLDER DATA
          </span>
        </span>
      )}
    </header>
  );
}
