// [CTO] T-033 / S-028 · footer (build spec 3, row 6). The closer moved into the earn stage (it is the
// timeline's final frame), so this file keeps only the footer.
import type { LabFixture } from "../stage/schema.ts";
import s from "./footer.module.css";

export function Footer({ last, placeholder }: { last: LabFixture; placeholder: boolean }) {
  const settledAt = [...last.events].reverse().find((e) => e.type === "settled")?.at;
  return (
    <footer className={s.foot}>
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
