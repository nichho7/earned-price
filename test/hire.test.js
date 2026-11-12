// earned hire (S-022 / T-031). No live chain or NEAR AI calls: an in-memory escrow answers the
// views (recorded-shape JSON-RPC bodies) and the txs (recorded-shape FinalExecutionOutcome bodies
// with the contract's EVENT_JSON logs), and the TEE review is a real pack-2 response signed by a
// test key that only TEST_TRUST allowlists. Time is a fake clock moved by sleep().
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { canonicalJson, commit, findingsFromResponse, grade, sha256Hex } from "../grader/grade.js";
import { ATTESTATION_CHECKS, ethAddress } from "../verify/nearai-verify.js";
import { buildReceipt, verifyReceipt } from "../verify/receipt.js";
import { TRUST } from "../verify/trust-anchors.js";
import { loadPack } from "../packs/packs.js";
import { buildReviewRequest } from "../seller/review-prompt.js";
import { loadState, saveState } from "../cli/init.js";
import { DEMO_SELLER, loadJob, saveJob, sealPick } from "../cli/pick.js";
import { YOCTO_PER_MNEAR } from "../cli/quote.js";
import { REVEAL_GAS, TIMEOUT_GAS, parseTxOutcome } from "../cli/tx.js";
import { makeLocalSeller, replayReason } from "../cli/seller-local.js";
import { HireError, assertJobId, outcomeOf, parseHireArgs, receiptPaths, runHire, stageLine } from "../cli/hire.js";
import { errorLine } from "../cli/errors.js";
import { parseVerifyArgs, printableJson, runVerify } from "../cli/verify-cmd.js";

const CONTRACT = "earned-price.testnet";
const BUYER = "earned-price-buyer-deadbeef.testnet";
const PRIV = "ed25519:FAKEPRIVATEKEYdoNotUseAnywhere1111111111111111111111111111111111";
const SELLER_PRIV = "ed25519:FAKESELLERKEYdoNotUseAnywhere22222222222222222222222222222222222";
const API_KEY = "test-near-ai-key-do-not-use-3333";
const SALT = "cd".repeat(32);
const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const T0 = Date.UTC(2026, 10, 12, 20, 0, 0);
const MIN = 60_000;
const msToNs = (ms) => (BigInt(ms) * 1_000_000n).toString();
const b64 = (s) => Buffer.from(s).toString("base64");
const bytes = (v) => [...Buffer.from(JSON.stringify(v))];
const readJson = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));

