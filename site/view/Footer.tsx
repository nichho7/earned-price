// [CTO] T-033 / S-028 · footer (build spec 3, row 6). The closer moved into the earn stage (it is the
// timeline's final frame), so this file keeps only the footer.
// T-040 / S-018: the one exam-vs-real line (PRD 6, IDEA-038), server-rendered here, outside the
// closer and the earn view, so no motion stage ever hides or replays it.
import type { LabFixture } from "../stage/schema.ts";
import s from "./footer.module.css";

/** PRD 6 approved copy, verbatim (README "Exam jobs vs real jobs" says the same). */
export const EXAM_LINE =
  "Graded jobs (exams with sealed answers) build the record; real jobs pay the earned price; buyers can supply tests, not answers.";

export function Footer({ last, placeholder }: { last: LabFixture; placeholder: boolean }) {
  const settledAt = [...last.events].reverse().find((e) => e.type === "settled")?.at;
  return (
    <footer className={s.foot}>
      <p className={s.exam} data-exam-line="">{EXAM_LINE}</p>
      {placeholder && (
        <p data-placeholder-notice="">
          <span className="ph">PLACEHOLDER DATA</span> This build shows placeholder runs (test fixtures). Every value
          marked PLACEHOLDER is not real, and the timings are estimates. A ship build refuses them.
        </p>
      )}
      <p>
        Testnet only, no real funds. Every figure comes from a tx result or get_record. Recorded run:{" "}
        {settledAt ? settledAt.slice(0, 10) : "not recorded yet"} · contract {last.contract}
      </p>
    </footer>
  );
}
