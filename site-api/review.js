// T-028 / S-005: the website's live review step (beat 3), framework-agnostic.
//
// handleReview({ method, headers, bodyText }, deps) -> { status, body }. site-api/vercel.js turns
// a Web Request into that and the result into a Response; tests call it directly.
//
// The browser created the job (its throwaway buyer account signed `create`). This function plays
// the demo seller: it checks the job is ours, takes a live slot (caps), accepts the job, runs the
// TEE review (seller/review.js reviewJob) and submits the signed review on-chain. The browser then
// reveals with its own key + salt.
//
// Caller binding (security M-1): the request carries an ed25519 signature by the job's buyer key
// over { job_id, pack_id, expires_ms } (site-api/buyer-auth.js), and the function checks on-chain that
// the key belongs to job.buyer before it accepts, declines or pays for anything.
//
// Replay-only fallback (Nicho, 2026-11-12, decisions.md): when the live path can't run (TEE
// unavailable: 401/402/403/429/5xx/network/timeout from NEAR AI, signature unavailable, no time
// left, a cap hit, not configured, the chain unreachable, the job busy or expired) the answer is
//   { mode: "replay", label: "RECORDED", reason, review_submitted: false, job_state, message }
// and the site replays a real earlier run's receipt + explorer links, labelled RECORDED. Nothing
// pre-recorded is ever submitted on-chain (the escrow's freshness check + replay guard would
// refuse it anyway). Refusals that hold for EVERY caller (GLOBAL_REFUSALS) and happen before accept
// also decline the open job, so the buyer is refunded at once and the seller's record is untouched;
// per-caller refusals (cap_visitor, cap_buyer) never decline. Nothing refunds by itself: an open job
// past accept_by, or an accepted job with no review past review_by, stays in the escrow until
// someone calls the contract's timeout(job_id). The site (T-033) calls it with the buyer key; for
// "accepted_no_review" that timeout also records a fail for the seller (A-008).
//
// Secrets: the NEAR AI key (deps.apiKey) goes only into reviewJob; the seller key lives inside
// deps.chain. Neither, nor the client IP, appears in a response or a log line. Error messages from
// lower layers are never echoed: responses carry fixed codes and copy only.
import { DEFAULT_BUDGET_MS, DEFAULT_MAX_ATTEMPTS, ReviewError } from "../seller/review.js";
import { authShapeOk, checkReviewAuth } from "./buyer-auth.js";
import { CapStoreError, reserveLive, reviewReserveMicro, utcDay } from "./caps.js";
import { header, visitorId } from "./visitor.js";

export const MAX_DURATION_MS = 300_000; // Vercel Hobby maximum (maxDuration 300)
const SAFETY_MS = 10_000; // answer before Vercel kills the function
const SUBMIT_RESERVE_MS = 45_000; // kept after the review for submit_review (as seller/review.js)
const MIN_REVIEW_MS = 30_000; // less review budget than this: replay instead of a paid call
const CHAIN_CALL_MS = 40_000; // one view or tx (near-api-js retries inside)
const ACCEPT_POLLS = 8; // get_job reads at "final"; the accept landed at "optimistic" a block or two earlier
const ACCEPT_POLL_MS = 1_000;
const ACCEPT_POLL_TOTAL_MS = 10_000; // stop re-reading after this, however slow the reads are
const SUBMIT_RETRY_MIN_MS = 10_000; // retry a never-sent submit_review only with this much time left
const SUBMIT_TRIES = 3;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
export const MAX_BODY_BYTES = 1024;
const U64_MAX = 18446744073709551615n;
const PACK_IDS = new Set(["pack-1", "pack-2", "pack-3"]);
const INPUT_KEYS = ["job_id", "pack_id", "public_key", "signature", "expires_ms"];

export const REPLAY_REASONS = [
  "tee_unavailable",
  "timeout",
  "cap_daily",
  "cap_visitor",
  "cap_buyer",
  "cap_spend",
  "cap_store_unavailable",
  "not_configured",
  "chain_unavailable",
  "chain_refused",
  "job_busy",
  "job_expired",
  "review_failed",
];