// --- a signed review (same construction as test/receipt.test.js) -------------------------------
function eip191Sign(text, sk) {
  const msg = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`);
  const rec = secp256k1.sign(keccak_256(new Uint8Array([...prefix, ...msg])), sk, { format: "recovered", prehash: false });
  return "0x" + bytesToHex(new Uint8Array([...rec.slice(1), rec[0] + 27]));
}
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
const NONCE = "ab".repeat(32);
const TEST_TRUST = Object.freeze({ ...TRUST, signers: Object.freeze([signer]) });
const PACK2 = loadPack("2");
const PACK2_REQUEST = buildReviewRequest(PACK2.reviewFiles);
const PASS_BODY = readJson("packs/results/round-1/raw/pack-2-run01.json").response_body; // 5/5
const FAIL_BODY = JSON.stringify({ id: "chatcmpl-fail-1", created: 1794398261, model: MODEL, choices: [{ message: { role: "assistant", content: JSON.stringify({ findings: [] }) } }] });

function reviewResult(responseBody = PASS_BODY, jobId = "7") {
  const text = `${MODEL}:${sha256Hex(PACK2_REQUEST)}:${sha256Hex(responseBody)}`;
  const tee = {
    model: MODEL,
    request_sha256: sha256Hex(PACK2_REQUEST),
    response_sha256: sha256Hex(responseBody),
    signed_text: text,
    signature: eip191Sign(text, sk),
    signing_address: signer,
    nonce: NONCE,
    attestation: { gateway_attestation: fakeEntry(gwSigner, NONCE), model_attestations: [fakeEntry(signer, NONCE, { model_name: MODEL })] },
    attestation_checks: { ...ATTESTATION_CHECKS },
  };
  const findings = findingsFromResponse(responseBody);
  return {
    request_body: PACK2_REQUEST,
    response_body: responseBody,
    findings,
    check: { ok: true, list: findings },
    misses: [],
    attempts: 1,
    created: JSON.parse(responseBody).created,
    tee,
    submit_args: { job_id: jobId, model: MODEL, request_sha256: tee.request_sha256, response_sha256: tee.response_sha256, signature: tee.signature, signing_address: tee.signing_address, response: responseBody },
  };
}

// --- an in-memory escrow -----------------------------------------------------------------------
function makeChain({ jobId = "7", sealed, price = 30n * YOCTO_PER_MNEAR, record = { passes: 0, fails: 0, unique_buyers: 0, jobs: 0 }, clock }) {
  const chain = {
    record: { ...record },
    job: {
      id: jobId,
      buyer: BUYER,
      seller: DEMO_SELLER,
      price: price.toString(),
      commit_hash: sealed.commit_hash,
      pack_id: "pack-2",
      created_at_ns: msToNs(T0),
      accept_by_ns: msToNs(T0 + 2 * MIN),
      review_by_ns: msToNs(T0 + 7 * MIN),
      reveal_deadline_ns: msToNs(T0 + 12 * MIN),
      status: "open",
      accepted_at_ns: null,
      review: null,
    },
    sends: [],
    nullReads: 0, // get_job answers null this many times first (view lag)
    hideReviewReads: 0, // get_job shows review: null this many times while a review is on-chain
    seq: 0,
  };
  const quoteOf = (r) => Math.min(100, Math.max(25, 30 + 10 * r.unique_buyers - 5 * r.fails));
  const ev = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: "earned_price", version: "0.1.0", event, data })}`;
  const ok = (hash, value, logs, signerId) => ({
    status: { SuccessValue: b64(JSON.stringify(value ?? null)) },
    transaction: { hash },
    transaction_outcome: { id: hash, outcome: { executor_id: signerId, logs: [] } },
    receipts_outcome: logs.map((l, i) => ({ id: `${hash}-r${i}`, outcome: { executor_id: CONTRACT, logs: l } })),
  });
  const fail = (hash, msg, signerId) => ({
    status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${msg}` } } } } },
    transaction: { hash },
    transaction_outcome: { id: hash, outcome: { executor_id: signerId, logs: [] } },
    receipts_outcome: [],
  });
  const now = () => clock.now();
  chain.fetch = async (_url, init) => {
    const p = JSON.parse(init.body).params;
    const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString());
    let value;
    if (p.method_name === "get_job") {
      if (chain.nullReads > 0) {
        chain.nullReads--;
        value = null;
      } else value = chain.job && args.id === chain.job.id ? chain.job : null;
      if (value?.review && chain.hideReviewReads > 0) {
        chain.hideReviewReads--;
        value = { ...value, review: null };
      }
    } else if (p.method_name === "get_record") value = chain.record;
    else if (p.method_name === "quote") value = (BigInt(quoteOf(chain.record)) * YOCTO_PER_MNEAR).toString();
    else if (p.method_name === "signers") value = [signer];
    else throw new Error(`unexpected view ${p.method_name}`);
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: "earned", result: { block_hash: "BLOCK1", block_height: 1, logs: [], result: bytes(value) } }) };
  };
  chain.outcomes = {}; // every outcome by tx hash, as an RPC lookup would return it
  chain.sendTx = async (req) => {
    chain.sends.push(req);
    const hash = `${req.methodName}Tx${++chain.seq}`;
    await req.onSigned?.(hash);
    const o = await applyTx(req, hash);
    chain.outcomes[hash] = o;
    return o;
  };
  const applyTx = async (req, hash) => {
    if (chain.beforeSend) {
      const r = await chain.beforeSend(req, hash);
      if (r) return r;
    }
    const j = chain.job;
    const who = req.state.account_id;
    if (!j || req.args.job_id !== j.id) return fail(hash, "Earned Price: no open job with that id", who);
    const t = BigInt(msToNs(now()));
    if (req.methodName === "accept") {
      if (who !== j.seller) return fail(hash, "Earned Price: only the job's seller can accept it", who);
      j.status = "accepted";
      j.accepted_at_ns = t.toString();
      return ok(hash, null, [[ev("accept", { job_id: j.id, seller: j.seller, accepted_at_ns: t.toString() })]], who);
    }
    if (req.methodName === "submit_review") {
      const a = req.args;
      if (j.review) return fail(hash, "Earned Price: a review was already submitted for this job", who);
      j.review = { model: a.model, request_sha256: a.request_sha256, response_sha256: a.response_sha256, signed_text: `${a.model}:${a.request_sha256}:${a.response_sha256}`, signature: a.signature, signing_address: a.signing_address };
      return ok(hash, null, [[ev("submit_review", { job_id: j.id, seller: j.seller })]], who);
    }
    if (req.methodName === "reveal") {
      if (!j.review) return fail(hash, "Earned Price: no signed review is on-chain yet.", who);
      if (sha256Hex(req.args.response) !== j.review.response_sha256) return fail(hash, "Earned Price: response does not hash to the review's response_sha256. Nothing changed.", who);
      if (commit(JSON.parse(req.args.key), req.args.salt) !== j.commit_hash) return fail(hash, "Earned Price: key and salt do not match the job's commit_hash. No funds moved.", who);
      const g = grade(JSON.parse(req.args.key), findingsFromResponse(req.args.response));
      const base = { job_id: j.id, buyer: j.buyer, seller: j.seller };
      const reveal = ev("reveal", { ...base, pack_id: g.pack_id, found: g.found, total: g.total, pass_min: g.pass_min, passed: g.passed, matched: g.matched.map((m) => m.bug), missed: g.missed, false_positives: g.false_positives, error: g.error ?? null, outcome: g.passed ? "pass" : "fail" });
      chain.job = null;
      if (g.passed) {
        chain.record.passes++;
        chain.record.unique_buyers++;
        chain.record.jobs++;
        return ok(hash, true, [[reveal], [], [ev("payout", { ...base, amount: j.price, kind: "settle" })]], who);
      }
      chain.record.fails++;
      chain.record.jobs++;
      return ok(hash, false, [[reveal, ev("refund", { ...base, amount: j.price, reason: "grade_fail", record: "fail" })]], who);
    }
    if (req.methodName === "timeout") {
      const [reason, deadline] = j.status === "open" ? ["not_accepted", j.accept_by_ns] : !j.review ? ["no_review", j.review_by_ns] : ["no_reveal", j.reveal_deadline_ns];
      if (t <= BigInt(deadline)) return fail(hash, `Earned Price: this job's deadline (${deadline} ns) has not passed yet. Nothing changed.`, who);
      chain.job = null;
      const base = { job_id: j.id, buyer: j.buyer, seller: j.seller, amount: j.price };
      const to = ev("timeout", { job_id: j.id, reason });
      if (reason === "no_reveal") return ok(hash, true, [[to], [], [ev("payout", { ...base, kind: "timeout" })]], who);
      if (reason === "no_review") {
        chain.record.fails++;
        chain.record.jobs++;
      }
      return ok(hash, false, [[to, ev("refund", { ...base, reason, record: reason === "no_review" ? "fail" : "unchanged" })]], who);
    }
    throw new Error(`unexpected tx ${req.methodName}`);
  };
  return chain;
}

// --- buyer home with a job as `earned pick 2` leaves it ----------------------------------------
function setup({ jobId = "7", spent = (30n * YOCTO_PER_MNEAR).toString(), status = "open", record } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "earned-hire-"));
  saveState(dir, { version: 1, network: "testnet", account_id: BUYER, public_key: "ed25519:FakePublicKey11111111111111111111111111111111", private_key: PRIV, status: "created", spent_yocto: spent, created_at: "2026-11-12T00:00:00Z" });
  const sealed = sealPick(PACK2, "2", SALT);
  const price = 30n * YOCTO_PER_MNEAR;
  saveJob(dir, { version: 1, network: "testnet", contract: CONTRACT, buyer: BUYER, seller: DEMO_SELLER, pack_id: sealed.pack_id, pack_hash: PACK2.hash, commit_hash: sealed.commit_hash, K: sealed.K, salt: sealed.salt, price_yocto: price.toString(), status, job_id: jobId, create_tx: "CreateTx111" });
  const clock = { t: T0 + 5000, now() { return this.t; } };
  const chain = makeChain({ jobId: /^\d+$/.test(jobId) ? jobId : "7", sealed, price, clock, record });
  const recordedDir = mkdtempSync(join(tmpdir(), "earned-recorded-"));
  const lines = [];
  const deps = {
    dir,
    network: "testnet",
    urls: ["https://a.test.example"],
    contractId: CONTRACT,
    fetch: chain.fetch,
    sendTx: chain.sendTx,
    sleep: async (ms) => {
      clock.t += ms;
    },
    now: () => clock.now(),
    trust: TEST_TRUST,
    recordedDir,
    out: (l) => lines.push(l),
  };
  return { dir, chain, clock, deps, lines, sealed, recordedDir };
}

/** The real local seller module with a mocked reviewJob (no NEAR AI call). */
function localSellerWith(chain, clock, reviewJob) {
  return ({ accountId, contractId, getJob, say }) =>
    makeLocalSeller({ sellerState: { account_id: accountId, private_key: SELLER_PRIV }, contractId, sendTx: chain.sendTx, getJob, getSigners: async () => [signer], reviewJob, apiKey: API_KEY, sleep: async (ms) => { clock.t += ms; }, pollMs: 1, log: say });
}

