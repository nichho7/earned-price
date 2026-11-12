// [CTO] T-034 / S-009 · the browser throwaway testnet buyer account (browser-safe, no wallet imports).
//
// The same account model as `earned init` (cli/init.js), moved into the browser:
//  - The key is made in this browser (near-api-js KeyPair, injected as `keyGen` from app/live/ so the
//    wallet code stays lazy, R4) and saved to localStorage BEFORE the faucet call, so a crash or a reload
//    never loses it. Only the PUBLIC key ever leaves the browser (faucet body + RPC view args).
//  - The account is created by the public NEAR testnet faucet helper that near-cli-rs uses
//    (helper.nearprotocol.com/account; it sends CORS headers for any origin, checked 2026-11-12). No
//    server of ours holds a key or funds anything, so no secret can reach the bundle.
//  - Spend is capped by cli/spend-cap.js (imported, not forked): SPEND_CAP_YOCTO is the one named cap, and
//    every cap number the page shows comes from it or SPEND_CAP_NEAR (code review R-1; a drift test pins the two).
//    The faucet funds far more than the cap on chain; the cap is this page's spend guard, as in the CLI.
//  - Before a job the page checks: live quote + JOB_GAS_RESERVE_YOCTO fits under what is left of the cap.
//
// All network access, storage, randomness and time are injected, so the unit tests never touch the network.
// Skills used: security-and-hardening, api-and-interface-design, karpathy-guidelines
import { SPEND_CAP_NEAR, SPEND_CAP_YOCTO, SpendCapError, assertCanSpend, formatNear, recordSpend, spentYocto } from "../../cli/spend-cap.js";
import { fetchQuote } from "../../cli/quote.js";

// Same values as cli/init.js FAUCET_URL / RPC_URLS, cli/pick.js DEMO_SELLER and names.json (drift tests in
// account.test.ts). Copied, not imported: those modules read files with node:fs and can't ship to a browser.
export const FAUCET_URL = "https://helper.nearprotocol.com/account";
export const RPC_URLS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
export const CONTRACT_ID = "earned-price.testnet";
export const DEMO_SELLER = "seller.earned-price.testnet";

export const STORAGE_KEY = "earned-price.buyer.v1";
export const ACCOUNT_PREFIX = "earned-price-web-";
export const FAUCET_TIMEOUT_MS = 20_000;
export const RPC_TIMEOUT_MS = 10_000;

// Gas reserve for one job: create (30 Tgas, cli/pick.js CREATE_GAS) + reveal (300 Tgas, cli/tx.js REVEAL_GAS),
// priced at testnet's minimum gas price (1e8 yocto per gas; read live 2026-11-12). That is the most one job's
// own txs can burn at that price (prepaid; unused gas is refunded), so it is a reservation, not a cost.
const TGAS = 10n ** 12n;
export const CREATE_GAS = 30n * TGAS;
export const REVEAL_GAS = 300n * TGAS;
export const GAS_PRICE_YOCTO = 100_000_000n;
export const JOB_GAS_RESERVE_YOCTO = (CREATE_GAS + REVEAL_GAS) * GAS_PRICE_YOCTO; // 0.033 NEAR

export { SPEND_CAP_NEAR, SPEND_CAP_YOCTO, formatNear, recordSpend, spentYocto };

export class AccountError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AccountError";
    this.code = code;
  }
}

const FAUCET_FALSE = "ZmFsc2U="; // base64("false"): the helper's "refused" SuccessValue (cli/init.js)
const KEY_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,90}$/;
const TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // a base58 tx hash; also guards create_tx read back from storage (L-2)
export const KEY_CHECK_TRIES = 3; // the faucet's "created" is checked on chain; a lagging RPC gets 3 looks, 1 s apart
const ACCOUNT_RE = /^[a-z0-9]+([_-][a-z0-9]+)*\.testnet$/;

/** A fresh top-level testnet name: earned-price-web-<12 hex>.testnet (48 random bits). */
export function newAccountId(randomBytes) {
  const b = randomBytes(6);
  return `${ACCOUNT_PREFIX}${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}.testnet`;
}

