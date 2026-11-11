// Seller quote module (S-007 / T-026), shared by the CLI and the website.
//
// The quote is computed on-chain by `quote(seller)` from the seller's record
// (contract/src/quote.rs). This module reads `get_record` and `quote` from
// testnet, recomputes the same formula in integer milliNEAR, refuses to print
// if the two disagree, and prints the formula with its inputs:
//   quote = clamp(30 + 10*P - 5*F, 25, 100) milliNEAR
//   P = unique buyers with a paid pass (get_record.unique_buyers), F = all graded fails.
// No LLM and no randomness: the same record always gives the same quote.
//
// Browser-safe: no node: imports. RPC URLs and fetch are injected, so the CLI
// passes cli/init.js RPC_URLS (the one T-014 list) and tests pass recorded responses.

export const BASE_MNEAR = 30;
export const PASS_MNEAR = 10;
export const FAIL_MNEAR = 5;
export const FLOOR_MNEAR = 25; // cost floor: 0.025 NEAR
export const CAP_MNEAR = 100;
export const YOCTO_PER_MNEAR = 10n ** 21n;

export class QuoteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QuoteError";
    this.code = code;
  }
}

const U32_MAX = 0xffffffff;
function u32(record, key) {
  const v = record?.[key];
  if (!Number.isInteger(v) || v < 0 || v > U32_MAX) {
    throw new QuoteError("BAD_RECORD", `get_record returned an invalid ${key}: ${JSON.stringify(v)}`);
  }
  return v;
}

/** Validates a get_record view: {passes, fails, unique_buyers, jobs}, all u32. */
export function parseRecord(record) {
  const r = {
    passes: u32(record, "passes"),
    fails: u32(record, "fails"),
    unique_buyers: u32(record, "unique_buyers"),
    jobs: u32(record, "jobs"),
  };
  if (r.unique_buyers > r.passes) throw new QuoteError("BAD_RECORD", "get_record: unique_buyers exceeds passes");
  return r;
}

/** Unclamped 30 + 10P - 5F (exact: u32 inputs stay far below 2^53). */
export function rawMilli({ unique_buyers, fails }) {
  return BASE_MNEAR + PASS_MNEAR * unique_buyers - FAIL_MNEAR * fails;
}

/** Same as contract quote_millinear: clamp(30 + 10P - 5F, 25, 100). */
export function quoteMilli(record) {
  return Math.min(CAP_MNEAR, Math.max(FLOOR_MNEAR, rawMilli(record)));
}

/** milliNEAR integer -> "0.030" (3 decimals, m001 §1). Negative values keep their sign. */
export function formatMilli(m) {
  const sign = m < 0 ? "-" : "";
  const a = Math.abs(m);
  return `${sign}${Math.floor(a / 1000)}.${String(a % 1000).padStart(3, "0")}`;
}

/** "0.02" / "0.020" / ".02" -> 20 milliNEAR. Refuses anything finer than 0.001 NEAR. */
export function parseNearToMilli(text) {
  const s = String(text ?? "").trim();
  const m = /^(\d*)(?:\.(\d+))?$/.exec(s);
  if (!s || !m || (m[1] === "" && m[2] === undefined)) {
    throw new QuoteError("BAD_OFFER", `offer must be a NEAR amount like 0.03 (got "${s}")`);
  }
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > 3) throw new QuoteError("BAD_OFFER", `offer has more than 3 decimals (got "${s}"); prices are whole milliNEAR`);
  const milli = Number(m[1] || "0") * 1000 + Number(frac.padEnd(3, "0"));
  if (!Number.isSafeInteger(milli)) throw new QuoteError("BAD_OFFER", `offer is too large (got "${s}")`);
  return milli;
}

/**
 * The printed formula with its inputs (m001 §3), P = unique_buyers. Examples:
 *   0.030 + 0.010×1 − 0.005×1 = 0.035 NEAR
 *   0.030 + 0.010×0 − 0.005×2 = 0.020 → floor 0.025 NEAR
 */
