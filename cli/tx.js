// Escrow tx results for `earned hire` (T-031) and its local seller: the outcome and the EVENT_JSON
// events of a FinalExecutionOutcome. A closed job is gone from get_job, so its outcome is read only
// from the closing tx (A-013, m001-ui-contract section 8), never from a later view.
// Browser-safe since T-035 (no node: imports): the /live signing gate (site/live/account.js) reuses
// sendCreateTx / signedTxHash, and the /live page reads outcomes with parseTxOutcome / outcomeOf.
import { sha256 } from "@noble/hashes/sha2.js";

export const txHashOf = (o) => o?.transaction?.hash ?? o?.transaction_outcome?.id ?? null;

const TGAS = 10n ** 12n;
export const ACCEPT_GAS = 30n * TGAS; // one job write (same as the T-028 function)
export const SUBMIT_GAS = 300n * TGAS; // ecrecover + sha256 + JSON parse of up to 128 KiB; unused gas is refunded
export const REVEAL_GAS = 300n * TGAS; // on-chain regrade + payout promise + callback
export const TIMEOUT_GAS = 100n * TGAS; // close + refund or payout promise + 10 Tgas callback

export class TxError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "TxError";
    this.code = code;
    Object.assign(this, extra);
  }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * FinalExecutionOutcome -> { txHash, failure, events }. failure is the contract's panic text
 * (prefix removed) or a short JSON of the failure, else null. events are the parsed EVENT_JSON
 * logs with standard "earned_price", from receipts executed by `contractId` only (a log line from
 * any other account is ignored). Throws BAD_TX_RESULT when the outcome has no readable status.
 */
export function parseTxOutcome(outcome, contractId) {
  const status = outcome?.status;
  const txHash = txHashOf(outcome);
  if (!isObj(status) || !(status.Failure || typeof status.SuccessValue === "string")) {
    throw new TxError("BAD_TX_RESULT", `the tx result is unreadable${txHash ? ` (tx ${txHash})` : ""}`, { txHash });
  }
  let failure = null;
  if (status.Failure) {
    const exec = status.Failure?.ActionError?.kind?.FunctionCallError?.ExecutionError;
    failure = typeof exec === "string" ? exec.replace(/^Smart contract panicked: /, "") : JSON.stringify(status.Failure).slice(0, 300);
  }
  const events = [];
  const outcomes = [outcome?.transaction_outcome, ...(Array.isArray(outcome?.receipts_outcome) ? outcome.receipts_outcome : [])];
  for (const o of outcomes) {
    if (o?.outcome?.executor_id !== contractId || !Array.isArray(o.outcome.logs)) continue;
    for (const line of o.outcome.logs) {
      if (typeof line !== "string" || !line.startsWith("EVENT_JSON:")) continue;
      try {
        const e = JSON.parse(line.slice("EVENT_JSON:".length));
        // blockHash: the block whose state includes this receipt's writes (step 4 pins its record read there).
        if (e?.standard === "earned_price" && typeof e.event === "string" && isObj(e.data)) events.push({ event: e.event, data: e.data, blockHash: typeof o.block_hash === "string" && o.block_hash !== "" ? o.block_hash : null });
      } catch {
        // not an event we emit
      }
    }
  }
  return { txHash, failure, events };
}

export const notSent = (err) => Object.assign(err instanceof Error ? err : new Error(String(err)), { notSent: true });

/**
 * True when send_tx was refused before the tx could be included (nearcore INVALID_TRANSACTION,
 * which near-api-js 7.4.0 throws as InvalidTransactionError or an InvalidTxError subclass of
 * TransactionExecutionError). ActionExecutionError means it ran, so it is not counted here.
 */
export function isRejectedBeforeInclusion(err, rpcErrors) {
  const { TransactionExecutionError, ActionExecutionError, InvalidTransactionError } = rpcErrors;
  if (err instanceof InvalidTransactionError) return true;
  return err instanceof TransactionExecutionError && !(err instanceof ActionExecutionError);
}

/** base58 sha256 of the borsh-encoded transaction: the hash the explorer and `tx` RPC use. */
export function signedTxHash(signed, near) {
  return near.baseEncode(sha256(near.encodeTransaction(signed.transaction)));
}

/**
 * Signs create on the first RPC that answers (views may have failed over), reports the tx hash
 * through onSigned before broadcasting, then broadcasts on that same RPC. Errors tagged notSent
 * cannot have landed: signing failed everywhere, or the RPC refused the tx. One fresh-nonce retry.
 * Anything else (timeout, dropped connection) is rethrown as an unknown outcome.
 */