/** Same shape and checks as the CLI's key file (cli/init.js validState), plus the testnet-only name rule. */
export function validBuyer(s) {
  return Boolean(
    s && s.version === 1 && s.network === "testnet" &&
    typeof s.account_id === "string" && s.account_id.length <= 64 && ACCOUNT_RE.test(s.account_id) &&
    typeof s.public_key === "string" && KEY_RE.test(s.public_key) &&
    typeof s.private_key === "string" && KEY_RE.test(s.private_key) &&
    (s.status === "pending" || s.status === "created") &&
    (s.create_tx === undefined || (typeof s.create_tx === "string" && TX_HASH_RE.test(s.create_tx))), // security L-2
  );
}

/** Reads the saved buyer. null when there is none; throws STORAGE_CORRUPT on an unreadable record. */
export function loadBuyer(storage) {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw == null) return null;
  let s = null;
  try { s = JSON.parse(raw); } catch { /* corrupt */ }
  if (!validBuyer(s)) throw new AccountError("STORAGE_CORRUPT", "the buyer account saved in this browser is unreadable");
  try { spentYocto(s); } catch { throw new AccountError("STORAGE_CORRUPT", "the spend record saved in this browser is unreadable"); }
  return s;
}

export function saveBuyer(storage, state) {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function clearBuyer(storage) {
  storage.removeItem(STORAGE_KEY);
}

/**
 * localStorage when this browser allows it, else an in-memory store (private mode, blocked site data).
 * `persistent: false` tells the page to say the account lasts only while the tab is open.
 */
export function pickStorage(win) {
  try {
    const ls = win.localStorage;
    const probe = `${STORAGE_KEY}.probe`;
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return { storage: ls, persistent: true };
  } catch {
    const m = new Map();
    return {
      storage: { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) },
      persistent: false,
    };
  }
}

async function rpc(fetchFn, urls, method, params, timeoutMs) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "earned", method, params });
  for (const url of urls) {
    let out;
    try {
      const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      out = await res.json();
    } catch {
      continue; // network error, timeout, unreadable body: next RPC
    }
    if (out && typeof out === "object" && (out.result || out.error)) return out;
  }
  throw new AccountError("RPC_UNAVAILABLE", "testnet RPC didn't answer");
}

/** true / false from the first RPC that answers; "does not exist" is an answer, not an outage (cli/init.js). */
export async function accountExists(fetchFn, urls, accountId, timeoutMs = RPC_TIMEOUT_MS) {
  // optimistic: an account the faucet just made is visible before it is final, so a reload right after
  // creation never asks the faucet for the same name twice.
  const out = await rpc(fetchFn, urls, "query", { request_type: "view_account", finality: "optimistic", account_id: accountId }, timeoutMs);
  if (out.result && !out.result.error) return true;
  const e = out.error ?? {};
  const text = `${e.cause?.name ?? ""} ${e.name ?? ""} ${e.data ?? ""} ${e.message ?? ""} ${out.result?.error ?? ""}`;
  if (/UNKNOWN_ACCOUNT|does not exist/i.test(text)) return false;
  throw new AccountError("RPC_UNAVAILABLE", "testnet RPC gave an unreadable answer");
}

/**
 * Security L-1: is OUR public key a full-access key on the account? true / false from the first RPC that
 * answers; "no such key" and "no such account" are answers (shapes as site-api/chain.js viewAccessKey,
 * near-api-js 7.4.0). Never trust "the account exists" or the faucet's "success" alone.
 */
export async function keyOnAccount(fetchFn, urls, accountId, publicKey, timeoutMs = RPC_TIMEOUT_MS) {
  const out = await rpc(fetchFn, urls, "query", { request_type: "view_access_key", finality: "optimistic", account_id: accountId, public_key: publicKey }, timeoutMs);
  if (out.result && !out.result.error && "permission" in out.result) return out.result.permission === "FullAccess";
  const e = out.error ?? {};
  const name = e.cause?.name ?? e.name ?? "";
  if (name === "UNKNOWN_ACCESS_KEY" || name === "UNKNOWN_ACCOUNT") return false;
  if (typeof out.result?.error === "string" && /does not exist while viewing/.test(out.result.error)) return false;
  throw new AccountError("RPC_UNAVAILABLE", "testnet RPC gave an unreadable answer");
}