const text = (lines) => lines.join("\n");

// --- pass ---------------------------------------------------------------------------------------

test("pass: accept -> TEE review -> submit_review -> reveal (300 Tgas) -> settle; 5/5, settle tx, 0.030 -> 0.040, receipt, SEE: step 3 PASS", async () => {
  const { dir, chain, clock, deps, lines } = setup();
  const r = await runHire({ ...deps, makeSeller: localSellerWith(chain, clock, async ({ job }) => reviewResult(PASS_BODY, String(job.id))) });
  const out = text(lines);
  assert.equal(r.pass, true);
  assert.deepEqual(chain.sends.map((s) => s.methodName), ["accept", "submit_review", "reveal"]);
  const reveal = chain.sends[2];
  assert.equal(reveal.gas, REVEAL_GAS);
  assert.equal(REVEAL_GAS, 300n * 10n ** 12n);
  assert.equal(reveal.state.account_id, BUYER);
  assert.equal(reveal.args.salt, SALT);
  assert.equal(reveal.args.response, PASS_BODY);
  assert.equal(chain.sends[0].state.account_id, DEMO_SELLER, "accept is signed by the seller");
  // progress: the stage deadline from get_job
  assert.match(out, /Stage: open\. seller must accept or decline by 2026-11-12T20:02:00\.000Z \(accept_by, 1m 55s left\)/);
  assert.match(out, /Stage: accepted, review on-chain\. buyer must reveal the key by 2026-11-12T20:12:00\.000Z \(reveal_deadline/);
  assert.match(out, /Seller accepted: accept tx acceptTx1/);
  // per-bug grade + outcome from the closing tx
  assert.match(out, /Grade: 5\/5 found \(pass mark 4\) -> PASS/);
  for (const b of ["B1", "B2", "B3", "B4", "B5"]) assert.match(out, new RegExp(`  ${b} found `));
  assert.match(out, /Passed\. The seller was paid from escrow\./);
  assert.match(out, /settle tx \(the settle runs inside reveal\): revealTx3/);
  assert.match(out, /Next quote \(get_record\): 0\.030 -> 0\.040 NEAR/);
  assert.match(out, /formula: 0\.030 \+ 0\.010×1 − 0\.005×0 = 0\.040 NEAR/);
  // receipt + full review next to it
  const paths = receiptPaths(dir, "7");
  assert.equal(r.receiptPath, paths.receipt);
  const receipt = JSON.parse(readFileSync(paths.receipt, "utf8"));
  assert.deepEqual(receipt.txs, { create: "CreateTx111", accept: "acceptTx1", submit_review: "submit_reviewTx2", reveal: "revealTx3" });
  assert.deepEqual(receipt.quote, { before: "0.030", after: "0.040", formula: "0.030 + 0.010×1 − 0.005×0 = 0.040 NEAR" });
  assert.equal(receipt.job_id, "7");
  const review = JSON.parse(readFileSync(paths.review, "utf8"));
  assert.equal(review.response_body, PASS_BODY);
  assert.ok(review.tee.attestation.model_attestations, "attestation stored for offline verify");
  const v = verifyReceipt(receipt, { trust: TEST_TRUST });
  assert.equal(v.ok, true);
  assert.match(out, /REVIEW AUTHENTIC \(offline\)/);
  assert.match(out, /Not proven offline: job, buyer, seller/);
  assert.match(out, /regrade: 5\/5 PASS/);
  assert.equal(lines.at(-1), "SEE: step 3 PASS");
  // job file closed, spend unchanged (paid)
  const job = loadJob(dir);
  assert.equal(job.status, "closed");
  assert.equal(job.outcome, "settled");
  assert.equal(job.closing_tx, "revealTx3");
  assert.equal(loadState(dir).spent_yocto, (30n * YOCTO_PER_MNEAR).toString());
  // secrets never printed
  for (const s of [PRIV, SELLER_PRIV, API_KEY]) assert.ok(!out.includes(s));
});

// --- fail -> refund -------------------------------------------------------------------------------

test("fail -> refund: 0/5, refund from the reveal tx, 0.030 -> 0.025, receipt AUTHENTIC but no SEE PASS (verify ok is not a pass, N-2)", async () => {
  const { dir, chain, clock, deps, lines } = setup();
  const r = await runHire({ ...deps, makeSeller: localSellerWith(chain, clock, async ({ job }) => reviewResult(FAIL_BODY, String(job.id))) });
  const out = text(lines);
  assert.equal(r.pass, false);
  assert.equal(r.outcome.kind, "refunded_fail");
  assert.match(out, /Grade: 0\/5 found \(pass mark 4\) -> FAIL/);
  assert.match(out, /Failed\. You were refunded and the seller takes a fail\./);
  assert.match(out, /Next quote \(get_record\): 0\.030 -> 0\.025 NEAR/);
  assert.equal(r.verify.ok, true, "the review is authentic...");
  assert.equal(r.verify.checks[3].regrade.passed, false, "...but the regrade failed");
  assert.ok(!out.includes("SEE: step 3 PASS"));
  assert.equal(loadJob(dir).status, "closed");
  assert.equal(loadState(dir).spent_yocto, "0", "the refunded reservation is released");
  assert.ok(existsSync(receiptPaths(dir, "7").receipt));
});

// --- timeout --------------------------------------------------------------------------------------

test("timeout: no live seller -> RECORDED notice, countdown to accept_by, timeout(job) after it -> refund, closed, no receipt", async () => {
  const { dir, chain, deps, lines } = setup();
  const r = await runHire(deps);
  const out = text(lines);
  assert.deepEqual(chain.sends.map((s) => s.methodName), ["timeout"]);
  assert.equal(chain.sends[0].gas, TIMEOUT_GAS);
  assert.match(out, /No live seller in this run/);
  assert.match(out, /RECORDED: no recorded live run of pack-2 ships with this version yet\./);
  assert.match(out, /waiting: seller must accept or decline, accept_by \d+s left/);
  assert.match(out, /accept_by has passed: calling timeout\(7\)/);
  assert.match(out, /Timed out: the seller did not accept by accept_by\. You were refunded; the seller's record is unchanged\./);
  assert.match(out, /timeout tx: timeoutTx1/);
  assert.equal(r.outcome.kind, "timeout_refund");
  assert.equal(r.pass, false);
  const job = loadJob(dir);
  assert.equal(job.status, "closed");
  assert.equal(job.outcome, "timeout_refund");
  assert.equal(loadState(dir).spent_yocto, "0");
  assert.ok(!existsSync(receiptPaths(dir, "7").folder), "no receipt for a job without a live review");
});

test("timeout: a refused 'has not passed yet' (block time behind our clock) is retried", async () => {
  const { chain, clock, deps } = setup();
  let first = true;
  chain.beforeSend = async (req) => {
    if (req.methodName === "timeout" && first) {
      first = false;
      clock.t = T0 + 2 * MIN - 1000; // the chain still thinks it is before accept_by
    }
  };
  const r = await runHire(deps);
  assert.deepEqual(chain.sends.map((s) => s.methodName), ["timeout", "timeout"]);
  assert.equal(r.outcome.kind, "timeout_refund");
});

// --- replay ---------------------------------------------------------------------------------------

test("replay: the TEE is down after accept -> RECORDED run shown (never a receipt), then review_by timeout -> refund + fail", async () => {
  const { dir, chain, clock, deps, lines, recordedDir } = setup();
  // a recorded past run, as T-032 will ship it
  const key = PACK2.key;
  const rec = buildReceipt({
    job: { network: "testnet", contract: CONTRACT, job_id: 3, pack_id: "pack-2", buyer: "other.testnet", seller: DEMO_SELLER, commit_hash: commit(key, "5a".repeat(32)) },
    reveal: { K: canonicalJson(key), salt: "5a".repeat(32) },
    review: reviewResult(PASS_BODY, "3"),
    quote: { before: "0.030", after: "0.040" },
    txs: { reveal: "RecordedRevealTx" },
  });
  writeFileSync(join(recordedDir, "pack-2.json"), JSON.stringify(rec));
  const down = Object.assign(new Error("NEAR AI review returned HTTP 503."), { code: "TEE_UNAVAILABLE" });
  const r = await runHire({ ...deps, makeSeller: localSellerWith(chain, clock, async () => { throw down; }) });
  const out = text(lines);
  assert.match(out, /Seller could not review live \(tee_unavailable\): TEE_UNAVAILABLE/);
  assert.match(out, /RECORDED \(a past run, job 3; not your job, and no receipt is written for your job\)/);
  assert.match(out, /RECORDED grade: 5\/5 PASS; settle tx RecordedRevealTx/);
  assert.match(out, /RECORDED REVIEW AUTHENTIC \(offline\)/);
  assert.match(out, /Stage: accepted\. seller's signed review due by 2026-11-12T20:07:00\.000Z/);
  assert.deepEqual(chain.sends.map((s) => s.methodName), ["accept", "timeout"]);
  assert.match(out, /Timed out: no signed review by review_by\. You were refunded and the seller takes a fail\./);
  assert.equal(r.outcome.kind, "timeout_refund_fail");
  assert.equal(r.receiptPath, null);
  assert.ok(!existsSync(receiptPaths(dir, "7").receipt));
  assert.equal(loadJob(dir).status, "closed");
});

// --- hash mismatch refusal ----------------------------------------------------------------------

test("hash mismatch: the saved review is not the one the escrow stored -> REVIEW_MISMATCH, no reveal, no receipt", async () => {
  const { dir, chain, deps } = setup();
  const saved = reviewResult(PASS_BODY);
  const other = reviewResult(FAIL_BODY);
  // A seller that saves one review but submits another (or a stale review file).
  const makeSeller = () => ({
    async review({ saveReview }) {
      await chain.sendTx({ state: { account_id: DEMO_SELLER }, methodName: "accept", args: { job_id: "7" } });
      saveReview(saved);
      await chain.sendTx({ state: { account_id: DEMO_SELLER }, methodName: "submit_review", args: other.submit_args });
      return { mode: "live", review: saved, txs: {}, submit: "landed" };
    },
  });
  await assert.rejects(runHire({ ...deps, makeSeller }), { code: "REVIEW_MISMATCH" });
  assert.ok(!chain.sends.some((s) => s.methodName === "reveal"), "the key is never revealed");
  assert.ok(!existsSync(receiptPaths(dir, "7").receipt));
  assert.equal(loadJob(dir).status, "reviewed", "job stays live (not closed)");
});

// --- job_id validation --------------------------------------------------------------------------

test("job_id: only /^\\d{1,20}$/ up to u64::MAX reaches a path or an arg", () => {
  assert.equal(assertJobId("7"), "7");
  assert.equal(assertJobId("18446744073709551615"), "18446744073709551615");
  for (const bad of ["", "-1", "1e3", "7 ", "../7", "7/../../x", "18446744073709551616", "123456789012345678901", 7, null, undefined]) {
    assert.throws(() => assertJobId(bad), { code: "BAD_JOB_ID" }, JSON.stringify(bad));
    assert.throws(() => receiptPaths("/tmp/x", bad), { code: "BAD_JOB_ID" });
  }
  const p = receiptPaths("/home/u/.earned", "42");
  assert.equal(p.receipt, "/home/u/.earned/receipts/job-42.json");
  assert.equal(p.review, "/home/u/.earned/receipts/job-42.review.json");
});

test("job_id: a job file with a path-like id is refused before any network call", async () => {
  const { chain, deps } = setup({ jobId: "../../evil" });
  let calls = 0;
  await assert.rejects(runHire({ ...deps, fetch: async (...a) => (calls++, chain.fetch(...a)) }), { code: "BAD_JOB_ID" });
  assert.equal(calls, 0);
  assert.equal(chain.sends.length, 0);
});

// --- resume, lag, mismatch, closed ---------------------------------------------------------------

test("resume: a reveal sent by an earlier run is looked up by its tx hash and finished (receipt only for the checked body)", async () => {
  const { dir, chain, clock, deps, lines } = setup();
  // Run 1: the reveal result never comes back.
  chain.beforeSend = async (req) => {
    if (req.methodName === "reveal") throw new Error("socket hang up");
  };
  await assert.rejects(runHire({ ...deps, makeSeller: localSellerWith(chain, clock, async ({ job }) => reviewResult(PASS_BODY, String(job.id))) }), { code: "REVEAL_UNCONFIRMED" });
  const mid = loadJob(dir);
  assert.equal(mid.status, "revealing");
  assert.equal(mid.reveal_tx, "revealTx3");
  // It did land: replay it on the chain to get the outcome the lookup returns.
  chain.beforeSend = null;
  const landed = await chain.sendTx({ state: { account_id: BUYER }, methodName: "reveal", args: chain.sends[2].args });
  lines.length = 0;
  const r = await runHire({ ...deps, lookupTx: async ({ txHash }) => (txHash === "revealTx3" ? landed : null) });
  assert.equal(r.pass, true);
  assert.match(text(lines), /Earlier reveal tx revealTx3 landed/);
  assert.equal(loadJob(dir).status, "closed");
  assert.ok(existsSync(receiptPaths(dir, "7").receipt));
});

test("resume: a review file swapped after the checked reveal gets no receipt", async () => {
  const { dir, chain, clock, deps, lines } = setup();
  chain.beforeSend = async (req) => {
    if (req.methodName === "reveal") throw new Error("socket hang up");
  };
  await assert.rejects(runHire({ ...deps, makeSeller: localSellerWith(chain, clock, async ({ job }) => reviewResult(PASS_BODY, String(job.id))) }), { code: "REVEAL_UNCONFIRMED" });
  chain.beforeSend = null;
  const landed = await chain.sendTx({ state: { account_id: BUYER }, methodName: "reveal", args: chain.sends[2].args });
  const folder = receiptPaths(dir, "7").folder;
  for (const n of readdirSync(folder)) if (n.includes(".review")) writeFileSync(join(folder, n), JSON.stringify(reviewResult(FAIL_BODY)));
  lines.length = 0;
  const r = await runHire({ ...deps, lookupTx: async () => landed });
  assert.equal(r.receiptPath, null);
  assert.equal(r.pass, false);
  assert.match(text(lines), /No receipt: this CLI does not hold the live review/);
  assert.ok(!existsSync(receiptPaths(dir, "7").receipt));
  assert.equal(loadJob(dir).status, "closed");
});

test("pass graded but the payout failed: refunded, record unchanged, receipt written, no SEE PASS", async () => {
  const { dir, chain, clock, deps, lines } = setup();
  chain.beforeSend = async (req, hash) => {
    if (req.methodName !== "reveal") return null;
    const j = chain.job;
    chain.job = null;
    const base = { job_id: j.id, buyer: j.buyer, seller: j.seller };
    const ev = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: "earned_price", version: "0.1.0", event, data })}`;
    return { status: { SuccessValue: b64("false") }, transaction: { hash }, receipts_outcome: [{ outcome: { executor_id: CONTRACT, logs: [ev("reveal", { ...base, found: 5, total: 5, pass_min: 4, passed: true, outcome: "pass" })] } }, { outcome: { executor_id: CONTRACT, logs: [ev("payout_failed_refunded", { ...base, amount: j.price, kind: "settle" })] } }] };
  };
  const r = await runHire({ ...deps, makeSeller: localSellerWith(chain, clock, async ({ job }) => reviewResult(PASS_BODY, String(job.id))) });
  assert.equal(r.outcome.kind, "payout_failed_refunded");
  assert.equal(r.verify.ok, true);
  assert.equal(r.verify.checks[3].regrade.passed, true);
  assert.equal(r.pass, false);
  assert.ok(!text(lines).includes("SEE: step 3 PASS"));
  assert.match(text(lines), /payout to the seller failed, so you were refunded/);
  assert.equal(loadState(dir).spent_yocto, "0");
  assert.equal(loadJob(dir).status, "closed");
});

test("view lag after submit_review: the live review shows up late -> no RECORDED notice, reveal still runs", async () => {
  const { chain, clock, deps, lines } = setup();
  let hide = 0;
  const realFetch = chain.fetch;
  chain.fetch = async (url, init) => {
    const res = await realFetch(url, init);
    const p = JSON.parse(init.body).params;
    if (p.method_name !== "get_job" || !chain.job?.review || hide++ >= 8) return res;
    const body = await res.json();
    const v = JSON.parse(Buffer.from(body.result.result).toString());
    return { ok: true, json: async () => ({ ...body, result: { ...body.result, result: bytes({ ...v, review: null }) } }) };
  };
  const r = await runHire({ ...deps, fetch: chain.fetch, makeSeller: localSellerWith(chain, clock, async ({ job }) => reviewResult(PASS_BODY, String(job.id))) });
  assert.equal(r.pass, true);
  assert.ok(!text(lines).includes("RECORDED"));
});

test("view lag: get_job null right after create is read again, not taken as closed", async () => {
  const { chain, clock, deps } = setup();
  chain.nullReads = 2;
  const r = await runHire({ ...deps, makeSeller: localSellerWith(chain, clock, async ({ job }) => reviewResult(PASS_BODY, String(job.id))) });
  assert.equal(r.pass, true);
});

test("closed elsewhere: get_job stays null -> job file closed, outcome not invented", async () => {
  const { dir, chain, deps, lines } = setup();
  chain.job = null;
  const r = await runHire(deps);
  assert.equal(r.outcome, null);
  assert.equal(loadJob(dir).status, "closed");
  assert.equal(loadJob(dir).outcome, "closed_elsewhere");
  assert.match(text(lines), /did not see the closing tx/);
  assert.equal(chain.sends.length, 0);
});

test("job mismatch: the on-chain job's commit differs from the job file -> refused, nothing sent", async () => {
  const { chain, deps } = setup();
  chain.job.commit_hash = "00".repeat(32);
  await assert.rejects(runHire(deps), { code: "JOB_MISMATCH" });
  assert.equal(chain.sends.length, 0);
});

test("job states: no job, closed/failed job and unconfirmed create are refused before any tx", async () => {
  for (const status of ["closed", "failed"]) {
    const { deps } = setup({ status });
    await assert.rejects(runHire(deps), { code: "NO_OPEN_JOB" });
  }
  const { deps } = setup({ status: "unconfirmed" });
  await assert.rejects(runHire(deps), { code: "JOB_UNCONFIRMED" });
  const empty = mkdtempSync(join(tmpdir(), "earned-hire-"));
  await assert.rejects(runHire({ ...deps, dir: empty }), { code: "NO_BUYER" });
});

test("reveal rejected by the escrow: nothing moved, job stays live (status reviewed), clear message", async () => {
  const { dir, chain, clock, deps } = setup();
  chain.beforeSend = async (req, hash) => {
    if (req.methodName !== "reveal") return null;
    return { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: Earned Price: key and salt do not match the job's commit_hash. No funds moved." } } } } }, transaction: { hash }, receipts_outcome: [] };
  };
  await assert.rejects(runHire({ ...deps, makeSeller: localSellerWith(chain, clock, async ({ job }) => reviewResult(PASS_BODY, String(job.id))) }), (e) => e.code === "REVEAL_REJECTED" && /No funds moved/.test(e.message) && /pays the seller/.test(e.message));
  assert.equal(loadJob(dir).status, "reviewed");
  assert.ok(!existsSync(receiptPaths(dir, "7").receipt));
});

// --- units ---------------------------------------------------------------------------------------

test("parseHireArgs: no args or --local-seller once; anything else is USAGE", () => {
  assert.deepEqual(parseHireArgs([]), { localSeller: false });
  assert.deepEqual(parseHireArgs(["--local-seller"]), { localSeller: true });
  for (const bad of [["--local-seller", "--local-seller"], ["2"], ["--pack", "3"], ["--yes"]]) assert.throws(() => parseHireArgs(bad), { code: "USAGE" });
  assert.ok(new HireError("X", "y") instanceof Error);
});

test("parseTxOutcome: events only from the escrow's receipts; outcomeOf reads the closing events for this job only", () => {
  const ev = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: "earned_price", event, data })}`;
  const o = {
    status: { SuccessValue: b64("true") },
    transaction: { hash: "H" },
    receipts_outcome: [
      { outcome: { executor_id: "evil.testnet", logs: [ev("reveal", { job_id: "7", outcome: "fail" }), ev("refund", { job_id: "7", buyer: BUYER, amount: "1" })] } },
      { outcome: { executor_id: CONTRACT, logs: ["not an event", ev("reveal", { job_id: "7", outcome: "pass", found: 5, total: 5, passed: true }), ev("payout", { job_id: "8", amount: "1" })] } },
      { outcome: { executor_id: CONTRACT, logs: [ev("payout", { job_id: "7", buyer: BUYER, amount: "30" })] } },
    ],
  };
  const p = parseTxOutcome(o, CONTRACT);
  assert.equal(p.failure, null);
  assert.equal(p.events.length, 3);
  assert.equal(outcomeOf(p.events, "7", BUYER).kind, "settled");
  assert.equal(outcomeOf(p.events, "9", BUYER), null);
  assert.throws(() => parseTxOutcome({ transaction: { hash: "H" } }, CONTRACT), { code: "BAD_TX_RESULT" });
});

test("stageLine: one countdown per stage (accept_by, review_by, reveal_deadline)", () => {
  const v = { status: "open", accept_by_ns: msToNs(T0 + 2 * MIN), review_by_ns: msToNs(T0 + 7 * MIN), reveal_deadline_ns: msToNs(T0 + 12 * MIN), review: null };
  assert.match(stageLine(v, T0), /accept_by, 2m 00s left/);
  assert.match(stageLine({ ...v, status: "accepted" }, T0), /review_by, 7m 00s left/);
  assert.match(stageLine({ ...v, status: "accepted", review: {} }, T0 + 13 * MIN), /reveal_deadline, passed 1m 00s ago/);
});

test("local seller: refused accept and TEE errors are replays; keys never appear in messages", async () => {
  assert.equal(replayReason("TEE_UNAVAILABLE"), "tee_unavailable");
  assert.equal(replayReason("SIGNATURE_UNAVAILABLE"), "tee_unavailable");
  assert.equal(replayReason("DEADLINE_EXCEEDED"), "timeout");
  assert.equal(replayReason("SIGNER_NOT_ALLOWLISTED"), "review_failed");
  const view = { id: "7", status: "open" };
  const refused = makeLocalSeller({
    sellerState: { account_id: DEMO_SELLER, private_key: SELLER_PRIV },
    contractId: CONTRACT,
    sendTx: async () => ({ status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: Earned Price: the accept deadline has passed" } } } } }, transaction: { hash: "A1" } }),
    getJob: async () => view,
    getSigners: async () => [signer],
    reviewJob: async () => assert.fail("no review after a refused accept"),
    apiKey: API_KEY,
    sleep: async () => {},
  });
  const r1 = await refused.review({ jobId: "7", view, pack: PACK2, saveReview: () => {}, say: () => {} });
  assert.equal(r1.mode, "replay");
  assert.equal(r1.reason, "chain_refused");
  const leaky = makeLocalSeller({
    sellerState: { account_id: DEMO_SELLER, private_key: SELLER_PRIV },
    contractId: CONTRACT,
    sendTx: async () => {
      throw Object.assign(new Error(`bad key ${SELLER_PRIV} with ${API_KEY}`), { notSent: true });
    },
    getJob: async () => view,
    getSigners: async () => [signer],
    reviewJob: async () => assert.fail("unreachable"),
    apiKey: API_KEY,
    sleep: async () => {},
  });
  const r2 = await leaky.review({ jobId: "7", view, pack: PACK2, saveReview: () => {}, say: () => {} });
  assert.equal(r2.reason, "chain_unavailable");
  assert.ok(!r2.message.includes(SELLER_PRIV) && !r2.message.includes(API_KEY));
});

test("verify --json (T-029 N-1): C1 and bidi characters are escaped and the output stays the same JSON", async () => {
  const raw = '{\n  "a": "x\u202ey\u0085z\u2028"\n}';
  const safe = printableJson(raw);
  assert.ok(!/[\u0085\u202e\u2028]/u.test(safe));
  assert.match(safe, /\\u202e/);
  assert.deepEqual(JSON.parse(safe), JSON.parse(raw));
  // end to end: runVerify --json still prints valid JSON
  const dir = mkdtempSync(join(tmpdir(), "earned-vjson-"));
  mkdirSync(dir, { recursive: true });
  const r = readJson("test/fixtures/receipt-t003-sample-0.json");
  const file = join(dir, "r.json");
  writeFileSync(file, JSON.stringify(r));
  const got = [];
  await runVerify({ ...parseVerifyArgs([file, "--json"]), out: (l) => got.push(l) });
  assert.equal(typeof JSON.parse(got.join("")).verdict, "string");
});

// --- review fix round (t031-code.md, t031-security.md) --------------------------------------------

const liveSeller = (chain, clock, body = PASS_BODY) => localSellerWith(chain, clock, async ({ job }) => reviewResult(body, String(job.id)));

/** A seller that accepts, saves `saved` and submits `submitted` (a stale or swapped review file). */
const swappingSeller = (chain, saved, submitted) => () => ({
  async review({ saveReview }) {
    await chain.sendTx({ state: { account_id: DEMO_SELLER }, methodName: "accept", args: { job_id: "7" } });
    if (saved) saveReview(saved);
    await chain.sendTx({ state: { account_id: DEMO_SELLER }, methodName: "submit_review", args: submitted.submit_args });
    return { mode: "live", review: saved, txs: {}, submit: "landed" };
  },
});

test("H-1: a mismatched review past reveal_deadline still closes: timeout pays the seller, no reveal, job closed", async () => {
  const { dir, chain, clock, deps } = setup();
  await assert.rejects(runHire({ ...deps, makeSeller: swappingSeller(chain, reviewResult(PASS_BODY), reviewResult(FAIL_BODY)) }), { code: "REVIEW_MISMATCH" });
  clock.t = T0 + 60 * MIN;
  const r = await runHire(deps);
  assert.equal(r.outcome.kind, "timeout_paid_seller");
  assert.ok(!chain.sends.some((x) => x.methodName === "reveal"));
  assert.equal(loadJob(dir).status, "closed");
  assert.ok(!existsSync(receiptPaths(dir, "7").receipt));
});

test("H-1: an on-chain review with no local body past reveal_deadline still closes (timeout pays the seller)", async () => {
  const { dir, chain, clock, deps } = setup();
  await assert.rejects(runHire({ ...deps, makeSeller: swappingSeller(chain, null, reviewResult(PASS_BODY)) }), { code: "REVIEW_BODY_MISSING" });
  clock.t = T0 + 60 * MIN;
  const r = await runHire(deps);
  assert.equal(r.outcome.kind, "timeout_paid_seller");
  assert.equal(loadJob(dir).status, "closed");
});

/** Run 1: the reveal lands on-chain but no result comes back (REVEAL_UNCONFIRMED). Returns the landed outcome. */
async function revealLandsUnseen({ chain, clock, deps }) {
  const real = chain.sendTx;
  let landed = null;
  let stale = null;
  chain.sendTx = async (req) => {
    if (req.methodName === "reveal") stale = structuredClone(chain.job);
    const o = await real(req);
    if (req.methodName !== "reveal") return o;
    landed = o;
    throw new Error("socket hang up");
  };
  await assert.rejects(runHire({ ...deps, sendTx: chain.sendTx, makeSeller: liveSeller(chain, clock) }), { code: "REVEAL_UNCONFIRMED" });
  chain.sendTx = real;
  revealLandsUnseen.stale = stale;
  return landed;
}

test("M-1: lookup fails while a lagging RPC still shows the job, then it reads null -> still CLOSE_TX_UNCONFIRMED, never closed_elsewhere", async () => {
  const ctx = setup();
  const { dir, chain, deps } = ctx;
  await revealLandsUnseen(ctx);
  const stale = revealLandsUnseen.stale;
  let staleReads = 1;
  const realFetch = chain.fetch;
  const lagging = async (url, init) => {
    const p = JSON.parse(init.body).params;
    if (p.method_name === "get_job" && staleReads-- > 0) return { ok: true, json: async () => ({ jsonrpc: "2.0", id: "earned", result: { block_hash: "B", block_height: 1, logs: [], result: bytes(stale) } }) };
    return realFetch(url, init);
  };
  await assert.rejects(runHire({ ...deps, fetch: lagging, lookupTx: async () => null }), { code: "CLOSE_TX_UNCONFIRMED" });
  assert.notEqual(loadJob(dir).status, "closed");
  assert.equal(loadJob(dir).reveal_tx, "revealTx3", "the landed hash is kept");
  assert.equal(chain.sends.filter((x) => x.methodName === "reveal").length, 1);
});

test("M-1 / sec L-2 PoC: reveal landed but the lookup fails -> CLOSE_TX_UNCONFIRMED, job.json untouched, no second reveal; later lookup gives the receipt", async () => {
  const ctx = setup();
  const { dir, chain, deps, lines } = ctx;
  const landed = await revealLandsUnseen(ctx);
  const before = readFileSync(join(dir, "job.json"), "utf8");
  await assert.rejects(runHire({ ...deps, lookupTx: async () => null }), { code: "CLOSE_TX_UNCONFIRMED" });
  assert.equal(readFileSync(join(dir, "job.json"), "utf8"), before, "job file unchanged");
  assert.equal(chain.sends.filter((x) => x.methodName === "reveal").length, 1, "never a second reveal");
  // RPC catches up: null twice, then the outcome.
  let n = 0;
  lines.length = 0;
  const r = await runHire({ ...deps, lookupTx: async () => (++n > 2 ? landed : null) });
  assert.equal(r.pass, true);
  assert.ok(existsSync(receiptPaths(dir, "7").receipt));
  assert.equal(loadJob(dir).status, "closed");
});

test("M-2: interrupted after the reveal landed but before the receipt -> job not closed; the next run writes the receipt", async () => {
  const { dir, chain, clock, deps } = setup();
  const crashOut = (l) => {
    if (l.startsWith("Next quote")) throw new Error("killed");
  };
  await assert.rejects(runHire({ ...deps, out: crashOut, makeSeller: liveSeller(chain, clock) }), /killed/);
  const mid = loadJob(dir);
  assert.equal(mid.status, "revealing", "still resumable, not closed");
  assert.ok(!existsSync(receiptPaths(dir, "7").receipt));
  const revealTx = mid.reveal_tx;
  const r = await runHire({ ...deps, lookupTx: async ({ txHash }) => (txHash === revealTx ? chain.outcomes[revealTx] : null) });
  assert.equal(r.pass, true);
  assert.ok(existsSync(receiptPaths(dir, "7").receipt));
  assert.equal(loadJob(dir).status, "closed");
});

test("M-3 / N-2: settled + authentic regrade PASS but the signer is not in the trust anchors -> verify not ok, no SEE PASS", async () => {
  const { chain, clock, deps, lines } = setup();
  const r = await runHire({ ...deps, trust: TRUST, makeSeller: liveSeller(chain, clock) });
  assert.equal(r.outcome.kind, "settled");
  assert.equal(r.verify.ok, false);
  assert.equal(r.pass, false);
  assert.ok(!text(lines).includes("SEE: step 3 PASS"));
});

test("M-3: escrow event says pass + payout but our regrade fails -> warning, no SEE PASS", async () => {
  const { chain, clock, deps, lines } = setup();
  chain.beforeSend = async (req, hash) => {
    if (req.methodName !== "reveal") return null;
    const j = chain.job;
    chain.job = null;
    const base = { job_id: j.id, buyer: j.buyer, seller: j.seller };
    const ev = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: "earned_price", event, data })}`;
    return { status: { SuccessValue: b64("true") }, transaction: { hash }, receipts_outcome: [{ outcome: { executor_id: CONTRACT, logs: [ev("reveal", { ...base, found: 5, total: 5, pass_min: 4, passed: true, outcome: "pass" }), ev("payout", { ...base, amount: j.price, kind: "settle" })] } }] };
  };
  const r = await runHire({ ...deps, makeSeller: liveSeller(chain, clock, FAIL_BODY) });
  assert.equal(r.outcome.kind, "settled");
  assert.equal(r.verify.ok, true);
  assert.equal(r.pass, false);
  assert.match(text(lines), /WARNING: the escrow graded 5\/5 \(pass\); this CLI's regrade differs/);
  assert.ok(!text(lines).includes("SEE: step 3 PASS"));
});

test("M-3: a checked review whose reveal was refused, then closed by timeout -> no receipt (receipts only after a landed reveal)", async () => {
  const { dir, chain, clock, deps } = setup();
  let refuse = true;
  chain.beforeSend = async (req, hash) => {
    if (req.methodName !== "reveal" || !refuse) return null;
    refuse = false;
    return { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: Earned Price: the reveal deadline has passed. No funds moved." } } } } }, transaction: { hash }, receipts_outcome: [] };
  };
  await assert.rejects(runHire({ ...deps, makeSeller: liveSeller(chain, clock) }), { code: "REVEAL_REJECTED" });
  assert.equal(typeof loadJob(dir).review_checked_sha256, "string");
  clock.t = T0 + 60 * MIN;
  const r = await runHire(deps);
  assert.equal(r.outcome.kind, "timeout_paid_seller");
  assert.equal(r.receiptPath, null);
  assert.ok(!existsSync(receiptPaths(dir, "7").receipt));
});

for (const [field, value] of [["request_sha256", "11".repeat(32)], ["response_sha256", "22".repeat(32)], ["signing_address", "0x" + "33".repeat(20)], ["model", "other/model"], ["request_sha256", undefined]]) {
  test(`M-3 / L-4: saved review with a different tee.${field}${value === undefined ? " (missing)" : ""} -> REVIEW_MISMATCH, no reveal`, async () => {
    const { chain, deps } = setup();
    const real = reviewResult(PASS_BODY);
    const saved = structuredClone(real);
    if (value === undefined) delete saved.tee[field];
    else saved.tee[field] = value;
    await assert.rejects(runHire({ ...deps, makeSeller: swappingSeller(chain, saved, real) }), { code: "REVIEW_MISMATCH" });
    assert.ok(!chain.sends.some((x) => x.methodName === "reveal"));
  });
}

for (const [field, value] of [["buyer", "someone-else.testnet"], ["price", (40n * YOCTO_PER_MNEAR).toString()]]) {
  test(`M-3 / L-6: on-chain ${field} differs from the job file -> JOB_MISMATCH, nothing sent`, async () => {
    const { chain, deps } = setup();
    chain.job[field] = value;
    await assert.rejects(runHire(deps), { code: "JOB_MISMATCH" });
    assert.equal(chain.sends.length, 0);
  });
}

test("M-3: outcomeOf never credits a refund to another buyer; the release is capped at the price", async () => {
  const ev = (event, data) => ({ event, data });
  const events = [ev("timeout", { job_id: "7", reason: "not_accepted" }), ev("refund", { job_id: "7", buyer: "other.testnet", amount: "30" })];
  assert.equal(outcomeOf(events, "7", BUYER).refundYocto, null);
  const { dir, chain, deps } = setup({ spent: (50n * YOCTO_PER_MNEAR).toString() });
  chain.beforeSend = async (req, hash) => {
    if (req.methodName !== "timeout" || req.state.account_id !== BUYER) return null;
    chain.job = null;
    const e = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: "earned_price", event, data })}`;
    return { status: { SuccessValue: b64("false") }, transaction: { hash }, receipts_outcome: [{ outcome: { executor_id: CONTRACT, logs: [e("timeout", { job_id: "7", reason: "not_accepted" }), e("refund", { job_id: "7", buyer: BUYER, amount: (40n * YOCTO_PER_MNEAR).toString() })] } }] };
  };
  await runHire(deps);
  assert.equal(loadState(dir).spent_yocto, (20n * YOCTO_PER_MNEAR).toString(), "released 30 (the price), not 40");
});

