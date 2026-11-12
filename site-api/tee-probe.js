// T-084: a cheap NEAR AI health probe, run before the live review function accepts a job.
//
// Why: A-010 accepts before the TEE review, and once a job is accepted only a signed review or the
// escrow's timeout can close it; timeout on an accepted, unreviewed job refunds the buyer AND
// records a fail for the seller (A-008). So our own NEAR AI outage, or our key running out of
// credit, must be caught while the job is still open, where the seller can decline it (buyer
// refunded at once, record unchanged).
//
// The call: POST https://cloud-api.near.ai/v1/check_api_key with the key as a Bearer header and no
// body. Docs (read 2026-11-12):
//   https://docs.near.ai/api-reference/gateway/check-api-key-validity.md
//   200 = "API key is valid and has sufficient credits" ({ valid, organization_id, workspace_id,
//   api_key_id }); 401 = invalid or missing key; 402 = insufficient credits or spend limit exceeded;
//   500 = internal error. No tokens, no review: it costs nothing. Measured without a key on
//   2026-11-12: 401 in 0.6-2.3 s; GET answers 405.
// It proves the gateway is up and the key can pay. It does NOT prove the review model's backend is
// up; a model outage still shows up only in the review, after accept (README threat model).
// The docs mark the endpoint deprecated ("moving to cloud-platform at the same path"), so an answer
// that says nothing about our key or NEAR AI's health (a 3xx redirect, 404/405/410, other 4xx, a 200
// in a shape we don't know) is "inconclusive": the caller proceeds as before this probe existed,
// rather than switching off every live review. Redirects are never followed (redirect: "manual"),
// so the key is only ever sent to NEAR_AI_BASE.
//
// Verdicts:
//   ok            200 with valid === true
//   unavailable   401/402/403/408/429, any 5xx (seller/review.js nearAiUnavailable), a 200 with
//                 valid === false, a network error, a timeout, a response with no HTTP status, or no
//                 key at all (no request then)
//   inconclusive  any other status, including 3xx; a 200 without a boolean `valid` or with an
//                 unreadable body
//
// Secrets: the key goes only into the Authorization header of a request to NEAR_AI_BASE (a constant).
// The result is { verdict, status } and nothing else: no key, no response body, no account ids,
// no error text.
import { NEAR_AI_BASE, nearAiUnavailable } from "../seller/review.js";

export const PROBE_TIMEOUT_MS = 8_000;

/** -> { verdict: "ok" | "unavailable" | "inconclusive", status: number | null }. Never throws. */
export async function probeNearAi({ apiKey, fetch = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS, timeoutSignal = (ms) => AbortSignal.timeout(ms) }) {
  if (typeof apiKey !== "string" || !apiKey.trim()) return { verdict: "unavailable", status: null };
  const ms = Math.max(1, Math.floor(Math.min(PROBE_TIMEOUT_MS, Number(timeoutMs) || PROBE_TIMEOUT_MS)));
  let res;
  try {
    res = await fetch(`${NEAR_AI_BASE}/check_api_key`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      redirect: "manual", // a 3xx comes back as itself, unfollowed: inconclusive below
      signal: timeoutSignal(ms),
    });
  } catch {
    return { verdict: "unavailable", status: null }; // network error or timeout
  }
  const status = Number(res?.status);
  if (!Number.isInteger(status)) return { verdict: "unavailable", status: null }; // malformed: fail closed
  if (status === 200) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      // unreadable body: says nothing either way
    }
    if (body?.valid === true) return { verdict: "ok", status };
    if (body?.valid === false) return { verdict: "unavailable", status };
    return { verdict: "inconclusive", status }; // the 200 changed shape: proceed as before T-084
  }
  try {
    await res.body?.cancel?.(); // free the connection; the error body is never read
  } catch {
    // nothing to free
  }
  return { verdict: nearAiUnavailable(status) ? "unavailable" : "inconclusive", status };
}
