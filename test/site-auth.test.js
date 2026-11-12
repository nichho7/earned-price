// T-028 security M-1: buyer-signed review requests (site-api/buyer-auth.js). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyPair } from "near-api-js";
import { AUTH_MAX_AHEAD_MS, authShapeOk, checkReviewAuth, reviewAuthMessage, signReviewAuth } from "../site-api/buyer-auth.js";

const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
const kp = KeyPair.fromRandom("ed25519"); // test-only throwaway key
const body = (over = {}) => ({ job_id: "7", pack_id: "pack-1", ...signReviewAuth(kp, { job_id: "7", pack_id: "pack-1", nowMs: T0 }), ...over });

test("the signed message is domain-tagged and covers job_id, pack_id and expiry", () => {
  assert.equal(new TextDecoder().decode(reviewAuthMessage({ job_id: "7", pack_id: "pack-1", expires_ms: "123" })), "earned-review-v1:7:pack-1:123");
});

test("signReviewAuth -> checkReviewAuth round trip; shape is strict", () => {
  const b = body();
  assert.equal(b.public_key, kp.getPublicKey().toString());
  assert.equal(b.expires_ms, String(T0 + 5 * 60_000));
  assert.ok(authShapeOk(b));
  assert.equal(checkReviewAuth(b, T0), null);
  assert.equal(authShapeOk({ ...b, signature: "abc" }), false);
  assert.equal(authShapeOk({ ...b, public_key: "secp256k1:abc" }), false);
  assert.equal(authShapeOk({ ...b, expires_ms: Number(b.expires_ms) }), false, "expiry is a string");
});

test("a signature over another job, pack or expiry, or by another key, is BAD_SIGNATURE", () => {
  const b = body();
  assert.equal(checkReviewAuth({ ...b, job_id: "8" }, T0), "BAD_SIGNATURE");
  assert.equal(checkReviewAuth({ ...b, pack_id: "pack-2" }, T0), "BAD_SIGNATURE");
  assert.equal(checkReviewAuth({ ...b, expires_ms: String(Number(b.expires_ms) - 1) }, T0), "BAD_SIGNATURE");
  assert.equal(checkReviewAuth({ ...b, public_key: KeyPair.fromRandom("ed25519").getPublicKey().toString() }, T0), "BAD_SIGNATURE");
});

test("expired or too far ahead is AUTH_EXPIRED (a captured request is short-lived)", () => {
  const b = body();
  assert.equal(checkReviewAuth(b, Number(b.expires_ms)), "AUTH_EXPIRED");
  assert.equal(checkReviewAuth(b, T0 - AUTH_MAX_AHEAD_MS), "AUTH_EXPIRED");
  const far = { job_id: "7", pack_id: "pack-1", ...signReviewAuth(kp, { job_id: "7", pack_id: "pack-1", nowMs: T0, ttlMs: 60 * 60_000 }) };
  assert.equal(Number(far.expires_ms), T0 + AUTH_MAX_AHEAD_MS, "signer clamps the TTL");
});
