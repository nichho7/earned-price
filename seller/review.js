// T-027 / S-005: the seller's TEE review of one accepted job, on NEAR AI Cloud.
//
// Flow (reviewJob): the job must already be accepted (A-010: accept first, then review), because
// the escrow refuses a review whose TEE `created` time is before accepted_at - 2 min (T-048 M-1).
//   1. keyless attestation with a fresh 32-byte nonce: both TDX quotes must bind the nonce and the
//      signer, and the model signer must be on the escrow's allowlist; checked before any paid call.
//      Binding only: the Intel DCAP signature, NVIDIA NRAS evidence and image measurements are NOT
//      verified (receipt.tee.attestation_checks says so; security review T-027 M-1)
//   2. POST /v1/chat/completions with the string buildReviewRequest(pack) returns, byte for byte
//      (comments already stripped there). Never parsed, re-serialised or handed to an SDK: the
//      escrow pins its sha256 per pack (T-048) and rejects any other body
//   3. parse findings with the grader's own rule (findingsFromResponse + normaliseFindings).
//      Malformed or > 10 findings is retried once inside the job window; if it stays bad, the
//      signed review is still returned (it is the fixed FAIL: buyer refunded, fail on record).
//      If the retry itself fails (HTTP error, timeout, unreadable body) or there is no time left
//      for it, the first signed attempt is returned the same way. Never thrown, never truncated.
//      A well-formed finding with an off-list category or a file the pack does not have is kept
//      and logged as a miss
//   4. the response's `created` must be inside [accepted_at - 2 min, now + 2 min], as on-chain
//   5. GET /v1/signature/{id}: the provider_tee signature over "<model>:<sha256 req>:<sha256 resp>"
//      is verified offline against the attested signer before anything is returned
// The result carries receipt.tee (m001-ui-contract section 5) and the exact submit_review args.
// The whole review ends by a deadline (DEFAULT_BUDGET_MS = 240 s, and review_by - 45 s).
//
// Error codes (ReviewError.code). T-028 falls back only on TEE_UNAVAILABLE and SIGNATURE_UNAVAILABLE.
//   before any call  JOB_NOT_ACCEPTED, ALREADY_REVIEWED, PACK_MISMATCH, REVIEW_WINDOW_CLOSED,
//                    BAD_REQUEST_BODY, BAD_OPTIONS, NO_SIGNERS, NO_API_KEY, DEADLINE_EXCEEDED
//   attestation/chat TEE_UNAVAILABLE = 401/402/403/408/429/any 5xx/network/timeout/redirect
//                    TEE_HTTP_ERROR = any other non-2xx status
//   attestation      ATTESTATION_INVALID (not JSON / no nonce+signer binding), SIGNER_NOT_ALLOWLISTED
//   chat             TEE_BAD_RESPONSE (no attempt gave a submittable body), STALE_REVIEW
//   signature        SIGNATURE_UNAVAILABLE (any status, network, timeout, never stored, bad body),
//                    SIGNATURE_INVALID (does not verify as the attested signer)
// A chat failure after an earlier submittable attempt is not an error: that attempt is returned.
//
// The API key comes from the caller or NEAR_AI_API_KEY. It is sent only as the Authorization
// header of the chat and signature calls to NEAR_AI_BASE (a constant), and never appears in a log
// line, an error, a result or a receipt. Docs (read 2026-11-10, T-003 spike):
//   https://docs.near.ai/cloud/verification/cloud-api/response-signatures.md
//   https://docs.near.ai/cloud/verification/cloud-api/gateway-attestation.md
import { randomBytes } from "node:crypto";
import { CATEGORIES, findingsFromResponse, normaliseFindings, sha256Hex } from "../grader/grade.js";
import { ATTESTATION_CHECKS, bindingOk, checkAttestationBinding, verifyCompletionSignature } from "../verify/nearai-verify.js";
import { REVIEW_MODEL, buildReviewRequest } from "./review-prompt.js";