test("M-3: timeout is only sent after the stage deadline plus the clock margin", async () => {
  const { chain, clock, deps } = setup();
  let sentAt = null;
  chain.beforeSend = async (req) => {
    if (req.methodName === "timeout" && sentAt === null) sentAt = clock.t;
  };
  await runHire(deps);
  assert.ok(sentAt > T0 + 2 * MIN + 3000, `sent at +${sentAt - T0} ms`);
});

test("M-4 PoC: review landed before review_by but showed late -> refused timeout re-reads get_job and reveals (pass)", async () => {
  const { chain, clock, deps } = setup();
  chain.hideReviewReads = 1e9;
  chain.beforeSend = async (req) => {
    if (req.methodName === "timeout") chain.hideReviewReads = 0; // the view catches up
  };
  const r = await runHire({ ...deps, makeSeller: liveSeller(chain, clock) });
  assert.deepEqual(chain.sends.map((x) => x.methodName), ["accept", "submit_review", "timeout", "reveal"]);
  assert.equal(r.pass, true);
});

test("M-5: a second review in a later run never overwrites the body whose submit landed; reveal uses the on-chain one", async () => {
  const { dir, chain, clock, deps } = setup();
  // Run 1: R1 submitted (it landed) but the result is lost and the run dies.
  const real = chain.sendTx;
  chain.sendTx = async (req) => {
    const o = await real(req);
    if (req.methodName === "submit_review") throw new Error("socket hang up");
    return o;
  };
  const dieOn = (l) => {
    if (/submit_review unknown/.test(l)) throw new Error("killed");
  };
  await assert.rejects(runHire({ ...deps, sendTx: chain.sendTx, out: dieOn, makeSeller: localSellerWith(chain, clock, async () => reviewResult(PASS_BODY)) }), /killed/);
  chain.sendTx = real;
  // Run 2: the view still hides the review, so the seller reviews again (R2), and its submit is refused.
  chain.hideReviewReads = 3;
  const r = await runHire({ ...deps, makeSeller: localSellerWith(chain, clock, async () => reviewResult(FAIL_BODY)) });
  assert.equal(r.pass, true);
  const receipt = JSON.parse(readFileSync(receiptPaths(dir, "7").receipt, "utf8"));
  assert.equal(receipt.tee.response_body, PASS_BODY);
  assert.equal(readdirSync(receiptPaths(dir, "7").folder).filter((n) => /review-[0-9a-f]{16}\.json$/.test(n)).length, 2);
});

