// Escrow tx results for `earned hire` (T-031) and its local seller: the outcome and the EVENT_JSON
// events of a FinalExecutionOutcome. A closed job is gone from get_job, so its outcome is read only
// from the closing tx (A-013, m001-ui-contract section 8), never from a later view.
import { txHashOf } from "./pick.js";

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
        if (e?.standard === "earned_price" && typeof e.event === "string" && isObj(e.data)) events.push({ event: e.event, data: e.data });
      } catch {
        // not an event we emit
      }
    }
  }
  return { txHash, failure, events };
}
