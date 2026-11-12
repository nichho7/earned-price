// `earned pick N` (S-021 / T-030): seal pack N's answer key, haggle with the seller and lock the
// agreed price in testnet escrow with create(seller, commit_hash, pack_id).
//
// Order (nothing is sent until every local and read-only check passes):
//   1. buyer from `earned init`; refuse if an earlier job is still open (its salt is needed to reveal)
//   2. load pack N, seal its key (fresh 32-byte salt), L-1: the key's own pack_id must be pack-N
//   3. pre-flight: our review request for pack-N equals the contract's live pin (review_pins)
//   4. read the on-chain quote (fetchQuote), haggle: opening offer 0.020, then the quote
//   5. spend cap: reserve the deposit (assertCanSpend/recordSpend), save K + salt, then send create
// The job file (.earned/job.json, 0600) keeps K and salt byte-for-byte until `earned hire` reveals.
// All network access is injected (fetch for views, sendCreate for the tx), so tests never touch it.
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_ACCOUNT, NETWORK } from "./names.js";
import { RPC_URLS, assertTestnet, assertTestnetRpc, loadState, redact, saveState, stateDir } from "./init.js";
import { assertCanSpend, formatNear, recordSpend } from "./spend-cap.js";
import { assertTestnetAccount, evaluateOffer, fetchQuote, formatMilli, parseNearToMilli, viewFunction } from "./quote.js";
import { loadPack as loadPackDefault, sealKey } from "../packs/packs.js";
import { requestSha256 } from "../seller/review-prompt.js";

// Demo seller: a sub-account of the escrow account, so only we can create it (same reasoning
// as the deploy smoke seller). T-027's seller agent runs as this account. Override: --seller.
export const DEMO_SELLER = "seller.earned-price.testnet";
export const OPENING_OFFER_MILLI = 20; // the scripted counteroffer (PRD beat 2): below the 0.025 floor
export const CREATE_GAS = 30n * 10n ** 12n; // 30 Tgas: create writes one job and may refund excess
export const JOB_FILE_NAME = "job.json";
const PACK_IDS = ["1", "2", "3"];
const USAGE = "usage: earned pick <1|2|3> [--offer 0.02] [--seller seller.testnet]";

export class PickError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "PickError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/** argv after "pick" -> { pack, offer, seller }. Strict, like parseQuoteArgs. */
export function parsePickArgs(argv) {
  let pack;
  let offer;
  let seller;
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
    } else if (a.startsWith("--") || pack !== undefined || !PACK_IDS.includes(a)) {
      throw new PickError("USAGE", USAGE);
    } else {
      pack = a;
    }
  }
  if (pack === undefined) throw new PickError("USAGE", USAGE);
  return { pack, offer, seller };
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

const txHashOf = (o) => o?.transaction?.hash ?? o?.transaction_outcome?.id ?? null;

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

const OPEN_STATUSES = new Set(["sending", "open", "unconfirmed"]);

