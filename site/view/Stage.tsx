// [CTO] T-033 · the stage in its server-rendered FINAL state (ladder stage 1: no motion code).
// Left: kicker, headline, move line, lede, escrow ledger, repeat strip, record card, run register.
// Right: the receipt. Every figure comes from a run's events through the reducer; nothing is typed.
// Test hooks (build spec 8.6): data-stage-state, data-seq, data-run on the stage.
import type { RunView } from "./model.ts";
import { stageStateOf } from "./model.ts";
import { headlineOf } from "../stage/reducer.ts";
import { nearOf, packLabel, signedNear } from "../stage/format.ts";
import { Lock } from "./icons.tsx";
import { Ref } from "./Ref.tsx";
import { Receipt } from "./Receipt.tsx";
import s from "./stage.module.css";

function kickerOf(r: RunView): string {
  const pack = packLabel(r.fixture.pack_id);
  if (r.fixture.mode === "contract-test") return `Contract test · refund path · ${pack}`;
  return r.fixture.sequence === "repeat" ? `Beat 4 · same buyer · ${pack}` : `Beat 3 · hire · ${pack}`;
}

function MoveLine({ r }: { r: RunView }) {
  const q = r.state.quoteAfter, st = r.state.settled, qb = r.state.quoteBefore;
  if (r.state.failed) return <>tx failed · {r.state.failed.action} · nothing moved, quote unchanged</>;
  if (q && st && q.delta_mnear !== undefined && q.prev_quote_mnear !== undefined) {
    if (q.delta_mnear > 0) return <>{nearOf(q.prev_quote_mnear)} → <b>{nearOf(q.quote_mnear)}</b> NEAR · {signedNear(q.delta_mnear)} on a graded pass</>;
    if (q.delta_mnear < 0) return <>{nearOf(q.prev_quote_mnear)} → <b>{nearOf(q.quote_mnear)}</b> NEAR · {signedNear(q.delta_mnear)} on a graded fail · {nearOf(st.amount_mnear)} refunded</>;
    if (r.outcome === "holds") return <><b>{nearOf(q.quote_mnear)}</b> NEAR holds · repeat buyer · counted once</>;
    return <><b>{nearOf(q.quote_mnear)}</b> NEAR holds</>;
  }
  if (qb) return <>Quote <b>{nearOf(qb.quote_mnear)}</b> NEAR · read from the record, nobody typed it</>;
  return null;
}

const LEDE: Record<string, string> = {
  earned: "The record moved, so the quote moved. Nobody typed this number.",
  holds: "Same buyer, second pass. The seller is paid, but unique buyers stay at 1, so a repeat pass can’t pump the price.",
  refunded: "The grade failed, so the buyer gets the escrow back and the quote drops by the contract’s rule.",
  "tx-failed": "The chain rejected the transaction, so no money moved and the record is unchanged.",
  ready: "A seller agent is paid from escrow only when a graded review passes. Every pass or fail moves its next quote.",
};

function Ledger({ r }: { r: RunView }) {
  const st = r.state.settled;
  const create = r.state.rows.create;
  let holder: "you" | "esc" | "sel" = "you";
  let amt: number | null = r.state.quoteBefore?.quote_mnear ?? null;
  let note = "to lock";
  if (create?.status === "wait") { amt = create.deposit_mnear ?? amt; note = "sending…"; }
  if (create?.status === "ok") { holder = "esc"; amt = r.state.lockedMnear; note = "locked"; }
  if (st) { amt = st.amount_mnear; if (st.outcome === "paid_seller") { holder = "sel"; note = "paid"; } else { holder = "you"; note = "refunded"; } }
  if (r.state.failed?.action === "create") { holder = "you"; note = "not sent"; }
  const lockOpen = !!st || create?.status !== "ok";
  const box = (label: string, key: typeof holder) => {
    const has = holder === key && amt != null;
    return (
      <div className={`${s.box} ${has ? s.hot : ""}`} data-box={key}>
        {label}
        <div className={`${s.amt} ${has ? "" : s.nil}`}>
          {has ? <><span className={s.token}>{nearOf(amt!)}</span><small>{note}</small></> : "·"}
        </div>
        {key === "esc" && <Lock className={s.lock} shackleClassName={s.shackle} open={lockOpen} />}
      </div>
    );
  };
  const cap = st
    ? st.outcome === "paid_seller" ? "escrow released to the seller on a graded pass" : "escrow refunded to the buyer on a graded fail"
    : r.state.lockedMnear && !r.state.failed ? "held by the contract until the grade" : "nothing locked yet";
  return (
    <>
      <div className={s.ledger} role="group" aria-label="Escrow ledger">{box("YOU", "you")}{box("ESCROW", "esc")}{box("SELLER", "sel")}</div>
      <p className={s.cap}>{cap}</p>
    </>
  );
}

