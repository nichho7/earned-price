// `earned pick N` (S-021 / T-030): seal pack N's answer key, haggle with the seller and lock the
// agreed price in testnet escrow with create(seller, commit_hash, pack_id).
//
// Order (nothing is sent until every local and read-only check passes):
//   0. a non-demo seller needs --yes (the payee is shown with its source); one pick at a time (pick.lock)
//   1. buyer from `earned init`; refuse unless the earlier job is failed/closed (its salt is needed to
//      reveal). An unconfirmed earlier create is looked up by its tx hash first.
//   2. load pack N, seal its key (fresh 32-byte salt), L-1: the key's own pack_id must be pack-N
//   3. pre-flight: our review request for pack-N equals the contract's live pin (review_pins)
//   4. read the on-chain quote (fetchQuote), haggle: opening offer 0.020, then the quote
//   5. spend cap: reserve the deposit (assertCanSpend/recordSpend), archive the old job file to
//      .earned/jobs/, save K + salt, sign (tx hash saved), then broadcast create
// The job file (.earned/job.json, 0600) keeps K and salt byte-for-byte until `earned hire` reveals.
// A finished job file is archived, never overwritten. T-031 hire must end a job with status "closed".
// All network access is injected (fetch for views, sendCreate for the tx), so tests never touch it.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_ACCOUNT, NETWORK } from "./names.js";
import { RPC_RETRIES, RPC_URLS, assertTestnet, assertTestnetRpc, loadState, redact, saveState, stateDir } from "./init.js";
import { assertCanSpend, formatNear, recordSpend } from "./spend-cap.js";
import { assertTestnetAccount, evaluateOffer, fetchQuote, formatMilli, parseNearToMilli, viewFunction } from "./quote.js";
import { loadPack as loadPackDefault, sealKey } from "../packs/packs.js";
import { requestSha256 } from "../seller/review-prompt.js";

// Demo seller: a sub-account of the escrow account, so only we can create it (same reasoning
// as the deploy smoke seller). T-027's seller agent runs as this account. Override: --seller plus
// --yes (security L-2). There is deliberately no environment override: a leftover env var must
// never change the payee silently.
export const DEMO_SELLER = "seller.earned-price.testnet";
export const OPENING_OFFER_MILLI = 20; // the scripted counteroffer (PRD beat 2): below the 0.025 floor
export const CREATE_GAS = 30n * 10n ** 12n; // 30 Tgas: create writes one job and may refund excess
export const JOB_FILE_NAME = "job.json";
export const JOBS_ARCHIVE_DIR = "jobs";
export const LOCK_FILE_NAME = "pick.lock";
export const EXPLORER = "https://testnet.nearblocks.io";
const PACK_IDS = ["1", "2", "3"];
const USAGE = "usage: earned pick <1|2|3> [--offer 0.02] [--seller seller.testnet --yes]";

export class PickError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "PickError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/** argv after "pick" -> { pack, offer, seller, yes }. Strict, like parseQuoteArgs. */
export function parsePickArgs(argv) {
  let pack;
  let offer;
  let seller;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--offer") {
      if (offer !== undefined) throw new PickError("USAGE", `--offer given twice; ${USAGE}`);
      const v = argv[++i];
      if (v === undefined || v === "" || v.startsWith("--")) throw new PickError("BAD_OFFER", "--offer needs a NEAR amount like 0.02");
      offer = v;
    } else if (a === "--seller") {
      const v = argv[++i];
      if (seller !== undefined || v === undefined || v.startsWith("--")) throw new PickError("USAGE", USAGE);
      seller = v;
    } else if (a === "--yes") {
      if (yes) throw new PickError("USAGE", USAGE);
      yes = true;
    } else if (a.startsWith("--") || pack !== undefined || !PACK_IDS.includes(a)) {
      throw new PickError("USAGE", USAGE);
    } else {
      pack = a;
    }
  }
  if (pack === undefined) throw new PickError("USAGE", USAGE);
  return { pack, offer, seller, yes };
}