test("sec L-1 PoC: the error line escapes terminal control bytes and cuts key-shaped text", async () => {
  const { chain, clock, deps } = setup();
  chain.beforeSend = async (req, hash) => {
    if (req.methodName !== "reveal") return null;
    return { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: x\x1b[2J\x1b[H\x1b[32mSEE: step 3 PASS\x1b[8m" } } } } }, transaction: { hash }, receipts_outcome: [] };
  };
  const err = await runHire({ ...deps, makeSeller: liveSeller(chain, clock) }).catch((e) => e);
  assert.equal(err.code, "REVEAL_REJECTED");
  const line = errorLine(err, "x");
  assert.ok(!line.includes("\x1b"), line);
  assert.match(line, /\\u001b\[2J/);
  const secret = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi3vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"; // base58, private-key length
  const leak = errorLine(Object.assign(new Error(`rpc said \x1b]0;pwned\x1b\\ key ed25519:${secret}`), { code: "REVEAL_NOT_SENT" }), "x");
  assert.ok(!leak.includes("\x1b"));
  assert.ok(!leak.includes(secret) && leak.includes("ed25519:[redacted]"), leak);
  assert.match(errorLine(Object.assign(new Error("pk ed25519:4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"), { code: "X" }), ""), /4vJ9JU1b/, "public keys are kept");
  assert.equal(errorLine(new Error("boom"), "hire failed"), "error UNEXPECTED: hire failed");
});
