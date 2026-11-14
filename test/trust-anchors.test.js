// T-029 security review C-1: verify/trust-anchors.js is generated from the files the escrow is built
// and deployed from, and must never drift from them (or from contract/src/pins.rs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TRUST } from "../verify/trust-anchors.js";
import { TRUST_FILE, buildTrustAnchors, trustAnchorsSource } from "../scripts/trust-anchors-lib.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("verify/trust-anchors.js is exactly what scripts/trust-anchors.mjs generates (regenerate on purpose only)", () => {
  assert.equal(readFileSync(TRUST_FILE, "utf8"), trustAnchorsSource());
  assert.deepEqual(JSON.parse(JSON.stringify(TRUST)), buildTrustAnchors());
});

test("trust anchors match the contract: pins.rs model, prompt version and every pack pin; tee-signers.json", () => {
  const rs = read("contract/src/pins.rs");
  assert.equal(rs.match(/pub const REVIEW_MODEL: &str = "([^"]+)";/)[1], TRUST.review_model);
  assert.equal(Number(rs.match(/pub const PROMPT_VERSION: u32 = (\d+);/)[1]), TRUST.prompt_version);
  const rsPins = Object.fromEntries([...rs.matchAll(/\(\s*"(pack-\d+)",\s*"([0-9a-f]{64})",?\s*\)/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(rsPins, { ...TRUST.request_pins });
  const signers = JSON.parse(read("contract/tee-signers.json")).signers.map((s) => s.toLowerCase());
  assert.deepEqual([...TRUST.signers], signers);
  assert.deepEqual(Object.keys(TRUST.key_sha256), Object.keys(TRUST.request_pins), "every official pack has a request pin and a key pin");
});

test("trust anchors are frozen and isomorphic (no imports, no node:, no Buffer)", () => {
  assert.ok(Object.isFrozen(TRUST) && Object.isFrozen(TRUST.request_pins) && Object.isFrozen(TRUST.key_sha256) && Object.isFrozen(TRUST.signers));
  const src = read("verify/trust-anchors.js");
  assert.doesNotMatch(src, /^\s*import\b/m);
  assert.doesNotMatch(src, /\bBuffer\b|\bprocess\./);
});