function RepeatStrip({ r }: { r: RunView }) {
  const q = r.state.quoteAfter;
  if (r.outcome !== "holds" || !q) return null; // renders only when counts_unique_buyer === false
  return (
    <div className={s.strip} data-repeat-strip="">
      <div><b>REPEAT BUYER</b>same buyer · {packLabel(r.fixture.pack_id)} · pass<br />seller paid · unique buyers stay {q.record.unique_buyers}</div>
      <span className="stamp">NOT COUNTED</span>
      <div className={s.stripPrice}><em>{nearOf(q.quote_mnear)}</em>NEAR holds</div>
    </div>
  );
}

function RecordCard({ r }: { r: RunView }) {
  const q = r.state.quoteAfter ?? r.state.quoteBefore;
  if (!q) return null;
  const a = q.record;
  const b = r.state.quoteAfter && r.state.quoteBefore ? r.state.quoteBefore.record : null;
  const cell = (k: keyof typeof a, label: string) => {
    const changed = !!b && b[k] !== a[k];
    return (
      <div>
        {label}
        <b className={changed ? s.changed : undefined} data-rk={k}>{changed && <s>{b![k]} →</s>}{a[k]}</b>
      </div>
    );
  };
  return (
    <div className={s.record} role="group" aria-label="Seller record">
      {cell("passes", "PASSES")}{cell("fails", "FAILS")}{cell("unique_buyers", "UNIQUE BUYERS")}{cell("jobs", "JOBS")}
      <small>Seller record from get_record{r.state.quoteAfter ? " after the settle" : " before the hire"}{b ? " · yellow = changed by this job" : ""} · the quote is computed from it</small>
    </div>
  );
}

/** One line per finished run, with its settle tx (build spec 3, "run register"). */
function RunRegister({ runs }: { runs: RunView[] }) {
  return (
    <ol className={s.register} aria-label="Runs">
      {runs.map((r) => {
        const q = r.state.quoteAfter, st = r.state.settled, g = st?.grade;
        if (!q || !st || q.prev_quote_mnear === undefined) return null;
        const same = r.n > 1 && runs[0].fixture.buyer === r.fixture.buyer;
        const move =
          r.outcome === "earned" ? `${nearOf(q.prev_quote_mnear)} → ${nearOf(q.quote_mnear)}`
          : r.outcome === "holds" ? `${nearOf(q.quote_mnear)} holds · counted once`
          : r.outcome === "refunded" ? `${nearOf(q.prev_quote_mnear)} → ${nearOf(q.quote_mnear)} · refunded`
          : `${nearOf(q.quote_mnear)} holds`;
        return (
          <li key={r.n} data-run-line={r.n}>
            <span>Run {r.n}{same ? " · same buyer" : ""} · {packLabel(r.fixture.pack_id)} · {g?.passed ? "pass" : "fail"} · {move}</span>
            <span className={s.registerTx} data-settle-tx={r.n}>
              {st.outcome === "paid_seller" ? "settle tx" : "refund tx"} <Ref value={st.tx} kind="tx" fixture={r.fixture} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function Stage({ runs, last }: { runs: RunView[]; last: RunView }) {
  const h = headlineOf(last.state);
  const state = stageStateOf(last);
  const lede = LEDE[state] ?? LEDE.ready;
  return (
    <section className={s.stage} aria-label="Earn moment" data-stage-state={state} data-seq={last.state.seq} data-run={last.n}>
      <div className={s.left}>
        <div className={s.kicker}>{kickerOf(last)}</div>
        <h2 className={`${s.headline} ${h.waiting ? s.waiting : ""}`} id="stage-headline" tabIndex={-1} role="status">{h.text}</h2>
        <p className={s.move}><MoveLine r={last} /></p>
        <p className={s.lede}>{lede}</p>
        <Ledger r={last} />
        <RepeatStrip r={last} />
        <RecordCard r={last} />
        <RunRegister runs={runs} />
      </div>
      <div className={s.right}>
        <Receipt r={last} />
      </div>
    </section>
  );
}
