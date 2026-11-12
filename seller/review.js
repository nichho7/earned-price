// T-027 / S-005: the seller's TEE review of one accepted job, on NEAR AI Cloud.
//
// Flow (reviewJob): the job must already be accepted (A-010: accept first, then review), because
// the escrow refuses a review whose TEE `created` time is before accepted_at - 2 min (T-048 M-1).
//   1. keyless attestation with a fresh 32-byte nonce: both TDX quotes must bind the nonce and the
//      signer, and the model signer must be on the escrow's allowlist; checked before any paid call
//   2. POST /v1/chat/completions with the string buildReviewRequest(pack) returns, byte for byte
//      (comments already stripped there). Never parsed, re-serialised or handed to an SDK: the
//      escrow pins its sha256 per pack (T-048) and rejects any other body
//   3. parse findings with the grader's own rule (findingsFromResponse + normaliseFindings).
//      Malformed or > 10 findings is retried once inside the job window; if it stays bad, the
//      signed review is still returned (it is the fixed FAIL: buyer refunded, fail on record).
//      Never thrown, never truncated. A well-formed finding with an off-list category or a file
//      the pack does not have is kept and logged as a miss
//   4. the response's `created` must be inside [accepted_at - 2 min, now + 2 min], as on-chain
//   5. GET /v1/signature/{id}: the provider_tee signature over "<model>:<sha256 req>:<sha256 resp>"
//      is verified offline against the attested signer before anything is returned
// The result carries receipt.tee (m001-ui-contract section 5) and the exact submit_review args.
//
// The API key comes from the caller or NEAR_AI_API_KEY. It is sent only as the Authorization
// header of the chat and signature calls to NEAR_AI_BASE (a constant), and never appears in a log
// line, an error, a result or a receipt. Docs (read 2026-11-10, T-003 spike):
//   https://docs.near.ai/cloud/verification/cloud-api/response-signatures.md
//   https://docs.near.ai/cloud/verification/cloud-api/gateway-attestation.md
import { randomBytes } from "node:crypto";
import { CATEGORIES, findingsFromResponse, normaliseFindings, sha256Hex } from "../grader/grade.js";
import { bindingOk, checkAttestationBinding, verifyCompletionSignature } from "../verify/nearai-verify.js";
import { REVIEW_MODEL, buildReviewRequest } from "./review-prompt.js";

export const NEAR_AI_BASE = "https://cloud-api.near.ai/v1";
export const CLOCK_SKEW_S = 120; // contract CLOCK_SKEW_NS (2 min)
export const DEFAULT_MAX_ATTEMPTS = 2; // one retry for malformed output, ~$0.0007 each (reasoning off)
const CHAT_TIMEOUT_MS = 120_000; // reasoning off: 2-8 s measured; well under Vercel's 300 s
const SMALL_TIMEOUT_MS = 30_000;
const SIGNATURE_TRIES = 6; // the signature can take a few seconds to be stored (T-003: 404 first)
const UNAVAILABLE = new Set([401, 402, 403, 429]); // key expired / out of credit / rate limited

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

const nsToS = (ns) => Number(BigInt(ns) / 1_000_000_000n);

/**
 * Reviews `pack` for an accepted `job` (the escrow get_job view). Returns the teeReview result plus
 * submit_args, the exact arguments for the escrow's submit_review. Options: apiKey (else
 * NEAR_AI_API_KEY from `env`), signers (required: the escrow's signers() view), fetch, log, nonce,
 * sleep, now, maxAttempts.
 */