export const NEAR_AI_BASE = "https://cloud-api.near.ai/v1";
export const CLOCK_SKEW_S = 120; // contract CLOCK_SKEW_NS (2 min)
const CLOCK_SKEW_NS = 120_000_000_000n;
export const DEFAULT_MAX_ATTEMPTS = 2; // one retry for malformed output, ~$0.0007 each (reasoning off)
export const MAX_RESPONSE_BYTES = 128 * 1024; // contract MAX_RESPONSE_LEN: a bigger body can't be submitted
// Time budget (S-1). Every call's timeout is capped by what is left of the deadline, so the whole
// review ends by it: default 240 s from the start, and reviewJob also ends it SUBMIT_MARGIN_MS
// before review_by. 240 s leaves 60 s of Vercel's 300 s maxDuration for the accept/submit txs.
// Typical run: 10-20 s (reasoning off, T-003/T-021 measurements).
export const DEFAULT_BUDGET_MS = 240_000;
export const SUBMIT_MARGIN_MS = 45_000; // kept before review_by for the submit_review tx
const CHAT_TIMEOUT_MS = 120_000; // reasoning off: 2-8 s measured
const SMALL_TIMEOUT_MS = 30_000;
const SIGNATURE_RESERVE_MS = 20_000; // kept after each chat call for the signature fetch
const MIN_CHAT_MS = 15_000; // less than this for the first paid call: don't start it
const RETRY_MIN_MS = 30_000; // less than this for a retry: submit the first attempt (fixed FAIL)
const SIGNATURE_TRIES = 6; // the signature can take a few seconds to be stored (T-003: 404 first)
const UNAVAILABLE_4XX = new Set([401, 402, 403, 408, 429]); // key expired / out of credit / rate limited / timeout

/** HTTP status of the attestation or chat call -> code (see the table at the top). */
const httpCode = (status) => (status >= 500 || UNAVAILABLE_4XX.has(status) ? "TEE_UNAVAILABLE" : "TEE_HTTP_ERROR");

/** Every failure the caller must handle. `code` is stable; `status` is the HTTP status if any. */
export class ReviewError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "ReviewError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** The NEAR AI key from an environment object. Load .env first (process.loadEnvFile()) if you use one. */
export function readApiKey(env = process.env) {
  const key = env.NEAR_AI_API_KEY;
  if (typeof key !== "string" || key.trim() === "") {
    throw new ReviewError("NO_API_KEY", "NEAR_AI_API_KEY is not set (environment or .env).");
  }
  return key.trim();
}

/**
 * Reviews `pack` for an accepted `job` (the escrow get_job view). Returns the teeReview result plus
 * submit_args, the exact arguments for the escrow's submit_review. Options: apiKey (else
 * NEAR_AI_API_KEY from `env`), signers (required: the escrow's signers() view), budgetMs (default
 * DEFAULT_BUDGET_MS; T-028 passes what is left of its function time minus the submit tx), fetch,
 * log, nonce, sleep, now, timeoutSignal, maxAttempts.
 */
export async function reviewJob({ job, pack, budgetMs = DEFAULT_BUDGET_MS, ...opts }) {
  if (!job || job.status !== "accepted" || job.accepted_at_ns == null || job.review_by_ns == null) {
    throw new ReviewError("JOB_NOT_ACCEPTED", "The job must be accepted (accept(job_id)) before the TEE review starts; pass the get_job view.");
  }
  if (job.review != null) {
    throw new ReviewError("ALREADY_REVIEWED", "The job already has a review on-chain; the escrow would refuse another.");
  }
  if (!Array.isArray(pack?.reviewFiles) || job.pack_id !== `pack-${pack.id}`) {
    throw new ReviewError("PACK_MISMATCH", `The job is for ${job.pack_id}, not ${pack?.id === undefined ? "no pack" : `pack-${pack.id}`}.`);
  }
  const start = (opts.now ?? Date.now)();
  const windowEndMs = Number(BigInt(job.review_by_ns) / 1_000_000n) - SUBMIT_MARGIN_MS;
  if (windowEndMs <= start) {
    throw new ReviewError("REVIEW_WINDOW_CLOSED", "Too late: review_by (minus time for the submit tx) has passed; a paid review could not land.");
  }
  const r = await teeReview({
    ...opts,
    requestBody: buildReviewRequest(pack.reviewFiles),
    model: REVIEW_MODEL,
    notBeforeNs: job.accepted_at_ns,
    deadlineMs: Math.min(start + budgetMs, windowEndMs),
    reviewedFiles: pack.reviewFiles.map((f) => f.path),
  });
  return {
    ...r,
    submit_args: {
      job_id: String(job.id),
      model: r.tee.model,
      request_sha256: r.tee.request_sha256,
      response_sha256: r.tee.response_sha256,
      signature: r.tee.signature,
      signing_address: r.tee.signing_address,
      response: r.response_body,
    },
  };
}

