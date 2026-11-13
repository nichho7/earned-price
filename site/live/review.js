// [CTO] T-036 / S-013 · beat 3 helpers for /live (browser-safe; nothing here signs or touches the key).
//
// - requestReview: the browser client of the T-028 review function (POST /api/review, site-api/review.js). The body is
//   { job_id, pack_id, public_key, signature, expires_ms }: the auth fields are signed by the gate (account.js
//   signReviewAuth), so the key never leaves account.js. 401 AUTH_EXPIRED is signed again once (T-028 "what T-033 must
//   wire"). The answer is normalised to { mode: "live", ... } or { mode: "replay", reason, job_state }. Everything the
//   function can't answer cleanly (no route yet = 404, any 5xx, a 504, a body that isn't the contract's shape, a client
//   timeout past the function's 300 s, a network error) is { mode: "replay", reason: "review_down" }: RECORDED plays.
//   The NEAR AI key is server-side only; the page sees the review body, never a key.
// - The review body is cached per job in this browser (REVIEW_KEY), so a reload can still reveal. It is only ever
//   revealed after the gate checks its sha256 against the response_sha256 on-chain (account.js assertReviewOnChain).
// - checksOf: the pure grader (grader/grade.js grade) over the signed findings and the revealed key, as rows: "Check N"
//   until the reveal, then the key's title, its line range and the finding that hit it (m001 §2: titles are part of the
//   sealed key, so they are shown only after the reveal).
// - stageOf: which deadline the one countdown runs to (m001 §8): accept_by while open, review_by while accepted with no
//   review, reveal_deadline once a review is on-chain. get_job is read only while the job is live.
// All network access and storage are injected, so the unit tests never touch the network.
// Skills used: api-and-interface-design, security-and-hardening, karpathy-guidelines
import { BUG_COUNT, findingsFromResponse, grade, sha256Hex } from "../../grader/grade.js";

export const REVIEW_URL = "/api/review";
export const REVIEW_FN_MAX_MS = 300_000; // site-api/review.js MAX_DURATION_MS (Vercel maxDuration 300; drift test)
export const REVIEW_CLIENT_TIMEOUT_MS = REVIEW_FN_MAX_MS + 15_000; // past this the function is gone: replay
export const SLOW_MS = 40_000; // design spec screen 4 "Slow (>40 s)"
export const MAX_REVIEW_ANSWER_BYTES = 2 * 1024 * 1024; // the answer carries the TEE attestation (~300 KB)
export const MAX_RESPONSE_BYTES = 128 * 1024; // the escrow's own limit on a review response (account.js)
export const REVIEW_KEY = "earned-price.review.v1";
/** site-api/review.js REPLAY_REASONS (drift test), plus review_down for anything the function didn't answer. */
export const REPLAY_REASONS = Object.freeze([
  "tee_unavailable", "timeout", "cap_daily", "cap_visitor", "cap_buyer", "cap_spend", "cap_store_unavailable", "not_configured",
  "chain_unavailable", "chain_refused", "job_busy", "job_expired", "review_failed", "review_down",
]);
const JOB_STATES = new Set(["declined", "open", "accepted_no_review", "unknown"]);
const TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hashOrNull = (v) => (typeof v === "string" && TX_HASH_RE.test(v) ? v : null);
const down = () => ({ mode: "replay", reason: "review_down", jobState: "unknown" });

/** The function's answer -> { mode: "live", acceptTx, submitTx, submitLanded, responseBody } | { mode: "replay", reason, jobState }. */
export function normaliseAnswer(body, jobId) {
  if (!isObj(body)) return down();
  if (body.mode === "replay") {
    return {
      mode: "replay",
      reason: REPLAY_REASONS.includes(body.reason) ? body.reason : "review_failed",
      jobState: JOB_STATES.has(body.job_state) ? body.job_state : "unknown",
    };
  }
  if (body.mode !== "live" || body.job_id !== jobId || !isObj(body.review) || !isObj(body.submit)) return down();
  const responseBody = body.review.response_body;
  if (typeof responseBody !== "string" || responseBody === "" || new TextEncoder().encode(responseBody).length > MAX_RESPONSE_BYTES) return down();
  return {
    mode: "live",
    acceptTx: hashOrNull(body.accept_tx),
    submitTx: hashOrNull(body.submit.tx_hash),
    submitLanded: body.submit.status === "landed",
    responseBody,
  };
}