/**
 * Runs pick. deps: { pack, offer?, seller?, dir? | cwd+env, network, fetch, urls, contractId,
 * sendCreate, loadPack?, salt?, out }. Returns { job, quote, haggle, txHash }.
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
    sendCreate,
    loadPack = loadPackDefault,
    salt,
  } = deps;
  const out = deps.out ?? ((line) => console.log(line));
  assertTestnet(network);
  assertTestnetAccount(seller);
  if (!PACK_IDS.includes(String(n))) throw new PickError("USAGE", USAGE);
  const openingMilli = offer === undefined ? OPENING_OFFER_MILLI : parseNearToMilli(offer);

  const dir = deps.dir ?? stateDir(deps.cwd ?? process.cwd(), deps.env ?? {});
  const state = loadState(dir);
  if (!state || state.status !== "created") throw new PickError("NO_BUYER", "no testnet buyer yet; run `earned init` first");
  const say = (line) => out(redact(line, state));
  const prior = loadJob(dir);
  if (prior && OPEN_STATUSES.has(prior.status)) {
    throw new PickError(
      "JOB_IN_PROGRESS",
      `job ${prior.job_id ?? "(create unconfirmed)"} for ${prior.pack_id} is still ${prior.status}; run \`earned hire\` to finish it (its salt in ${jobFilePath(dir)} is needed to reveal). Move the file aside only if you are sure no create landed.`,
    );
  }

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
  say(`Seller ${seller} on ${contractId}`);
  quote.lines.forEach((l) => say(l));
  const answers = haggle(quote.quoteMilli, openingMilli);
  for (const a of answers) {
    say(`Buyer offers ${formatMilli(a.offerMilli)} NEAR`);
    say(`  seller: ${a.reason}`);
  }
  const deal = answers.at(-1);
  if (!deal.accept || deal.priceMilli !== quote.quoteMilli) throw new PickError("NO_DEAL", "haggle ended without a deal; nothing sent");
  const depositYocto = quote.quoteYocto; // == quoteMilli * 1e21 (fetchQuote refuses a mismatch)

  // 5. Spend cap: reserve first (a crash after this over-counts, never under-counts), then save
  // K + salt, then send. The contract refunds any excess and refuses a deposit below the quote.
  assertCanSpend(state, depositYocto);
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

  let outcome;
  try {
    outcome = await sendCreate({
      state: reserved,
      contractId,
      methodName: "create",
      args: { seller, commit_hash: sealed.commit_hash, pack_id: sealed.pack_id },
      depositYocto,
      gas: CREATE_GAS,
    });
  } catch (err) {
    saveJob(dir, { ...job, status: "unconfirmed" });
    throw new PickError(
      "CREATE_UNCONFIRMED",
      `create was sent but no result came back (${redact(String(err?.message ?? err), state).slice(0, 200)}). Check ${state.account_id} on the testnet explorer before retrying; the ${formatMilli(deal.priceMilli)} NEAR stays counted against your cap and the salt stays in ${jobFilePath(dir)}.`,
    );
  }

  let created;
  try {
    created = parseCreateOutcome(outcome);
  } catch (err) {
    if (err.code === "CREATE_FAILED") {
      // Definite refusal: the contract moved no funds, so release the reservation.
      saveState(dir, state);
      saveJob(dir, { ...job, status: "failed", create_tx: err.txHash ?? null });
    } else {
      saveJob(dir, { ...job, status: "unconfirmed", create_tx: err.txHash ?? null });
    }
    throw err;
  }

  const done = { ...job, status: "open", job_id: created.jobId, create_tx: created.txHash };
  saveJob(dir, done);
  say(`Escrow create: job ${created.jobId}, ${formatMilli(deal.priceMilli)} NEAR locked (spent ${formatNear(BigInt(reserved.spent_yocto))} of 0.2 NEAR cap)`);
  say(`  create tx: ${created.txHash}`);
  say(`  commit:    ${sealed.commit_hash}`);
  say(`  key + salt kept in ${jobFilePath(dir)} until reveal`);
  say("Next: `earned hire` (the seller accepts, reviews in the TEE, then you reveal)");
  say("SEE: step 2 PASS");
  return { job: done, quote, haggle: answers, txHash: created.txHash };
}

/** Real dependencies: keyless views over the T-014 RPC list; create signed with near-api-js 7.4.0. */
export async function defaultPickDeps(env = process.env) {
  const urls = env.EARNED_RPC_URL ? [env.EARNED_RPC_URL] : RPC_URLS;
  urls.forEach(assertTestnetRpc);
  return {
    cwd: process.cwd(),
    env,
    network: env.EARNED_NETWORK || NETWORK,
    fetch: globalThis.fetch,
    urls,
    seller: env.EARNED_SELLER || DEMO_SELLER,
    sendCreate: async ({ state, contractId, methodName, args, depositYocto, gas }) => {
      const { Account, JsonRpcProvider, actions } = await import("near-api-js");
      // One RPC for the tx: a resend through another node could not tell us more than "unknown".
      const account = new Account(state.account_id, new JsonRpcProvider({ url: urls[0] }, { retries: 3 }), state.private_key);
      return account.signAndSendTransaction({
        receiverId: contractId,
        actions: [actions.functionCall(methodName, args, gas, depositYocto)],
        throwOnFailure: false, // we read status ourselves: Failure = refused, no funds moved
      });
    },
  };
}
