// `earned hire` (S-022 / T-031): finish the job `earned pick` opened. The seller accepts and puts a
// signed TEE review on-chain, the buyer reveals the sealed key (300 Tgas), the escrow regrades and
// settles (pass: seller paid) or refunds (fail). Prints the per-bug grade, the settle tx, the next
// quote from get_record and, for a live review, writes and verifies the receipt.
//
// Rules (m001-ui-contract section 8, T-029 reviews):
// - Every decision is read from get_job: the stage and its deadline (accept_by / review_by /
//   reveal_deadline) are printed while waiting. The final outcome comes only from the closing tx's
//   EVENT_JSON (reveal or timeout), never from get_job (the job is deleted at close; A-013).
// - The key is revealed only when a signed review is on-chain AND the review body this CLI holds
//   hashes to the response_sha256 the escrow stored for this job. Otherwise nothing is sent.
// - A receipt is built only for a live review whose submit_review landed (the on-chain hash check
//   above), only after the reveal tx landed (txs.reveal), under <state>/receipts/job-<id>.json with
//   the id validated as /^\d{1,20}$/. The full review result goes next to it (job-<id>.review.json).
//   A replay never builds one: it shows a recorded run labelled RECORDED.
// - "SEE: step 3 PASS" needs the escrow's own pass (reveal event + payout), our regrade's explicit
//   passed flag, and verifyReceipt ok. verify ok means AUTHENTIC, never PASSED (T-029 N-2).
// - .earned/job.json ends with status exactly "closed" after settle, refund or timeout.
// Network access and the seller are injected, so tests never touch testnet or NEAR AI.
import { closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONTRACT_ACCOUNT, NETWORK } from "./names.js";
import { RPC_RETRIES, RPC_URLS, assertTestnet, assertTestnetRpc, loadState, redact, saveState, stateDir } from "./init.js";
import { formatNear } from "./spend-cap.js";
import { YOCTO_PER_MNEAR, fetchQuote, formatMilli, parseRecord, quoteMilli, viewFunction } from "./quote.js";
import { EXPLORER, REUSABLE_STATUSES, UNRESOLVED_STATUSES, acquirePickLock, defaultPickDeps, jobFilePath, loadJob, reconcileCreate, releaseSpend, runPick, saveJob, sendCreateTx } from "./pick.js";
import { STEP4_PACK, step4Report } from "./step4.js";
import { REVEAL_GAS, TIMEOUT_GAS, TxError, parseTxOutcome } from "./tx.js";
import { makeLocalSeller } from "./seller-local.js";
import { readReceipt, writeReceipt } from "./receipt-file.js";
import { loadPack as loadPackDefault } from "../packs/packs.js";
import { findingsFromResponse, grade, sha256Hex } from "../grader/grade.js";
import { buildReceipt, printable, verifyReceipt } from "../verify/receipt.js";
import { TRUST } from "../verify/trust-anchors.js";

export const RECEIPTS_DIR_NAME = "receipts";
export const RECORDED_DIR = new URL("../recorded/", import.meta.url).pathname; // past live runs (T-032)
export const JOB_ID_RE = /^\d{1,20}$/;
const U64_MAX = 2n ** 64n - 1n;
export const POLL_MS = 2000; // view lag after a tx: final trails optimistic by a block or two
export const VIEW_POLLS = 6;
export const WAIT_POLL_MS = 10_000; // while waiting for a stage deadline
export const COUNTDOWN_EVERY_MS = 30_000;
export const DEADLINE_MARGIN_MS = 3000; // our clock vs block time: timeout only after deadline + this
export const TIMEOUT_TRIES = 4;
export const LOOKUP_TRIES = 6; // a saved closing tx: looked up this many times (POLL_MS apart) before giving up
const RESTART = Symbol("restart"); // the stage changed under a timeout: go round the main loop again
const MAX_REVIEW_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ROUNDS = 8; // stage changes per run: open -> accepted -> reviewed is 3
const USAGE = "usage: earned hire [--pack <1|2|3>] [--local-seller]";
const PACK_ARGS = ["1", "2", "3"];

export class HireError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "HireError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/** argv after "hire" -> { localSeller, pack? }. `--pack N` opens a pack-N job first when none is open (step 4). */
export function parseHireArgs(argv) {
  let localSeller = false;
  let pack;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--local-seller" && !localSeller) localSeller = true;
    else if (a === "--pack" && pack === undefined && PACK_ARGS.includes(argv[i + 1])) pack = argv[++i];
    else throw new HireError("USAGE", USAGE);
  }
  return pack === undefined ? { localSeller } : { localSeller, pack };
}

/**
 * `--pack N`: the job hire works on. An open pack-N job is resumed as is. No open job (none yet,
 * or the last one closed/failed): `earned pick N` runs first (same seal, pin check, haggle, spend
 * cap and create as the pick command). An open job for another pack is refused: its salt is
 * needed to reveal it, so it must be finished first. Nothing is sent before these checks.
 */
async function ensurePackJob(deps, dir, out) {
  const want = `pack-${deps.pack}`;
  const job = loadJob(dir);
  if (job && !REUSABLE_STATUSES.has(job.status)) {
    if (job.pack_id === want) {
      out(`Resuming the open ${want} job ${job.job_id ?? "(create not confirmed yet)"} from ${jobFilePath(dir)}`);
      return;
    }
    throw new HireError(
      "OTHER_JOB_OPEN",
      `job ${job.job_id ?? "(no id)"} for ${job.pack_id} is still ${job.status}; finish it with \`earned hire\` first, then run \`earned hire --pack ${deps.pack}\`. Nothing was sent.`,
    );
  }
  if (typeof deps.pick !== "function") throw new HireError("NO_PICK", "this build cannot open a job from `earned hire --pack`; run `earned pick` first");
  out(`No open job: opening a ${want} job first (as \`earned pick ${deps.pack}\`)`);
  await deps.pick({ pack: deps.pack, dir, out, embedded: true });
}

