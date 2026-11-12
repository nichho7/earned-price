// T-029: receipt writer (version 1) + offline verify (4 checks in order) + tamper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { canonicalJson, commit, sha256Hex } from "../grader/grade.js";
import { ATTESTATION_CHECKS, ethAddress } from "../verify/nearai-verify.js";
import {
  CHECKS,
  NOT_CHECKED_OFFLINE,
  RECEIPT_VERSION,
  ReceiptError,
  buildReceipt,
  receiptJson,
  tamperReceipt,
  verifyReceipt,
} from "../verify/receipt.js";
import { sample0Inputs } from "../scripts/receipt-fixture.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const readJson = (p) => JSON.parse(read(p));
const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

// --- Fixture A: a real T-003 record (real TEE signature + real keyless attestation) -------------
const FIXTURE_PATH = "test/fixtures/receipt-t003-sample-0.json";

// --- Fixture B: a real T-013 pack-2 response (real key), signed by a test key ------------------
function eip191Sign(text, sk) {
  const msg = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`);
  const rec = secp256k1.sign(keccak_256(new Uint8Array([...prefix, ...msg])), sk, { format: "recovered", prehash: false });
  return "0x" + bytesToHex(new Uint8Array([...rec.slice(1), rec[0] + 27]));
}

// A TDX v4 quote whose report_data = signer (20 bytes, zero-padded to 32) || nonce, as NEAR AI's.
function fakeEntry(addr, nonce, extra = {}) {
  const q = new Uint8Array(48 + 584);
  q[0] = 4;
  const rd = addr.slice(2).padEnd(64, "0") + nonce;
  q.set(hexToBytes(rd), 48 + 520);
  return { signing_address: addr, request_nonce: nonce, intel_quote: bytesToHex(q), report_data: rd, ...extra };
}

const sk = secp256k1.utils.randomSecretKey();
const signer = ethAddress(secp256k1.getPublicKey(sk));
const gwSigner = ethAddress(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey()));
const nonce = "ab".repeat(32);
const pack2Key = readJson("packs/pack-2/answer-key.json");
const pack2Run = readJson("packs/results/round-1/raw/pack-2-run01.json");
const salt2 = "5a".repeat(32);

function signedReview({ requestBody = pack2Run.request_body, responseBody = pack2Run.response_body, signWith = sk } = {}) {
  const text = `${MODEL}:${sha256Hex(requestBody)}:${sha256Hex(responseBody)}`;
  return {
    request_body: requestBody,
    response_body: responseBody,
    created: JSON.parse(responseBody).created,
    tee: {
      model: MODEL,
      request_sha256: sha256Hex(requestBody),
      response_sha256: sha256Hex(responseBody),
      signed_text: text,
      signature: eip191Sign(text, signWith),
      signing_address: signer,
      nonce,
      attestation: {
        gateway_attestation: fakeEntry(gwSigner, nonce),
        model_attestations: [fakeEntry(signer, nonce, { model_name: MODEL })],
      },
      attestation_checks: { ...ATTESTATION_CHECKS },
    },
  };
}

function pack2Receipt(review = signedReview()) {
  return buildReceipt({
    job: {
      network: "testnet",
      contract: "earned-price.testnet",
      job_id: 7,
      pack_id: "pack-2",
      buyer: "buyer-test.testnet",
      seller: "seller.earned-price.testnet",
      commit_hash: commit(pack2Key, salt2),
    },
    reveal: { K: canonicalJson(pack2Key), salt: salt2 },
    review,
    quote: { before: "0.030", after: "0.040", formula: "0.030 + 0.010×1 − 0.005×0 = 0.040" },
    txs: { create: "CreateTx111", accept: "AcceptTx111", submit_review: "SubmitTx111", reveal: "RevealTx111" },
  });
}

const statuses = (v) => v.checks.map((c) => c.ok);

// --- Writer -----------------------------------------------------------------------------------

test("writer: version 1 receipt holds the m001 section 5 fields plus the raw review bodies", () => {
  const r = pack2Receipt();
  assert.equal(r.version, RECEIPT_VERSION);
  assert.equal(RECEIPT_VERSION, 1);
  for (const k of ["network", "contract", "job_id", "pack_id", "buyer", "seller", "commit_hash", "reveal", "findings", "grade", "quote", "txs", "tee"]) {
    assert.ok(k in r, `missing ${k}`);
  }
  assert.equal(r.job_id, "7", "job ids are strings (u64)");
  assert.deepEqual(r.reveal, { key: pack2Key, salt: salt2 });
  assert.equal(r.grade.passed, true);
  assert.equal(r.grade.found, 5);
  assert.deepEqual(r.findings, JSON.parse(JSON.parse(pack2Run.response_body).choices[0].message.content).findings);
  for (const k of ["model", "request_sha256", "response_sha256", "signed_text", "signature", "signing_address", "nonce", "created", "attestation_checks", "request_body", "response_body", "attestation"]) {
    assert.ok(k in r.tee, `missing tee.${k}`);
  }
  assert.equal(r.tee.response_body, pack2Run.response_body, "raw response bytes kept exactly");
  assert.deepEqual(r.tee.attestation_checks, ATTESTATION_CHECKS);
  assert.equal(Object.keys(r.tee).at(-1), "attestation", "the ~300 KB attestation sits last, so the file reads top-down");
});

test("writer: grade and findings come from the signed response, never from the caller", () => {
  for (const extra of [{ grade: { passed: true } }, { findings: [] }]) {
    assert.throws(() => buildReceipt({ ...sample0Inputs(), ...extra }), (e) => e instanceof ReceiptError && e.code === "BAD_INPUT");
  }
});

test("writer: refuses a non-canonical K, a bad salt, or a review without response_body", () => {
  const base = sample0Inputs();
  const key = base.reveal.K && JSON.parse(base.reveal.K);
  const salt = base.reveal.salt;
  const bad = (patch) => assert.throws(() => buildReceipt({ ...base, ...patch }), (e) => e instanceof ReceiptError && e.code === "BAD_INPUT");
  bad({ reveal: { K: JSON.stringify(key, null, 1), salt } });
  bad({ reveal: { K: canonicalJson(key), salt: "AB".repeat(32) } });
  bad({ reveal: { K: canonicalJson(key), salt: "ab" } });
  bad({ reveal: { K: canonicalJson({ ...key, pass_min: 1 }), salt } });
  const { response_body, ...noBody } = base.review;
  bad({ review: noBody });
  bad({ review: { ...base.review, tee: { ...base.review.tee, signature: undefined } } });
  bad({ review: { ...base.review, tee: { ...base.review.tee, attestation_checks: undefined } } });
  bad({ job: { ...base.job, network: "mainnet" } });
  bad({ quote: { before: 0.03, after: "0.04" } });
});

test("writer: receiptJson is stable pretty JSON with a trailing newline", () => {
  const r = pack2Receipt();
  const s = receiptJson(r);
  assert.ok(s.endsWith("}\n"));
  assert.deepEqual(JSON.parse(s), r);
  assert.equal(receiptJson(JSON.parse(s)), s);
});

// --- Verify: the real T-003 record ------------------------------------------------------------

test("committed fixture equals buildReceipt(real T-003 record): regenerate with node scripts/receipt-fixture.mjs", () => {
  assert.equal(read(FIXTURE_PATH), receiptJson(buildReceipt(sample0Inputs())));
});

test("real T-003 record: all 4 checks pass, in order, and check 4 reproduces the malformed_finding FAIL", () => {
  const r = readJson(FIXTURE_PATH);
  const v = verifyReceipt(r);
  assert.deepEqual(v.checks.map((c) => c.n), [1, 2, 3, 4]);
  assert.deepEqual(v.checks.map((c) => c.title), CHECKS.map((c) => c.title));
  assert.deepEqual(CHECKS.map((c) => c.title), [
    "Commit hash matches the revealed key",
    "TEE signature covers this review",
    "Attestation binds the signer and nonce",
    "Regrade gives the same score",
  ]);
  assert.deepEqual(statuses(v), [true, true, true, true], JSON.stringify(v.checks, null, 1));
  assert.equal(v.ok, true);
  // The T-003 prompt asked for {file, line, note}: no category, so it is the fixed FAIL (T-025 review).
  assert.equal(r.grade.passed, false);
  assert.equal(r.grade.error, "malformed_finding");
  assert.match(v.checks[3].detail, /malformed_finding/);
});

test("real T-003 record: --tamper changes one byte of the stored review text and fails ONLY check 2", () => {
  const r = readJson(FIXTURE_PATH);
  const { receipt: t, edit } = tamperReceipt(r);
  assert.equal(edit.field, "tee.response_body");
  assert.equal(t.tee.response_body.length, r.tee.response_body.length);
  const diff = [...t.tee.response_body].filter((c, i) => c !== r.tee.response_body[i]).length;
  assert.equal(diff, 1, "exactly one byte differs");
  assert.notEqual(edit.from, edit.to);
  assert.deepEqual(t.findings, r.findings, "findings untouched");
  assert.equal(r.tee.response_body, readJson(FIXTURE_PATH).tee.response_body, "the input is not mutated");
  const v = verifyReceipt(t);
  assert.deepEqual(statuses(v), [true, false, true, true]);
  assert.equal(v.ok, false);
  assert.match(v.checks[1].detail, /review text was changed/);
});

// --- Verify: real T-013 response, PASS grade, and each check's own failure ---------------------

test("real T-013 pack-2 response: PASS receipt verifies; tamper fails only check 2", () => {
  const r = pack2Receipt();
  assert.deepEqual(statuses(verifyReceipt(r)), [true, true, true, true]);
  assert.match(verifyReceipt(r).checks[3].detail, /5\/5 found, passed/);
  assert.deepEqual(statuses(verifyReceipt(tamperReceipt(r).receipt)), [true, false, true, true]);
});

test("verify survives a JSON round trip (the CLI and the browser read the file)", () => {
  assert.equal(verifyReceipt(JSON.parse(receiptJson(pack2Receipt()))).ok, true);
});

test("check 1 fails alone for a wrong salt, a swapped key, or a key for another pack", () => {
  const r = pack2Receipt();
  const wrongSalt = structuredClone(r);
  wrongSalt.reveal.salt = "6b".repeat(32);
  assert.deepEqual(statuses(verifyReceipt(wrongSalt)), [false, true, true, true]);
  assert.match(verifyReceipt(wrongSalt).checks[0].detail, /does not match/);

  const otherCommit = structuredClone(r);
  otherCommit.commit_hash = "00".repeat(32);
  assert.deepEqual(statuses(verifyReceipt(otherCommit)), [false, true, true, true]);

  const otherPack = structuredClone(r);
  otherPack.pack_id = "pack-1";
  assert.equal(verifyReceipt(otherPack).checks[0].ok, false);
  assert.match(verifyReceipt(otherPack).checks[0].detail, /key is for pack-2, the job is for pack-1/);
});

test("check 2 fails alone for an edited findings field, a forged signer, a high-s signature or a lying hash field", () => {
  const r = pack2Receipt();
  const editedFinding = structuredClone(r);
  editedFinding.findings[0].line += 1;
  assert.deepEqual(statuses(verifyReceipt(editedFinding)), [true, false, true, true]);
  assert.match(verifyReceipt(editedFinding).checks[1].detail, /findings/);

  const otherSigner = pack2Receipt(signedReview({ signWith: secp256k1.utils.randomSecretKey() }));
  assert.deepEqual(statuses(verifyReceipt(otherSigner)), [true, false, true, true]);

  const high = structuredClone(r);
  const b = hexToBytes(high.tee.signature.slice(2));
  const s = secp256k1.Point.Fn.ORDER - BigInt("0x" + bytesToHex(b.slice(32, 64)));
  high.tee.signature = "0x" + bytesToHex(b.slice(0, 32)) + s.toString(16).padStart(64, "0") + (b[64] === 27 ? 28 : 27).toString(16);
  const vh = verifyReceipt(high);
  assert.deepEqual(statuses(vh), [true, false, true, true]);
  assert.match(vh.checks[1].detail, /high-s/);

  const lyingHash = structuredClone(r);
  lyingHash.tee.response_sha256 = "11".repeat(32);
  assert.deepEqual(statuses(verifyReceipt(lyingHash)), [true, false, true, true]);
});

test("check 2 needs the stored request and response bodies", () => {
  const r = pack2Receipt();
  delete r.tee.response_body;
  const v = verifyReceipt(r);
  assert.equal(v.checks[1].ok, false);
  assert.match(v.checks[1].detail, /response_body/);
});

test("check 3 fails alone for a wrong nonce, a signer not in the quotes, or an over-claiming scope", () => {
  const r = pack2Receipt();
  const wrongNonce = structuredClone(r);
  wrongNonce.tee.nonce = "cd".repeat(32);
  assert.deepEqual(statuses(verifyReceipt(wrongNonce)), [true, true, false, true]);

  const swappedQuote = structuredClone(r);
  swappedQuote.tee.attestation.model_attestations[0] = fakeEntry(gwSigner, nonce, { model_name: MODEL });
  assert.deepEqual(statuses(verifyReceipt(swappedQuote)), [true, true, false, true]);

  for (const k of ["intel_dcap", "nvidia_nras", "measurements_pinned"]) {
    const overclaim = structuredClone(r);
    overclaim.tee.attestation_checks[k] = true;
    const v = verifyReceipt(overclaim);
    assert.deepEqual(statuses(v), [true, true, false, true], k);
    assert.match(v.checks[2].detail, new RegExp(k));
  }
  const noScope = structuredClone(r);
  delete noScope.tee.attestation_checks;
  assert.equal(verifyReceipt(noScope).checks[2].ok, false);
});

test("check 3 states its binding-only scope and never says a bare 'attested'", () => {
  const v = verifyReceipt(pack2Receipt());
  assert.match(v.checks[2].detail, /binding only/);
  assert.deepEqual(v.checks[2].scope, { nonce_bound: true, signer_bound: true, signer_allowlisted: null, intel_dcap: false, nvidia_nras: false, measurements_pinned: false });
  assert.match(NOT_CHECKED_OFFLINE, /Intel DCAP/);
  assert.match(NOT_CHECKED_OFFLINE, /NVIDIA/);
  assert.match(NOT_CHECKED_OFFLINE, /measurements/);
  assert.doesNotMatch(JSON.stringify(v), /\battested\b/i);
});

test("check 4 fails alone when the stored grade was edited", () => {
  const r = pack2Receipt();
  const edited = structuredClone(r);
  edited.grade.found = 3;
  edited.grade.passed = false;
  const v = verifyReceipt(edited);
  assert.deepEqual(statuses(v), [true, true, true, false]);
  assert.match(v.checks[3].detail, /receipt says 3\/5 found, failed; regrade gives 5\/5 found, passed/);
});

test("check 4 reproduces the fixed FAIL for a non-JSON or non-array review (T-025 review)", () => {
  for (const content of ["not json at all", '{"findings": {"file": "a.py"}}', "[1, 2]"]) {
    const body = JSON.stringify({ id: "chatcmpl-x", created: 1, choices: [{ message: { content } }] });
    const r = pack2Receipt(signedReview({ responseBody: body }));
    assert.equal(r.grade.passed, false);
    assert.equal(r.grade.error, "malformed_finding");
    assert.deepEqual(statuses(verifyReceipt(r)), [true, true, true, true]);
    const edited = structuredClone(r);
    delete edited.grade.error;
    assert.equal(verifyReceipt(edited).checks[3].ok, false);
  }
});

test("verify never throws on a broken v1 receipt: each check fails with a reason", () => {
  const v = verifyReceipt({ version: 1 });
  assert.deepEqual(statuses(v), [false, false, false, false]);
  for (const c of v.checks) assert.equal(typeof c.detail, "string");
});

test("verify refuses a non-receipt or another version with a ReceiptError", () => {
  for (const bad of [null, [], "x", { version: 2 }, {}]) {
    assert.throws(() => verifyReceipt(bad), (e) => e instanceof ReceiptError && e.code === "NOT_A_RECEIPT");
  }
});

test("verify and tamper make no network call", () => {
  const orig = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network used");
  };
  try {
    const r = readJson(FIXTURE_PATH);
    assert.equal(verifyReceipt(r).ok, true);
    verifyReceipt(tamperReceipt(r).receipt);
  } finally {
    globalThis.fetch = orig;
  }
});

test("verify/receipt.js and verify/nearai-verify.js have no node: imports and no Buffer (isomorphic, T-039)", () => {
  for (const f of ["verify/receipt.js", "verify/nearai-verify.js", "grader/grade.js"]) {
    const src = read(f).replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src, /from\s+["']node:/, f);
    assert.doesNotMatch(src, /\bBuffer\b/, f);
    assert.doesNotMatch(src, /\bprocess\./, f);
  }
});