/**
 * Security L-1 (T-048 review): the key sealed for a job must be for the job's pack. A key for
 * another pack is only caught at reveal, where it is the buyer's fault and the R2 timeout pays
 * the seller. Checked on K itself, the exact bytes the reveal will send. Returns the pack_id.
 */
export function assertKeyMatchesPack(K, packId) {
  let keyPack;
  try {
    keyPack = JSON.parse(K)?.pack_id;
  } catch {
    keyPack = undefined;
  }
  if (keyPack !== packId) {
    throw new PickError("KEY_PACK_MISMATCH", `refused: the sealed answer key is for ${JSON.stringify(keyPack ?? null)}, but you picked ${packId}. No transaction was sent.`);
  }
  return packId;
}

/** Seals pack N's key for one job: { pack_id, K, salt, commit_hash }. pack_id comes from the key. */
export function sealPick(pack, n, salt) {
  const sealed = salt === undefined ? sealKey(pack.key) : sealKey(pack.key, salt);
  const pack_id = assertKeyMatchesPack(sealed.K, `pack-${n}`);
  return { pack_id, ...sealed };
}

/**
 * Scripted haggle: the buyer opens at `openingMilli`; if the seller refuses, the buyer pays the
 * quote. Pass fetchQuote().quoteMilli only (T-026). Returns the seller's answers with the offers.
 */
export function haggle(quoteM, openingMilli = OPENING_OFFER_MILLI) {
  const first = { offerMilli: openingMilli, ...evaluateOffer(openingMilli, quoteM) };
  if (first.accept) return [first];
  return [first, { offerMilli: quoteM, ...evaluateOffer(quoteM, quoteM) }];
}

/** Optional pre-flight from the T-048 review: our pack-N request hash equals the live pin. */
export async function checkPin({ fetch: fetchFn, urls, contractId, pack, pack_id }) {
  const pins = await viewFunction({ fetch: fetchFn, urls, contractId, method: "review_pins" });
  const live = Array.isArray(pins?.packs) ? pins.packs.find((p) => p?.pack_id === pack_id)?.request_sha256 : undefined;
  const local = requestSha256(pack);
  if (live !== local) {
    throw new PickError(
      "PIN_MISMATCH",
      `refused: this CLI's ${pack_id} review request (${local.slice(0, 12)}…) is not the contract's pinned one (${live ? `${String(live).slice(0, 12)}…` : "none"}); the seller's review would be rejected. Update earned-price. No transaction was sent.`,
    );
  }
  return local;
}

export const jobFilePath = (dir) => join(dir, JOB_FILE_NAME);

/** The current job, or null. Throws on an unsafe or corrupt file. */
export function loadJob(dir) {
  const file = jobFilePath(dir);
  if (!existsSync(file)) return null;
  const st = lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile()) throw new PickError("JOB_FILE_UNSAFE", `refused: ${file} is not a regular file`);
  try {
    const job = JSON.parse(readFileSync(file, "utf8"));
    if (job && typeof job === "object" && typeof job.status === "string") return job;
  } catch {
    // fall through
  }
  throw new PickError("JOB_FILE_CORRUPT", `refused: ${file} is not a valid job file; move it aside only if no job is open`);
}

