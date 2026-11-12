// [CTO] T-033 · event log: every event of every run, server-rendered, closed by default (build spec 3,
// row 4). The real t_ms is shown as recorded; nothing is shortened here.
import type { LabEvent } from "../stage/schema.ts";
import type { RunView } from "./model.ts";
import { nearOf } from "../stage/format.ts";
import { Ref } from "./Ref.tsx";
import s from "./eventlog.module.css";

function detail(e: LabEvent): string {
  switch (e.type) {
    case "quote": return `${e.data.phase} · ${nearOf(e.data.quote_mnear)} NEAR`;
    case "tx_submitted": return `${e.data.action} · signed by the ${e.data.actor}`;
    case "tx_confirmed": return `${e.data.action} · ${e.data.status}`;
    case "accepted": return "seller accepted";
    case "attested": return `${e.data.findings_count} findings`;
    case "check_graded": return `${e.data.bug_id} ${e.data.hit ? "found" : "missed"}`;
    case "settled": return `${e.data.outcome === "paid_seller" ? "paid seller" : "refunded buyer"} · ${nearOf(e.data.amount_mnear)}`;
  }
}

export function EventLog({ runs, count }: { runs: RunView[]; count: number }) {
  return (
    <details className={s.log} data-event-log="">
      {/* A drawn marker (not the native one, which display:flex hides): QA loop 1, B1. */}
      <summary><span className={s.marker} aria-hidden="true" data-marker="" />Event log · {count} events</summary>
      <div className={s.scroll}>
        <table>
          <thead><tr><th scope="col">run</th><th scope="col">seq</th><th scope="col">type</th><th scope="col">t_ms</th><th scope="col">what</th><th scope="col">tx</th></tr></thead>
          <tbody>
            {runs.flatMap((r) =>
              r.fixture.events.map((e) => (
                <tr key={`${r.n}-${e.seq}`}>
                  <td>{r.n}</td><td>{e.seq}</td><td>{e.type}</td><td>{e.t_ms}</td><td>{detail(e)}</td>
                  <td>{"tx_hash" in e ? <Ref value={e.tx_hash} kind="tx" fixture={r.fixture} /> : "view"}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    </details>
  );
}
