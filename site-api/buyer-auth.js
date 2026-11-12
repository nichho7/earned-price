// T-028 (security M-1): binds a /api/review request to the job's buyer.
//
// The browser holds the throwaway buyer key that signed `create`. It signs
//   earned-review-v1:<job_id>:<pack_id>:<expires_ms>
// (raw ed25519 over the UTF-8 bytes, near-api-js KeyPair.sign) and sends
//   { job_id, pack_id, public_key: "ed25519:<base58>", signature: "<base64, 64 bytes>", expires_ms: "<epoch ms>" }
// The function checks the signature here (no network), then checks on-chain that `public_key` is an
// access key of job.buyer (view_access_key, site-api/chain.js). Only then may it accept, decline or
// pay for a review. expires_ms limits how long a captured request stays usable (at most
// AUTH_MAX_AHEAD_MS ahead); the job lock + the escrow's one-review rule make each job single-use.
//
// Browser-safe (no node: imports) so T-033 can import signReviewAuth from the same file.
import { PublicKey } from "near-api-js";

export const AUTH_PREFIX = "earned-review-v1";
export const AUTH_MAX_AHEAD_MS = 10 * 60_000;
const PUBLIC_KEY_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/; // 64 bytes, base64 with padding
const EXPIRES_RE = /^[1-9]\d{12,14}$/; // epoch ms as a decimal string

/** The exact bytes the buyer signs. */
export function reviewAuthMessage({ job_id, pack_id, expires_ms }) {
  return new TextEncoder().encode(`${AUTH_PREFIX}:${job_id}:${pack_id}:${expires_ms}`);
}

/** Shape check only (the handler's strict-input step). */
export function authShapeOk({ public_key, signature, expires_ms }) {
  return typeof public_key === "string" && PUBLIC_KEY_RE.test(public_key) && typeof signature === "string" && SIGNATURE_RE.test(signature) && typeof expires_ms === "string" && EXPIRES_RE.test(expires_ms);
}

/**
 * Checks expiry and the ed25519 signature. Returns null when fine, else an error code:
 * AUTH_EXPIRED (past, or too far ahead) | BAD_SIGNATURE.
 */
export function checkReviewAuth(input, nowMs) {
  const exp = Number(input.expires_ms);
  if (!(exp > nowMs) || exp > nowMs + AUTH_MAX_AHEAD_MS) return "AUTH_EXPIRED";
  try {
    const sig = Uint8Array.from(atob(input.signature), (c) => c.charCodeAt(0));
    return PublicKey.fromString(input.public_key).verify(reviewAuthMessage(input), sig) ? null : "BAD_SIGNATURE";
  } catch {
    return "BAD_SIGNATURE";
  }
}

/** Browser side (T-033): the auth fields to add to the POST body. keyPair = near-api-js KeyPair. */
export function signReviewAuth(keyPair, { job_id, pack_id, nowMs = Date.now(), ttlMs = 5 * 60_000 }) {
  const expires_ms = String(nowMs + Math.min(ttlMs, AUTH_MAX_AHEAD_MS));
  const { signature } = keyPair.sign(reviewAuthMessage({ job_id, pack_id, expires_ms }));
  return { public_key: keyPair.getPublicKey().toString(), signature: btoa(String.fromCharCode(...signature)), expires_ms };
}
