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
// Replay-only fallback (Nicho, 2026-11-12, decisions.md): when the live path can't run (TEE
// unavailable: 401/402/403/429/5xx/network/timeout from NEAR AI, signature unavailable, no time
// left, a cap hit, not configured, the chain unreachable) the answer is
//   { mode: "replay", label: "RECORDED", reason, review_submitted: false, job_state, message }
// and the site replays a real earlier run's receipt + explorer links, labelled RECORDED. Nothing
// pre-recorded is ever submitted on-chain (the escrow's freshness check + replay guard would
// refuse it anyway). Refusals that happen before accept also decline the open job, so the buyer
// is refunded at once and the seller's record is untouched. An outage AFTER accept leaves the job
// accepted with no review: at review_by the escrow refunds the buyer and records a fail for the
// seller (A-008); job_state "accepted_no_review" tells the site to say so.
//
// Secrets: the NEAR AI key (deps.apiKey) goes only into reviewJob; the seller key lives inside
// deps.chain. Neither, nor the client IP, appears in a response or a log line. Error messages from
// lower layers are never echoed: responses carry fixed codes and copy only.
import { DEFAULT_BUDGET_MS, DEFAULT_MAX_ATTEMPTS, ReviewError } from "../seller/review.js";
import { CapStoreError, reserveLive, reviewReserveMicro, utcDay } from "./caps.js";
import { visitorId } from "./visitor.js";

export const MAX_DURATION_MS = 300_000; // Vercel Hobby maximum (maxDuration 300)
const SAFETY_MS = 10_000; // answer before Vercel kills the function
const SUBMIT_RESERVE_MS = 45_000; // kept after the review for submit_review (as seller/review.js)
const MIN_REVIEW_MS = 30_000; // less review budget than this: replay instead of a paid call
const CHAIN_CALL_MS = 40_000; // one view or tx (near-api-js retries inside)
const ACCEPT_POLLS = 8; // get_job reads at "final"; the accept landed at "optimistic" a block or two earlier
const ACCEPT_POLL_MS = 1_000;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
export const MAX_BODY_BYTES = 1024;
const U64_MAX = 18446744073709551615n;
const PACK_IDS = new Set(["pack-1", "pack-2", "pack-3"]);

export const REPLAY_REASONS = [
  "tee_unavailable",
  "timeout",
  "cap_daily",
  "cap_visitor",
  "cap_spend",
  "cap_store_unavailable",
  "not_configured",
  "chain_unavailable",
  "chain_refused",
  "review_failed",
];

const COPY = {
  tee_unavailable: "The TEE reviewer is unavailable right now (NEAR AI Cloud refused, ran out of credit or timed out).",
  timeout: "The live review ran out of time.",
  cap_daily: "Today's live reviews are used up.",
  cap_visitor: "You've used your live reviews for today.",
  cap_spend: "The live review budget for this demo is used up.",
  cap_store_unavailable: "Live reviews are paused (the usage counter is unavailable).",
  not_configured: "Live reviews are not switched on for this deployment.",
  chain_unavailable: "NEAR testnet could not be reached.",
  chain_refused: "NEAR testnet refused the review transaction.",
  review_failed: "The live review could not be completed.",
};
const JOB_COPY = {
  declined: " Your job was declined and your deposit refunded.",
  open: " Your job was not accepted; the escrow refunds your deposit after the accept window.",
  accepted_no_review: " Your job was accepted but no review landed: the escrow refunds you at the review deadline and records a fail for the seller.",
  unknown: "",
};

const REVIEW_REPLAY = {
  TEE_UNAVAILABLE: "tee_unavailable",
  SIGNATURE_UNAVAILABLE: "tee_unavailable",
  DEADLINE_EXCEEDED: "timeout",
  NO_API_KEY: "not_configured",
};

const error = (status, code, message) => ({ status, body: { mode: "error", code, message } });

/**
 * deps: { sellerId, apiKey, sellerKeyConfigured, chain, store, review, loadPack, visitorSecret,
 * now?, log?, sleep?, maxDurationMs?, chainTimeoutMs? }. chain: { getJob(id), signers(), getRecord(seller),
 * accept(id), decline(id), submitReview(args) }; tx methods resolve to
 * { status: landed | failed | not_sent | unknown, txHash, message? } and never throw.
 */
