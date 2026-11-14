// T-029: receipt writer (version 1) + offline verify (4 checks in order) + tamper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { canonicalJson, commit, grade, sha256Hex } from "../grader/grade.js";
import { ATTESTATION_CHECKS, ethAddress } from "../verify/nearai-verify.js";
import {
  CHECKS,
  NOT_CHECKED_OFFLINE,
  NOT_PROVEN_OFFLINE,
  RECEIPT_VERSION,
  ReceiptError,
  CLAIM_CUT,
  buildReceipt,
  claim,
  printable,
  receiptJson,
  tamperReceipt,
  verifyReceipt,
} from "../verify/receipt.js";
import { sample0Inputs } from "../scripts/receipt-fixture.mjs";
import { runVerify } from "../cli/verify-cmd.js";
import { TRUST } from "../verify/trust-anchors.js";
import { loadPack } from "../packs/packs.js";
import { buildReviewRequest } from "../seller/review-prompt.js";

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
// The official pack-2 request (= the escrow's pin). The recorded T-013 response is from an older
// prompt, but the test key signs whatever request we give it, so the receipt carries the pinned one.
const pack2Request = buildReviewRequest(loadPack("2").reviewFiles);
// Offline verify trusts only verify/trust-anchors.js. Tests that need a signature we can make add
// the test signer to a copy of the real anchors (same model, pins and key hashes).
const TEST_TRUST = Object.freeze({ ...TRUST, signers: Object.freeze([signer]) });
const verifyT = (r) => verifyReceipt(r, { trust: TEST_TRUST });

function signedReview({ requestBody = pack2Request, responseBody = pack2Run.response_body, signWith = sk, model = MODEL, address = signer } = {}) {
  const text = `${model}:${sha256Hex(requestBody)}:${sha256Hex(responseBody)}`;
  return {
    request_body: requestBody,
    response_body: responseBody,
    created: JSON.parse(responseBody).created,
    tee: {
      model,
      request_sha256: sha256Hex(requestBody),
      response_sha256: sha256Hex(responseBody),
      signed_text: text,
      signature: eip191Sign(text, signWith),
      signing_address: address,
      nonce,
      attestation: {
        gateway_attestation: fakeEntry(gwSigner, nonce),
        model_attestations: [fakeEntry(address, nonce, { model_name: MODEL })],
      },
      attestation_checks: { ...ATTESTATION_CHECKS },
    },
  };
}

