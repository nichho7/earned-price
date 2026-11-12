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
    // M-1: is `publicKey` an access key of `accountId` (the job's buyer)? true / false; throws if unreachable.
    hasAccessKey: async (accountId, publicKey) => (await viewAccessKey({ fetch, urls, accountId, publicKey })) !== null,
    accept: (id) => call("accept", { job_id: id }, ACCEPT_GAS),
    decline: (id) => call("decline", { job_id: id }, ACCEPT_GAS),
    submitReview: (args) => call("submit_review", args, SUBMIT_GAS),
    sellerId,
  };
}

/**
 * Keyless view_access_key with failover over `urls` (finality final). Returns the key's
 * `permission` ("FullAccess" or { FunctionCall: { allowance, receiver_id, method_names } }), or null
 * when the account has no such key. Throws (no detail) when no RPC answers. Shapes as in
 * near-api-js 7.4.0 (provider.viewAccessKey; errors UNKNOWN_ACCESS_KEY / "access key ... does not
 * exist while viewing"; unknown account UNKNOWN_ACCOUNT).
 */
export async function viewAccessKey({ fetch, urls, accountId, publicKey, timeoutMs = 15000 }) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "earned",
    method: "query",
    params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey },
  });
  for (const url of urls) {
    let out;
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      out = await res.json();
    } catch {
      continue;
    }
    if (!out || typeof out !== "object") continue;
    if (out.error) {
      const name = out.error.cause?.name ?? out.error.name;
      if (name === "UNKNOWN_ACCESS_KEY" || name === "UNKNOWN_ACCOUNT") return null;
      continue; // INTERNAL_ERROR, TIMEOUT_ERROR, ...: try the next RPC
    }
    if (typeof out.result?.error === "string") {
      if (/does not exist while viewing/.test(out.result.error)) return null;
      continue;
    }
    if (out.result && "permission" in out.result) return out.result.permission;
  }
  throw new Error("testnet RPC unreachable");
}

export const SELLER_KEY_METHODS = ["accept", "decline", "submit_review"];

/**
 * Security M-2 (Nicho 2026-11-12): the Vercel seller key must be a function-call key for the escrow
 * limited to accept / decline / submit_review. "ok" | "full_access" | "wrong_scope" | "missing".
 */
export function sellerKeyScope(permission, contractId) {
  if (permission === null || permission === undefined) return "missing";
  if (permission === "FullAccess") return "full_access";
  const fc = permission?.FunctionCall;
  if (!fc || fc.receiver_id !== contractId || !Array.isArray(fc.method_names)) return "wrong_scope";
  const names = new Set(fc.method_names);
  // An empty list means "any method" on NEAR: too wide.
  return names.size > 0 && [...names].every((m) => SELLER_KEY_METHODS.includes(m)) ? "ok" : "wrong_scope";
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