/** Atomic 0600 write next to the buyer key (the folder is 0700 and self-gitignored by init). */
export function saveJob(dir, job) {
  const file = jobFilePath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(job, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

/**
 * Moves a finished job file to .earned/jobs/<time>-<pack>-<job>.json (0700 folder), so an old K +
 * salt is never overwritten. Returns the archive path.
 */
export function archiveJob(dir, prior, now = new Date()) {
  const archive = join(dir, JOBS_ARCHIVE_DIR);
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  chmodSync(archive, 0o700);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const name = `${stamp}-${prior.pack_id ?? "pack"}-${prior.job_id ?? "unsent"}-${process.pid}.json`.replace(/[^\w.-]/g, "_");
  const dest = join(archive, name);
  renameSync(jobFilePath(dir), dest);
  return dest;
}

export const STALE_LOCK_MS = 2 * 60 * 1000;

/** True when the process that wrote this lock is gone (ESRCH), or the lock has no pid and is old. */
function lockIsStale(lock, now) {
  let body;
  let mtimeMs;
  try {
    body = readFileSync(lock, "utf8").trim();
    mtimeMs = lstatSync(lock).mtimeMs;
  } catch (err) {
    if (err?.code === "ENOENT") return { stale: true, pid: null }; // released meanwhile
    throw err;
  }
  const pid = /^\d+$/.test(body) ? Number(body) : NaN;
  if (Number.isSafeInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return { stale: false, pid };
    } catch (err) {
      return { stale: err?.code === "ESRCH", pid }; // EPERM: alive, not ours to judge
    }
  }
  return { stale: now - mtimeMs > STALE_LOCK_MS, pid: null };
}

/**
 * One pick at a time (security L-1): an exclusive lock file holding our pid (0600); returns the
 * release function. Ctrl+C skips `finally`, so a lock whose pid is dead (or an empty, unreadable
 * lock older than 2 min) is removed once, with a message, and acquisition retried (review N-1).
 */
export function acquirePickLock(dir, { say = () => {}, now = Date.now() } = {}) {
  const lock = join(dir, LOCK_FILE_NAME);
  const take = () => writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    take();
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    const { stale, pid } = lockIsStale(lock, now);
    if (!stale) {
      throw new PickError("PICK_LOCKED", `refused: another \`earned pick\` is running (${lock} exists${pid ? `, pid ${pid}` : ""}). If none is, delete that file and retry. Nothing was sent.`);
    }
    say(`removed a stale lock from pid ${pid ?? "unknown"} (${lock})`);
    try {
      unlinkSync(lock);
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    try {
      take();
    } catch (e) {
      if (e?.code === "EEXIST") throw new PickError("PICK_LOCKED", `refused: another \`earned pick\` took ${lock} just now. Nothing was sent.`);
      throw e;
    }
  }
  return () => {
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  };
}

export const txHashOf = (o) => o?.transaction?.hash ?? o?.transaction_outcome?.id ?? null;

/**
 * FinalExecutionOutcome of create -> { jobId, txHash }. A Failure status is a definite refusal
 * (CREATE_FAILED, the contract's message kept); anything unreadable is BAD_CREATE_RESULT.
 */
export function parseCreateOutcome(outcome) {
  const status = outcome?.status;
  const txHash = txHashOf(outcome);
  if (status && typeof status === "object" && status.Failure) {
    const exec = status.Failure?.ActionError?.kind?.FunctionCallError?.ExecutionError;
    const why = typeof exec === "string" ? exec.replace(/^Smart contract panicked: /, "") : JSON.stringify(status.Failure).slice(0, 300);
    throw new PickError("CREATE_FAILED", `create refused on testnet: ${why}`, { txHash });
  }
  if (status && typeof status === "object" && typeof status.SuccessValue === "string") {
    let id;
    try {
      id = JSON.parse(Buffer.from(status.SuccessValue, "base64").toString("utf8"));
    } catch {
      id = undefined;
    }
    if (typeof id === "string" && /^\d+$/.test(id)) return { jobId: id, txHash };
  }
  throw new PickError("BAD_CREATE_RESULT", `create returned an unreadable result${txHash ? ` (tx ${txHash})` : ""}`, { txHash });
}

// Allow-list (code review M-2 / security M-1): only these end a job. Every other status, including
// ones T-031 hire will add (accepted, reviewed, revealing...) and typos, blocks a new pick.
export const REUSABLE_STATUSES = new Set(["failed", "closed"]);
export const UNRESOLVED_STATUSES = new Set(["sending", "unconfirmed"]);

/** Returns state with a reservation released (never below 0). */
export function releaseSpend(state, priceYocto) {
  const spent = BigInt(state.spent_yocto ?? "0");
  const price = /^\d+$/.test(String(priceYocto ?? "")) ? BigInt(priceYocto) : 0n;
  return { ...state, spent_yocto: (spent > price ? spent - price : 0n).toString() };
}

/**
 * An earlier create whose outcome we never saw: look it up by the tx hash saved before broadcast
 * (code review S-2). Landed -> the job is open; refused -> failed and the reservation is released;
 * anything else stays unresolved. Returns { prior, state }.
 */
export async function reconcileCreate({ dir, prior, state, lookupCreate, say }) {
  let outcome = null;
  try {
    outcome = await lookupCreate({ txHash: prior.create_tx, accountId: state.account_id });
  } catch {
    outcome = null;
  }
  if (!outcome) return { prior, state };
  try {
    const { jobId } = parseCreateOutcome(outcome);
    const open = { ...prior, status: "open", job_id: jobId };
    saveJob(dir, open);
    say(`Earlier create ${prior.create_tx} landed: job ${jobId} is open`);
    return { prior: open, state };
  } catch (err) {
    if (err.code !== "CREATE_FAILED") return { prior, state };
    const released = releaseSpend(state, prior.price_yocto);
    saveState(dir, released);
    const failed = { ...prior, status: "failed" };
    saveJob(dir, failed);
    say(`Earlier create ${prior.create_tx} was refused on testnet; its reservation is released`);
    return { prior: failed, state: released };
  }
}

function jobInProgress(dir, prior, state) {
  const file = jobFilePath(dir);
  if (UNRESOLVED_STATUSES.has(prior.status)) {
    const where = prior.create_tx ? `${EXPLORER}/txns/${prior.create_tx}` : `${EXPLORER}/address/${state.account_id}`;
    return new PickError(
      "JOB_IN_PROGRESS",
      `the last create for ${prior.pack_id} is ${prior.status}: its outcome is not known yet. Check ${where}. If it shows a create to ${prior.contract ?? CONTRACT_ACCOUNT}, run \`earned hire\` (the salt in ${file} is needed to reveal). Only if no create from ${state.account_id} landed: mkdir -p ${join(dir, JOBS_ARCHIVE_DIR)} && mv -n ${file} ${join(dir, JOBS_ARCHIVE_DIR, `unsent-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)}`,
    );
  }
  return new PickError(
    "JOB_IN_PROGRESS",
    `job ${prior.job_id ?? "(no id)"} for ${prior.pack_id} is still ${prior.status}; run \`earned hire\` to finish it (its salt in ${file} is needed to reveal).`,
  );
}