function pack2Receipt(review = signedReview(), { key = pack2Key, packId = key.pack_id } = {}) {
  return buildReceipt({
    job: {
      network: "testnet",
      contract: "earned-price.testnet",
      job_id: 7,
      pack_id: packId,
      buyer: "buyer-test.testnet",
      seller: "seller.earned-price.testnet",
      commit_hash: commit(key, salt2),
    },
    reveal: { K: canonicalJson(key), salt: salt2 },
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

test("real T-003 record: all 4 checks pass in order with the real anchors, but it is NOT an official pack, so not authentic", () => {
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
  // sample-0 has no request pin and no key pin: never "REVIEW AUTHENTIC" (security review C-1 step 4).
  assert.equal(v.ok, false);
  assert.equal(v.official, false);
  assert.equal(v.checks[0].key_pinned, null);
  assert.equal(v.checks[1].request_pinned, null);
  assert.equal(v.checks[1].signer_allowlisted, true, "the real T-003 signer is on the escrow's allowlist");
  assert.match(v.verdict, /^NOT AN OFFICIAL PACK \(fixture\)/);
  assert.doesNotMatch(v.verdict, /AUTHENTIC/);
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

test("official pack-2 request + real T-013 response: REVIEW AUTHENTIC (offline) with proves + chain_fields_checked false; tamper fails only check 2", () => {
  const r = pack2Receipt();
  const v = verifyT(r);
  assert.deepEqual(statuses(v), [true, true, true, true]);
  assert.match(v.checks[3].detail, /5\/5 found, passed/);
  assert.equal(v.ok, true);
  assert.equal(v.official, true);
  assert.equal(v.checks[0].key_pinned, true);
  assert.equal(v.checks[1].request_pinned, true);
  assert.deepEqual(v.proves, { review_authentic: true, official_request: true, official_key: true, regrade_matches: true });
  assert.equal(v.chain_fields_checked, false);
  assert.equal(v.verdict, "REVIEW AUTHENTIC (offline): genuine NEAR AI TEE review of the official pack-2 request (prompt v1), regrade PASS.");
  assert.equal(v.not_proven, NOT_PROVEN_OFFLINE);
  assert.deepEqual(statuses(verifyT(tamperReceipt(r).receipt)), [true, false, true, true]);
});

test("verify survives a JSON round trip (the CLI and the browser read the file)", () => {
  assert.equal(verifyT(JSON.parse(receiptJson(pack2Receipt()))).ok, true);
});

test("check 1 fails alone for a wrong salt, a swapped key, or a key for another pack", () => {
  const r = pack2Receipt();
  const wrongSalt = structuredClone(r);
  wrongSalt.reveal.salt = "6b".repeat(32);
  assert.deepEqual(statuses(verifyT(wrongSalt)), [false, true, true, true]);
  assert.match(verifyT(wrongSalt).checks[0].detail, /does not match/);

  const otherCommit = structuredClone(r);
  otherCommit.commit_hash = "00".repeat(32);
  assert.deepEqual(statuses(verifyT(otherCommit)), [false, true, true, true]);

  const otherPack = structuredClone(r);
  otherPack.pack_id = "pack-1";
  assert.equal(verifyT(otherPack).checks[0].ok, false);
  assert.match(verifyT(otherPack).checks[0].detail, /key is for pack-2, the job is for pack-1/);
});

test("check 2 fails alone for an edited findings field, a forged signer, a high-s signature or a lying hash field", () => {
  const r = pack2Receipt();
  const editedFinding = structuredClone(r);
  editedFinding.findings[0].line += 1;
  assert.deepEqual(statuses(verifyT(editedFinding)), [true, false, true, true]);
  assert.match(verifyT(editedFinding).checks[1].detail, /findings/);

  const otherSigner = pack2Receipt(signedReview({ signWith: secp256k1.utils.randomSecretKey() }));
  assert.deepEqual(statuses(verifyT(otherSigner)), [true, false, true, true]);

  // Code review S-4: the request edited alone, and a gateway-format signed text with a valid signature.
  const editedRequest = structuredClone(r);
  editedRequest.tee.request_body += " ";
  assert.deepEqual(statuses(verifyT(editedRequest)), [true, false, true, true]);

  const gw = structuredClone(r);
  gw.tee.signed_text = `${sha256Hex(gw.tee.request_body)}:${sha256Hex(gw.tee.response_body)}`;
  gw.tee.signature = eip191Sign(gw.tee.signed_text, sk);
  const vg = verifyT(gw);
  assert.deepEqual(statuses(vg), [true, false, true, true]);
  assert.match(vg.checks[1].detail, /signed text is not/);

  const high = structuredClone(r);
  const b = hexToBytes(high.tee.signature.slice(2));
  const s = secp256k1.Point.Fn.ORDER - BigInt("0x" + bytesToHex(b.slice(32, 64)));
  high.tee.signature = "0x" + bytesToHex(b.slice(0, 32)) + s.toString(16).padStart(64, "0") + (b[64] === 27 ? 28 : 27).toString(16);
  const vh = verifyT(high);
  assert.deepEqual(statuses(vh), [true, false, true, true]);
  assert.match(vh.checks[1].detail, /high-s/);

  const lyingHash = structuredClone(r);
  lyingHash.tee.response_sha256 = "11".repeat(32);
  assert.deepEqual(statuses(verifyT(lyingHash)), [true, false, true, true]);
});

test("check 2 needs the stored request and response bodies", () => {
  const r = pack2Receipt();
  delete r.tee.response_body;
  const v = verifyT(r);
  assert.equal(v.checks[1].ok, false);
  assert.match(v.checks[1].detail, /response_body/);
});

test("check 3 fails alone for a wrong nonce, a signer not in the quotes, or an over-claiming scope", () => {
  const r = pack2Receipt();
  const wrongNonce = structuredClone(r);
  wrongNonce.tee.nonce = "cd".repeat(32);
  assert.deepEqual(statuses(verifyT(wrongNonce)), [true, true, false, true]);

  const swappedQuote = structuredClone(r);
  swappedQuote.tee.attestation.model_attestations[0] = fakeEntry(gwSigner, nonce, { model_name: MODEL });
  assert.deepEqual(statuses(verifyT(swappedQuote)), [true, true, false, true]);

  for (const k of ["intel_dcap", "nvidia_nras", "measurements_pinned"]) {
    const overclaim = structuredClone(r);
    overclaim.tee.attestation_checks[k] = true;
    const v = verifyT(overclaim);
    assert.deepEqual(statuses(v), [true, true, false, true], k);
    assert.match(v.checks[2].detail, new RegExp(k));
  }
  const noScope = structuredClone(r);
  delete noScope.tee.attestation_checks;
  assert.equal(verifyT(noScope).checks[2].ok, false);
});

test("check 3 states its binding-only scope and never says a bare 'attested'", () => {
  const v = verifyT(pack2Receipt());
  assert.match(v.checks[2].detail, /binding only/);
  assert.deepEqual(v.checks[2].scope, { nonce_bound: true, signer_bound: true, signer_allowlisted: true, intel_dcap: false, nvidia_nras: false, measurements_pinned: false });
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
  const v = verifyT(edited);
  assert.deepEqual(statuses(v), [true, true, true, false]);
  assert.match(v.checks[3].detail, /receipt says 3\/5 found, failed; regrade gives 5\/5 found, passed/);
});

test("check 4 reproduces the fixed FAIL for a non-JSON or non-array review (T-025 review)", () => {
  for (const content of ["not json at all", '{"findings": {"file": "a.py"}}', "[1, 2]"]) {
    const body = JSON.stringify({ id: "chatcmpl-x", created: 1, choices: [{ message: { content } }] });
    const r = pack2Receipt(signedReview({ responseBody: body }));
    assert.equal(r.grade.passed, false);
    assert.equal(r.grade.error, "malformed_finding");
    assert.deepEqual(statuses(verifyT(r)), [true, true, true, true]);
    const edited = structuredClone(r);
    delete edited.grade.error;
    assert.equal(verifyT(edited).checks[3].ok, false);
  }
});

test("verify never throws on a broken v1 receipt: each check fails with a reason", () => {
  const v = verifyT({ version: 1 });
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
    assert.ok(verifyReceipt(r).checks.every((c) => c.ok));
    verifyReceipt(tamperReceipt(r).receipt);
  } finally {
    globalThis.fetch = orig;
  }
});

test("verify/receipt.js and verify/nearai-verify.js have no node: imports and no Buffer (isomorphic, T-039)", () => {
  for (const f of ["verify/receipt.js", "verify/nearai-verify.js", "verify/trust-anchors.js", "grader/grade.js"]) {
    const src = read(f).replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src, /from\s+["']node:/, f);
    assert.doesNotMatch(src, /\bBuffer\b/, f);
    assert.doesNotMatch(src, /\bprocess\./, f);
  }
});

// --- Security review fixes (T-029: C-1, H-1, H-2, M-a, M-b, L-2, Info-1, Info-3; code review M-1, M-2) ----

const PINS = readJson("test-vectors/review-pins.json");

// The auditor's C-1 PoC: a receipt minted from nothing (own key, invented review, quotes rewritten to
// bind the forger's address, grade recomputed, price inflated). With the REAL anchors it must fail.
function forge(base, key) {
  const fsk = secp256k1.utils.randomSecretKey();
  const addr = ethAddress(secp256k1.getPublicKey(fsk));
  const findings = key.bugs.map((b) => ({ file: b.file, line: b.line_start, category: b.category }));
  const body = JSON.stringify({ id: "chatcmpl-forged", created: base.tee.created, choices: [{ message: { content: JSON.stringify({ findings }) } }] });
  const r = structuredClone(base);
  const t = r.tee;
  t.response_body = body;
  t.response_sha256 = sha256Hex(body);
  t.signed_text = `${t.model}:${t.request_sha256}:${t.response_sha256}`;
  t.signature = eip191Sign(t.signed_text, fsk);
  t.signing_address = addr;
  t.attestation = structuredClone(t.attestation);
  const i = t.attestation.model_attestations.findIndex((a) => a.model_name === t.model);
  t.attestation.model_attestations[i] = fakeEntry(addr, t.nonce, { model_name: t.model });
  r.findings = findingsFromBody(body);
  r.grade = grade(key, r.findings);
  r.quote.after = "9.999";
  return r;
}
const findingsFromBody = (body) => JSON.parse(JSON.parse(body).choices[0].message.content).findings;

test("C-1 PoC: a self-signed forged receipt (sample-0 fixture) fails check 2: signer is not allowlisted; never authentic", () => {
  const base = readJson(FIXTURE_PATH);
  const forged = forge(base, base.reveal.key);
  // The forgery is internally consistent: with the forger trusted, all 4 checks would pass.
  assert.deepEqual(statuses(verifyReceipt(forged, { trust: { ...TRUST, signers: [forged.tee.signing_address] } })), [true, true, true, true]);
  const v = verifyReceipt(forged);
  assert.equal(v.checks[1].ok, false);
  assert.match(v.checks[1].detail, /is not an allowlisted NEAR AI TEE signer/);
  assert.equal(v.checks[1].signer_allowlisted, false);
  assert.equal(v.ok, false);
  assert.doesNotMatch(v.verdict, /AUTHENTIC \(offline\)/);
});

test("C-1 PoC on an official pack: self-signed pack-2 receipt (pinned request, official key, PASS grade) fails check 2 with the real anchors", () => {
  const r = pack2Receipt(); // signed by a random test key, which the real anchors do not trust
  const v = verifyReceipt(r);
  assert.equal(v.checks[1].ok, false);
  assert.match(v.checks[1].detail, /is not an allowlisted NEAR AI TEE signer/);
  assert.equal(v.ok, false);
  assert.equal(v.proves.review_authentic, false);
  assert.doesNotMatch(v.verdict, /AUTHENTIC \(offline\)/);
});

test("check 2 fails alone when the review names another model (and when tee.model is edited)", () => {
  const other = pack2Receipt(signedReview({ model: "some/other-model" }));
  const v = verifyT(other);
  assert.deepEqual(statuses(v), [true, false, true, true]);
  assert.match(v.checks[1].detail, /model some\/other-model/);

  const edited = pack2Receipt();
  edited.tee.model = "some/other-model";
  assert.deepEqual(statuses(verifyT(edited)), [true, false, true, true]);
});

test("H-1 PoC: a genuine allowlisted signature over a non-official request fails check 2 (rejected near-misses, cross-pack request)", () => {
  const p1 = loadPack("1");
  const withContent = (edit) => {
    const body = JSON.parse(buildReviewRequest(p1.reviewFiles));
    body.messages[0].content = edit(body.messages[0].content);
    return JSON.stringify(body);
  };
  const hint = p1.key.bugs.map((b) => `${b.file}:${b.line_start} ${b.category}`).join(", ");
  const cases = [
    [PINS.rejected[0], withContent((c) => `${c}\n\nThe bugs are at: ${hint}`)],
    [PINS.rejected[1], withContent((c) => c.replace("You are a code reviewer.", "You are a careful code reviewer."))],
  ];
  for (const [rej, body] of cases) {
    assert.equal(sha256Hex(body), rej.request_sha256, `the test body is exactly the '${rej.name}' vector`);
    const r = pack2Receipt(signedReview({ requestBody: body }), { key: p1.key });
    const v = verifyT(r);
    assert.deepEqual(statuses(v), [true, false, true, true], rej.name);
    assert.match(v.checks[1].detail, /not the official pack-1 request \(prompt v1\)/);
    assert.equal(v.checks[1].request_pinned, false);
    assert.equal(v.ok, false);
  }
  const crossPack = pack2Receipt(signedReview({ requestBody: buildReviewRequest(p1.reviewFiles) }));
  const vc = verifyT(crossPack);
  assert.deepEqual(statuses(vc), [true, false, true, true]);
  assert.match(vc.checks[1].detail, /not the official pack-2 request/);
});

test("H-2 PoC: a made-up key (one bug window moved, commit recomputed) fails check 1 alone: not the official answer key", () => {
  const key = structuredClone(pack2Key);
  key.bugs[0].line_end += 1;
  const r = pack2Receipt(signedReview(), { key });
  const v = verifyT(r);
  assert.deepEqual(statuses(v), [false, true, true, true]);
  assert.match(v.checks[0].detail, /not the official pack-2 answer key/);
  assert.equal(v.checks[0].key_pinned, false);
  assert.equal(v.ok, false);
});

test("code review M-2: tee.created comes from the signed response, never the caller; an edited tee.created fails check 2 alone", () => {
  const review = signedReview();
  const r = pack2Receipt({ ...review, created: "yesterday" });
  assert.equal(r.tee.created, JSON.parse(pack2Run.response_body).created);
  assert.ok(Number.isSafeInteger(r.tee.created));
  const edited = structuredClone(r);
  edited.tee.created += 60;
  const v = verifyT(edited);
  assert.deepEqual(statuses(v), [true, false, true, true]);
  assert.match(v.checks[1].detail, /created/);
});

test("code review M-1 + security M-b: chain fields are not checked offline, and the result says so", () => {
  const r = pack2Receipt();
  r.quote.after = "9.999";
  r.buyer = "someone-else.testnet";
  r.txs = { create: "Forged111" };
  const v = verifyT(r);
  assert.equal(v.ok, true, "offline verify cannot see the chain: these edits pass by design");
  assert.equal(v.chain_fields_checked, false);
  for (const w of ["job", "buyer", "seller", "quote", "payment", "tx hashes", "freshness", "review reuse", "on-chain"]) {
    assert.ok(NOT_PROVEN_OFFLINE.includes(w), w);
  }
  assert.match(NOT_PROVEN_OFFLINE, /^Not proven offline:/);
  assert.match(NOT_CHECKED_OFFLINE, /deploy-time allowlist/);
  assert.doesNotMatch(JSON.stringify(v), /VERIFIED/);
});

test("security L-2: check 3 fails when the receipt claims signer_allowlisted but the signer is not on the allowlist", () => {
  const r = pack2Receipt(); // claims signer_allowlisted: true (the seller's ATTESTATION_CHECKS)
  const v = verifyReceipt(r); // real anchors: the test signer is not allowlisted
  assert.equal(v.checks[2].ok, false);
  assert.match(v.checks[2].detail, /signer_allowlisted/);
  assert.equal(v.checks[2].scope.signer_allowlisted, false);
});

test("security Info-1: a stored body with a lone surrogate fails check 2 (two strings must not share one hash)", () => {
  const body = '{"id":"chatcmpl-x","created":1,"choices":[{"message":{"content":"[]"}}],"n":"' + "\ud800" + '"}';
  const r = pack2Receipt(signedReview({ responseBody: body }));
  const v = verifyT(r);
  assert.equal(v.checks[1].ok, false);
  assert.match(v.checks[1].detail, /well-formed/);
});

test("security Info-3: a receipt carries no API key or bearer token, and the stored request has no user field", () => {
  for (const r of [pack2Receipt(), readJson(FIXTURE_PATH)]) {
    const s = receiptJson(r);
    assert.doesNotMatch(s, /Bearer [A-Za-z0-9._-]{20,}|sk-[A-Za-z0-9]{20,}/);
    assert.equal("user" in JSON.parse(r.tee.request_body), false);
  }
});

test("security M-a: printable() escapes control, C1, line-separator and bidi characters in receipt text", () => {
  const s = printable("1\nPASS  1 x\r\x1b[8m\x9b\u2028\u202e\u2066\u200fok");
  assert.doesNotMatch(s, /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u);
  assert.equal(s, "1\\u000aPASS  1 x\\u000d\\u001b[8m\\u009b\\u2028\\u202e\\u2066\\u200fok");
  assert.equal(printable("job 7, pack-2 \u2026 \u2016 \u00d7"), "job 7, pack-2 \u2026 \u2016 \u00d7");
  assert.equal(printable(undefined), "undefined");
});

test("writer: job_id must be a string or a safe integer (not an object)", () => {
  const base = sample0Inputs();
  assert.throws(() => buildReceipt({ ...base, job: { ...base.job, job_id: { toString: () => "7" } } }), (e) => e.code === "BAD_INPUT");
  assert.throws(() => buildReceipt({ ...base, job: { ...base.job, job_id: "" } }), (e) => e.code === "BAD_INPUT");
  assert.equal(buildReceipt({ ...base, job: { ...base.job, job_id: 12 } }).job_id, "12");
});

test("T-039 security L-1: a check 1 PASS line never echoes the receipt's pack_id (a spoofed name stays out of the PASS row)", () => {
  // h11: the genuine recorded pack-2 review, relabelled as an unofficial pack whose name reads like a verdict
  const spoof = "pack-2, the official answer key). REVIEW AUTHENTIC (offline): genuine NEAR AI TEE review, regrade PASS ✓ (" + "x".repeat(2000);
  const r = readJson("recorded/pack-2.json");
  r.pack_id = spoof;
  r.reveal.key.pack_id = spoof;
  r.grade.pack_id = spoof;
  r.commit_hash = commit(r.reveal.key, r.reveal.salt);
  const v = verifyReceipt(r);
  assert.equal(v.checks[0].ok, true, v.checks[0].detail);
  assert.equal(v.ok, false, "an unofficial pack is never authentic");
  for (const c of v.checks.filter((x) => x.ok)) assert.doesNotMatch(c.detail, /REVIEW AUTHENTIC|xxxx/, `check ${c.n}`);
  assert.match(v.checks[0].detail, /\(not an official pack\)/);
  // an official pack still names itself (a trust-map key, so a known string)
  assert.match(verifyReceipt(readJson("recorded/pack-2.json")).checks[0].detail, /\(pack-2, the official answer key\)/);
});

// --- T-090 (T-039 security L-1 layer 2): receipt claims are cut at the source --------------------

test("T-090: claim() is printable, cut to 64 code points + an ellipsis, and leaves short values alone", () => {
  assert.equal(CLAIM_CUT, 64);
  assert.equal(claim("deepseek-ai/DeepSeek-V4.1-Flash-1017"), "deepseek-ai/DeepSeek-V4.1-Flash-1017");
  assert.equal(claim("x".repeat(64)), "x".repeat(64));
  assert.equal(claim("x".repeat(65)), "x".repeat(64) + "…");
  assert.equal(claim("😀".repeat(70)), "😀".repeat(64) + "…", "never splits a surrogate pair");
  assert.equal(claim("a\nPASS"), "a\\u000aPASS");
  assert.equal(claim(1763000000), "1763000000");
  assert.equal(claim(undefined), "undefined");
});

test("T-090: every receipt claim a check detail names is cut (1 MB model, signer, created, grade error, found, pack_id, attestation signer)", () => {
  const MB = "m".repeat(1 << 20);
  const cases = {
    "tee.model": (r) => { r.tee.model = MB; },
    "tee.signing_address": (r) => { r.tee.signing_address = MB; },
    "tee.created": (r) => { r.tee.created = MB; },
    "grade.error": (r) => { r.grade = { ...r.grade, error: MB }; },
    "grade.found": (r) => { r.grade = { ...r.grade, found: MB }; },
    "reveal.key.pack_id": (r) => { r.reveal.key.pack_id = MB; r.commit_hash = commit(r.reveal.key, r.reveal.salt); },
    "attestation signer vs tee signer": (r) => {
      const other = ethAddress(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey()));
      r.tee.attestation.model_attestations = [fakeEntry(other, nonce, { model_name: MODEL })];
      r.tee.signing_address = MB;
    },
  };
  for (const [name, edit] of Object.entries(cases)) {
    const r = pack2Receipt();
    edit(r);
    const v = verifyT(r);
    assert.equal(v.ok, false, name);
    assert.ok(v.checks.some((c) => !c.ok && c.detail.includes("…")), `${name}: a FAIL names the cut claim`);
    for (const c of v.checks) assert.ok(c.detail.length <= 300, `${name}: check ${c.n} detail is ${c.detail.length} chars`);
  }
});

test("T-090 AC: earned verify on a receipt with a 1 MB tee.model prints no line over 300 chars", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t090-"));
  try {
    const r = pack2Receipt();
    r.tee.model = "M".repeat(1 << 20);
    r.pack_id = "p".repeat(1 << 20); // the header line names pack_id too
    const path = join(dir, "r.json");
    writeFileSync(path, receiptJson(r));
    const lines = [];
    const v = await runVerify({ path, tamper: false, json: false, out: (l) => lines.push(l) });
    assert.equal(v.ok, false);
    assert.match(lines.join("\n"), /FAIL  2 /);
    for (const l of lines) assert.ok(l.length - path.length <= 300, `a ${l.length}-char line: ${l.slice(0, 80)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
