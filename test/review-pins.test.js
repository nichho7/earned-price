// T-048 (A-016 = B): the escrow contract pins each official pack's exact review request. These
// tests recompute the shared vector (test-vectors/review-pins.json) from the packs and the prompt
// builder; contract/src/pins.rs is checked against the same file by `cargo test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../grader/grade.js";
import { loadPack, readIndex } from "../packs/packs.js";
import { PROMPT_VERSION, REVIEW_MODEL, buildReviewRequest, requestSha256 } from "../seller/review-prompt.js";
import { PINS_FILE, buildReviewPins } from "../scripts/review-pins.mjs";

const repo = new URL("..", import.meta.url).pathname;
const vector = JSON.parse(readFileSync(PINS_FILE, "utf8"));

test("review-pins.json is exactly what the packs and prompt builder produce (regenerate on purpose only)", () => {
  assert.deepEqual(vector, buildReviewPins());
});

test("one pin per official pack, same prompt version and model as seller/review-prompt.js", () => {
  assert.equal(vector.prompt_version, PROMPT_VERSION);
  assert.equal(vector.model, REVIEW_MODEL);
  assert.deepEqual(vector.packs.map((p) => p.pack_id), readIndex().map((p) => `pack-${p.id}`));
  for (const p of vector.packs) {
    assert.match(p.request_sha256, /^[0-9a-f]{64}$/);
    const pack = loadPack(p.pack_id.slice("pack-".length));
    assert.equal(requestSha256(pack), p.request_sha256);
    assert.equal(sha256Hex(buildReviewRequest(pack.reviewFiles)), p.request_sha256, "pin = sha256 of the exact body sent");
  }
  assert.equal(new Set(vector.packs.map((p) => p.request_sha256)).size, vector.packs.length, "pins are distinct");
});

test("the pinned requests are the ones calibration measured (recorded request bodies in packs/results)", () => {
  const dir = join(repo, "packs/results");
  const seen = new Map();
  for (const round of readdirSync(dir)) {
    for (const f of readdirSync(join(dir, round, "raw"))) {
      const { request_body } = JSON.parse(readFileSync(join(dir, round, "raw", f), "utf8"));
      const pack = f.split("-run")[0];
      if (!seen.has(pack)) seen.set(pack, new Set());
      seen.get(pack).add(sha256Hex(request_body));
    }
  }
  for (const p of vector.packs) {
    assert.ok(seen.get(p.pack_id)?.has(p.request_sha256), `${p.pack_id}: no calibration run used the pinned request`);
  }
});

test("which calibration rounds used the pinned requests (README 'Public answer keys' states this)", () => {
  const dir = join(repo, "packs/results");
  const pinOf = new Map(vector.packs.map((p) => [p.pack_id, p.request_sha256]));
  const rounds = {};
  for (const round of readdirSync(dir).sort()) {
    for (const f of readdirSync(join(dir, round, "raw"))) {
      const { request_body } = JSON.parse(readFileSync(join(dir, round, "raw", f), "utf8"));
      const pack = f.split("-run")[0];
      const key = `${pack} ${round}`;
      rounds[key] ??= new Set();
      rounds[key].add(sha256Hex(request_body) === pinOf.get(pack) ? "pinned" : "older");
    }
  }
  const summary = Object.fromEntries(Object.entries(rounds).map(([k, v]) => [k, [...v].join("+")]));
  assert.deepEqual(summary, {
    "pack-1 round-1": "pinned",
    "pack-2 round-1": "pinned",
    "pack-3 round-1": "older",
    "pack-3 round-2": "older",
    "pack-1 round-3": "pinned",
    "pack-3 round-4": "pinned",
  });
});

test("every TEE response carries a top-level integer created (Unix s) inside the signed body (T-048 M-1)", () => {
  // The signed T-003 body hashes to the signed response_sha256, so its created is TEE-signed.
  const sig = JSON.parse(readFileSync(join(repo, "test-vectors/tee-signature.json"), "utf8"));
  assert.equal(sha256Hex(sig.response_body), sig.response_sha256);
  const bodies = [sig.response_body];
  const dir = join(repo, "packs/results");
  for (const round of readdirSync(dir)) {
    for (const f of readdirSync(join(dir, round, "raw"))) {
      bodies.push(JSON.parse(readFileSync(join(dir, round, "raw", f), "utf8")).response_body);
    }
  }
  assert.equal(bodies.length, 61);
  for (const b of bodies) {
    const { created } = JSON.parse(b);
    assert.ok(Number.isSafeInteger(created), `created is an integer: ${created}`);
    // Seconds, not ms: between 2026-01-01 and 2030-01-01.
    assert.ok(created > 1_767_225_600 && created < 1_893_456_000, `created in seconds: ${created}`);
  }
});

test("NEAR AI's request_sha256 is sha256 of the exact request body (real T-003 signature)", () => {
  const run = JSON.parse(readFileSync(join(repo, "spike/evidence/runs/recorded-review-sample-0-run08.json"), "utf8"));
  const sig = JSON.parse(readFileSync(join(repo, "test-vectors/tee-signature.json"), "utf8"));
  assert.equal(sha256Hex(run.request_body), sig.request_sha256);
});

test("rejected near-miss requests are real variants of pack-1's request and match no pin", () => {
  const pins = new Set(vector.packs.map((p) => p.request_sha256));
  assert.equal(vector.rejected.length, 3);
  for (const r of vector.rejected) {
    assert.equal(r.pack_id, "pack-1");
    assert.match(r.request_sha256, /^[0-9a-f]{64}$/);
    assert.ok(!pins.has(r.request_sha256), r.name);
  }
  // One changed character anywhere in the request moves the hash.
  const pack = loadPack("1");
  const body = buildReviewRequest(pack.reviewFiles);
  assert.notEqual(sha256Hex(body.replace('"temperature":0', '"temperature":0.1')), requestSha256(pack));
});