/** A job id we may put in a path or an arg: 1-20 digits, at most u64::MAX. Returns it as a string. */
export function assertJobId(id) {
  const s = typeof id === "string" ? id : "";
  if (!JOB_ID_RE.test(s) || BigInt(s) > U64_MAX) throw new HireError("BAD_JOB_ID", `refused: job id ${JSON.stringify(id ?? null)} is not a u64 number`);
  return s;
}

/** Receipt + review file paths: a fixed folder, names only from a validated job id. */
export function receiptPaths(dir, jobId) {
  const id = assertJobId(jobId);
  const folder = join(dir, RECEIPTS_DIR_NAME);
  return { folder, receipt: join(folder, `job-${id}.json`), review: join(folder, `job-${id}.review.json`) };
}

// Atomic write through a random O_EXCL tmp file (a planted file or symlink is refused, never followed).
function writeJsonAtomic(file, value, mode = 0o644) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, JSON.stringify(value, null, 2) + "\n");
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return file;
}

/**
 * Saves a review result (request + response bodies, signature, attestation; no secret in it) as
 * receipts/job-<id>.review-<first 16 hex of sha256(response)>.json. Keyed by the body's hash, so a
 * second review in a later run never overwrites the body whose submit may have landed (review M-5).
 */
export function saveReviewFile(dir, jobId, review) {
  const sha = sha256Hex(review.response_body);
  return writeJsonAtomic(join(receiptPaths(dir, jobId).folder, `job-${assertJobId(jobId)}.review-${sha.slice(0, 16)}.json`), review);
}

function readReviewFile(file) {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > MAX_REVIEW_FILE_BYTES) return null;
    const r = JSON.parse(readFileSync(file, "utf8"));
    return r && typeof r === "object" && typeof r.response_body === "string" && r.tee && typeof r.tee === "object" ? r : null;
  } catch {
    return null;
  }
}

/** Every saved review result for this job (keyed files and the one next to the receipt). Symlinks, huge or unreadable files are skipped. */
export function loadReviewFiles(dir, jobId) {
  const { folder } = receiptPaths(dir, jobId);
  const name = new RegExp(`^job-${assertJobId(jobId)}\\.review(-[0-9a-f]{16})?\\.json$`);
  let names = [];
  try {
    names = readdirSync(folder).filter((n) => name.test(n)).sort();
  } catch {
    return [];
  }
  return names.map((n) => readReviewFile(join(folder, n))).filter(Boolean);
}

/** The saved review whose response hashes to `sha` (hex), or null. */
const reviewWithHash = (reviews, sha) => reviews.find((r) => typeof sha === "string" && sha256Hex(r.response_body) === sha.toLowerCase().replace(/^0x/, "")) ?? null;

/** Closing tx hashes this job signed that may have landed (a definite refusal or not-sent is removed). */
const pendingTxs = (job, kind) => [...new Set([...(Array.isArray(job[`${kind}_txs`]) ? job[`${kind}_txs`] : []), job[`${kind}_tx`]].filter((h) => typeof h === "string" && h !== ""))];

const nsToMs = (ns) => Number(BigInt(ns) / 1_000_000n);
const lc = (s) => (typeof s === "string" ? s.toLowerCase().replace(/^0x/, "") : null);

/** The live job's current stage and the deadline that ends it (m001 section 8 countdown). */
export function stageOf(view) {
  if (view.status === "open") return { key: "open", deadlineNs: view.accept_by_ns, what: "seller must accept or decline", field: "accept_by" };
  if (view.review == null) return { key: "accepted", deadlineNs: view.review_by_ns, what: "seller's signed review due", field: "review_by" };
  return { key: "reviewed", deadlineNs: view.reveal_deadline_ns, what: "buyer must reveal the key", field: "reveal_deadline" };
}

export function fmtLeft(ms) {
  const s = Math.round(Math.abs(ms) / 1000);
  const t = s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
  return ms >= 0 ? `${t} left` : `passed ${t} ago`;
}

export function stageLine(view, nowMs) {
  const s = stageOf(view);
  const at = nsToMs(s.deadlineNs);
  return `Stage: ${view.status}${s.key === "reviewed" ? ", review on-chain" : ""}. ${s.what} by ${new Date(at).toISOString()} (${s.field}, ${fmtLeft(at - nowMs)})`;
}

/**
 * The outcome of a closing tx (reveal or timeout) from its events, for this job only. Returns
 * { kind, line, graded, refundYocto, reveal } or null when the tx carries no closing event.
 */