export async function handleReview(req, deps) {
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

  // 1. Request shape. Strict: only job_id (u64 decimal string) and pack_id.
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
  const keysOk = Object.keys(input).length === 2 && "job_id" in input && "pack_id" in input;
  if (!keysOk || !validJobId(jobId) || !PACK_IDS.has(packId)) {
    return done(error(400, "BAD_INPUT", 'Body must be exactly { "job_id": "<u64 decimal string>", "pack_id": "pack-1" | "pack-2" | "pack-3" }.'));
  }

  const replay = (reason, jobState, extra = {}) =>
    done(
      {
        status: 200,
        body: { mode: "replay", label: "RECORDED", reason, review_submitted: false, job_id: jobId, job_state: jobState, message: COPY[reason] + JOB_COPY[jobState], ...extra },
      },
      { job_id: jobId },
    );

  // 2. The job must be ours, for this pack, and still reviewable.
  let job;
  try {
    job = await within(deps.chain.getJob(jobId), chainMs());
  } catch {
    return replay("chain_unavailable", "unknown");
  }
  if (!job) return done(error(404, "JOB_NOT_FOUND", "No live job with that id."));
  if (job.seller !== deps.sellerId) return done(error(403, "NOT_OUR_SELLER", "This job is not for the demo seller."));
  if (job.pack_id !== packId) return done(error(409, "PACK_MISMATCH", `The job is for ${job.pack_id}.`));
  if (job.status === "accepted" && job.review != null) return done(error(409, "ALREADY_REVIEWED", "This job already has its review on-chain."));
  if (job.status === "open" && BigInt(job.accept_by_ns) < BigInt(t0) * 1_000_000n) return done(error(409, "JOB_EXPIRED", "The accept window for this job has passed."));
  if (job.status !== "open" && job.status !== "accepted") return done(error(409, "JOB_NOT_REVIEWABLE", "This job can't be reviewed."));

  if (!deps.sellerKeyConfigured) return replay("not_configured", job.status === "open" ? "open" : "accepted_no_review");

  // Refused before accept: decline an open job so the buyer is refunded now (best effort).
  const refuse = async (reason) => {
    if (job.status !== "open") return replay(reason, "accepted_no_review");
    const d = await tx(deps.chain.decline(jobId), chainMs());
    return d.status === "landed" ? replay(reason, "declined", { decline_tx: d.txHash }) : replay(reason, "open", { decline_tx: null });
  };
  if (!deps.apiKey) return refuse("not_configured");

  // 3. Caps: job lock, 100/day, 3 per visitor and per buyer, $1.75 spend stop (with the on-chain floor).
  const pack = deps.loadPack(packId.slice(5));
  const reserveMicro = reviewReserveMicro(pack);
  let floorMicro = 0;
  try {
    const rec = await within(deps.chain.getRecord(deps.sellerId), chainMs());
    floorMicro = (Number(rec?.passes ?? 0) + Number(rec?.fails ?? 0)) * reserveMicro;
  } catch {
    // backstop only: the store counter still applies
  }
  let slot;
  try {
    slot = await reserveLive({ store: deps.store, jobId, visitor, buyer: job.buyer, day: utcDay(t0), reserveMicro, floorMicro });
  } catch (e) {
    if (!(e instanceof CapStoreError)) throw e;
    return refuse("cap_store_unavailable");
  }
  if (!slot.ok) {
    if (slot.reason === "job_busy") return done(error(409, "JOB_BUSY", "This job's review is already running."));
    return refuse(slot.reason);
  }

  // 4. Accept (A-010: before the review; the escrow's freshness window starts here).
  let acceptTx = null;
  if (job.status === "open") {
    const a = await tx(deps.chain.accept(jobId), chainMs());
    if (a.status === "failed") {
      await slot.release();
      return done(error(409, "ACCEPT_REFUSED", "The escrow refused accept for this job."));
    }
    if (a.status !== "landed") {
      if (a.status === "not_sent") await slot.release();
      return replay("chain_unavailable", a.status === "not_sent" ? "open" : "unknown");
    }
    acceptTx = a.txHash;
  }

  // 5. TEE review on the re-read job (accepted_at_ns, review_by_ns), within the function's time.
  // Views read "final" state, which trails the optimistic accept by a block or two: poll briefly.
  let accepted;
  let signers;
  try {
    for (let i = 0; i < ACCEPT_POLLS; i++) {
      accepted = await within(deps.chain.getJob(jobId), chainMs());
      if (accepted?.status === "accepted") break;
      if (i < ACCEPT_POLLS - 1) await (deps.sleep ?? sleep)(ACCEPT_POLL_MS);
    }
    signers = await within(deps.chain.signers(), chainMs());
  } catch {
    await slot.release(); // no TEE call yet: a retry may resume this accepted job
    return replay("chain_unavailable", "accepted_no_review");
  }
  if (!accepted || accepted.status !== "accepted") {
    await slot.release();
    return replay("chain_unavailable", "unknown");
  }
  const budgetMs = Math.min(DEFAULT_BUDGET_MS, deadline - now() - SUBMIT_RESERVE_MS);
  if (budgetMs < MIN_REVIEW_MS) {
    await slot.release();
    return replay("timeout", "accepted_no_review");
  }
  let r;
  try {
    r = await deps.review({ job: accepted, pack, apiKey: deps.apiKey, signers, budgetMs });
  } catch (e) {
    // The reservation stays: a paid call may have happened before the failure.
    const reason = e instanceof ReviewError ? (REVIEW_REPLAY[e.code] ?? "review_failed") : "review_failed";
    return replay(reason, "accepted_no_review", { review_error: e instanceof ReviewError ? e.code : "INTERNAL" });
  }
  const attempts = Number.isInteger(r.attempts) && r.attempts > 0 ? Math.min(r.attempts, DEFAULT_MAX_ATTEMPTS) : DEFAULT_MAX_ATTEMPTS;
  try {
    await slot.settle((reserveMicro * attempts) / DEFAULT_MAX_ATTEMPTS);
  } catch {
    // keeping the full reservation is the safe side
  }

  // 6. Submit the signed review now (freshness window). Only a fresh review is ever submitted.
  const s = await tx(deps.chain.submitReview(r.submit_args), Math.max(1, deadline - now()));
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

function header(headers, name) {
  return typeof headers?.get === "function" ? headers.get(name) : (headers?.[name] ?? null);
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
