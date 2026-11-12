// T-028: the demo seller's side of the escrow for the live review function. Views are keyless
// JSON-RPC calls with failover (cli/quote.js viewFunction); accept / decline / submit_review are
// signed with the seller's testnet key through the same sign-then-broadcast path as `earned pick`
// (cli/pick.js sendCreateTx: tx hash known before broadcast, "never sent" kept apart from "sent,
// no answer"). Tx methods never throw: they resolve to
//   { status: "landed" | "failed" | "not_sent" | "unknown", txHash, message? }
// `message` is the contract's own panic text only; library error text (which could carry request
// details) is dropped. The seller private key never leaves this closure.
import { viewFunction } from "../cli/quote.js";

export const ACCEPT_GAS = 30n * 10n ** 12n; // 30 Tgas: one job write
export const SUBMIT_GAS = 300n * 10n ** 12n; // max: ecrecover + sha256 + JSON parse of up to 128 KiB; unused gas is refunded

/** Reads the outcome of a sent tx: Failure = refused on-chain (landed), SuccessValue = landed. */
export function classifyOutcome(outcome, txHash) {
  const st = outcome?.status;
  const hash = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id ?? txHash ?? null;
  if (st && typeof st === "object" && st.Failure) {
    const exec = st.Failure?.ActionError?.kind?.FunctionCallError?.ExecutionError;
    return { status: "failed", txHash: hash, message: typeof exec === "string" ? exec.replace(/^Smart contract panicked: /, "").slice(0, 300) : "refused on-chain" };
  }
  if (st && typeof st === "object" && "SuccessValue" in st) return { status: "landed", txHash: hash };
  return { status: "unknown", txHash: hash };
}

/**
 * deps: { fetch, urls, contractId, sellerId, send }. send(req) is sendCreateTx-shaped: it calls
 * req.onSigned(txHash) before broadcast, returns the final outcome, and tags errors that cannot
 * have landed with `notSent`; an error tagged `landedFailure` is a tx that ran and panicked.
 */
export function sellerChain({ fetch, urls, contractId, sellerId, send }) {
  const view = (method, args) => viewFunction({ fetch, urls, contractId, method, args });
  async function call(methodName, args, gas) {
    let txHash = null;
    try {
      const outcome = await send({ contractId, methodName, args, depositYocto: 0n, gas, onSigned: (h) => (txHash = h) });
      return classifyOutcome(outcome, txHash);
    } catch (err) {
      if (err?.landedFailure) return { status: "failed", txHash, message: "refused on-chain" };
      return { status: err?.notSent ? "not_sent" : "unknown", txHash };
    }
  }
  return {
    getJob: (id) => view("get_job", { id }),
    signers: () => view("signers", {}),
    getRecord: (seller) => view("get_record", { seller }),
    accept: (id) => call("accept", { job_id: id }, ACCEPT_GAS),
    decline: (id) => call("decline", { job_id: id }, ACCEPT_GAS),
    submitReview: (args) => call("submit_review", args, SUBMIT_GAS),
    sellerId,
  };
}

/**
 * The real `send`: near-api-js 7.4.0 through cli/pick.js sendCreateTx with the seller's key.
 * An ActionExecutionError (the tx ran and the contract panicked) is tagged landedFailure.
 */
export function nearSend({ urls, sellerId, privateKey, retries = 3 }) {
  return async (req) => {
    const near = await import("near-api-js");
    const rpcErrors = await import("near-api-js/rpc-errors");
    const { sendCreateTx } = await import("../cli/pick.js");
    const makeAccount = (url, st) => new near.Account(st.account_id, new near.JsonRpcProvider({ url }, { retries }), st.private_key);
    try {
      return await sendCreateTx({ ...req, urls, makeAccount, state: { account_id: sellerId, private_key: privateKey }, near, rpcErrors });
    } catch (err) {
      if (err instanceof rpcErrors.ActionExecutionError) throw Object.assign(new Error("refused on-chain"), { landedFailure: true });
      if (err?.notSent) throw Object.assign(new Error("not sent"), { notSent: true });
      throw new Error("tx outcome unknown"); // drop library text
    }
  };
}