export async function reviewJob({ job, pack, ...opts }) {
  if (!job || job.status !== "accepted" || job.accepted_at_ns === null || job.accepted_at_ns === undefined) {
    throw new ReviewError("JOB_NOT_ACCEPTED", "The job must be accepted (accept(job_id)) before the TEE review starts.");
  }
  if (job.pack_id !== `pack-${pack.id}`) {
    throw new ReviewError("PACK_MISMATCH", `The job is for ${job.pack_id}, not pack-${pack.id}.`);
  }
  const r = await teeReview({ ...opts, requestBody: buildReviewRequest(pack.reviewFiles), model: REVIEW_MODEL, notBeforeS: nsToS(job.accepted_at_ns), reviewedFiles: pack.reviewFiles.map((f) => f.path) });
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
 * One signed TEE review of an exact request body (a string). Returns
 * { request_body, response_body, findings, check, misses, attempts, created, tee }.
 * check is { ok: true, list } or { ok: false, error: malformed_finding | too_many_findings }.
 */
export async function teeReview({
  requestBody,
  model = REVIEW_MODEL,
  apiKey,
  env = process.env,
  signers,
  notBeforeS,
  reviewedFiles = null,
  fetch = globalThis.fetch,
  log = (line) => console.error(line),
  nonce = () => randomBytes(32).toString("hex"),
  sleep = (ms) => new Promise((res) => setTimeout(res, ms)),
  now = () => Date.now(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  if (typeof requestBody !== "string") {
    throw new ReviewError("BAD_REQUEST_BODY", "The request body must be the exact string from buildReviewRequest.");
  }
  if (!Array.isArray(signers) || signers.length === 0) {
    throw new ReviewError("NO_SIGNERS", "Pass the escrow's TEE signer allowlist (signers() view).");
  }
  const key = apiKey ?? readApiKey(env);
  const allow = new Set(signers.map((s) => String(s).toLowerCase()));

  // 1. Attestation (keyless, free), bound to our nonce.
  const n = nonce();
  const q = new URLSearchParams({ signing_algo: "ecdsa", nonce: n, model, provider: "near" });
  const attRes = await call(fetch, `${NEAR_AI_BASE}/attestation/report?${q}`, { headers: { Accept: "application/json", "x-no-aliasing": "true" } }, SMALL_TIMEOUT_MS, "attestation");
  if (!attRes.ok) throw new ReviewError("TEE_UNAVAILABLE", `NEAR AI attestation returned HTTP ${attRes.status}.`, attRes.status);
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

  // 2-3. The review, retried once if the output is malformed or has too many findings.
  const auth = { Authorization: `Bearer ${key}` };
  let responseBody;
  let resp;
  let findings;
  let check;
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts++;
    const r = await call(
      fetch,
      `${NEAR_AI_BASE}/chat/completions`,
      { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Encoding": "identity", ...auth }, body: requestBody },
      CHAT_TIMEOUT_MS,
      "review",
    );
    if (!r.ok) {
      const code = UNAVAILABLE.has(r.status) ? "TEE_UNAVAILABLE" : "TEE_HTTP_ERROR";
      throw new ReviewError(code, `NEAR AI review returned HTTP ${r.status}.`, r.status);
    }
    responseBody = await r.text(); // exact bytes: hashed and submitted as received
    resp = parseObject(responseBody);
    findings = findingsFromResponse(responseBody);
    const { list, error } = normaliseFindings(findings);
    check = error ? { ok: false, error } : { ok: true, list };
    if (check.ok && resp) break;
    log(`[seller] review attempt ${attempts}/${maxAttempts}: ${resp ? check.error : "unreadable response body"}${attempts < maxAttempts ? ", retrying" : ""}`);
  }
  if (!resp || typeof resp.id !== "string" || resp.id === "") {
    throw new ReviewError("TEE_BAD_RESPONSE", "NEAR AI returned a body with no completion id; it cannot be signed or submitted.");
  }

  // 4. Freshness, as the escrow checks it.
  const created = resp.created;
  const nowS = Math.floor(now() / 1000);
  if (!Number.isSafeInteger(created) || (notBeforeS !== undefined && created < notBeforeS - CLOCK_SKEW_S) || created > nowS + CLOCK_SKEW_S) {
    throw new ReviewError("STALE_REVIEW", "The review's TEE created time is outside this job's window (accepted_at - 2 min .. now + 2 min); the escrow would refuse it.");
  }

  const misses = check.ok ? logMisses(check.list, reviewedFiles, log) : [];

  // 5. Signature over these exact bytes, verified against the attested signer.
  const sig = await fetchSignature(fetch, resp.id, model, auth, sleep);
  let v;
  try {
    v = verifyCompletionSignature({ requestBody, responseBody, model, sig, expectedSigner: signer });
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
    },
  };
}

// fetch with a timeout; a network error or timeout becomes TEE_UNAVAILABLE. The underlying error
// message is dropped on purpose: it may echo request details.
async function call(fetch, url, init, timeoutMs, what) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ReviewError("TEE_UNAVAILABLE", `NEAR AI ${what} request failed (network error or timeout).`);
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

async function fetchSignature(fetch, id, model, auth, sleep) {
  const q = new URLSearchParams({ model, signing_algo: "ecdsa" });
  const url = `${NEAR_AI_BASE}/signature/${encodeURIComponent(id)}?${q}`;
  for (let i = 0; i < SIGNATURE_TRIES; i++) {
    const r = await call(fetch, url, { headers: { Accept: "application/json", ...auth } }, SMALL_TIMEOUT_MS, "signature");
    if (r.status === 404) {
      if (i < SIGNATURE_TRIES - 1) await sleep(1000 * (i + 1));
      continue;
    }
    if (!r.ok) throw new ReviewError("SIGNATURE_UNAVAILABLE", `NEAR AI signature returned HTTP ${r.status}.`, r.status);
    const body = await readJson(r, "SIGNATURE_UNAVAILABLE", "signature");
    if (body?.error_code || typeof body?.text !== "string" || typeof body?.signature !== "string" || typeof body?.signing_address !== "string") {
      throw new ReviewError("SIGNATURE_UNAVAILABLE", "NEAR AI signature body has no text, signature and signing_address.");
    }
    return body;
  }
  throw new ReviewError("SIGNATURE_UNAVAILABLE", "NEAR AI signature not found after retries.");
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
