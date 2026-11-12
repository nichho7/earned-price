// [CTO] T-033 · the review receipt (form EP-01) in a run's final state. Port of the /lab receiptHTML,
// as markup sized for the final state (build spec 8, constraint 1). The price is the plain value here;
// the odometer columns arrive with M1 (S-028).
import type { RunView } from "./model.ts";
import { isRefund } from "./model.ts";
import type { Action } from "../stage/schema.ts";
import { isPlaceholder, nearOf, packLabel, postmarkDate, quoteOf, rawQuoteOf, signedNear } from "../stage/format.ts";
import { Check, Cross, Dash, Seal } from "./icons.tsx";
import { isTestnetRun, Ref } from "./Ref.tsx";
import s from "./stage.module.css";

const ACT: Record<Action, string> = {
  create: "Lock in escrow", accept: "Seller accepts", submit_review: "Signed review on-chain", reveal: "Reveal key · grade · settle",
};
const ORDER: Action[] = ["create", "accept", "submit_review", "reveal"];

/** Round postmark, violet on the sheet (build spec 5): ring "EARNED PRICE · TESTNET", centre word(s), and
 *  the settle date, or "No. <job_id>" when the date is not recorded. */
function Postmark({ mid, sub, bottom, uid }: { mid: string; sub: string; bottom: string; uid: string }) {
  const id = `pm-${uid}`;
  return (
    <svg className={s.postmark} viewBox="0 0 120 120" role="img" aria-label={`Postmark: ${mid} ${sub}`.trim()} data-postmark={mid}>
      <defs><path id={id} d="M60,60 m-45,0 a45,45 0 1,1 90,0 a45,45 0 1,1 -90,0" /></defs>
      <circle cx="60" cy="60" r="57" fill="none" stroke="currentColor" strokeWidth="3.2" />
      <circle cx="60" cy="60" r="35" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <text className={s.pmRing} aria-hidden="true"><textPath href={`#${id}`}>{`EARNED PRICE · TESTNET · ${bottom} ·`}</textPath></text>
      <text className={`${s.pmMid} ${mid.length > 7 ? s.pmMidLong : ""}`} x="60" y="59" textAnchor="middle" aria-hidden="true">{mid}</text>
      <text className={s.pmSub} x="60" y="74" textAnchor="middle" aria-hidden="true">{sub}</text>
    </svg>
  );
}

