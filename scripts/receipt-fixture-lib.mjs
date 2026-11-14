// Builds test/fixtures/receipt-t003-sample-0.json: a version 1 receipt around a REAL recorded
// NEAR AI Cloud review (T-003 spike, 2026-11-10: real provider_tee signature, real keyless
// attestation bound to the recorded nonce) and the sample-0 answer key. There was no on-chain job,
// so the chain fields say "fixture.not-on-chain" and txs is empty: never show it as a real run.
// The T-003 prompt asked for {file, line, note} (no category), so the grade is the fixed FAIL
// malformed_finding. test/receipt.test.js checks the committed file equals this output.
//   node scripts/receipt-fixture.mjs        (rewrites the fixture)
// T-088: this is the library (tests and other scripts import it); `node scripts/receipt-fixture.mjs` is the CLI and always
// runs main() (same lib/CLI split as fe4e769: no "am I the main module?" check, which skipped main() via a symlink).
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalJson, commit } from "../grader/grade.js";
import { ATTESTATION_CHECKS } from "../verify/nearai-verify.js";
import { buildReceipt, receiptJson } from "../verify/receipt.js";

const ROOT = new URL("..", import.meta.url);
const readJson = (p) => JSON.parse(readFileSync(new URL(p, ROOT), "utf8"));
export const FIXTURE = "test/fixtures/receipt-t003-sample-0.json";

/** A spike record (spike/measure-review.mjs) in the shape seller/review.js teeReview returns. */
export function recordToReview(rec) {
  return {
    request_body: rec.request_body,
    response_body: rec.response_body,
    created: JSON.parse(rec.response_body).created,
    tee: {
      model: rec.model,
      request_sha256: rec.signature.text.split(":").at(-2),
      response_sha256: rec.signature.text.split(":").at(-1),
      signed_text: rec.signature.text,
      signature: rec.signature.signature,
      signing_address: rec.signature.signing_address,
      nonce: rec.nonce,
      attestation: rec.attestation,
      // What the T-003 spike checked: binding only, and no escrow allowlist existed yet.
      attestation_checks: { ...ATTESTATION_CHECKS, signer_allowlisted: false },
    },
  };
}

export function sample0Inputs() {
  const key = readJson("test/fixtures/sample-pack/answer-key.json");
  const { salt } = readJson("test/fixtures/sample-pack/reveal.json");
  const NOT_ON_CHAIN = "fixture.not-on-chain";
  return {
    job: {
      network: "testnet",
      contract: NOT_ON_CHAIN,
      job_id: "fixture-t003-sample-0-run08",
      pack_id: key.pack_id,
      buyer: NOT_ON_CHAIN,
      seller: NOT_ON_CHAIN,
      commit_hash: commit(key, salt),
    },
    reveal: { K: canonicalJson(key), salt },
    review: recordToReview(readJson("spike/evidence/runs/recorded-review-sample-0-run08.json")),
    quote: { before: "0.030", after: "0.030", formula: "fixture: no on-chain record" },
    txs: {},
  };
}

/** The CLI: rewrites the fixture. */
export function main() {
  writeFileSync(new URL(FIXTURE, ROOT), receiptJson(buildReceipt(sample0Inputs())));
  console.log(`wrote ${FIXTURE}`);
}