export function formulaLine(record) {
  const raw = rawMilli(record);
  const q = quoteMilli(record);
  const sum = `${formatMilli(BASE_MNEAR)} + ${formatMilli(PASS_MNEAR)}×${record.unique_buyers} − ${formatMilli(FAIL_MNEAR)}×${record.fails} = ${formatMilli(raw)}`;
  if (raw < FLOOR_MNEAR) return `${sum} → floor ${formatMilli(q)} NEAR`;
  if (raw > CAP_MNEAR) return `${sum} → cap ${formatMilli(q)} NEAR`;
  return `${sum} NEAR`;
}

/** Lines the seller prints for a quote (CLI and site share the text). */
export function quoteLines(r) {
  const counted = r.passes === r.unique_buyers ? "" : ` (${r.passes} passes, ${r.unique_buyers} counted: one per buyer)`;
  return [
    `Quote: ${formatMilli(quoteMilli(r))} NEAR (testnet)`,
    `  formula: ${formulaLine(r)}`,
    `  P = ${r.unique_buyers} unique buyers with a pass${counted}, F = ${r.fails} fails, ${r.jobs} graded jobs`,
    `  rule: 0.030 + 0.010×P − 0.005×F, clamped to ${formatMilli(FLOOR_MNEAR)}..${formatMilli(CAP_MNEAR)} NEAR`,
  ];
}

/**
 * Seller's off-chain answer to a buyer offer (the contract also enforces amount >= quote).
 * Returns { accept, priceMilli, reason }. Below the floor: refused, floor shown.
 * Between floor and quote: refused, quote shown. At or above quote: accepted at the quote
 * (the contract refunds any excess in the same create call).
 */
export function evaluateOffer(offerMilli, quoteM) {
  if (!Number.isSafeInteger(offerMilli) || offerMilli < 0) throw new QuoteError("BAD_OFFER", "offer must be a whole, non-negative milliNEAR amount");
  // Pass fetchQuote's quoteMilli. Anything outside the contract's clamp is a caller bug: never accept at it.
  if (!Number.isSafeInteger(quoteM) || quoteM < FLOOR_MNEAR || quoteM > CAP_MNEAR) {
    throw new QuoteError("BAD_QUOTE", `quote must be whole milliNEAR in ${FLOOR_MNEAR}..${CAP_MNEAR} (got ${String(quoteM)})`);
  }
  const offer = formatMilli(offerMilli);
  if (offerMilli < FLOOR_MNEAR) {
    return { accept: false, priceMilli: quoteM, reason: `Refused ${offer} NEAR: below my cost floor ${formatMilli(FLOOR_MNEAR)} NEAR. My price is ${formatMilli(quoteM)} NEAR.` };
  }
  if (offerMilli < quoteM) {
    return { accept: false, priceMilli: quoteM, reason: `Refused ${offer} NEAR: below my quote ${formatMilli(quoteM)} NEAR (set by my record, not negotiable).` };
  }
  return { accept: true, priceMilli: quoteM, reason: `Accepted: price ${formatMilli(quoteM)} NEAR.` };
}

// NEAR account id rules, ending in .testnet (same pattern as scripts/testnet-view.mjs).
const TESTNET_ACCOUNT = /^[a-z0-9]+([_-][a-z0-9]+)*(\.[a-z0-9]+([_-][a-z0-9]+)*)*\.testnet$/;
export function assertTestnetAccount(id) {
  if (typeof id !== "string" || id.length > 64 || !TESTNET_ACCOUNT.test(id)) {
    throw new QuoteError("NOT_TESTNET", `refused: ${JSON.stringify(id)} is not a .testnet account`);
  }
}

const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const utf8 = (bytes) => new TextDecoder().decode(Uint8Array.from(bytes));

/**
 * Keyless view call with failover over `urls` (in order). A node answering with a
 * contract or account error is a final answer (no failover, like T-014 "not found");
 * network errors, HTTP errors and unreadable bodies move to the next RPC.
 */
export async function viewFunction(opts) {
  return (await viewFunctionAt(opts)).value;
}