export function Receipt({ r }: { r: RunView }) {
  const { fixture: f, state: st } = r;
  const settled = st.settled, qa = st.quoteAfter, qb = st.quoteBefore;
  const net = isTestnetRun(f) ? "TESTNET" : "LOCAL SANDBOX";
  const jobReal = st.jobId && !isPlaceholder(st.jobId);
  const jobText = jobReal ? `No. ${st.jobId}` : "No. ——";
  const allGraded = st.checks.every(Boolean);
  const grade = settled?.grade;
  const q = qa ?? qb;
  const settleAt = settled?.at ? postmarkDate(settled.at) : "";
  const bottom = settleAt || jobText.toUpperCase();
  const repeat = r.outcome === "holds";
  const buyerIsReal = !!f.buyer_proof && f.buyer === f.buyer_proof.account;

  return (
    <div className={s.tilt}>
      <div className={s.paperWrap}>
        <i className={s.printShadow} aria-hidden="true" />
        <div className={`${s.paper} sheet`} role="group" aria-label="Review receipt">
          <div className={s.top}>
            <div>
              <b>Review · {packLabel(f.pack_id)}</b>
              <small data-form-no="">FORM EP-01 · {jobText}{st.jobId && isPlaceholder(st.jobId) && <> <span className="ph">PLACEHOLDER ID</span></>}</small>
              <small>buyer <Ref value={f.buyer} kind="account" fixture={f} />{buyerIsReal && <> <span className="real" title="Created on testnet by earned init">REAL ACCOUNT</span></>}</small>
            </div>
            <span>NEAR AI Cloud · TEE<br />{net}</span>
          </div>

          <div className={s.proc} role="list" aria-label="Transactions">
            {ORDER.map((a) => {
              const row = st.rows[a];
              if (!row) return <div key={a} role="listitem"><Dash className={s.ic} /><span>{ACT[a]}</span><span /></div>;
              if (row.status === "bad") return <div key={a} role="listitem" className={s.bad}><Cross className={s.ic} /><span>{ACT[a]}</span><span>failed</span></div>;
              if (row.status === "wait") return <div key={a} role="listitem" className={s.cur}><Dash className={s.ic} /><span>{ACT[a]}</span><span>waiting for tx</span></div>;
              return (
                <div key={a} role="listitem" className={s.ok} data-row={a}>
                  <Check className={s.ic} /><span>{ACT[a]}{a === "create" ? ` ${nearOf(st.lockedMnear)}` : ""}</span><span><Ref value={row.tx} kind="tx" fixture={f} /></span>
                </div>
              );
            })}
          </div>

          {st.attested && (
            <div className={s.tee} data-tee="">
              <span>signed review · model <Ref value={st.attested.model} kind="text" /></span>
              <span>signer <Ref value={st.attested.signing_address} kind="text" /></span>
              <span><b>{st.attested.findings_count}</b> findings</span>
            </div>
          )}

          <div className={s.checksHead}>
            <small>ANSWER KEY · GRADE</small>
            <div className={s.checkDots} aria-hidden="true">
              {st.checks.map((c, i) => (
                <i key={i} className={`${s.checkDot} ${c ? (c.hit ? s.dotOk : s.dotNo) : ""}`}>{c ? (c.hit ? <Check bold /> : <Cross bold />) : null}</i>
              ))}
            </div>
          </div>
          <div className={s.rows} role="list" aria-label="Checks">
            {st.checks.map((c, i) =>
              c ? (
                <div key={i} role="listitem" className={`${s.row} ${c.hit ? "" : s.rowNo}`} data-check={c.hit ? "found" : "missed"}>
                  {c.hit ? <Check className={s.ic} /> : <Cross className={s.ic} />}
                  <span className={s.rowId}>{c.bug_id}</span><span>{c.title}</span><span className={s.rowGrade}>{c.hit ? "found" : "missed"}</span>
                </div>
              ) : (
                <div key={i} role="listitem" className={`${s.row} ${s.rowSealed}`}>
                  <Seal className={s.ic} /><span className={s.rowId}>{i + 1}</span><span>Check {i + 1}</span><span className={s.rowGrade}>sealed</span>
                </div>
              ),
            )}
          </div>
          {allGraded && st.rows.reveal && (
            <p className={s.oneTx}>All 5 grades come from one reveal tx{settled ? " (same tx as the settle)" : ""}. The stagger is animation only.</p>
          )}
          {grade ? (
            <div className={s.sum} data-sum="">
              <i className={s.sumHl} aria-hidden="true" />
              <span>Plain grader, no AI · <span className={s.nowrap}>needs {grade.pass_min} of {grade.total}</span></span>
              <b>{grade.found} / {grade.total} · {grade.passed ? "pass" : "fail"}</b>
            </div>
          ) : (
            <div className={s.sum}><span>Plain grader, no AI · titles sealed until the key is revealed</span><b>—</b></div>
          )}

          <div className={s.quote}>
            <small>NEXT QUOTE</small>
            {qa?.delta_mnear !== undefined && <span className={s.pill}>{qa.delta_mnear === 0 ? "UNCHANGED" : signedNear(qa.delta_mnear)}</span>}
            <div className={s.priceRow}>
              <span className={s.price} data-price="">{q ? nearOf(q.quote_mnear) : "—"}</span>
              <span className={s.unit}>NEAR</span>
              {qa && qa.delta_mnear !== undefined && qa.delta_mnear < 0 && qa.prev_quote_mnear !== undefined && (
                <span className={s.was}>was {nearOf(qa.prev_quote_mnear)}</span>
              )}
            </div>
            {r.outcome === "earned" && qa && <Postmark uid={`r${r.n}`} mid="EARNED" sub={signedNear(qa.delta_mnear ?? 0)} bottom={bottom} />}
            {repeat && <Postmark uid={`r${r.n}`} mid="COUNTED" sub="ONCE" bottom={bottom} />}
            {isRefund(r.outcome) && <span className={`stamp ${s.refundStamp}`}>REFUNDED</span>}
            {q && <Formula r={r} repeat={repeat} />}
          </div>

          {settled ? (
            <div className={s.tx} data-settle-row="">
              <span className={s.txTag}>{settled.outcome === "paid_seller" ? "SETTLE TX" : "REFUND TX"}</span>
              {settled.outcome === "paid_seller" ? "paid to seller" : "refunded to buyer"} {nearOf(settled.amount_mnear)} ·{" "}
              <span className={s.txRef}><Ref value={settled.tx} kind="tx" fixture={f} /></span>
              {isPlaceholder(settled.tx)
                ? <span className={s.noLink}>no explorer link: placeholder</span>
                : !isTestnetRun(f) ? <span className={s.noLink}>sandbox tx: not on testnet</span> : null}
            </div>
          ) : (
            <div className={s.tx}><span className={s.txTag}>TX</span>{st.failed ? "nothing settled" : "nothing settled yet"}</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** "30 + 10 × P − 5 × F = Q mNEAR → 0.0QQ" from get_record (build spec 5, "Formula line"). */
function Formula({ r, repeat }: { r: RunView; repeat: boolean }) {
  const q = (r.state.quoteAfter ?? r.state.quoteBefore)!;
  const rec = q.record, calc = quoteOf(rec), clamped = rawQuoteOf(rec) !== calc;
  const p = rec.unique_buyers, mismatch = r.state.mismatch[0];
  return (
    <div className={s.formula} data-formula="">
      <div className={s.formulaIn}>
        <span>P = <b>{p}</b> unique buyer{p === 1 ? "" : "s"} <span>(<b>{rec.passes}</b> pass{rec.passes === 1 ? "" : "es"})</span></span>
        <span>F = <b>{rec.fails}</b> fail{rec.fails === 1 ? "" : "s"}</span>
        <span>{rec.jobs} job{rec.jobs === 1 ? "" : "s"}</span>
      </div>
      <div className={s.formulaEq}>
        <span>30 + 10 × <b>{p}</b> − 5 × <b>{rec.fails}</b> = <b>{calc}</b> mNEAR → <b>{nearOf(calc)}</b>{clamped ? " (clamped)" : ""}</span>
        {repeat && <span className={s.countedOnce} data-chip="counted-once">REPEAT BUYER · COUNTED ONCE</span>}
      </div>
      {mismatch
        ? <p className={`${s.formulaSrc} ${s.mismatch}`}>Mismatch: {mismatch}</p>
        : <p className={s.formulaSrc}>From get_record · clamped 25–100 mNEAR · unique buyers only</p>}
    </div>
  );
}