/**
 * One signed TEE review of an exact request body (a string). Use it through reviewJob; called
 * directly, notBeforeNs (the job's accepted_at_ns) is required. deadlineMs is an absolute epoch-ms
 * deadline (default now + DEFAULT_BUDGET_MS). Returns
 * { request_body, response_body, findings, check, misses, attempts, created, tee }.
 * check is { ok: true, list } or { ok: false, error: malformed_finding | too_many_findings }.
 */
export async function teeReview({
  requestBody,
  model = REVIEW_MODEL,
  apiKey,
  env = process.env,
  signers,
  notBeforeNs,
  reviewedFiles = null,
  fetch = globalThis.fetch,
  log = (line) => console.error(line),
  nonce = () => randomBytes(32).toString("hex"),
  sleep = (ms) => new Promise((res) => setTimeout(res, ms)),
  now = () => Date.now(),
  timeoutSignal = (ms) => AbortSignal.timeout(ms),
  deadlineMs,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  if (typeof requestBody !== "string") {
    throw new ReviewError("BAD_REQUEST_BODY", "The request body must be the exact string from buildReviewRequest.");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new ReviewError("BAD_OPTIONS", "maxAttempts must be an integer >= 1.");
  }
  let notBefore;
  try {
    notBefore = BigInt(notBeforeNs);
  } catch {
    throw new ReviewError("BAD_OPTIONS", "notBeforeNs (the job's accepted_at_ns) is required.");
  }
  if (!Array.isArray(signers) || signers.length === 0) {
    throw new ReviewError("NO_SIGNERS", "Pass the escrow's TEE signer allowlist (signers() view).");
  }
  const key = apiKey ?? readApiKey(env);
  const allow = new Set(signers.map((s) => String(s).toLowerCase()));
  const deadline = deadlineMs ?? now() + DEFAULT_BUDGET_MS;
  const left = () => deadline - now();
  const io = { fetch, timeoutSignal };
  const noTime = () => new ReviewError("DEADLINE_EXCEEDED", "Not enough of the review time budget left to start the paid TEE call.");

  // 1. Attestation (keyless, free), bound to our nonce.
  if (left() < SIGNATURE_RESERVE_MS + MIN_CHAT_MS) throw noTime();
  const n = nonce();
  const q = new URLSearchParams({ signing_algo: "ecdsa", nonce: n, model, provider: "near" });
  const attRes = await call(io, `${NEAR_AI_BASE}/attestation/report?${q}`, { headers: { Accept: "application/json", "x-no-aliasing": "true" } }, Math.min(SMALL_TIMEOUT_MS, left()), "attestation", "TEE_UNAVAILABLE");
  if (!attRes.ok) throw new ReviewError(httpCode(attRes.status), `NEAR AI attestation returned HTTP ${attRes.status}.`, attRes.status);
  const attestation = await readJson(attRes, "ATTESTATION_INVALID", "attestation");
  const modelAtt = attestation?.model_attestations?.find?.((a) => a?.model_name === model);
  let bound = false;
  try {
    bound = !!modelAtt && bindingOk(checkAttestationBinding(attestation.gateway_attestation, n)) && bindingOk(checkAttestationBinding(modelAtt, n));
  } catch {
    bound = false;
  }
  if (!bound) throw new ReviewError("ATTESTATION_INVALID", `The attestation does not bind this nonce and a ${model} signer.`);
  const signer = String(modelAtt.signing_address).toLowerCase();
  if (!allow.has(signer)) {
    throw new ReviewError("SIGNER_NOT_ALLOWLISTED", `The attested TEE signer ${signer} is not on the escrow allowlist; the escrow would refuse its review.`);
  }

  // 2-3. The review, retried once if the output is malformed, has too many findings or can't be
  // submitted. `best` is the last attempt the escrow would accept (JSON with a completion id, under
  // the size cap): if a retry fails or there is no time for one, `best` is submitted as is (the
  // fixed FAIL when malformed), so a paid, signed review is never dropped for an outage.
  const auth = { Authorization: `Bearer ${key}` };
  let best = null;
  let attempts = 0;
  while (attempts < maxAttempts) {
    const chatMs = Math.min(CHAT_TIMEOUT_MS, left() - SIGNATURE_RESERVE_MS);
    if (attempts > 0 && chatMs < RETRY_MIN_MS) {
      log(`[seller] no time left for review attempt ${attempts + 1}/${maxAttempts}`);
      break;
    }
    if (attempts === 0 && chatMs < MIN_CHAT_MS) throw noTime();
    attempts++;
    let a;
    try {
      a = await chatOnce(io, requestBody, auth, chatMs);
    } catch (e) {
      if (!best || !(e instanceof ReviewError)) throw e;
      log(`[seller] review attempt ${attempts}/${maxAttempts} failed (${e.code}); submitting the earlier signed attempt`);
      break;
    }
    if (a.problem === null) best = a;
    if (a.problem === null && a.check.ok) break;
    log(`[seller] review attempt ${attempts}/${maxAttempts}: ${a.problem ?? a.check.error}${attempts < maxAttempts ? ", retrying" : ""}`);
  }
  if (!best) {
    throw new ReviewError("TEE_BAD_RESPONSE", "NEAR AI returned no body that can be signed and submitted (not JSON, no completion id, or over 128 KiB).");
  }
  const { responseBody, resp, findings, check } = best;

  // 4. Freshness, as the escrow checks it (in ns, like check_fresh).
  const created = resp.created;
  const nowS = Math.floor(now() / 1000);
  if (!Number.isSafeInteger(created) || created < 0 || BigInt(created) * 1_000_000_000n + CLOCK_SKEW_NS < notBefore || created > nowS + CLOCK_SKEW_S) {
    throw new ReviewError("STALE_REVIEW", "The review's TEE created time is outside this job's window (accepted_at - 2 min .. now + 2 min); the escrow would refuse it.");
  }

  const misses = check.ok ? logMisses(check.list, reviewedFiles, log) : [];

  // 5. Signature over these exact bytes, verified against the attested signer.
  const sig = await fetchSignature(io, resp.id, model, auth, sleep, left);
  let v;
  try {
    const { text, signature, signing_address } = sig;
    v = verifyCompletionSignature({ requestBody, responseBody, model, sig: { text, signature, signing_address, signing_algo: "ecdsa" }, expectedSigner: signer });
  } catch {
    v = { ok: false };
  }
  if (!v.ok || v.text_kind !== "provider_tee") {
    throw new ReviewError("SIGNATURE_INVALID", "The TEE signature does not verify as the attested model signer over this request and response.");
  }
  log(`[seller] signed review: ${check.ok ? `${check.list.length} findings` : check.error}, attempts ${attempts}, response ${v.response_sha256.slice(0, 12)}`);

  return {
    request_body: requestBody,
    response_body: responseBody,
    findings,
    check,
    misses,
    attempts,
    created,
    tee: {
      model,
      request_sha256: sha256Hex(requestBody),
      response_sha256: v.response_sha256,
      signed_text: sig.text,
      signature: sig.signature,
      signing_address: sig.signing_address,
      nonce: n,
      attestation,
      attestation_checks: { ...ATTESTATION_CHECKS },
    },
  };
}

// One chat call. Throws a ReviewError on HTTP error, network error, timeout or an unreadable
// stream. Otherwise returns the exact body and why it can't be submitted (problem), if so.
async function chatOnce(io, requestBody, auth, timeoutMs) {
  const headers = { "Content-Type": "application/json", Accept: "application/json", "Accept-Encoding": "identity", ...auth };
  const r = await call(io, `${NEAR_AI_BASE}/chat/completions`, { method: "POST", headers, body: requestBody }, timeoutMs, "review", "TEE_UNAVAILABLE");
  if (!r.ok) throw new ReviewError(httpCode(r.status), `NEAR AI review returned HTTP ${r.status}.`, r.status);
  let responseBody;
  try {
    responseBody = await r.text(); // exact bytes: hashed and submitted as received
  } catch {
    throw new ReviewError("TEE_UNAVAILABLE", "NEAR AI review body could not be read (network error or timeout).");
  }
  const resp = parseObject(responseBody);
  const findings = findingsFromResponse(responseBody);
  const { list, error } = normaliseFindings(findings);
  let problem = null;
  if (!resp) problem = "unreadable response body";
  else if (typeof resp.id !== "string" || resp.id === "") problem = "response has no completion id";
  else if (Buffer.byteLength(responseBody, "utf8") > MAX_RESPONSE_BYTES) problem = "response over the escrow's 128 KiB cap";
  return { responseBody, resp, findings, check: error ? { ok: false, error } : { ok: true, list }, problem };
}

// fetch with a timeout and no redirects; a network error, redirect or timeout becomes `failCode`.
// The underlying error message is dropped on purpose: it may echo request details.
async function call({ fetch, timeoutSignal }, url, init, timeoutMs, what, failCode) {
  try {
    return await fetch(url, { ...init, redirect: "error", signal: timeoutSignal(Math.max(1, Math.floor(timeoutMs))) });
  } catch {
    throw new ReviewError(failCode, `NEAR AI ${what} request failed (network error or timeout).`);
  }
}

async function readJson(res, code, what) {
  try {
    return await res.json();
  } catch {
    throw new ReviewError(code, `NEAR AI ${what} body is not JSON.`);
  }
}

function parseObject(body) {
  try {
    const v = JSON.parse(body);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Every failure here comes after the paid call, so it has its own code (the review exists but
// can't be proven yet): SIGNATURE_UNAVAILABLE, whatever the cause.
async function fetchSignature(io, id, model, auth, sleep, left) {
  const q = new URLSearchParams({ model, signing_algo: "ecdsa" });
  const url = `${NEAR_AI_BASE}/signature/${encodeURIComponent(id)}?${q}`;
  for (let i = 0; i < SIGNATURE_TRIES && left() > 0; i++) {
    const r = await call(io, url, { headers: { Accept: "application/json", ...auth } }, Math.min(SMALL_TIMEOUT_MS, left()), "signature", "SIGNATURE_UNAVAILABLE");
    if (r.status === 404) {
      if (i < SIGNATURE_TRIES - 1) await sleep(Math.max(0, Math.min(1000 * (i + 1), left())));
      continue;
    }
    if (!r.ok) throw new ReviewError("SIGNATURE_UNAVAILABLE", `NEAR AI signature returned HTTP ${r.status}.`, r.status);
    const body = await readJson(r, "SIGNATURE_UNAVAILABLE", "signature");
    if (body?.error_code || typeof body?.text !== "string" || typeof body?.signature !== "string" || typeof body?.signing_address !== "string") {
      throw new ReviewError("SIGNATURE_UNAVAILABLE", "NEAR AI signature body has no text, signature and signing_address.");
    }
    return body;
  }
  throw new ReviewError("SIGNATURE_UNAVAILABLE", "NEAR AI signature not found after retries or before the deadline.");
}

// Well-formed findings that can never hit a key bug: kept as is (the grader counts them as misses).
function logMisses(list, reviewedFiles, log) {
  const files = reviewedFiles ? new Set(reviewedFiles) : null;
  const misses = [];
  for (const f of list) {
    let reason = null;
    if (!CATEGORIES.includes(f.category)) reason = "category not in the fixed list";
    else if (files && !files.has(f.file)) reason = "file is not a reviewed file (repo-relative, no ./)";
    if (!reason) continue;
    misses.push({ ...f, reason });
    log(`[seller] finding ${JSON.stringify(f.file)}:${f.line} ${JSON.stringify(f.category)} counts as a miss: ${reason}`);
  }
  return misses;
}