/** viewFunction plus the block it was read at: { value, blockHash }. Pass blockId to pin a block. */
export async function viewFunctionAt({ fetch: fetchFn, urls, contractId, method, args = {}, blockId, timeoutMs = 15000 }) {
  assertTestnetAccount(contractId);
  const at = blockId ? { block_id: blockId } : { finality: "final" };
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "earned",
    method: "query",
    params: { request_type: "call_function", ...at, account_id: contractId, method_name: method, args_base64: b64(JSON.stringify(args)) },
  });
  const causes = [];
  for (const url of urls) {
    let out;
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      out = await res.json();
      if (!out || (typeof out !== "object") || (!out.result && !out.error)) throw new Error("not a JSON-RPC response");
    } catch (err) {
      causes.push({ url, error: String(err?.message ?? err) });
      continue;
    }
    if (out.error) {
      const name = out.error.cause?.name ?? out.error.name;
      if (name === "UNKNOWN_ACCOUNT") throw new QuoteError("CONTRACT_MISSING", `${contractId} does not exist on testnet (contract not deployed yet?)`);
      if (name === "NO_CONTRACT_CODE") throw new QuoteError("CONTRACT_MISSING", `${contractId} has no contract deployed`);
      if (name === "INTERNAL_ERROR" || name === "TIMEOUT_ERROR" || name === "UNKNOWN_BLOCK" || out.error.code === -32603) {
        causes.push({ url, error: `RPC ${name}` });
        continue;
      }
      throw new QuoteError("VIEW_FAILED", `view ${method} failed: ${out.error.data ?? out.error.message ?? name}`);
    }
    if (out.result.error) {
      // Recorded 2026-11-11 (fastnear): an account with no code answers result.error "...CodeDoesNotExist...".
      if (/CodeDoesNotExist/.test(out.result.error)) throw new QuoteError("CONTRACT_MISSING", `${contractId} has no contract deployed`);
      throw new QuoteError("VIEW_FAILED", `view ${method} failed: ${out.result.error}`);
    }
    try {
      return { value: JSON.parse(utf8(out.result.result)), blockHash: out.result.block_hash };
    } catch {
      throw new QuoteError("VIEW_FAILED", `view ${method} returned unreadable JSON`);
    }
  }
  const err = new QuoteError("RPC_UNAVAILABLE", "testnet RPC unreachable; check your connection and retry");
  err.cause = causes;
  throw err;
}

/**
 * Reads the seller's record and on-chain quote, checks they match this module's formula,
 * and returns { seller, record, quoteMilli, quoteYocto, lines }. Throws QUOTE_MISMATCH
 * if the contract's quote differs from the formula (never prints a price we can't explain).
 */
export async function fetchQuote({ fetch: fetchFn, urls, contractId, seller }) {
  assertTestnetAccount(seller);
  const view = (method, blockId) => viewFunctionAt({ fetch: fetchFn, urls, contractId, method, args: { seller }, blockId });
  // Read quote at the same block as the record, so a job settling in between can't cause a false mismatch.
  const first = await view("get_record");
  const record = parseRecord(first.value);
  // Without a block hash the next read would silently fall back to finality=final and lose the pin.
  if (typeof first.blockHash !== "string" || !first.blockHash) throw new QuoteError("VIEW_FAILED", "get_record answer has no block_hash; cannot pin the quote read");
  const onChain = (await view("quote", first.blockHash)).value;
  if (typeof onChain !== "string" || !/^\d+$/.test(onChain)) throw new QuoteError("VIEW_FAILED", `quote returned ${JSON.stringify(onChain)}, expected a yoctoNEAR string`);
  const quoteYocto = BigInt(onChain);
  const q = quoteMilli(record);
  if (quoteYocto !== BigInt(q) * YOCTO_PER_MNEAR) {
    throw new QuoteError("QUOTE_MISMATCH", `on-chain quote ${onChain} yocto does not match the formula (${formatMilli(q)} NEAR from the record); refusing to quote`);
  }
  return { seller, record, quoteMilli: q, quoteYocto, lines: quoteLines(record) };
}