export function outcomeOf(events, jobId, buyer) {
  const ev = (name) => events.find((e) => e.event === name && String(e.data.job_id) === jobId) ?? null;
  const reveal = ev("reveal");
  const timeout = ev("timeout");
  const payout = ev("payout");
  const failedPayout = ev("payout_failed_refunded");
  const refund = ev("refund");
  const refunded = (e) => (e && e.data.buyer === buyer && /^\d+$/.test(String(e.data.amount)) ? String(e.data.amount) : null);
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

/** Per-bug lines: our regrade of the signed findings against the revealed key. */
export function gradeLines(key, responseBody) {
  const g = grade(key, findingsFromResponse(responseBody));
  const lines = [`Grade: ${g.found}/${g.total} found (pass mark ${g.pass_min}) -> ${g.passed ? "PASS" : "FAIL"}${g.error ? ` (${g.error})` : ""}`];
  const byId = new Map(g.matched.map((m) => [m.bug, m.line]));
  for (const bug of [...key.bugs].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const where = `${bug.file}:${bug.line_start}-${bug.line_end} ${bug.category}`;
    lines.push(byId.has(bug.id) ? `  ${bug.id} found   (finding at line ${byId.get(bug.id)}; key ${where})` : `  ${bug.id} missed  (key ${where})`);
  }
  if (g.false_positives) lines.push(`  ${g.false_positives} other finding(s) matched no bug`);
  return { g, lines };
}

/**
 * Runs hire. deps: { dir? | cwd+env, network, fetch, urls, contractId, sendTx, lookupTx?,
 * lookupCreate?, makeSeller?, loadPack?, sleep?, now?, trust?, recordedDir?, out }.
 * sendTx is pick's sendCreateTx contract (onSigned before broadcast, notSent on errors that can't
 * have landed). makeSeller({ accountId, getJob, say }) returns a seller (cli/seller-local.js) or
 * null for no live seller. Returns { job, outcome, receiptPath, verify, pass }.
 */
export async function runHire(deps) {
  const network = deps.network ?? NETWORK;
  assertTestnet(network);
  const out = deps.out ?? ((line) => console.log(line));
  const dir = deps.dir ?? stateDir(deps.cwd ?? process.cwd(), deps.env ?? process.env);
  const buyer = loadState(dir);
  if (!buyer || buyer.status !== "created") throw new HireError("NO_BUYER", "no testnet buyer yet; run `earned init` first");
  if (deps.pack !== undefined) {
    if (!PACK_ARGS.includes(String(deps.pack))) throw new HireError("USAGE", USAGE);
    await ensurePackJob(deps, dir, out); // takes and releases the pick lock itself
  }
  const release = acquirePickLock(dir, { say: out });
  try {
    return await new Hire({ ...deps, out, dir }).run();
  } finally {
    release();
  }
}

class Hire {
  constructor(deps) {
    this.d = deps;
    this.dir = deps.dir;
    this.contractId = deps.contractId ?? CONTRACT_ACCOUNT;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? (() => Date.now());
    this.trust = deps.trust ?? TRUST;
    this.loadPack = deps.loadPack ?? loadPackDefault;
    this.recordedDir = deps.recordedDir ?? RECORDED_DIR;
  }

  say(line) {
    this.d.out(printable(redact(line, this.state)));
  }

  save(job) {
    saveJob(this.dir, job);
    this.job = job;
    return job;
  }

  view(method, args = {}) {
    return viewFunction({ fetch: this.d.fetch, urls: this.d.urls, contractId: this.contractId, method, args });
  }

  getJob() {
    return this.view("get_job", { id: this.jobId });
  }

  /** get_job, read again a few times while it is null: a just-sent tx can be ahead of the view. */
  async readLiveJob(until = (v) => v !== null) {
    let v = null;
    for (let i = 0; i < VIEW_POLLS; i++) {
      v = await this.getJob();
      if (until(v)) return v;
      if (i < VIEW_POLLS - 1) await this.sleep(POLL_MS);
    }
    return v;
  }

  sendTx(methodName, args, gas, onSigned) {
    return this.d.sendTx({ state: this.state, contractId: this.contractId, methodName, args, depositYocto: 0n, gas, onSigned });
  }

  async run() {
    this.state = loadState(this.dir);
    if (!this.state || this.state.status !== "created") throw new HireError("NO_BUYER", "no testnet buyer yet; run `earned init` first");
    let job = loadJob(this.dir);
    if (!job) throw new HireError("NO_JOB", "no job yet; run `earned pick <1|2|3>` first");
    if (UNRESOLVED_STATUSES.has(job.status) && job.create_tx && this.d.lookupCreate) {
      ({ prior: job, state: this.state } = await reconcileCreate({ dir: this.dir, prior: job, state: this.state, lookupCreate: this.d.lookupCreate, say: (l) => this.say(l) }));
    }
    if (UNRESOLVED_STATUSES.has(job.status)) {
      throw new HireError("JOB_UNCONFIRMED", `the create for ${job.pack_id} is ${job.status}: its outcome is not known yet. Check ${EXPLORER}/address/${this.state.account_id}, then run \`earned hire\` again.`);
    }
    if (REUSABLE_STATUSES.has(job.status)) {
      throw new HireError("NO_OPEN_JOB", `the last job (${job.job_id ?? "never created"}, ${job.pack_id}) is already ${job.status}; run \`earned pick <1|2|3>\` for a new one`);
    }
    this.job = job;
    this.jobId = assertJobId(job.job_id);
    try {
      this.key = JSON.parse(job.K);
    } catch {
      throw new HireError("JOB_FILE_CORRUPT", "refused: the job file's sealed key is not JSON; nothing was sent");
    }
    const packN = /^pack-([1-3])$/.exec(job.pack_id)?.[1];
    if (!packN) throw new HireError("JOB_FILE_CORRUPT", `refused: ${job.pack_id} is not an official pack`);
    this.pack = this.loadPack(packN);
    this.reviews = loadReviewFiles(this.dir, this.jobId);
    this.review = reviewWithHash(this.reviews, job.review_checked_sha256) ?? this.reviews.at(-1) ?? null;
    this.seller = this.d.makeSeller ? this.d.makeSeller({ accountId: job.seller, contractId: this.contractId, getJob: () => this.getJob(), say: (l) => this.say(l) }) : null;

    this.say(`Job ${this.jobId} (${job.pack_id}) on ${this.contractId}: ${formatNear(BigInt(job.price_yocto))} NEAR in escrow, seller ${job.seller}`);

    // Closing txs sent by an earlier run whose result we never saw: look them up first (M-1).
    for (const kind of ["reveal", "timeout"]) {
      const r = await this.resumeClosing(kind);
      if (r) return r;
    }

    let sellerTried = false;
    let replayShown = false;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const view = await this.readLiveJob();
      if (!view) return this.closedUnseen();
      this.assertSameJob(view);
      this.say(stageLine(view, this.now()));
      if (view.status === "accepted" && view.review != null) {
        const r = await this.revealStage(view);
        if (r === RESTART) continue;
        return r;
      }

      if (this.seller && !sellerTried) {
        sellerTried = true;
        const r = await this.seller.review({
          jobId: this.jobId,
          view,
          pack: this.pack,
          say: (l) => this.say(l),
          saveReview: (rv) => {
            saveReviewFile(this.dir, this.jobId, rv);
            this.reviews.push(rv);
            this.review = rv;
          },
        });
        this.save({ ...this.job, txs: { ...(this.job.txs ?? {}), ...(r.txs ?? {}) } });
        if (r.mode === "replay") {
          this.say(`Seller could not review live (${r.reason}): ${r.message}`);
          this.showRecorded();
          replayShown = true;
        } else if (r.submit === "refused" || r.submit === "not_sent") {
          // No live review can land (L-3): fall back to the RECORDED replay, then wait out the stage.
          this.say(`Seller's submit_review ${r.submit}${r.message ? `: ${r.message}` : ""}`);
          this.showRecorded();
          replayShown = true;
        } else {
          if (r.submit !== "landed") this.say(`Seller's submit_review ${r.submit}${r.message ? `: ${r.message}` : ""}`);
          // Wait for the review to show in get_job (the view trails the tx by a block or two).
          await this.readLiveJob((v) => v === null || v?.review != null);
          continue;
        }
      } else if (!this.seller && !replayShown) {
        this.say("No live seller in this run (live reviews need `--local-seller` with the seller and NEAR AI keys).");
        this.showRecorded();
        replayShown = true;
      }
      // Otherwise the seller already ran (its review may still be landing): wait on the stage.
      const next = await this.waitForStage(view);
      if (next.deadline) {
        const t = await this.timeoutStage(next.view);
        if (t === RESTART) continue;
        return t;
      }
      if (next.closed) return this.closedUnseen();
    }
    throw new HireError("STUCK", `job ${this.jobId} changed stage too often in one run; run \`earned hire\` again`);
  }

  /**
   * Finishes from a closing tx (reveal or timeout) an earlier run signed but never saw land. Every
   * saved hash is looked up, LOOKUP_TRIES times. Landed: finish from its events. All refused:
   * forget them and carry on. Unknown while get_job is null: our tx probably closed the job, so
   * throw CLOSE_TX_UNCONFIRMED and leave job.json as it is (never close it blind, never re-send).
   */
  async resumeClosing(kind) {
    const status = kind === "reveal" ? "revealing" : "timing_out";
    const hashes = pendingTxs(this.job, kind);
    // Any unclosed job holding a pending hash is looked up, whatever its status (re-check R-1).
    if (hashes.length === 0 || REUSABLE_STATUSES.has(this.job.status)) return null;
    const refused = new Set();
    for (let i = 0; i < LOOKUP_TRIES && this.d.lookupTx; i++) {
      if (i > 0) await this.sleep(POLL_MS);
      for (const h of hashes) {
        if (refused.has(h)) continue;
        const o = await this.d.lookupTx({ txHash: h, accountId: this.state.account_id }).catch(() => null);
        if (!o) continue;
        const p = parseTxOutcome(o, this.contractId);
        if (!p.failure) {
          this.say(`Earlier ${kind} tx ${h} landed`);
          return this.finish(kind, p, null);
        }
        this.say(`Earlier ${kind} tx ${h} was refused: ${p.failure}`);
        refused.add(h);
      }
      if (refused.size === hashes.length) break;
    }
    const left = hashes.filter((h) => !refused.has(h));
    const back = kind === "reveal" ? "reviewed" : "accepted";
    if (left.length === 0) {
      this.save({ ...this.job, status: back, [`${kind}_tx`]: null, [`${kind}_txs`]: [] });
      return null;
    }
    if ((await this.readLiveJob()) === null) throw this.closeTxUnconfirmed(kind, left);
    // The job is still live, so none of them has landed yet; keep the hashes and carry on.
    this.save({ ...this.job, status: back });
    return null;
  }

  closeTxUnconfirmed(kind, hashes) {
    // State never moves backward (re-check sec N-1): the job waits on this close tx again.
    this.save({ ...this.job, status: kind === "reveal" ? "revealing" : "timing_out" });
    return new HireError(
      "CLOSE_TX_UNCONFIRMED",
      `job ${this.jobId} is closed on-chain and your ${kind} tx ${hashes.join(", ")} is not visible on the RPC yet. Nothing was changed: run \`earned hire\` again in a minute to read its outcome (and write the receipt). Check ${EXPLORER}/txns/${hashes[0]}. Only if the explorer shows that tx never landed: move ${jobFilePath(this.dir)} into ${join(this.dir, "jobs")}/.`,
    );
  }

  assertSameJob(view) {
    const j = this.job;
    const same =
      String(view.id) === this.jobId &&
      view.buyer === this.state.account_id &&
      view.seller === j.seller &&
      view.pack_id === j.pack_id &&
      lc(view.commit_hash) === lc(j.commit_hash) &&
      String(view.price) === String(j.price_yocto);
    if (!same) throw new HireError("JOB_MISMATCH", `refused: on-chain job ${this.jobId} is not the job in your job file (buyer, seller, pack, commit or price differ). Nothing was sent.`);
  }

  /** Polls until the stage changes or its deadline (+ margin) passes, printing a countdown. */
  async waitForStage(view) {
    const s = stageOf(view);
    const endMs = nsToMs(s.deadlineNs) + DEADLINE_MARGIN_MS;
    let lastPrint = this.now();
    for (;;) {
      if (this.now() > endMs) return { deadline: true, view };
      await this.sleep(Math.max(1, Math.min(WAIT_POLL_MS, endMs - this.now() + 1)));
      let v;
      try {
        v = await this.getJob();
      } catch {
        continue; // RPC hiccup: keep waiting for the deadline
      }
      if (v === null) {
        const again = await this.readLiveJob();
        if (again === null) return { closed: true };
        v = again;
      }
      if (stageOf(v).key !== s.key) return { view: v };
      if (this.now() - lastPrint >= COUNTDOWN_EVERY_MS) {
        this.say(`  waiting: ${s.what}, ${s.field} ${fmtLeft(nsToMs(s.deadlineNs) - this.now())}`);
        lastPrint = this.now();
      }
    }
  }

  /** (b) The review we hold must be exactly the one the escrow stored for this job. */
  reviewMatchesChain(view) {
    const r = this.review;
    const c = view.review;
    if (!r || typeof r.response_body !== "string" || !r.tee || !c) return false;
    const str = (o, k) => typeof o[k] === "string" && o[k] !== "";
    if (!["model", "request_sha256", "response_sha256", "signing_address"].every((k) => str(c, k) && str(r.tee, k))) return false;
    const h = sha256Hex(r.response_body);
    return (
      h === lc(r.tee.response_sha256) &&
      h === lc(c.response_sha256) &&
      lc(r.tee.request_sha256) === lc(c.request_sha256) &&
      lc(r.tee.signing_address) === lc(c.signing_address) &&
      r.tee.model === c.model
    );
  }

  async revealStage(view) {
    this.save({ ...this.job, status: "reviewed" });
    // H-1: past reveal_deadline nothing can be revealed, so close it whatever review we hold.
    if (this.now() > nsToMs(view.reveal_deadline_ns) + DEADLINE_MARGIN_MS) return this.timeoutStage(view);
    this.review = reviewWithHash(this.reviews, view.review?.response_sha256) ?? this.review;
    if (!this.review) {
      throw new HireError(
        "REVIEW_BODY_MISSING",
        `the signed review is on-chain, but this CLI has no copy of its response body (needed to reveal). It is in the submit_review tx arguments on ${EXPLORER}/address/${this.contractId}. Without a valid reveal by ${new Date(nsToMs(view.reveal_deadline_ns)).toISOString()}, the timeout pays the seller. Nothing was sent.`,
      );
    }
    if (!this.reviewMatchesChain(view)) {
      throw new HireError("REVIEW_MISMATCH", "refused: the saved review does not hash to the response_sha256 the escrow stored for this job. No key was revealed and no receipt was written.");
    }
    // Remembered so a later run that only finds the landed reveal tx knows this exact body was checked.
    this.save({ ...this.job, review_checked_sha256: sha256Hex(this.review.response_body) });

    let before = null;
    try {
      before = await fetchQuote({ fetch: this.d.fetch, urls: this.d.urls, contractId: this.contractId, seller: this.job.seller });
    } catch {
      before = null; // used to wait for the record to move and, for step 4, to read what moved
    }
    // Kept in the job file so a run that resumes from a landed reveal can still compare (step 4).
    this.save({ ...this.job, status: "revealing", record_before: before ? before.record : null });
    let outcome;
    try {
      outcome = await this.sendTx("reveal", { job_id: this.jobId, key: this.job.K, salt: this.job.salt, response: this.review.response_body }, REVEAL_GAS, (h) => {
        this.save({ ...this.job, reveal_tx: h, reveal_txs: [...pendingTxs(this.job, "reveal"), h] });
      });
    } catch (err) {
      const why = redact(String(err?.message ?? err), this.state).slice(0, 200);
      if (err?.notSent) {
        this.save({ ...this.job, status: "reviewed", ...this.dropTx("reveal", this.job.reveal_tx) });
        throw new HireError("REVEAL_NOT_SENT", `the reveal did not reach the chain (${why}). Nothing moved; run \`earned hire\` again before ${new Date(nsToMs(view.reveal_deadline_ns)).toISOString()}.`);
      }
      throw new HireError("REVEAL_UNCONFIRMED", `the reveal was sent but no result came back (${why}). ${this.job.reveal_tx ? `Its tx ${this.job.reveal_tx} is saved; ` : ""}run \`earned hire\` again to look it up.`);
    }
    const p = parseTxOutcome(outcome, this.contractId);
    if (p.failure) {
      const earlier = pendingTxs(this.job, "reveal").filter((h) => h !== p.txHash);
      if (/no open job with that id/.test(p.failure) && earlier.length) {
        // An earlier reveal of ours probably closed the job: keep its hash and look it up next run.
        this.save({ ...this.job, status: "revealing", ...this.dropTx("reveal", p.txHash) });
        throw this.closeTxUnconfirmed("reveal", earlier);
      }
      this.save({ ...this.job, status: "reviewed", ...this.dropTx("reveal", p.txHash) });
      throw new HireError(
        "REVEAL_REJECTED",
        `Reveal rejected: ${p.failure} (tx ${p.txHash}). Nothing moved. Without a valid reveal by ${new Date(nsToMs(view.reveal_deadline_ns)).toISOString()}, the signed review pays the seller.`,
      );
    }
    return this.finish("reveal", p, before);
  }

  async timeoutStage(view) {
    const s = stageOf(view);
    this.say(`${s.field} has passed: calling timeout(${this.jobId})`);
    const prior = this.job.status;
    let last = "";
    for (let i = 0; i < TIMEOUT_TRIES; i++) {
      if (i > 0) await this.sleep(POLL_MS * 2);
      this.save({ ...this.job, status: "timing_out" });
      let outcome;
      try {
        outcome = await this.sendTx("timeout", { job_id: this.jobId }, TIMEOUT_GAS, (h) => this.save({ ...this.job, timeout_tx: h, timeout_txs: [...pendingTxs(this.job, "timeout"), h] }));
      } catch (err) {
        last = redact(String(err?.message ?? err), this.state).slice(0, 200);
        if (err?.notSent) {
          this.save({ ...this.job, status: prior, ...this.dropTx("timeout", this.job.timeout_tx) });
          continue;
        }
        throw new HireError("TIMEOUT_UNCONFIRMED", `timeout was sent but no result came back (${last}). Run \`earned hire\` again to look it up.`);
      }
      const p = parseTxOutcome(outcome, this.contractId);
      if (!p.failure) return this.finish("timeout", p, null);
      last = p.failure;
      this.save({ ...this.job, status: prior, ...this.dropTx("timeout", p.txHash) });
      if (/has not passed yet/.test(p.failure)) {
        // Block time behind our clock, or the stage moved (a late-visible review, M-4): re-read first.
        const v = await this.getJob().catch(() => null);
        if (v && stageOf(v).key !== s.key) {
          this.say(`  the job moved on (${stageOf(v).what}); not timing out`);
          return RESTART;
        }
        continue;
      }
      if (/no open job with that id/.test(p.failure)) return this.closedUnseen();
      break;
    }
    throw new HireError("TIMEOUT_REFUSED", `timeout(${this.jobId}) did not land: ${last}. Run \`earned hire\` again.`);
  }

  /** Job fields after removing a closing tx hash that can no longer land (not sent, or refused). */
  dropTx(kind, hash) {
    const left = pendingTxs(this.job, kind).filter((h) => h !== hash);
    return { [`${kind}_tx`]: left.at(-1) ?? null, [`${kind}_txs`]: left };
  }

  /** The job is gone from get_job and we never saw its closing tx (another caller closed it). */
  closedUnseen() {
    // One of ours may be the closing tx: never close blind over it (M-1 / sec L-2).
    for (const kind of ["reveal", "timeout"]) {
      const mine = pendingTxs(this.job, kind);
      if (mine.length) throw this.closeTxUnconfirmed(kind, mine);
    }
    this.save({ ...this.job, status: "closed", outcome: "closed_elsewhere" });
    this.say(`Job ${this.jobId} is closed on-chain (get_job returns null), but this CLI did not see the closing tx. Find the outcome at ${EXPLORER}/address/${this.contractId}.`);
    this.say(`If it was a refund (decline or timeout), the ${formatNear(BigInt(this.job.price_yocto))} NEAR still counts against your 0.2 NEAR cap in this CLI.`);
    this.say("Job file closed; run `earned pick <1|2|3>` for a new job.");
    return { job: this.job, outcome: null, receiptPath: null, verify: null, pass: false };
  }

  /**
   * Prints and records a landed closing tx. Order (M-2): the job stays revealing / timing_out with
   * its tx hash saved while the quote is read and the receipt written, so an interrupted run
   * re-enters through resumeClosing and rebuilds them; only then is it marked closed, and only
   * after that is a refund released from the spend cap (a crash between over-counts, never under).
   */
  async finish(kind, p, before) {
    const outcome = outcomeOf(p.events, this.jobId, this.state.account_id);
    const txs = { ...(this.job.txs ?? {}), ...(this.job.create_tx ? { create: this.job.create_tx } : {}), [kind]: p.txHash };
    const close = () => {
      this.save({ ...this.job, status: "closed", outcome: outcome?.kind ?? "unknown", closing_tx: p.txHash, txs });
      if (outcome?.refundYocto) {
        const amount = BigInt(outcome.refundYocto) < BigInt(this.job.price_yocto) ? outcome.refundYocto : this.job.price_yocto;
        this.state = releaseSpend(this.state, amount);
        saveState(this.dir, this.state);
      }
    };
    if (kind === "reveal") this.review = reviewWithHash(this.reviews, this.job.review_checked_sha256) ?? this.review;
    before ??= this.savedBefore();

    let regrade = null;
    let escrowAgrees = false;
    if (outcome?.reveal && this.review) {
      const { g, lines } = gradeLines(this.key, this.review.response_body);
      lines.forEach((l) => this.say(l));
      regrade = g;
      const e = outcome.reveal.data;
      escrowAgrees = e.found === g.found && e.passed === g.passed;
      if (!escrowAgrees) this.say(`WARNING: the escrow graded ${e.found}/${e.total} (${e.passed ? "pass" : "fail"}); this CLI's regrade differs`);
    } else if (outcome?.reveal) {
      const e = outcome.reveal.data;
      this.say(`Grade (escrow): ${e.found}/${e.total} found (pass mark ${e.pass_min}) -> ${e.passed ? "PASS" : "FAIL"}${e.error ? ` (${e.error})` : ""}`);
    }
    if (!outcome) {
      close();
      this.say(`The ${kind} tx ${p.txHash} landed, but it has no closing event for job ${this.jobId}; check ${EXPLORER}/txns/${p.txHash}`);
      return { job: this.job, outcome: null, receiptPath: null, verify: null, pass: false };
    }
    this.say(outcome.line);
    const txLabel = kind !== "reveal" ? "timeout tx" : outcome.kind === "settled" ? "settle tx (the settle runs inside reveal)" : outcome.kind === "refunded_fail" ? "refund tx (the refund runs inside reveal)" : "reveal tx";
    this.say(`  ${txLabel}: ${p.txHash}`);
    this.say(`  ${EXPLORER}/txns/${p.txHash}`);

    const quote = await this.nextQuote(before, outcome);
    let receiptPath = null;
    let v = null;
    if (kind === "reveal" && this.review && this.liveReviewOnChain) {
      ({ receiptPath, v } = this.writeReceipt(quote, txs));
    } else if (kind === "reveal") {
      this.say("No receipt: this CLI does not hold the live review that the escrow stored for this job.");
    }
    close();
    if (this.job.pack_id === STEP4_PACK && kind === "reveal") {
      // Step 4 (S-023): the repeat pass (or a real fail), checked against the on-chain record.
      const step4 = step4Report({ outcome, txHash: p.txHash, seller: this.job.seller, priceYocto: this.job.price_yocto, before, after: this.afterQuote, regrade, escrowAgrees, verify: v });
      step4.lines.forEach((l) => this.say(l));
      if (step4.pass) this.say("SEE: step 4 PASS");
      else this.say("Job file closed; run `earned hire --pack 3` for a new pack 3 job.");
      return { job: this.job, outcome, receiptPath, verify: v, pass: step4.pass, step4 };
    }
    const pass = outcome.kind === "settled" && regrade?.passed === true && v?.ok === true && v.checks?.[3]?.ok === true && v.checks[3].regrade?.passed === true;
    if (pass) this.say("SEE: step 3 PASS");
    else this.say("Job file closed; run `earned pick <1|2|3>` for a new job.");
    return { job: this.job, outcome, receiptPath, verify: v, pass };
  }

  /**
   * get_record + quote at the block of the closing receipt that wrote the record, accepted only if
   * get_job(this job) is null at that same block. The block may be ahead of the RPC for a moment
   * (UNKNOWN_BLOCK): polled VIEW_POLLS times. Returns the fetchQuote result or null (step 4 then
   * says "unclear" and prints no SEE line).
   */
  async pinnedAfter(outcome) {
    const at = outcome.graded ? outcome.recordBlock : null;
    if (typeof at !== "string" || at === "") return null;
    for (let i = 0; i < VIEW_POLLS; i++) {
      if (i > 0) await this.sleep(POLL_MS);
      let q;
      let job;
      try {
        q = await fetchQuote({ fetch: this.d.fetch, urls: this.d.urls, contractId: this.contractId, seller: this.job.seller, blockId: at });
        job = await viewFunction({ fetch: this.d.fetch, urls: this.d.urls, contractId: this.contractId, method: "get_job", args: { id: this.jobId }, blockId: at });
      } catch {
        continue; // the RPC does not know that block yet
      }
      if (q.blockHash !== at) return null; // not the block we asked for: never compare it
      return job === null ? q : null; // still open at that block: this state does not include our close
    }
    return null;
  }

  /** The record read just before an earlier run's reveal (job file), as { record, quoteMilli }, or null. */
  savedBefore() {
    try {
      const record = parseRecord(this.job.record_before);
      return { record, quoteMilli: quoteMilli(record) };
    } catch {
      return null;
    }
  }

  /** The quote after the close, from get_record. A graded close is waited for (the view lags). */
  async nextQuote(before, outcome) {
    const graded = outcome.graded;
    // The quote just before the close if we read it, else the price this job paid (L-2).
    const beforeText = formatMilli(before ? before.quoteMilli : Number(BigInt(this.job.price_yocto) / YOCTO_PER_MNEAR));
    // Review R-1 / sec L-3: only a read that provably includes this job's close may be compared with
    // the before-read. Close txs come back at EXECUTED_OPTIMISTIC, final views trail them, and
    // another buyer's close of the same seller also moves `jobs`. So get_record + quote are read AT
    // the block of the receipt that wrote the record, and get_job(job) must be null at that block.
    this.afterQuote = await this.pinnedAfter(outcome);
    let after = this.afterQuote;
    for (let i = 0; !after && i < VIEW_POLLS; i++) {
      try {
        after = await fetchQuote({ fetch: this.d.fetch, urls: this.d.urls, contractId: this.contractId, seller: this.job.seller });
      } catch {
        after = null;
      }
      if (after && (!graded || !before || after.record.jobs > before.record.jobs)) break;
      if (i < VIEW_POLLS - 1) await this.sleep(POLL_MS);
    }
    if (!after) {
      this.say(`Next quote: unavailable (testnet RPC); was ${beforeText} NEAR. Run \`earned quote ${this.job.seller}\`.`);
      return { before: beforeText, after: "unavailable", formula: undefined };
    }
    // A display-only read (not pinned to our close) is never handed to step 4 (this.afterQuote stays null).
    this.say(`Next quote (get_record): ${beforeText} -> ${formatMilli(after.quoteMilli)} NEAR`);
    after.lines.slice(1).forEach((l) => this.say(l));
    return { before: beforeText, after: formatMilli(after.quoteMilli), formula: after.lines[1].replace(/^\s*formula: /, "") };
  }

  // The review we hold passed revealStage's check against the escrow's stored hash for this job
  // (in this run or the run that sent the reveal), so it is the live review that landed.
  get liveReviewOnChain() {
    return !!this.review && typeof this.job.review_checked_sha256 === "string" && sha256Hex(this.review.response_body) === this.job.review_checked_sha256;
  }

  writeReceipt(quote, txs) {
    const j = this.job;
    const receipt = buildReceipt({
      job: { network: "testnet", contract: this.contractId, job_id: this.jobId, pack_id: j.pack_id, buyer: this.state.account_id, seller: j.seller, commit_hash: j.commit_hash },
      reveal: { K: j.K, salt: j.salt },
      review: this.review,
      quote,
      txs: Object.fromEntries(Object.entries(txs).filter(([, h]) => typeof h === "string" && h !== "")),
    });
    const paths = receiptPaths(this.dir, this.jobId);
    writeJsonAtomic(paths.review, this.review); // the checked review, next to the receipt
    writeReceipt(paths.receipt, receipt);
    const v = verifyReceipt(receipt, { trust: this.trust });
    this.say(`Receipt: ${paths.receipt}`);
    this.say(`  full review (response + attestation): ${paths.review}`);
    for (const c of v.checks) this.say(`  ${c.ok ? "PASS" : "FAIL"}  ${c.n} ${c.title}`);
    const rg = v.checks[3]?.regrade;
    this.say(`  regrade: ${rg ? `${rg.found}/${rg.total} ${rg.passed ? "PASS" : "FAIL"}` : "not computed"}`);
    this.say(`  ${v.verdict}`);
    this.say(`  ${v.not_proven}`);
    this.say(`Check it yourself: earned verify ${paths.receipt}`);
    return { receiptPath: paths.receipt, v };
  }

  /** Replay: a recorded past run, labelled RECORDED. Never builds or writes a receipt. */
  showRecorded() {
    const file = join(this.recordedDir, `${this.job.pack_id}.json`);
    if (!existsSync(file)) {
      this.say(`RECORDED: no recorded live run of ${this.job.pack_id} ships with this version yet.`);
      return;
    }
    try {
      const r = readReceipt(file);
      const v = verifyReceipt(r, { trust: this.trust });
      const rg = v.checks[3]?.regrade;
      this.say(`RECORDED (a past run, job ${r.job_id}; not your job, and no receipt is written for your job)`);
      this.say(`  RECORDED grade: ${rg ? `${rg.found}/${rg.total} ${rg.passed ? "PASS" : "FAIL"}` : "unreadable"}; settle tx ${r.txs?.reveal ?? "none recorded"}`);
      this.say(`  RECORDED ${v.verdict}`);
      this.say(`  ${v.not_proven}`);
    } catch (err) {
      this.say(`RECORDED: the recorded run of ${this.job.pack_id} is unreadable (${err?.code ?? "error"})`);
    }
  }
}

