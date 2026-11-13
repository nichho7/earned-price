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
//
// T-035 adds THE signing gate (security M-2): signJobAction() is the only code on the site that signs with the
// buyer key. It allows create / reveal / timeout to CONTRACT_ID only, with fixed gas, a deposit only on create
// (=== the live quote it reads itself), providers from RPC_URLS only, under the buyer lock, the budget checked
// right before create, the spend reserved and the tx hash saved before broadcast (the cli/pick.js pattern).
// Skills used: security-and-hardening, api-and-interface-design, karpathy-guidelines
import { SPEND_CAP_NEAR, SPEND_CAP_YOCTO, SpendCapError, assertCanSpend, formatNear, recordBurn, recordSpend, releaseSpend, spentYocto } from "../../cli/spend-cap.js";
import { fetchQuote } from "../../cli/quote.js";
import { outcomeOf, parseTxOutcome, sendCreateTx } from "../../cli/tx.js";
import { canonicalJson, commit } from "../../grader/grade.js";

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

// Gas reserve for one job: create (30 Tgas, cli/pick.js CREATE_GAS) + reveal (300 Tgas, cli/tx.js REVEAL_GAS)
// + timeout (100 Tgas, cli/tx.js TIMEOUT_GAS: the refund path the buyer signs; security M-2), priced at testnet's
// minimum gas price (1e8 yocto per gas; read live 2026-11-12 and 2026-11-13). That is the most one job's own txs
// can burn at that price (prepaid; unused gas is refunded), so it is a reservation, not a cost. A burn above it
// (a higher gas price, a retry) is still recorded after the fact with recordBurn, never refused.
const TGAS = 10n ** 12n;
export const CREATE_GAS = 30n * TGAS;
export const REVEAL_GAS = 300n * TGAS;
export const TIMEOUT_GAS = 100n * TGAS;
export const GAS_PRICE_YOCTO = 100_000_000n;
export const JOB_GAS_RESERVE_YOCTO = (CREATE_GAS + REVEAL_GAS + TIMEOUT_GAS) * GAS_PRICE_YOCTO; // 0.043 NEAR
/** How the reserve is priced, for the receipt line (M-2 item 3: "say which"). */
export const GAS_RESERVE_BASIS = "create + reveal + timeout at 1e8 yocto/gas";

export { SPEND_CAP_NEAR, SPEND_CAP_YOCTO, formatNear, recordBurn, recordSpend, spentYocto };

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

/** JSON-RPC over `urls` in order: the first answer (result or error) wins; none = RPC_UNAVAILABLE. */
export async function rpcCall(fetchFn, urls, method, params, timeoutMs = RPC_TIMEOUT_MS) {
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
  const out = await rpcCall(fetchFn, urls, "query", { request_type: "view_account", finality: "optimistic", account_id: accountId }, timeoutMs);
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
  const out = await rpcCall(fetchFn, urls, "query", { request_type: "view_access_key", finality: "optimistic", account_id: accountId, public_key: publicKey }, timeoutMs);
  if (out.result && !out.result.error && "permission" in out.result) return out.result.permission === "FullAccess";
  const e = out.error ?? {};
  const name = e.cause?.name ?? e.name ?? "";
  if (name === "UNKNOWN_ACCESS_KEY" || name === "UNKNOWN_ACCOUNT") return false;
  if (typeof out.result?.error === "string" && /does not exist while viewing/.test(out.result.error)) return false;
  throw new AccountError("RPC_UNAVAILABLE", "testnet RPC gave an unreadable answer");
}

/**
 * Code review O-7: asks EVERY RPC (not the first that answers). true if any sees our full-access key; false only
 * when at least two RPCs answer and all say "not ours"; anything less is RPC_UNAVAILABLE (retry, never "fresh").
 */