/**
 * Runs pick. deps: { pack, offer?, seller?, yes?, dir? | cwd+env, network, fetch, urls, contractId,
 * sendCreate, lookupCreate?, loadPack?, salt?, embedded?, out }. Returns { job, quote, haggle, txHash }.
 * embedded: run from `earned hire --pack N` (T-032), so the "Next:" and "SEE: step 2" lines are left out.
 * sendCreate({ ..., onSigned(txHash) }) must call onSigned before broadcasting and tag errors that
 * cannot have landed with notSent: true.
 */
export async function runPick(deps) {
  const {
    pack: n,
    offer,
    network = NETWORK,
    fetch: fetchFn,
    urls,
    contractId = CONTRACT_ACCOUNT,
    seller = DEMO_SELLER,
    yes = false,
    sendCreate,
    lookupCreate,
    loadPack = loadPackDefault,
    salt,
  } = deps;
  const out = deps.out ?? ((line) => console.log(line));
  assertTestnet(network);
  assertTestnetAccount(seller);
  if (!PACK_IDS.includes(String(n))) throw new PickError("USAGE", USAGE);
  // Security L-2: the payee is never changed without the user saying so.
  if (seller !== DEMO_SELLER && !yes) {
    throw new PickError(
      "SELLER_NOT_CONFIRMED",
      `refused: ${seller} is not the demo seller ${DEMO_SELLER}, and your deposit would be escrowed for it. Re-run with --yes if you meant that seller. Nothing was sent.`,
    );
  }
  const openingMilli = offer === undefined ? OPENING_OFFER_MILLI : parseNearToMilli(offer);

  const dir = deps.dir ?? stateDir(deps.cwd ?? process.cwd(), deps.env ?? process.env);
  const buyer = loadState(dir);
  if (!buyer || buyer.status !== "created") throw new PickError("NO_BUYER", "no testnet buyer yet; run `earned init` first");
  const release = acquirePickLock(dir, { say: out });
  try {
    return await pickLocked({ n, fetchFn, urls, contractId, seller, sendCreate, lookupCreate, loadPack, salt, out, openingMilli, dir, embedded: deps.embedded === true });
  } finally {
    release();
  }
}