export async function sendCreateTx({ urls, makeAccount, state, contractId, methodName, args, depositYocto, gas, onSigned, near, rpcErrors }) {
  const action = near.actions.functionCall(methodName, args, gas, depositYocto);
  for (let attempt = 0; ; attempt++) {
    let account;
    let signed;
    let lastErr;
    for (const url of urls) {
      try {
        account = makeAccount(url, state); // fresh account = fresh nonce from the chain
        signed = await account.createSignedTransaction({ receiverId: contractId, actions: [action] });
        break;
      } catch (err) {
        lastErr = err;
        signed = undefined;
      }
    }
    if (!signed) throw notSent(lastErr ?? new Error("no RPC to sign with"));
    try {
      await onSigned?.(signedTxHash(signed, near));
    } catch (err) {
      throw notSent(err); // nothing broadcast yet
    }
    try {
      return await account.provider.sendTransactionUntil(signed, "EXECUTED_OPTIMISTIC");
    } catch (err) {
      if (!isRejectedBeforeInclusion(err, rpcErrors)) throw err;
      if (err instanceof rpcErrors.InvalidNonceError && attempt === 0) {
        // Review O-1: a provider retry of send_tx may already have landed this exact tx (it used
        // the nonce). If the chain knows it, that is our create: never re-sign a second one.
        const landed = await account.provider
          .viewTransactionStatus({ txHash: signedTxHash(signed, near), accountId: state.account_id, waitUntil: "EXECUTED_OPTIMISTIC" })
          .catch(() => null);
        if (landed) return landed;
        continue;
      }
      throw notSent(err);
    }
  }
}

/**
 * The outcome of a closing tx (reveal, timeout or the seller's decline) from its events, for this job
 * only. Returns { kind, line, graded, refundYocto, reveal } or null when the tx carries no closing
 * event. Shared by `earned hire` and the /live page (T-035), so both print the same outcome.
 */
export function outcomeOf(events, jobId, buyer) {
  const ev = (name) => events.find((e) => e.event === name && String(e.data.job_id) === jobId) ?? null;
  const reveal = ev("reveal");
  const timeout = ev("timeout");
  const payout = ev("payout");
  const failedPayout = ev("payout_failed_refunded");
  const refund = ev("refund");
  const decline = ev("decline");
  const refunded = (e) => (e && e.data.buyer === buyer && /^\d+$/.test(String(e.data.amount)) ? String(e.data.amount) : null);
  if (decline) {
    // The decline refunds the buyer in the same call (A-010); its event names the amount as "refunded".
    const amount = decline.data.buyer === buyer && /^\d+$/.test(String(decline.data.refunded)) ? String(decline.data.refunded) : null;
    return { kind: "declined", line: "The seller declined. Your deposit came back in the same transaction. A declined job doesn't change the seller's record.", graded: false, refundYocto: amount, reveal: null };
  }
  if (failedPayout) {
    return { kind: "payout_failed_refunded", line: "The payout to the seller failed, so you were refunded. The seller's record is unchanged.", graded: false, refundYocto: refunded(failedPayout), reveal };
  }
  if (reveal) {
    // recordBlock: the block of the receipt that wrote the record (payout callback = record_pass;
    // the reveal's own receipt = record_fail), so the after-read can be pinned to it (review R-1).
    if (reveal.data.outcome === "pass" && payout) return { kind: "settled", line: "Passed. The seller was paid from escrow.", graded: true, refundYocto: null, reveal, recordBlock: payout.blockHash ?? null };
    if (reveal.data.outcome === "fail" && refund) return { kind: "refunded_fail", line: "Failed. You were refunded and the seller takes a fail.", graded: true, refundYocto: refunded(refund), reveal, recordBlock: refund.blockHash ?? null };
    return null;
  }
  if (timeout) {
    const reason = timeout.data.reason;
    if (reason === "not_accepted" && refund) return { kind: "timeout_refund", line: "Timed out: the seller did not accept by accept_by. You were refunded; the seller's record is unchanged.", graded: false, refundYocto: refunded(refund), reveal: null };
    if (reason === "no_review" && refund) return { kind: "timeout_refund_fail", line: "Timed out: no signed review by review_by. You were refunded and the seller takes a fail.", graded: true, refundYocto: refunded(refund), reveal: null, recordBlock: refund.blockHash ?? null };
    if (reason === "no_reveal" && payout) return { kind: "timeout_paid_seller", line: "Timed out: no valid reveal by reveal_deadline, so the signed review paid the seller. The record is unchanged.", graded: false, refundYocto: null, reveal: null };
  }
  return null;
}