/** Real dependencies: keyless views over the T-014 RPC list; txs signed with near-api-js 7.4.0. */
export async function defaultHireDeps(env = process.env, { localSeller = false } = {}) {
  const urls = env.EARNED_RPC_URL ? [env.EARNED_RPC_URL] : RPC_URLS;
  urls.forEach(assertTestnetRpc);
  const load = async () => [await import("near-api-js"), await import("near-api-js/rpc-errors")];
  const sendTx = async (req) => {
    const [near, rpcErrors] = await load();
    const makeAccount = (url, st) => new near.Account(st.account_id, new near.JsonRpcProvider({ url }, { retries: RPC_RETRIES }), st.private_key);
    return sendCreateTx({ ...req, urls, makeAccount, near, rpcErrors });
  };
  const lookupTx = async ({ txHash, accountId }) => {
    const [near] = await load();
    for (const url of urls) {
      try {
        return await new near.JsonRpcProvider({ url }, { retries: RPC_RETRIES }).viewTransactionStatus({ txHash, accountId, waitUntil: "EXECUTED_OPTIMISTIC" });
      } catch {
        // next RPC
      }
    }
    return null;
  };
  let makeSeller = null;
  if (localSeller) {
    const sellerKey = env.EARNED_SELLER_PRIVATE_KEY;
    const apiKey = env.NEAR_AI_API_KEY;
    if (!sellerKey || !apiKey) {
      throw new HireError("SELLER_NOT_CONFIGURED", "--local-seller needs EARNED_SELLER_PRIVATE_KEY (the seller's key) and NEAR_AI_API_KEY in the environment. Nothing was sent.");
    }
    const { reviewJob } = await import("../seller/review.js");
    makeSeller = ({ accountId, contractId, getJob, say }) =>
      makeLocalSeller({
        sellerState: { account_id: accountId, private_key: sellerKey },
        contractId,
        sendTx,
        getJob,
        getSigners: () => viewFunction({ fetch: globalThis.fetch, urls, contractId, method: "signers" }),
        reviewJob,
        apiKey,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        log: say,
      });
  }
  return {
    cwd: process.cwd(),
    env,
    network: env.EARNED_NETWORK || NETWORK,
    fetch: globalThis.fetch,
    urls,
    sendTx,
    lookupTx,
    lookupCreate: lookupTx,
    makeSeller,
    // `--pack N` with no open job: the same pick as `earned pick N` (demo seller, scripted haggle).
    pick: async (opts) => runPick({ ...(await defaultPickDeps(env)), ...opts }),
  };
}

export { TxError };