// Refusals that would hit any caller for this job: only these may decline an open job (M-1).
export const GLOBAL_REFUSALS = new Set(["cap_daily", "cap_spend", "cap_store_unavailable", "not_configured"]);

export const COPY = {
  tee_unavailable: "The TEE reviewer is unavailable right now (NEAR AI Cloud refused, ran out of credit or timed out).",
  timeout: "The live review ran out of time.",
  cap_daily: "Today's live reviews are used up.",
  cap_visitor: "You've used your live reviews for today.",
  cap_buyer: "This buyer account has used its live reviews for today.",
  cap_spend: "The live review budget for this demo is used up.",
  cap_store_unavailable: "Live reviews are paused (the usage counter is unavailable).",
  not_configured: "Live reviews are not switched on for this deployment.",
  chain_unavailable: "NEAR testnet could not be reached.",
  chain_refused: "NEAR testnet refused the review transaction.",
  job_busy: "This job's live review is already running.",
  job_expired: "The accept window for this job has passed.",
  review_failed: "The live review could not be completed.",
};
// Code review M-2: the escrow refunds nothing by itself; someone must call timeout(job_id).
const JOB_COPY = {
  declined: " Your job was declined and your deposit refunded.",
  open: " Your job was not accepted. Once its accept window closes, calling the escrow's timeout refunds your deposit (the site does this for you).",
  accepted_no_review: " Your job was accepted but no review landed. Once the review deadline passes, calling the escrow's timeout refunds you and records a fail for the seller (the site does this for you).",
  unknown: "",
};

const REVIEW_REPLAY = {
  TEE_UNAVAILABLE: "tee_unavailable",
  SIGNATURE_UNAVAILABLE: "tee_unavailable",
  DEADLINE_EXCEEDED: "timeout",
  NO_API_KEY: "not_configured",
};
// reviewJob throws these before its paid chat call, so the slot is given back (security L-1).
const UNPAID_REVIEW_ERRORS = new Set([
  "NO_API_KEY",
  "JOB_NOT_ACCEPTED",
  "ALREADY_REVIEWED",
  "PACK_MISMATCH",
  "REVIEW_WINDOW_CLOSED",
  "BAD_REQUEST_BODY",
  "BAD_OPTIONS",
  "NO_SIGNERS",
  "ATTESTATION_INVALID",
  "SIGNER_NOT_ALLOWLISTED",
]);

/** Fixed body for anything unexpected (S-1 / L-3): no raw 500, no internals. */
export const INTERNAL_REPLAY = Object.freeze({ mode: "replay", label: "RECORDED", reason: "review_failed", review_submitted: false, job_id: null, job_state: "unknown", message: COPY.review_failed });

const error = (status, code, message) => ({ status, body: { mode: "error", code, message } });
const nsToMs = (ns) => Number(BigInt(ns) / 1_000_000n);

/**
 * deps: { sellerId, apiKey, sellerKeyConfigured, liveEnabled?, sellerKeyCheck?, chain, store, review,
 * loadPack, visitorSecret, now?, log?, sleep?, maxDurationMs?, chainTimeoutMs? }.
 * chain: { getJob(id), hasAccessKey(account, publicKey), signers(), getRecord(seller), accept(id),
 * decline(id), submitReview(args) }; tx methods resolve to
 * { status: landed | failed | not_sent | unknown, txHash, message? } and never throw.
 * liveEnabled === false: the deployment may not run live reviews (no durable cap store, H-1).
 * sellerKeyCheck(): "ok" | "full_access" | "wrong_scope" | "missing" (M-2); anything but "ok" = no tx.
 *
 * Never throws: an unexpected error becomes a fixed replay body (S-1 / L-3).
 */