export async function keyOnAccountEvery(fetchFn, urls, accountId, publicKey, timeoutMs = RPC_TIMEOUT_MS) {
  const answers = [];
  for (const url of urls) {
    try {
      answers.push(await keyOnAccount(fetchFn, [url], accountId, publicKey, timeoutMs));
    } catch {
      // this RPC can't say
    }
  }
  if (answers.includes(true)) return true;
  if (answers.length >= 2) return false;
  throw new AccountError("RPC_UNAVAILABLE", "only one testnet RPC answered about this account's key; not enough to give it up");
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
      // Code review O-7 (T-035): a CREATED account may hold an open job whose reveal / timeout only this key can
      // sign. One RPC's "not yours" must not lead to "Start a fresh account": every RPC has to agree.
      if (await keyOnAccountEvery(fetchFn, rpcUrls, state.account_id, state.public_key)) {
        // another RPC sees our key after all: keep the account
      } else {
        throw new AccountError("ACCOUNT_KEY_MISSING", "this browser's key is not on the saved account");
      }
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

// ---------------------------------------------------------------------------------------------------------------
// T-035 · the browser job record (the CLI's .earned/job.json, in localStorage) and THE signing gate (security M-2).

export const JOB_KEY = "earned-price.job.v1";
/** The only methods the page may sign, with their fixed gas (cli/pick.js CREATE_GAS, cli/tx.js REVEAL_GAS / TIMEOUT_GAS). */
export const SIGNABLE = Object.freeze({ create: CREATE_GAS, reveal: REVEAL_GAS, timeout: TIMEOUT_GAS });
const JOB_ID_RE = /^\d{1,20}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PACK_RE = /^pack-[123]$/;
const DIGITS = /^\d+$/;
const MAX_RESPONSE_BYTES = 128 * 1024; // the escrow's own limit on a review response (cli/tx.js SUBMIT_GAS note)
const JOB_STATUSES = new Set(["sending", "unconfirmed", "open", "accepted", "closed", "failed"]);
const LIVE_STATUSES = new Set(["sending", "unconfirmed", "open", "accepted"]); // may hold escrow: no new create
const REQUEST_KEYS = new Set(["method", "args", "depositYocto", "seal", "onSigned"]);

/** The buyer without its private key: what every part of the page except the signer gets (M-2 item 4). */
export function publicBuyer(state) {
  if (!state) return null;
  const { private_key: _secret, ...rest } = state;
  return rest;
}

const optHash = (v) => v === null || v === undefined || (typeof v === "string" && TX_HASH_RE.test(v));

/** Same checks as the CLI's job file, plus the shapes the page renders (every tx hash becomes an href). */
export function validJob(j) {
  return Boolean(
    j && j.version === 1 && j.network === "testnet" && j.contract === CONTRACT_ID && j.seller === DEMO_SELLER &&
    typeof j.buyer === "string" && ACCOUNT_RE.test(j.buyer) && typeof j.pack_id === "string" && PACK_RE.test(j.pack_id) &&
    typeof j.commit_hash === "string" && HEX64.test(j.commit_hash) && typeof j.K === "string" && typeof j.salt === "string" && HEX64.test(j.salt) &&
    [j.price_yocto, j.reserve_yocto, j.burnt_yocto].every((v) => typeof v === "string" && DIGITS.test(v)) &&
    JOB_STATUSES.has(j.status) && (j.job_id === null || (typeof j.job_id === "string" && JOB_ID_RE.test(j.job_id))) &&
    optHash(j.create_tx) && optHash(j.accept_tx) && optHash(j.closing_tx) &&
    Array.isArray(j.close_txs) && j.close_txs.every((h) => typeof h === "string" && TX_HASH_RE.test(h)),
  );
}

/** The saved job, or null. Throws STORAGE_CORRUPT on an unreadable record (never repaired silently). */
export function loadJob(storage) {
  const raw = storage.getItem(JOB_KEY);
  if (raw == null) return null;
  let j = null;
  try { j = JSON.parse(raw); } catch { /* corrupt */ }
  if (!validJob(j)) throw new AccountError("STORAGE_CORRUPT", "the job saved in this browser is unreadable");
  return j;
}

export function saveJob(storage, job) {
  storage.setItem(JOB_KEY, JSON.stringify(job));
}

/** A job that may hold escrow (or whose create may have landed): the page opens no second one, and never offers "fresh". */
export const jobIsLive = (job) => Boolean(job && LIVE_STATUSES.has(job.status));

/** Re-reads the buyer from storage, without its key (code review O-2: no stale copy after a spend). */
export function readPublicBuyer(storage) {
  return publicBuyer(loadBuyer(storage));
}

/** Gas the signer paid for one tx: tokens_burnt over the tx and every receipt it caused (unused gas is refunded). */
export function burntOf(outcome) {
  const outs = [outcome?.transaction_outcome, ...(Array.isArray(outcome?.receipts_outcome) ? outcome.receipts_outcome : [])];
  let total = 0n;
  for (const o of outs) {
    const b = o?.outcome?.tokens_burnt;
    if (typeof b === "string" && DIGITS.test(b)) total += BigInt(b);
  }
  return total;
}

const exactKeys = (o, keys) => Boolean(o) && typeof o === "object" && !Array.isArray(o) &&
  Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
const refuse = (why) => new AccountError("BAD_SIGN_REQUEST", `refused to sign: ${why}`);

/** Everything about a sign request that can be checked without the network or the key. */
function checkRequest(req) {
  if (!req || typeof req !== "object") throw refuse("no request");
  for (const k of Object.keys(req)) if (!REQUEST_KEYS.has(k)) throw refuse(`unknown field ${JSON.stringify(k)} (receiver, gas and RPC are fixed)`);
  const { method, args, depositYocto, seal } = req;
  if (typeof method !== "string" || !Object.prototype.hasOwnProperty.call(SIGNABLE, method)) throw refuse(`method ${JSON.stringify(method)} is not create, reveal or timeout`);
  if (typeof depositYocto !== "bigint" || depositYocto < 0n) throw refuse("the deposit must be a yoctoNEAR bigint");
  if (method !== "create" && depositYocto !== 0n) throw refuse(`${method} carries no deposit`);
  if (method !== "create" && seal !== undefined) throw refuse("only create carries a sealed key");
  if (method === "create") {
    if (!exactKeys(args, ["seller", "commit_hash", "pack_id"])) throw refuse("create takes exactly seller, commit_hash, pack_id");
    if (args.seller !== DEMO_SELLER) throw refuse(`the seller must be the demo seller ${DEMO_SELLER}`);
    if (typeof args.commit_hash !== "string" || !HEX64.test(args.commit_hash)) throw refuse("commit_hash must be 64 lowercase hex");
    if (typeof args.pack_id !== "string" || !PACK_RE.test(args.pack_id)) throw refuse("pack_id must be pack-1, pack-2 or pack-3");
    if (depositYocto <= 0n) throw refuse("create needs the quote as its deposit");
    // The key + salt saved before broadcast must be the ones the commit seals (cli/pick.js assertKeyMatchesPack + seal).
    if (!exactKeys(seal, ["K", "salt"]) || typeof seal.K !== "string" || typeof seal.salt !== "string" || !HEX64.test(seal.salt)) throw refuse("create needs the sealed key and its 32-byte salt");
    let key;
    try { key = JSON.parse(seal.K); } catch { throw refuse("the sealed key is not JSON"); }
    if (canonicalJson(key) !== seal.K) throw refuse("the sealed key is not canonical JSON");
    if (key?.pack_id !== args.pack_id) throw refuse(`the sealed key is for ${JSON.stringify(key?.pack_id ?? null)}, not ${args.pack_id}`);
    let sealed;
    try { sealed = commit(key, seal.salt); } catch { throw refuse("the sealed key is not a valid answer key"); }
    if (sealed !== args.commit_hash) throw refuse("commit_hash is not sha256 of the sealed key and salt");
  } else if (method === "timeout") {
    if (!exactKeys(args, ["job_id"]) || typeof args.job_id !== "string" || !JOB_ID_RE.test(args.job_id)) throw refuse("timeout takes exactly a job_id");
  } else {
    if (!exactKeys(args, ["job_id", "key", "salt", "response"])) throw refuse("reveal takes exactly job_id, key, salt, response");
    if (typeof args.job_id !== "string" || !JOB_ID_RE.test(args.job_id)) throw refuse("reveal needs a job_id");
    if (typeof args.response !== "string" || new TextEncoder().encode(args.response).length > MAX_RESPONSE_BYTES) throw refuse("the review response is missing or too large");
  }
  return { method, args, depositYocto, seal };
}

/**
 * A closing outcome (decline, timeout or reveal; cli/tx.js outcomeOf) settles the job's spend record. Order (as
 * cli/hire.js M-2): the job is marked closed first, then the spend is released, so a crash in between over-counts,
 * never under-counts. The unused gas reserve is released; gas burnt above it is recorded (recordBurn, never refused);
 * a refund to this buyer (at most the price) is released. Returns { state, job }; a closed job is left as it is.
 */
function settleClose(storage, state, job, outcome, txHash) {
  if (job.status === "closed") return { state, job };
  const closed = { ...job, status: "closed", outcome: outcome.kind, closing_tx: txHash ?? job.closing_tx ?? null };
  saveJob(storage, closed);
  const reserve = BigInt(job.reserve_yocto);
  const burnt = BigInt(job.burnt_yocto);
  let next = burnt <= reserve ? releaseSpend(state, (reserve - burnt).toString()) : recordBurn(state, burnt - reserve);
  if (outcome.refundYocto && DIGITS.test(outcome.refundYocto)) {
    const price = BigInt(job.price_yocto);
    const r = BigInt(outcome.refundYocto);
    next = releaseSpend(next, (r < price ? r : price).toString());
  }
  saveBuyer(storage, next);
  return { state: next, job: closed };
}

/**
 * A closing tx this page did not sign (the seller's decline), already parsed and checked by the caller
 * (cli/tx.js parseTxOutcome + outcomeOf for this job and buyer): close the job and settle its spend, under the lock.
 * Returns the public buyer and the job.
 */
export async function recordJobClosed({ storage, nav }, outcome, txHash) {
  return withBuyerLock(nav, async () => {
    const state = loadBuyer(storage);
    const job = loadJob(storage);
    if (!state || !job) throw new AccountError("STORAGE_CORRUPT", "the buyer or the job saved in this browser is missing");
    const r = settleClose(storage, state, job, outcome, txHash);
    return { buyer: publicBuyer(r.state), job: r.job };
  });
}

/** Records the seller's accept on the saved job (status accepted + its tx), under the lock. */
export async function recordJobAccepted({ storage, nav }, acceptTx) {
  return withBuyerLock(nav, async () => {
    const job = loadJob(storage);
    if (!job || (job.status !== "open" && job.status !== "accepted")) return job;
    const next = { ...job, status: "accepted", accept_tx: acceptTx };
    saveJob(storage, next);
    return next;
  });
}

/**
 * THE signing gate (security M-2): the only code on the site that signs with the buyer key.
 * deps: { storage, nav, fetch, loadNear } (loadNear = the page's lazy import of near-api-js + its rpc-errors, R4: wallet
 * code is imported only from app/live/; it is loaded BEFORE anything is booked, so a failed load leaves no reservation). req: { method, args, depositYocto, seal? (create), onSigned? }.
 *  - receiverId is CONTRACT_ID, gas is SIGNABLE[method], providers come from RPC_URLS: none of them can be passed in.
 *  - method in { create, reveal, timeout }; a deposit only on create, and only === the quote this gate reads itself.
 *  - under withBuyerLock; the buyer and job are re-read from storage inside it (no stale copy, review O-2).
 *  - create: no live job, checkJobBudget right before, the quote + gas reserve booked (recordSpend) and the key +
 *    salt + tx hash saved before broadcast (cli/pick.js). Not sent = released; unknown = kept, job "unconfirmed".
 *  - reveal / timeout: only for the saved job (its job_id; reveal only the key + salt it committed).
 *  - this browser's key must still be on the account (keyOnAccount) before anything is signed.
 * Returns { outcome, parsed, job, buyer } with the buyer WITHOUT its private key; throws AccountError otherwise.
 */
export async function signJobAction(deps, req) {
  const { method, args, depositYocto, seal } = checkRequest(req);
  const { storage, nav, fetch: fetchFn } = deps;
  if (typeof deps.loadNear !== "function") throw new AccountError("WALLET_LOAD_FAILED", "no near-api-js loader");
  return withBuyerLock(nav, async () => {
    let state = loadBuyer(storage);
    if (!state || state.status !== "created") throw new AccountError("NO_BUYER", "no testnet buyer in this browser yet");
    let job = loadJob(storage);
    let quoteYocto = null;
    if (method === "create") {
      if (jobIsLive(job)) throw new AccountError("JOB_OPEN", `job ${job.job_id ?? "(create not confirmed)"} is still ${job.status}; finish it first`);
      quoteYocto = (await readLiveQuote(fetchFn)).quoteYocto; // RPC_URLS only
      if (depositYocto !== quoteYocto) {
        throw Object.assign(new AccountError("QUOTE_CHANGED", "the deposit is not the seller's live quote"), { quoteYocto });
      }
      const budget = checkJobBudget(state, quoteYocto); // right before create (T-076)
      if (!budget.fits) throw Object.assign(new AccountError("CAP_REACHED", "quote + gas reserve is over what is left of the spend cap"), { budget });
    } else {
      if (!job || job.job_id !== args.job_id) throw new AccountError("NO_JOB", `job ${args.job_id} is not this browser's job`);
      if (method === "timeout" && job.status !== "open" && job.status !== "accepted") throw new AccountError("NO_JOB", `job ${args.job_id} is ${job.status}`);
      if (method === "reveal" && (job.status !== "accepted" || args.key !== job.K || args.salt !== job.salt)) {
        throw refuse("reveal sends only the key and salt this job committed, on an accepted job");
      }
    }
    if (!(await keyOnAccount(fetchFn, RPC_URLS, state.account_id, state.public_key))) {
      throw new AccountError("ACCOUNT_KEY_MISSING", "this browser's key is not on the saved account");
    }
    let near, rpcErrors;
    try {
      ({ near, rpcErrors } = await deps.loadNear());
    } catch {
      throw new AccountError("WALLET_LOAD_FAILED", "near-api-js failed to load");
    }

    const before = state;
    if (method === "create") {
      state = recordSpend(state, quoteYocto + JOB_GAS_RESERVE_YOCTO); // refuses past the cap; a crash after this over-counts
      saveBuyer(storage, state);
      job = {
        version: 1, network: "testnet", contract: CONTRACT_ID, buyer: state.account_id, seller: DEMO_SELLER,
        pack_id: args.pack_id, commit_hash: args.commit_hash, K: seal.K, salt: seal.salt,
        price_yocto: quoteYocto.toString(), reserve_yocto: JOB_GAS_RESERVE_YOCTO.toString(), burnt_yocto: "0",
        status: "sending", job_id: null, create_tx: null, close_txs: [],
      };
      saveJob(storage, job);
    }
    const onSigned = (txHash) => {
      job = method === "create" ? { ...job, create_tx: txHash } : { ...job, close_txs: [...job.close_txs, txHash] };
      saveJob(storage, job); // before broadcast: an unknown outcome can be looked up later
      try { req.onSigned?.(txHash); } catch { /* a view callback never stops the send */ }
    };
    const makeAccount = (url, st) => {
      if (!RPC_URLS.includes(url)) throw new Error("refused: provider not in RPC_URLS");
      return new near.Account(st.account_id, new near.JsonRpcProvider({ url }, { retries: 2 }), st.private_key);
    };
    let outcome;
    try {
      outcome = await sendCreateTx({ urls: RPC_URLS, makeAccount, state, contractId: CONTRACT_ID, methodName: method, args, depositYocto, gas: SIGNABLE[method], onSigned, near, rpcErrors });
    } catch (err) {
      if (err?.notSent) {
        if (method === "create") {
          saveBuyer(storage, before); // it can't land: release the reservation
          saveJob(storage, { ...job, status: "failed" });
        }
        throw new AccountError("NOT_SENT", `${method} did not reach testnet; nothing moved`);
      }
      if (method === "create") saveJob(storage, { ...job, status: "unconfirmed" });
      throw new AccountError("SEND_UNCONFIRMED", `${method} was sent but no result came back`);
    }

    let parsed;
    try {
      parsed = parseTxOutcome(outcome, CONTRACT_ID);
    } catch {
      if (method === "create") saveJob(storage, { ...job, status: "unconfirmed" });
      throw new AccountError("SEND_UNCONFIRMED", `${method} returned an unreadable result`);
    }
    const burnt = burntOf(outcome);
    job = { ...job, burnt_yocto: (BigInt(job.burnt_yocto) + burnt).toString() };
    if (method === "create") {
      if (parsed.failure) {
        // A definite refusal moved no deposit; the gas it burnt is real (recordBurn, never refused).
        saveJob(storage, { ...job, status: "failed", create_tx: parsed.txHash ?? job.create_tx });
        saveBuyer(storage, recordBurn(before, burnt));
        throw Object.assign(new AccountError("CREATE_REFUSED", `create refused on testnet: ${parsed.failure}`), { txHash: parsed.txHash });
      }
      const ev = parsed.events.find((e) => e.event === "create" && e.data.buyer === state.account_id && e.data.commit_hash === args.commit_hash);
      if (!ev || typeof ev.data.job_id !== "string" || !JOB_ID_RE.test(ev.data.job_id)) {
        saveJob(storage, { ...job, status: "unconfirmed" });
        throw new AccountError("SEND_UNCONFIRMED", "create landed without this job's create event");
      }
      job = { ...job, status: "open", job_id: ev.data.job_id, create_tx: parsed.txHash ?? job.create_tx };
      saveJob(storage, job);
      return { outcome, parsed, job, buyer: publicBuyer(state) };
    }
    saveJob(storage, job);
    if (parsed.failure) throw Object.assign(new AccountError("TX_REFUSED", `${method} refused on testnet: ${parsed.failure}`), { txHash: parsed.txHash, failure: parsed.failure });
    const closed = outcomeOf(parsed.events, job.job_id, state.account_id);
    if (closed) ({ state, job } = settleClose(storage, state, job, closed, parsed.txHash));
    return { outcome, parsed, job, buyer: publicBuyer(state), closed };
  });
}

/**
 * A create whose outcome this page never saw (status sending / unconfirmed with its tx hash saved before broadcast):
 * look it up by hash, under the lock (cli/pick.js reconcileCreate). Landed = the job is open; refused = failed and
 * the reservation released (its burnt gas kept); unknown = unchanged. Returns the job.
 */
export async function reconcileCreate({ storage, nav, fetch: fetchFn }) {
  return withBuyerLock(nav, async () => {
    const state = loadBuyer(storage);
    let job = loadJob(storage);
    if (!state || !job || (job.status !== "sending" && job.status !== "unconfirmed") || !job.create_tx) return job;
    let outcome = null;
    try {
      const out = await rpcCall(fetchFn, RPC_URLS, "tx", { tx_hash: job.create_tx, sender_account_id: state.account_id, wait_until: "EXECUTED_OPTIMISTIC" });
      outcome = out.result && typeof out.result === "object" ? out.result : null;
    } catch {
      outcome = null;
    }
    if (!outcome) return job;
    let parsed;
    try { parsed = parseTxOutcome(outcome, CONTRACT_ID); } catch { return job; }
    const burnt = burntOf(outcome);
    if (parsed.failure) {
      job = { ...job, status: "failed", burnt_yocto: burnt.toString() };
      saveJob(storage, job);
      const reserved = BigInt(job.price_yocto) + BigInt(job.reserve_yocto);
      saveBuyer(storage, recordBurn(releaseSpend(state, reserved.toString()), burnt));
      return job;
    }
    const ev = parsed.events.find((e) => e.event === "create" && e.data.buyer === state.account_id && e.data.commit_hash === job.commit_hash);
    if (!ev || !JOB_ID_RE.test(String(ev.data.job_id))) return job;
    job = { ...job, status: "open", job_id: String(ev.data.job_id), burnt_yocto: burnt.toString() };
    saveJob(storage, job);
    return job;
  });
}
