// [CTO] T-033 · closer (the timeline's final frame) + footer (build spec 3, rows 5-6). REPO_URL is a
// build-time value; empty = a marked placeholder here, and a ship build refuses it (data gate).
import type { LabFixture } from "../stage/schema.ts";
import s from "./closer.module.css";

export function Closer({ repoUrl }: { repoUrl: string }) {
  return (
    <section className={s.closer} aria-labelledby="closer-heading" data-closer="">
      <div>
        <h2 id="closer-heading" className={s.heading}>Earned Price.<em>Price earned, not claimed.</em></h2>
      </div>
      <div>
        <p className={s.cmd}><span aria-hidden="true">$</span><code>npx earned-price init</code></p>
        <p className={s.meta}>
          Repo{" "}
          {repoUrl
            ? <a href={repoUrl}><b>{repoUrl.replace(/^https?:\/\//, "")}</b></a>
            : <><b>not public yet</b> <span className="ph">PLACEHOLDER URL</span></>}
          <br />Sister project: <b>NEAR Real-World Money</b> (realworld track)
        </p>
      </div>
    </section>
  );
}

export function Footer({ last, placeholder }: { last: LabFixture; placeholder: boolean }) {
  const settledAt = [...last.events].reverse().find((e) => e.type === "settled")?.at;
  return (
    <footer className={s.foot}>
      {placeholder && (
        <p data-placeholder-notice="">
          <span className="ph">PLACEHOLDER DATA</span> No recorded testnet run of the demo is on this page yet. Every tx
          hash, job id, seller and TEE field marked PLACEHOLDER is not real, and the timings are estimates. Only the buyer
          account is real.
        </p>
      )}
      <p>
        Testnet only, no real funds. Every figure comes from a tx result or get_record. Recorded run:{" "}
        {settledAt ? settledAt.slice(0, 10) : "not recorded yet"} · contract {last.contract}
      </p>
    </footer>
  );
}