export async function handleReview(req, deps) {
  try {
    return await handle(req, deps);
  } catch {
    try {
      (deps?.log ?? ((l) => console.log(l)))(JSON.stringify({ at: "review-fn", outcome: "replay", code: "INTERNAL" }));
    } catch {
      // logging must not turn this into a 500
    }
    return { status: 200, body: { ...INTERNAL_REPLAY } };
  }
}

async function handle(req, deps) {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const deadline = t0 + (deps.maxDurationMs ?? MAX_DURATION_MS) - SAFETY_MS;
  const chainMs = () => Math.max(1, Math.min(deps.chainTimeoutMs ?? CHAIN_CALL_MS, deadline - now()));
  const log = deps.log ?? ((l) => console.log(l));
  const visitor = visitorId(req.headers, deps.visitorSecret);
  const done = (res, extra = {}) => {
    log(JSON.stringify({ at: "review-fn", outcome: res.body.mode, code: res.body.code ?? res.body.reason ?? null, visitor: visitor.slice(0, 8), ms: now() - t0, ...extra }));
    return res;
  };

  // 1. Request shape. Strict: exactly job_id (u64 decimal string), pack_id and the buyer's auth fields.
  if (req.method !== "POST") return done(error(405, "METHOD_NOT_ALLOWED", "Use POST."));
  const ctype = header(req.headers, "content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(ctype)) return done(error(415, "UNSUPPORTED_MEDIA_TYPE", "Send JSON (Content-Type: application/json)."));
  const text = String(req.bodyText ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return done(error(413, "BODY_TOO_LARGE", "Request body too large."));
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    input = null;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return done(error(400, "BAD_JSON", "Body must be a JSON object."));
  const { job_id: jobId, pack_id: packId } = input;
  const keysOk = Object.keys(input).length === INPUT_KEYS.length && INPUT_KEYS.every((k) => k in input);
  if (!keysOk || !validJobId(jobId) || !PACK_IDS.has(packId) || !authShapeOk(input)) {
    return done(
      error(400, "BAD_INPUT", 'Body must be exactly { "job_id": "<u64 decimal string>", "pack_id": "pack-1" | "pack-2" | "pack-3", "public_key": "ed25519:...", "signature": "<base64>", "expires_ms": "<epoch ms>" }.'),
    );
  }

  // 2. The buyer's signature (no network). Which account the key belongs to is checked after get_job.
  const authErr = checkReviewAuth(input, t0);
  if (authErr === "AUTH_EXPIRED") return done(error(401, authErr, "The request signature has expired; sign it again."));
  if (authErr) return done(error(401, authErr, "The request signature does not verify."));

  const replay = (reason, jobState, extra = {}, logExtra = {}) =>
    done(
      {
        status: 200,
        body: { mode: "replay", label: "RECORDED", reason, review_submitted: false, job_id: jobId, job_state: jobState, message: COPY[reason] + JOB_COPY[jobState], ...extra },
      },
      { job_id: jobId, ...logExtra },
    );

  // 3. The job must be ours, the caller its buyer, for this pack, and still reviewable.
  let job;
  try {
    job = await within(deps.chain.getJob(jobId), chainMs());
  } catch {
    return replay("chain_unavailable", "unknown");
  }
  if (!job) return done(error(404, "JOB_NOT_FOUND", "No live job with that id."));
  if (job.seller !== deps.sellerId) return done(error(403, "NOT_OUR_SELLER", "This job is not for the demo seller."));
  let isBuyer;
  try {
    isBuyer = await within(deps.chain.hasAccessKey(job.buyer, input.public_key), chainMs());
  } catch {
    return replay("chain_unavailable", "unknown");
  }
  if (isBuyer !== true) return done(error(403, "NOT_BUYER", "The signing key is not a key of this job's buyer."));
  if (job.pack_id !== packId) return done(error(409, "PACK_MISMATCH", `The job is for ${job.pack_id}.`));
  if (job.status === "accepted" && job.review != null) return done(error(409, "ALREADY_REVIEWED", "This job already has its review on-chain."));
  if (job.status === "open" && BigInt(job.accept_by_ns) < BigInt(t0) * 1_000_000n) return replay("job_expired", "open", { code: "JOB_EXPIRED" });
  if (job.status !== "open" && job.status !== "accepted") return done(error(409, "JOB_NOT_REVIEWABLE", "This job can't be reviewed."));
  const unreviewed = job.status === "open" ? "open" : "accepted_no_review";

  // 4. Configuration. No seller key, or a key wider than accept/decline/submit_review: no tx at all.
  if (!deps.sellerKeyConfigured) return replay("not_configured", unreviewed);
  if (deps.sellerKeyCheck) {
    let scope;
    try {
      scope = await within(deps.sellerKeyCheck(), chainMs());
    } catch {
      return replay("chain_unavailable", unreviewed);
    }
    if (scope !== "ok") return replay("not_configured", unreviewed, {}, { seller_key: String(scope) });
  }

  // Refused before accept: decline an open job (buyer refunded now) only when the refusal would hit
  // any caller; a per-caller cap leaves the job open (M-1).
  const declineOrReplay = async (reason) => {
    if (job.status !== "open") return replay(reason, "accepted_no_review");
    if (!GLOBAL_REFUSALS.has(reason)) return replay(reason, "open");
    const d = await tx(deps.chain.decline(jobId), chainMs());
    return d.status === "landed" ? replay(reason, "declined", { decline_tx: d.txHash }) : replay(reason, "open", { decline_tx: null });
  };
  // H-1: no durable cap store (or no dedicated NEAR AI key) means no live review.
  if (!deps.apiKey || deps.liveEnabled === false) return declineOrReplay("not_configured");

  // A resumed (accepted, unreviewed) job needs enough of its review window left (S-2 / L-1).
  const windowLeft = (j) => nsToMs(j.review_by_ns) - SUBMIT_RESERVE_MS - now();
  if (job.status === "accepted" && windowLeft(job) < MIN_REVIEW_MS) return replay("timeout", "accepted_no_review");

  // 5. Caps: job lock, 100/day, 3 per visitor and per buyer, $1.75 spend stop (with the on-chain floor).
  const pack = deps.loadPack(packId.slice(5));
  const reserveMicro = reviewReserveMicro(pack);
  let floorMicro = 0;
  try {
    const rec = await within(deps.chain.getRecord(deps.sellerId), chainMs());
    floorMicro = (Number(rec?.passes ?? 0) + Number(rec?.fails ?? 0)) * reserveMicro;
  } catch {
    // partial backstop only: the store counter still applies
  }
  let slot;
  try {
    slot = await reserveLive({ store: deps.store, jobId, visitor, buyer: job.buyer, day: utcDay(t0), reserveMicro, floorMicro });
  } catch (e) {
    if (!(e instanceof CapStoreError)) throw e;
    return declineOrReplay("cap_store_unavailable");
  }
  if (!slot.ok) {
    if (slot.reason === "job_busy") return replay("job_busy", "unknown", { code: "JOB_BUSY" }); // S-4
    return declineOrReplay(slot.reason);
  }
  // Best effort: if the store is down, keeping the reservation is the safe side (S-1).
  const free = async () => {
    try {
      await slot.release();
    } catch {
      // the daily keys and the job lock expire on their own
    }
  };

  // 6. Accept (A-010: before the review; the escrow's freshness window starts here).
  let acceptTx = null;
  if (job.status === "open") {
    const a = await tx(deps.chain.accept(jobId), chainMs());
    if (a.status === "failed") {
      await free();
      return replay("chain_refused", "unknown", { code: "ACCEPT_REFUSED" }); // S-4
    }
    if (a.status !== "landed") {
      if (a.status === "not_sent") await free();
      return replay("chain_unavailable", a.status === "not_sent" ? "open" : "unknown");
    }
    acceptTx = a.txHash;
  }

  // 7. TEE review on the re-read job (accepted_at_ns, review_by_ns), within the function's time.
  // Views read "final" state, which trails the optimistic accept by a block or two: poll briefly.
  let accepted;
  let signers;
  try {
    const pollEnd = now() + ACCEPT_POLL_TOTAL_MS;
    for (let i = 0; i < ACCEPT_POLLS; i++) {
      accepted = await within(deps.chain.getJob(jobId), chainMs());
      if (accepted?.status === "accepted" || now() >= pollEnd) break;
      if (i < ACCEPT_POLLS - 1) await (deps.sleep ?? sleep)(ACCEPT_POLL_MS);
    }
    signers = await within(deps.chain.signers(), chainMs());
  } catch {
    await free(); // no TEE call yet: a retry may resume this accepted job
    return replay("chain_unavailable", "accepted_no_review");
  }
  if (!accepted || accepted.status !== "accepted") {
    await free();
    return replay("chain_unavailable", "unknown");
  }
  const budgetMs = Math.min(DEFAULT_BUDGET_MS, deadline - now() - SUBMIT_RESERVE_MS, windowLeft(accepted));
  if (budgetMs < MIN_REVIEW_MS) {
    await free();
    return replay("timeout", "accepted_no_review");
  }
  let r;
  try {
    r = await deps.review({ job: accepted, pack, apiKey: deps.apiKey, signers, budgetMs });
  } catch (e) {
    const code = e instanceof ReviewError ? e.code : "INTERNAL";
    // Otherwise the reservation stays: a paid call may have happened before the failure.
    if (UNPAID_REVIEW_ERRORS.has(code)) await free();
    return replay(REVIEW_REPLAY[code] ?? "review_failed", "accepted_no_review", { review_error: code });
  }

  // 8. Submit the signed review now (freshness window). Only a fresh review is ever submitted. A
  // never-sent tx (e.g. a nonce race between instances) is retried while time is left (L-4); the
  // escrow refuses a second review of the same job, so a retry can't double-submit.
  let s;
  for (let i = 0; i < SUBMIT_TRIES; i++) {
    s = await tx(deps.chain.submitReview(r.submit_args), Math.max(1, deadline - now()));
    if (s.status !== "not_sent" || deadline - now() < SUBMIT_RETRY_MIN_MS) break;
  }
  const attempts = Number.isInteger(r.attempts) && r.attempts > 0 ? Math.min(r.attempts, DEFAULT_MAX_ATTEMPTS) : DEFAULT_MAX_ATTEMPTS;
  try {
    await slot.settle((reserveMicro * attempts) / DEFAULT_MAX_ATTEMPTS); // after the submit (O-3)
  } catch {
    // keeping the full reservation is the safe side
  }
  if (s.status === "not_sent") return replay("chain_unavailable", "accepted_no_review");
  if (s.status === "failed") return replay("chain_refused", "accepted_no_review", { submit_tx: s.txHash ?? null });
  return done(
    {
      status: 200,
      body: {
        mode: "live",
        job_id: jobId,
        pack_id: packId,
        seller: deps.sellerId,
        accept_tx: acceptTx,
        submit: { status: s.status === "landed" ? "landed" : "unknown", tx_hash: s.txHash ?? null },
        review_submitted: s.status === "landed",
        review: {
          findings: r.findings,
          check: r.check,
          misses: r.misses,
          attempts: r.attempts,
          created: r.created,
          request_body: r.request_body,
          response_body: r.response_body,
          tee: r.tee,
        },
      },
    },
    { job_id: jobId },
  );
}

function validJobId(v) {
  return typeof v === "string" && /^(0|[1-9]\d{0,19})$/.test(v) && BigInt(v) <= U64_MAX;
}

/** Rejects when `p` takes longer than `ms`. */
function within(p, ms) {
  let timer;
  return Promise.race([p, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("timeout")), ms)))]).finally(() => clearTimeout(timer));
}

/** A chain tx with a time limit; a timeout or a throw is an unknown outcome (it may have landed). */
async function tx(p, ms) {
  try {
    const r = await within(p, ms);
    return r && typeof r.status === "string" ? r : { status: "unknown", txHash: null };
  } catch {
    return { status: "unknown", txHash: null };
  }
}
