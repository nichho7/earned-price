// The demo seller run from this machine for `earned hire --local-seller` (T-031). Only for whoever
// holds the seller's key and a NEAR AI key (Nicho's live run); everyone else gets the RECORDED
// replay. Same steps as the T-028 review function: accept -> wait until the accept is visible ->
// T-027 reviewJob (buildReviewRequest unchanged, reasoning off) -> submit_review.
//
// review() never throws for a seller-side problem: it returns { mode: "replay", reason, message }
// when no signed review was made, or { mode: "live", review, txs, submit } once one was. `submit`
// is landed | refused | not_sent | unknown; hire trusts only what get_job then shows on-chain.
// The seller key and the NEAR AI key stay inside this closure and are cut from every message.
import { ACCEPT_GAS, SUBMIT_GAS, parseTxOutcome } from "./tx.js";

const UNAVAILABLE = new Set(["TEE_UNAVAILABLE", "SIGNATURE_UNAVAILABLE"]);
const TIMEOUTS = new Set(["DEADLINE_EXCEEDED", "REVIEW_WINDOW_CLOSED"]);

/** ReviewError code -> replay reason (the T-028 reason names). */
export function replayReason(code) {
  if (UNAVAILABLE.has(code)) return "tee_unavailable";
  if (TIMEOUTS.has(code)) return "timeout";
  return "review_failed";
}

/**
 * sellerState { account_id, private_key }; sendTx(req) as pick's sendCreateTx; getJob() -> the live
 * get_job view or null; getSigners() -> the signers() view; reviewJob = seller/review.js reviewJob;
 * apiKey; sleep; pollMs; polls; log.
 */
export function makeLocalSeller({ sellerState, contractId, sendTx, getJob, getSigners, reviewJob, apiKey, sleep, pollMs = 1500, polls = 8, log = () => {} }) {
  const secrets = [sellerState.private_key, apiKey].filter((s) => typeof s === "string" && s.length >= 8);
  const clean = (text) => secrets.reduce((t, s) => t.split(s).join("[redacted]"), String(text)).slice(0, 240);
  const send = (methodName, args, gas) => sendTx({ state: sellerState, contractId, methodName, args, depositYocto: 0n, gas });
  const replay = (reason, message, txs) => ({ mode: "replay", reason, message: clean(message), txs });

  async function pollAccepted() {
    for (let i = 0; i < polls; i++) {
      let v = null;
      try {
        v = await getJob();
      } catch {
        v = null;
      }
      if (v?.status === "accepted" && v.accepted_at_ns != null && v.review_by_ns != null) return v;
      if (i < polls - 1) await sleep(pollMs);
    }
    return null;
  }

  return {
    account: sellerState.account_id,
    async review({ jobId, view, pack, saveReview, say }) {
      const txs = {};
      if (view.status === "open") {
        try {
          const p = parseTxOutcome(await send("accept", { job_id: jobId }, ACCEPT_GAS), contractId);
          if (p.failure) return replay("chain_refused", `accept refused: ${p.failure}`, txs);
          txs.accept = p.txHash;
          say(`Seller accepted: accept tx ${p.txHash}`);
        } catch (err) {
          // Not sent: nothing landed. Unknown: it may have landed, so look before giving up.
          if (err?.notSent) return replay("chain_unavailable", `accept was not sent (${err?.message ?? err})`, txs);
          say(`Seller accept: no result came back (${clean(err?.message ?? err)}); checking get_job`);
        }
      }
      const job = await pollAccepted();
      if (!job) return replay("chain_unavailable", "the seller's accept is not visible on testnet", txs);
      if (job.review != null) return { mode: "live", review: null, txs, submit: "landed" };

      let r;
      try {
        r = await reviewJob({ job, pack, apiKey, signers: await getSigners(), log });
      } catch (err) {
        return replay(replayReason(err?.code), `${err?.code ?? "REVIEW_FAILED"}: ${err?.message ?? err}`, txs);
      }
      saveReview(r); // before submit: a crash after this still leaves the body needed to reveal
      const found = r.check?.ok ? `${r.check.list.length} findings` : `fixed FAIL (${r.check?.error})`;
      say(`Seller review in the TEE: ${found}, signed by ${r.tee.signing_address}, response ${r.tee.response_sha256.slice(0, 12)}…`);

      try {
        const p = parseTxOutcome(await send("submit_review", r.submit_args, SUBMIT_GAS), contractId);
        if (p.failure) return { mode: "live", review: r, txs, submit: "refused", message: clean(p.failure) };
        txs.submit_review = p.txHash;
        say(`  submit_review tx: ${p.txHash}`);
        return { mode: "live", review: r, txs, submit: "landed" };
      } catch (err) {
        return { mode: "live", review: r, txs, submit: err?.notSent ? "not_sent" : "unknown", message: clean(err?.message ?? err) };
      }
    },
  };
}