async function pickLocked({ n, fetchFn, urls, contractId, seller, sendCreate, lookupCreate, loadPack, salt, out, openingMilli, dir, embedded }) {
  let state = loadState(dir); // re-read under the lock
  if (!state || state.status !== "created") throw new PickError("NO_BUYER", "no testnet buyer yet; run `earned init` first");
  const say = (line) => out(redact(line, state));
  let prior = loadJob(dir);
  if (prior && UNRESOLVED_STATUSES.has(prior.status) && prior.create_tx && lookupCreate) {
    ({ prior, state } = await reconcileCreate({ dir, prior, state, lookupCreate, say }));
  }
  if (prior && !REUSABLE_STATUSES.has(prior.status)) throw jobInProgress(dir, prior, state);
  say(`Seller: ${seller} (${seller === DEMO_SELLER ? "demo default" : "from --seller, not the demo seller; confirmed with --yes"})`);

  // 2. Seal + L-1 (local, before any network call).
  const pack = loadPack(n);
  const sealed = sealPick(pack, n, salt);
  say(`Pack ${n} (${pack.name}), ${sealed.pack_id}, frozen sha256 ${pack.hash}`);
  say(`Sealed answer key: commit ${sealed.commit_hash}`);

  // 3. Review request pin pre-flight (read-only).
  const pin = await checkPin({ fetch: fetchFn, urls, contractId, pack, pack_id: sealed.pack_id });
  say(`  review request ${pin.slice(0, 12)}… matches the contract's ${sealed.pack_id} pin`);

  // 4. Quote + haggle. Only fetchQuote's quoteMilli goes to evaluateOffer.
  const quote = await fetchQuote({ fetch: fetchFn, urls, contractId, seller });
  say(`Escrow ${contractId}`);
  quote.lines.forEach((l) => say(l));
  const answers = haggle(quote.quoteMilli, openingMilli);
  for (const a of answers) {
    say(`Buyer offers ${formatMilli(a.offerMilli)} NEAR`);
    say(`  seller: ${a.reason}`);
  }
  const deal = answers.at(-1);
  // Defensive: evaluateOffer always prices at the quote, so the second test cannot fail today.
  if (!deal.accept || deal.priceMilli !== quote.quoteMilli) throw new PickError("NO_DEAL", "haggle ended without a deal; nothing sent");
  const depositYocto = quote.quoteYocto; // == quoteMilli * 1e21 (fetchQuote refuses a mismatch)

  // 5. Spend cap: reserve first (a crash after this over-counts, never under-counts), then save
  // K + salt, then send. The contract refunds any excess and refuses a deposit below the quote.
  assertCanSpend(state, depositYocto);
  if (prior) say(`  previous ${prior.status} job file archived to ${archiveJob(dir, prior)}`);
  const reserved = recordSpend(state, depositYocto);
  saveState(dir, reserved);
  const job = {
    version: 1,
    network: "testnet",
    contract: contractId,
    buyer: state.account_id,
    seller,
    pack_id: sealed.pack_id,
    pack_hash: pack.hash,
    commit_hash: sealed.commit_hash,
    K: sealed.K,
    salt: sealed.salt,
    price_yocto: depositYocto.toString(),
    status: "sending",
    job_id: null,
    create_tx: null,
  };
  saveJob(dir, job);

  // The signed tx hash is saved before broadcast, so an unknown outcome can be looked up later.
  let current = job;
  const onSigned = (txHash) => {
    current = { ...current, create_tx: txHash };
    saveJob(dir, current);
  };
  let outcome;
  try {
    outcome = await sendCreate({
      state: reserved,
      contractId,
      methodName: "create",
      args: { seller, commit_hash: sealed.commit_hash, pack_id: sealed.pack_id },
      depositYocto,
      gas: CREATE_GAS,
      onSigned,
    });
  } catch (err) {
    const why = redact(String(err?.message ?? err), state).slice(0, 200);
    if (err?.notSent) {
      // Signing failed or the RPC rejected the tx before inclusion: it cannot land, so release.
      saveState(dir, state);
      saveJob(dir, { ...current, status: "failed" });
      throw new PickError(
        "CREATE_NOT_SENT",
        `create did not reach the chain (${why}). No funds moved: the ${formatMilli(deal.priceMilli)} NEAR reservation is released. Run \`earned pick ${n}\` again.`,
      );
    }
    saveJob(dir, { ...current, status: "unconfirmed" });
    throw new PickError(
      "CREATE_UNCONFIRMED",
      `create was sent but no result came back (${why}). ${current.create_tx ? `Its tx ${current.create_tx} is saved; the next \`earned pick\` looks it up. ` : ""}Check ${EXPLORER}/address/${state.account_id} before retrying; the ${formatMilli(deal.priceMilli)} NEAR stays counted against your cap and the salt stays in ${jobFilePath(dir)}.`,
    );
  }

  let created;
  try {
    created = parseCreateOutcome(outcome);
  } catch (err) {
    if (err.code === "CREATE_FAILED") {
      // Definite refusal: the contract moved no funds, so release the reservation.
      saveState(dir, state);
      saveJob(dir, { ...current, status: "failed", create_tx: err.txHash ?? current.create_tx });
    } else {
      saveJob(dir, { ...current, status: "unconfirmed", create_tx: err.txHash ?? current.create_tx });
    }
    throw err;
  }

  const done = { ...current, status: "open", job_id: created.jobId, create_tx: created.txHash ?? current.create_tx };
  saveJob(dir, done);
  say(`Escrow create: job ${created.jobId}, ${formatMilli(deal.priceMilli)} NEAR locked (spent ${formatNear(BigInt(reserved.spent_yocto))} of 0.2 NEAR cap)`);
  say(`  create tx: ${created.txHash}`);
  say(`  commit:    ${sealed.commit_hash}`);
  say(`  key + salt kept in ${jobFilePath(dir)} until reveal`);
  if (!embedded) {
    say("Next: `earned hire` (the seller accepts, reviews in the TEE, then you reveal)");
    say("SEE: step 2 PASS");
  }
  return { job: done, quote, haggle: answers, txHash: created.txHash };
}

const notSent = (err) => Object.assign(err instanceof Error ? err : new Error(String(err)), { notSent: true });

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
  return near.baseEncode(createHash("sha256").update(near.encodeTransaction(signed.transaction)).digest());
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

/** Real dependencies: keyless views over the T-014 RPC list; create signed with near-api-js 7.4.0. */
export async function defaultPickDeps(env = process.env) {
  const urls = env.EARNED_RPC_URL ? [env.EARNED_RPC_URL] : RPC_URLS;
  urls.forEach(assertTestnetRpc);
  const load = async () => [await import("near-api-js"), await import("near-api-js/rpc-errors")];
  return {
    cwd: process.cwd(),
    env,
    network: env.EARNED_NETWORK || NETWORK,
    fetch: globalThis.fetch,
    urls,
    seller: DEMO_SELLER, // no env override (security L-2): --seller --yes only
    sendCreate: async (req) => {
      const [near, rpcErrors] = await load();
      const makeAccount = (url, st) => new near.Account(st.account_id, new near.JsonRpcProvider({ url }, { retries: RPC_RETRIES }), st.private_key);
      return sendCreateTx({ ...req, urls, makeAccount, near, rpcErrors });
    },
    // Read-only: the earlier create's outcome by tx hash, or null if no RPC knows it yet.
    lookupCreate: async ({ txHash, accountId }) => {
      const [near] = await load();
      for (const url of urls) {
        try {
          return await new near.JsonRpcProvider({ url }, { retries: RPC_RETRIES }).viewTransactionStatus({ txHash, accountId, waitUntil: "EXECUTED_OPTIMISTIC" });
        } catch {
          // try the next RPC
        }
      }
      return null;
    },
  };
}