/** Reads a fetch Response as JSON with a byte limit; null on anything unreadable or too big. */
async function readJson(res) {
  try {
    const text = await res.text();
    if (text.length > MAX_REVIEW_ANSWER_BYTES) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * POST /api/review for this job. deps: { fetch, sign: () => Promise<auth fields>, jobId, timeoutMs?, signal? }.
 * Never throws (an abort by `signal` resolves to replay too; the caller ignores it). The function runs for up to 300 s.
 */
export async function requestReview({ fetch: fetchFn, sign, jobId, timeoutMs = REVIEW_CLIENT_TIMEOUT_MS, signal }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let auth;
    try {
      auth = await sign();
    } catch {
      return down();
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let res;
    let body;
    try {
      res = await fetchFn(REVIEW_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ job_id: auth.job_id, pack_id: auth.pack_id, public_key: auth.public_key, signature: auth.signature, expires_ms: auth.expires_ms }),
        signal: ctl.signal,
      });
      body = await readJson(res);
    } catch {
      return down();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (res.status === 401 && body?.code === "AUTH_EXPIRED" && attempt === 0) continue;
    if (!res.ok) return down();
    return normaliseAnswer(body, jobId);
  }
  return down();
}

/** Keeps the review body for this job in this browser (a reload can still reveal). Best effort. */
export function saveReviewBody(storage, jobId, responseBody) {
  try { storage.setItem(REVIEW_KEY, JSON.stringify({ job_id: jobId, response_body: responseBody })); } catch { /* quota: the reveal just needs this tab */ }
}

/** The cached review body for this job, or null. */
export function loadReviewBody(storage, jobId) {
  try {
    const v = JSON.parse(storage.getItem(REVIEW_KEY) ?? "null");
    return isObj(v) && v.job_id === jobId && typeof v.response_body === "string" ? v.response_body : null;
  } catch {
    return null;
  }
}

const lcHex = (v) => (typeof v === "string" ? v.toLowerCase().replace(/^0x/, "") : null);

/** The signed review on-chain is the body this page holds (sha256 = get_job.review.response_sha256). */
export function reviewMatches(view, responseBody) {
  const want = lcHex(view?.review?.response_sha256);
  return Boolean(want && typeof responseBody === "string" && sha256Hex(responseBody) === want);
}

/** The live stage and its deadline (m001 §8): open -> accept_by, accepted -> review_by, review on-chain -> reveal_deadline. */
export function stageOf(view) {
  if (!view) return null;
  if (view.status === "open") return { stage: "accept", deadlineNs: view.accept_by_ns };
  if (!view.review) return { stage: "review", deadlineNs: view.review_by_ns };
  return { stage: "reveal", deadlineNs: view.reveal_deadline_ns };
}

/** How many findings the seller signed (null when the body isn't a readable review). */
export function findingsCount(responseBody) {
  const f = findingsFromResponse(responseBody);
  return Array.isArray(f) ? f.length : null;
}

/**
 * The five checks for the receipt. Before the reveal (`K` null): "Check 1".."Check 5", no titles (m001 §2).
 * After: the grader's own grade of the signed findings against the revealed key, one row per bug in id order:
 * { index, bug_id, title, file, lines, category, hit, finding: { line } | null }. `findings` = the signed findings
 * (findingsFromResponse) or null. Returns { rows, grade } (grade null before the reveal).
 */
export function checksOf(K, findings) {
  if (!K) return { rows: Array.from({ length: BUG_COUNT }, (_, i) => ({ index: i + 1, title: `Check ${i + 1}`, sealed: true })), grade: null };
  const key = JSON.parse(K);
  const g = grade(key, findings);
  const bugs = [...key.bugs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rows = bugs.map((b, i) => {
    const m = g.matched.find((x) => x.bug === b.id);
    return {
      index: i + 1, bug_id: b.id, title: b.title, file: b.file, category: b.category, sealed: false,
      lines: b.line_start === b.line_end ? `${b.line_start}` : `${b.line_start}-${b.line_end}`,
      hit: Boolean(m), finding: m ? { line: m.line } : null,
    };
  });
  return { rows, grade: g };
}