/** Asks the testnet faucet helper to create and fund the account. Only the public key is sent. */
export async function createViaFaucet(fetchFn, accountId, publicKey, timeoutMs = FAUCET_TIMEOUT_MS) {
  let res;
  try {
    res = await fetchFn(FAUCET_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    throw new AccountError(timedOut ? "FAUCET_TIMEOUT" : "FAUCET_UNREACHABLE", timedOut ? "the testnet faucet timed out" : "the testnet faucet is unreachable");
  }
  if (res.status === 429) throw new AccountError("FAUCET_RATE_LIMITED", "the testnet faucet is rate limiting requests");
  if (!res.ok) throw new AccountError("FAUCET_HTTP", `the testnet faucet returned HTTP ${res.status}`);
  let body;
  try { body = await res.json(); } catch { throw new AccountError("FAUCET_BAD_RESPONSE", "the testnet faucet sent an unreadable answer"); }
  const status = body?.status;
  if (!status || typeof status !== "object") throw new AccountError("FAUCET_BAD_RESPONSE", "the testnet faucet sent no transaction result");
  if (status.Failure) throw new AccountError("FAUCET_TX_FAILED", "the account creation transaction failed on testnet");
  if (status.SuccessValue === FAUCET_FALSE) throw new AccountError("FAUCET_REFUSED", "the testnet faucet refused this account name");
  const hash = body?.transaction?.hash ?? body?.transaction_outcome?.id ?? null;
  return typeof hash === "string" && TX_HASH_RE.test(hash) ? hash : null;
}

/**
 * Creates or reuses this browser's buyer. deps: { storage, fetch, keyGen, randomBytes, now, rpcUrls?, onStep?, sleep? }.
 * An account is adopted or counted as created only when this browser's public key is on it (security L-1).
 * onStep({ step: "key", status: "made" | "reused" }) and onStep({ step: "account", status: "checking" |
 * "creating" | "created" | "reused", accountId, txHash? }) drive the receipt lines.
 * Returns { state, keyReused, created, txHash }.
 */
export async function startAccount(deps) {
  const { storage, fetch: fetchFn, keyGen, randomBytes, now = () => new Date(), rpcUrls = RPC_URLS } = deps;
  const onStep = deps.onStep ?? (() => {});
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const ours = () => keyOnAccount(fetchFn, rpcUrls, state.account_id, state.public_key);
  let state = loadBuyer(storage);
  const keyReused = Boolean(state);
  if (!state) {
    const { publicKey, privateKey } = await keyGen();
    state = {
      version: 1,
      network: "testnet",
      account_id: newAccountId(randomBytes),
      public_key: publicKey,
      private_key: privateKey,
      status: "pending",
      spent_yocto: "0",
      created_at: now().toISOString(),
    };
    saveBuyer(storage, state); // before the faucet call: a crash never loses the key
  }
  onStep({ step: "key", status: keyReused ? "reused" : "made" });
  onStep({ step: "account", status: "checking", accountId: state.account_id });

  let txHash = null;
  let created = false;
  if (await accountExists(fetchFn, rpcUrls, state.account_id)) {
    if (!(await ours())) {
      // Someone else's account (a name clash, or an RPC that lies about "exists"). A pending key never
      // controlled it: drop it so Try again makes a new name. A created account is never dropped silently.
      if (state.status === "pending") {
        clearBuyer(storage);
        throw new AccountError("ACCOUNT_TAKEN", "that account name belongs to someone else");
      }
      throw new AccountError("ACCOUNT_KEY_MISSING", "this browser's key is not on the saved account");
    }
  } else {
    onStep({ step: "account", status: "creating", accountId: state.account_id });
    try {
      txHash = await createViaFaucet(fetchFn, state.account_id, state.public_key);
    } catch (err) {
      // The faucet refused the name. Before dropping the pending key, check the chain: another tab (no
      // navigator.locks) or a lost answer may already have made the account with THIS key (L-1). If the RPC
      // can't say, keep the key; the next try re-checks. Never drop a "created" account (it may hold a job).
      if (err?.code !== "FAUCET_REFUSED" || state.status !== "pending") throw err;
      const mine = await ours().catch(() => null); // null: the RPC can't say
      if (mine !== true) {
        if (mine === false) clearBuyer(storage);
        throw err;
      }
      // mine === true: the account is ours after all, so it is adopted below.
    }
    // The faucet's "success" is not proof: the key must be on the account. The key stays saved as
    // pending, so if the chain is slow, Try again adopts the account instead of making another.
    let onChain = false;
    for (let i = 0; i < KEY_CHECK_TRIES && !onChain; i++) {
      if (i) await sleep(1000);
      onChain = await ours();
    }
    if (!onChain) throw new AccountError("FAUCET_BAD_RESPONSE", "the faucet answered, but this browser's key is not on the account");
    created = true;
  }
  if (state.status !== "created" || created) {
    state = { ...state, status: "created", ...(txHash ? { create_tx: txHash } : {}) };
    saveBuyer(storage, state);
  }
  onStep({ step: "account", status: created ? "created" : "reused", accountId: state.account_id, txHash: txHash ?? state.create_tx ?? null });
  return { state, keyReused, created, txHash };
}

/** { capYocto, spentYocto, leftYocto } for the receipt's cap line. */
export function capStatus(state) {
  const spent = spentYocto(state);
  const left = SPEND_CAP_YOCTO > spent ? SPEND_CAP_YOCTO - spent : 0n;
  return { capYocto: SPEND_CAP_YOCTO, spentYocto: spent, leftYocto: left };
}

/**
 * The pre-job check (T-035 calls it right before `create`): does quote + gas reserve fit under what is left
 * of the cap? Uses cli/spend-cap.js assertCanSpend, so the boundary is the CLI's (total <= cap passes).
 * Returns { fits, needYocto, ...capStatus }.
 */
export function checkJobBudget(state, quoteYocto) {
  if (typeof quoteYocto !== "bigint" || quoteYocto <= 0n) throw new AccountError("BAD_QUOTE", "quote must be a positive yoctoNEAR bigint");
  const needYocto = quoteYocto + JOB_GAS_RESERVE_YOCTO;
  let fits = true;
  try {
    assertCanSpend(state, needYocto);
  } catch (err) {
    if (!(err instanceof SpendCapError)) throw err;
    fits = false;
  }
  return { fits, needYocto, ...capStatus(state) };
}

/** Reads the demo seller's live quote (cli/quote.js: record + quote at one block, formula checked). */
export async function readLiveQuote(fetchFn, rpcUrls = RPC_URLS) {
  try {
    const q = await fetchQuote({ fetch: fetchFn, urls: rpcUrls, contractId: CONTRACT_ID, seller: DEMO_SELLER });
    return { quoteYocto: q.quoteYocto, quoteMilli: q.quoteMilli };
  } catch (err) {
    throw new AccountError("QUOTE_UNAVAILABLE", `couldn't read the seller's quote (${err?.code ?? "error"})`);
  }
}

/**
 * "0.040" style, 3 decimals (m001 §1). `up` rounds a need / a spend up and the default rounds what is
 * left down, so the page never shows more room than the cap really has.
 */
export function near3(yocto, up = false) {
  const unit = 10n ** 21n;
  const milli = up ? (yocto + unit - 1n) / unit : yocto / unit;
  return `${milli / 1000n}.${String(milli % 1000n).padStart(3, "0")}`;
}

/** Runs fn under a cross-tab lock when the browser has one, so two tabs never make two accounts at once. */
export async function withBuyerLock(nav, fn) {
  if (nav?.locks?.request) return nav.locks.request("earned-price-buyer", fn);
  return fn();
}
