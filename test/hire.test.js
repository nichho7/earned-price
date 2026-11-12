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
import { FAIL_LINE, classifyClose, recordDelta, step4Report } from "../cli/step4.js";
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

function reviewResult(responseBody = PASS_BODY, jobId = "7", request = PACK2_REQUEST) {
  const text = `${MODEL}:${sha256Hex(request)}:${sha256Hex(responseBody)}`;
  const tee = {
    model: MODEL,
    request_sha256: sha256Hex(request),
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
    request_body: request,
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
function makeChain({ jobId = "7", sealed, price = 30n * YOCTO_PER_MNEAR, record = { passes: 0, fails: 0, unique_buyers: 0, jobs: 0 }, passBuyers = [], packId = "pack-2", clock }) {
  const chain = {
    record: { ...record },
    passBuyers: new Set(passBuyers), // the contract's pass_buyers: P counts a buyer's first pass only
    job: {
      id: jobId,
      buyer: BUYER,
      seller: DEMO_SELLER,
      price: price.toString(),
      commit_hash: sealed.commit_hash,
      pack_id: packId,
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
    // Block history (review R-1): every state change makes a block; views can be pinned to one.
    height: 0,
    blocks: new Map(),
    head: null,
    staleFinal: null, // a block hash: finality=final get_record/quote reads answer from it (view lag)
    unknownBlockReads: 0, // block-pinned reads answer UNKNOWN_BLOCK this many times first
  };
  chain.snap = () => {
    const h = `B${++chain.height}`;
    chain.blocks.set(h, { record: { ...chain.record }, job: chain.job ? { ...chain.job } : null });
    chain.head = h;
    return h;
  };
  chain.snap();
  const quoteOf = (r) => Math.min(100, Math.max(25, 30 + 10 * r.unique_buyers - 5 * r.fails));
  const ev = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: "earned_price", version: "0.1.0", event, data })}`;
  // logs[i] is one receipt's logs; blocks[i] the block it executed in (default: the head after the tx).
  const ok = (hash, value, logs, signerId, blocks = []) => ({
    status: { SuccessValue: b64(JSON.stringify(value ?? null)) },
    transaction: { hash },
    transaction_outcome: { id: hash, outcome: { executor_id: signerId, logs: [] } },
    receipts_outcome: logs.map((l, i) => ({ id: `${hash}-r${i}`, block_hash: blocks[i] ?? chain.snap(), outcome: { executor_id: CONTRACT, logs: l } })),
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
    if (p.block_id !== undefined) {
      // A block-pinned read: the state as of that block, or UNKNOWN_BLOCK (ahead of this node).
      const b = chain.blocks.get(p.block_id);
      if (!b || chain.unknownBlockReads > 0) {
        if (b) chain.unknownBlockReads--;
        return { ok: true, json: async () => ({ jsonrpc: "2.0", id: "earned", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" } } }) };
      }
      if (p.method_name === "get_job") value = b.job && args.id === b.job.id ? b.job : null;
      else if (p.method_name === "get_record") value = b.record;
      else if (p.method_name === "quote") value = (BigInt(quoteOf(b.record)) * YOCTO_PER_MNEAR).toString();
      else throw new Error(`unexpected pinned view ${p.method_name}`);
      return { ok: true, json: async () => ({ jsonrpc: "2.0", id: "earned", result: { block_hash: p.block_id, block_height: 1, logs: [], result: bytes(value) } }) };
    }
    if (chain.staleFinal && (p.method_name === "get_record" || p.method_name === "quote")) {
      const b = chain.blocks.get(chain.staleFinal);
      value = p.method_name === "get_record" ? b.record : (BigInt(quoteOf(b.record)) * YOCTO_PER_MNEAR).toString();
      return { ok: true, json: async () => ({ jsonrpc: "2.0", id: "earned", result: { block_hash: chain.staleFinal, block_height: 1, logs: [], result: bytes(value) } }) };
    }
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
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: "earned", result: { block_hash: chain.head, block_height: 1, logs: [], result: bytes(value) } }) };
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
      chain.snap();
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
        const closed = chain.snap(); // the reveal receipt: job deleted, record not written yet
        const transfer = chain.snap();
        await chain.betweenCloseAndPayout?.();
        chain.record.passes++;
        if (!chain.passBuyers.has(j.buyer)) {
          chain.passBuyers.add(j.buyer);
          chain.record.unique_buyers++;
        }
        chain.record.jobs++;
        return ok(hash, true, [[reveal], [], [ev("payout", { ...base, amount: j.price, kind: "settle" })]], who, [closed, transfer, chain.snap()]);
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
function setup({ jobId = "7", spent, status = "open", record, pack = "2", priceMilli = 30n, passBuyers, noJob = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "earned-hire-"));
  const price = priceMilli * YOCTO_PER_MNEAR;
  saveState(dir, { version: 1, network: "testnet", account_id: BUYER, public_key: "ed25519:FakePublicKey11111111111111111111111111111111", private_key: PRIV, status: "created", spent_yocto: spent ?? price.toString(), created_at: "2026-11-12T00:00:00Z" });
  const packData = loadPack(pack);
  const sealed = sealPick(packData, pack, SALT);
  if (!noJob) saveJob(dir, { version: 1, network: "testnet", contract: CONTRACT, buyer: BUYER, seller: DEMO_SELLER, pack_id: sealed.pack_id, pack_hash: packData.hash, commit_hash: sealed.commit_hash, K: sealed.K, salt: sealed.salt, price_yocto: price.toString(), status, job_id: jobId, create_tx: "CreateTx111" });
  const clock = { t: T0 + 5000, now() { return this.t; } };
  const chain = makeChain({ jobId: /^\d+$/.test(jobId) ? jobId : "7", sealed, price, clock, record, passBuyers, packId: sealed.pack_id });
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
  assert.deepEqual(parseHireArgs(["--pack", "3"]), { localSeller: false, pack: "3" });
  assert.deepEqual(parseHireArgs(["--local-seller", "--pack", "3"]), { localSeller: true, pack: "3" });
  for (const bad of [["--local-seller", "--local-seller"], ["2"], ["--pack"], ["--pack", "4"], ["--pack", "3", "--pack", "3"], ["--pack", "--local-seller"], ["--rigged"], ["--pack", "3", "--rigged"], ["--yes"]]) {
    assert.throws(() => parseHireArgs(bad), { code: "USAGE" });
  }
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
  const landed = await revealLandsUnseen(ctx);
  const stale = revealLandsUnseen.stale;
  let staleReads = 1;
  const realFetch = chain.fetch;
  const lagging = async (url, init) => {
    const p = JSON.parse(init.body).params;
    if (p.method_name === "get_job" && staleReads-- > 0) return { ok: true, json: async () => ({ jsonrpc: "2.0", id: "earned", result: { block_hash: "B", block_height: 1, logs: [], result: bytes(stale) } }) };
    return realFetch(url, init);
  };
  await assert.rejects(runHire({ ...deps, fetch: lagging, lookupTx: async () => null }), { code: "CLOSE_TX_UNCONFIRMED" });
  assert.equal(loadJob(dir).status, "revealing", "re-check sec N-1: status never moves backward");
  assert.equal(loadJob(dir).reveal_tx, "revealTx3", "the landed hash is kept");
  assert.equal(chain.sends.filter((x) => x.methodName === "reveal").length, 1);
  // re-check R-1 / PROBE-A / sec R1: a later run with a working lookup finishes it.
  let lookups = 0;
  const r = await runHire({ ...deps, lookupTx: async () => (lookups++, landed) });
  assert.ok(lookups > 0);
  assert.equal(r.pass, true);
  assert.ok(existsSync(receiptPaths(dir, "7").receipt));
  assert.equal(loadJob(dir).status, "closed");
});

test("re-check R-1: a job saved back to 'reviewed' with a pending reveal hash is still looked up (not stuck on CLOSE_TX_UNCONFIRMED)", async () => {
  const ctx = setup();
  const { dir, deps } = ctx;
  const landed = await revealLandsUnseen(ctx);
  saveJob(dir, { ...loadJob(dir), status: "reviewed" }); // as a 912207e run left it
  const r = await runHire({ ...deps, lookupTx: async () => landed });
  assert.equal(r.pass, true);
  assert.equal(loadJob(dir).status, "closed");
});

/** F-1 setup: a reveal hash that never landed (signed, never broadcast) plus a timeout that landed unseen. */
async function ghostRevealThenTimeoutUnseen({ dir, chain, clock, deps }) {
  await assert.rejects(runHire({ ...deps, makeSeller: swappingSeller(chain, reviewResult(PASS_BODY), reviewResult(FAIL_BODY)) }), { code: "REVIEW_MISMATCH" });
  saveJob(dir, { ...loadJob(dir), reveal_tx: "ghostReveal", reveal_txs: ["ghostReveal"] }); // signed, never broadcast
  clock.t = T0 + 60 * MIN;
  const real = chain.sendTx;
  let landed = null;
  chain.sendTx = async (req) => {
    const o = await real(req);
    if (req.methodName !== "timeout") return o;
    landed = o;
    throw new Error("socket hang up");
  };
  await runHire({ ...deps, sendTx: chain.sendTx, lookupTx: async () => null }).catch((e) => e);
  chain.sendTx = real;
  assert.ok(landed, "the timeout landed on-chain");
  return landed;
}

test("T-061 / T-031 sec F-1 probe Z: an unlanded reveal hash does not block the lookup of a landed timeout", async () => {
  const ctx = setup();
  const { dir, chain, deps } = ctx;
  const landed = await ghostRevealThenTimeoutUnseen(ctx);
  const tHash = landed.transaction.hash;
  const mid = loadJob(dir);
  assert.equal(mid.status, "timing_out");
  assert.deepEqual(mid.timeout_txs, [tHash]);
  const sendsBefore = chain.sends.length;
  const looked = new Set();
  const r = await runHire({ ...deps, lookupTx: async ({ txHash }) => (looked.add(txHash), txHash === tHash ? landed : null) });
  assert.equal(r.outcome.kind, "timeout_paid_seller", "finished from the landed timeout");
  assert.ok(looked.has("ghostReveal") && looked.has(tHash), "both kinds looked up");
  assert.equal(chain.sends.length, sendsBefore, "nothing re-sent");
  assert.ok(!chain.sends.some((x) => x.methodName === "reveal"), "no reveal ever went out");
  assert.equal(loadJob(dir).status, "closed");
  assert.ok(!existsSync(receiptPaths(dir, "7").receipt), "a timeout writes no receipt");
  await assert.rejects(runHire({ ...deps, lookupTx: async () => landed }), { code: "NO_OPEN_JOB" }, "nothing settles twice");
});

test("T-061: both an unlanded reveal and an unseen timeout unknown -> CLOSE_TX_UNCONFIRMED naming both hashes, status timing_out, nothing sent", async () => {
  const ctx = setup();
  const { dir, chain, deps } = ctx;
  const landed = await ghostRevealThenTimeoutUnseen(ctx);
  const tHash = landed.transaction.hash;
  const sendsBefore = chain.sends.length;
  const err = await runHire({ ...deps, lookupTx: async () => null }).catch((e) => e);
  assert.equal(err.code, "CLOSE_TX_UNCONFIRMED");
  assert.match(err.message, /ghostReveal/);
  assert.ok(err.message.includes(tHash), "the timeout hash is named too");
  assert.equal(chain.sends.length, sendsBefore, "nothing sent");
  const job = loadJob(dir);
  assert.equal(job.status, "timing_out", "status does not regress to revealing");
  assert.deepEqual(job.reveal_txs, ["ghostReveal"]);
  assert.deepEqual(job.timeout_txs, [tHash]);
});

test("re-check X3: a second reveal refused with 'no open job' keeps the earlier landed hash -> CLOSE_TX_UNCONFIRMED, then the receipt", async () => {
  const ctx = setup();
  const { dir, chain, deps } = ctx;
  const landed = await revealLandsUnseen(ctx);
  const stale = revealLandsUnseen.stale;
  let staleReads = 2; // resumeClosing's read and the main loop's read still show the job
  const realFetch = chain.fetch;
  const lagging = async (url, init) => {
    const p = JSON.parse(init.body).params;
    if (p.method_name === "get_job" && staleReads-- > 0) return { ok: true, json: async () => ({ jsonrpc: "2.0", id: "earned", result: { block_hash: "B", block_height: 1, logs: [], result: bytes(stale) } }) };
    return realFetch(url, init);
  };
  await assert.rejects(runHire({ ...deps, fetch: lagging, lookupTx: async () => null }), { code: "CLOSE_TX_UNCONFIRMED" });
  const reveals = chain.sends.filter((x) => x.methodName === "reveal");
  assert.equal(reveals.length, 2, "the lagging view let a second reveal go out");
  const mid = loadJob(dir);
  assert.equal(mid.status, "revealing");
  assert.deepEqual(mid.reveal_txs, ["revealTx3"], "the refused hash is dropped, the landed one kept");
  const r = await runHire({ ...deps, lookupTx: async ({ txHash }) => (txHash === "revealTx3" ? landed : null) });
  assert.equal(r.pass, true);
  assert.ok(existsSync(receiptPaths(dir, "7").receipt));
});

test("re-check L-3: a refused submit_review falls back to the RECORDED replay, then the review_by timeout refunds", async () => {
  const { chain, clock, deps, lines } = setup();
  chain.beforeSend = async (req, hash) => {
    if (req.methodName !== "submit_review") return null;
    return { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: Earned Price: signing_address is not an allowlisted NEAR AI TEE signer. Nothing stored." } } } } }, transaction: { hash }, receipts_outcome: [] };
  };
  const r = await runHire({ ...deps, makeSeller: liveSeller(chain, clock) });
  const out = text(lines);
  assert.match(out, /Seller's submit_review refused: Earned Price: signing_address is not an allowlisted/);
  assert.match(out, /RECORDED: no recorded live run of pack-2/);
  assert.equal(r.outcome.kind, "timeout_refund_fail");
  assert.equal(r.receiptPath, null);
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

// --- step 4 (S-023 / T-032): `earned hire --pack 3`, the same buyer again ------------------------

const PACK3 = loadPack("3");
const PACK3_REQUEST = buildReviewRequest(PACK3.reviewFiles);
// A real recorded pack-3 TEE answer (round 4, run 1): our regrade gives 4/5, B5 missed. The tests
// read the grade from the regrade, as the CLI does; nothing in the CLI knows "4/5".
const PACK3_PASS_BODY = readJson("packs/results/round-4/raw/pack-3-run01.json").response_body;
const PACK3_FAIL_BODY = JSON.stringify({ id: "chatcmpl-fail-3", created: 1794398261, model: MODEL, choices: [{ message: { role: "assistant", content: JSON.stringify({ findings: [] }) } }] });
// After step 3 (pack 2 passed, paid 0.030): one pass from this buyer, quote 0.040.
const AFTER_STEP3 = { passes: 1, fails: 0, unique_buyers: 1, jobs: 1 };
const step4Setup = (over = {}) => setup({ pack: "3", priceMilli: 40n, record: AFTER_STEP3, passBuyers: [BUYER], ...over });
const pack3Seller = (chain, clock, body) => localSellerWith(chain, clock, async ({ job }) => reviewResult(body, String(job.id), PACK3_REQUEST));

test("step 4 repeat pass: per-bug grade from the regrade (4/5, B5 missed), settle tx, quote holds 0.040 with P/passes/F, fail line, SEE: step 4 PASS", async () => {
  const expected = grade(PACK3.key, findingsFromResponse(PACK3_PASS_BODY));
  assert.equal(`${expected.found}/${expected.total}`, "4/5", "fixture sanity: the recorded run grades 4/5");
  const { dir, chain, clock, deps, lines } = step4Setup();
  const r = await runHire({ ...deps, makeSeller: pack3Seller(chain, clock, PACK3_PASS_BODY) });
  const out = text(lines);
  assert.equal(r.pass, true);
  assert.equal(r.step4.kind, "repeat");
  assert.deepEqual({ paid: r.step4.close.paid_seller, refunded: r.step4.close.refunded_buyer, counts: r.step4.close.counts_unique_buyer }, { paid: true, refunded: false, counts: false });
  assert.match(out, /Grade: 4\/5 found \(pass mark 4\) -> PASS/);
  for (const b of ["B1", "B2", "B3", "B4"]) assert.match(out, new RegExp(`  ${b} found   \\(finding at line \\d+; key `));
  assert.match(out, /  B5 missed  \(key /);
  assert.match(out, /Passed\. The seller was paid from escrow\./);
  assert.match(out, /settle tx \(the settle runs inside reveal\): revealTx3/);
  assert.match(out, /Next quote \(get_record\): 0\.040 -> 0\.040 NEAR/);
  assert.match(out, /formula: 0\.030 \+ 0\.010×1 − 0\.005×0 = 0\.040 NEAR/);
  assert.match(out, /P = 1 unique buyers with a pass \(2 passes, 1 counted: one per buyer\), F = 0 fails, 2 graded jobs/);
  assert.match(out, /Repeat pass: this buyer already has a paid pass with seller\.earned-price\.testnet, so P \(unique buyers\) stays 1; passes 1 -> 2\./);
  assert.match(out, /Quote held: 0\.040 -> 0\.040 NEAR \(P = 1 unique buyer, 2 passes, F = 0\)/);
  assert.ok(lines.includes("a fail subtracts 0.005 (see README step: contract test)"));
  assert.match(out, /REVIEW AUTHENTIC \(offline\): genuine NEAR AI TEE review of the official pack-3 request/);
  assert.equal(lines.at(-1), "SEE: step 4 PASS");
  assert.ok(!out.includes("SEE: step 3"));
  const job = loadJob(dir);
  assert.equal(job.status, "closed");
  assert.equal(job.outcome, "settled");
  assert.deepEqual(job.record_before, AFTER_STEP3, "the record read before the reveal is kept for a resumed run");
  assert.equal(loadState(dir).spent_yocto, (40n * YOCTO_PER_MNEAR).toString(), "paid, so the spend stays counted");
  const receipt = JSON.parse(readFileSync(receiptPaths(dir, "7").receipt, "utf8"));
  assert.deepEqual(receipt.quote, { before: "0.040", after: "0.040", formula: "0.030 + 0.010×1 − 0.005×0 = 0.040 NEAR" });
});

test("step 4 real fail: refund amount from the refund event, refund tx, quote 0.040 -> 0.035 from get_record, SEE: step 4 PASS (the honest fail)", async () => {
  const { dir, chain, clock, deps, lines } = step4Setup();
  const r = await runHire({ ...deps, makeSeller: pack3Seller(chain, clock, PACK3_FAIL_BODY) });
  const out = text(lines);
  assert.equal(r.outcome.kind, "refunded_fail");
  assert.equal(r.step4.kind, "fail");
  assert.deepEqual({ paid: r.step4.close.paid_seller, refunded: r.step4.close.refunded_buyer }, { paid: false, refunded: true });
  assert.match(out, /Grade: 0\/5 found \(pass mark 4\) -> FAIL/);
  for (const b of ["B1", "B2", "B3", "B4", "B5"]) assert.match(out, new RegExp(`  ${b} missed  `));
  assert.match(out, /Failed\. You were refunded and the seller takes a fail\./);
  assert.match(out, /refund tx \(the refund runs inside reveal\): revealTx3/);
  assert.match(out, /Refund: 0\.040 NEAR back to you \(refund event, reason grade_fail, in reveal tx revealTx3\)\./);
  assert.match(out, /Next quote \(get_record\): 0\.040 -> 0\.035 NEAR/);
  assert.match(out, /formula: 0\.030 \+ 0\.010×1 − 0\.005×1 = 0\.035 NEAR/);
  assert.match(out, /Fail counted: F 0 -> 1, so the quote dropped: 0\.040 -> 0\.035 NEAR/);
  assert.equal(lines.at(-1), "SEE: step 4 PASS");
  assert.equal(r.pass, true);
  assert.equal(loadState(dir).spent_yocto, "0", "the refund releases the reservation");
  assert.equal(loadJob(dir).outcome, "refunded_fail");
});

test("step 4 fail: the refund amount is the event's, never the job price; a short refund gets no SEE PASS", async () => {
  const { chain, clock, deps, lines } = step4Setup();
  const sendTx = async (req) => {
    const o = await chain.sendTx(req);
    if (req.methodName !== "reveal") return o;
    for (const ro of o.receipts_outcome) ro.outcome.logs = ro.outcome.logs.map((l) => l.replace(/"amount":"\d+"/, `"amount":"${(39n * YOCTO_PER_MNEAR).toString()}"`));
    return o;
  };
  const r = await runHire({ ...deps, sendTx, makeSeller: pack3Seller(chain, clock, PACK3_FAIL_BODY) });
  assert.match(text(lines), /Refund: 0\.039 NEAR back to you/);
  assert.equal(r.pass, false);
  assert.ok(!lines.includes("SEE: step 4 PASS"));
});

test("step 4 first pass (this buyer had no pass yet): P +1, quote rises, says to run step 3 first, no SEE: step 4 PASS", async () => {
  const { chain, clock, deps, lines } = step4Setup({ priceMilli: 30n, record: { passes: 0, fails: 0, unique_buyers: 0, jobs: 0 }, passBuyers: [] });
  const r = await runHire({ ...deps, makeSeller: pack3Seller(chain, clock, PACK3_PASS_BODY) });
  const out = text(lines);
  assert.equal(r.step4.kind, "first_pass");
  assert.equal(r.step4.close.counts_unique_buyer, true);
  assert.match(out, /First pass from this buyer with seller\.earned-price\.testnet: P 0 -> 1, so the quote rose 0\.030 -> 0\.040 NEAR\./);
  assert.equal(r.pass, false);
  assert.ok(!out.includes("SEE: step 4 PASS"));
});

test("step 4 unclear: another buyer's job for the same seller closes between the two reads -> nothing attributed, no SEE PASS", async () => {
  const { chain, clock, deps, lines } = step4Setup();
  chain.beforeSend = async (req) => {
    if (req.methodName === "reveal") {
      chain.record.passes++; // someone else's first pass lands in the same window
      chain.record.unique_buyers++;
      chain.record.jobs++;
    }
    return null;
  };
  const r = await runHire({ ...deps, makeSeller: pack3Seller(chain, clock, PACK3_PASS_BODY) });
  assert.equal(r.step4.kind, "unclear");
  assert.match(text(lines), /Step 4 can't attribute the quote change to this job: the seller's record moved by more than this job \(jobs \+2, passes \+2, fails \+0, unique_buyers \+1\)/);
  assert.equal(r.pass, false);
  assert.ok(!lines.includes("SEE: step 4 PASS"));
});

test("step 4 resume: the reveal landed in an earlier run; the record read before it comes from the job file -> still the repeat verdict", async () => {
  const { dir, chain, clock, deps, lines } = step4Setup();
  chain.beforeSend = async (req) => {
    if (req.methodName === "reveal") throw new Error("socket hang up");
  };
  await assert.rejects(runHire({ ...deps, makeSeller: pack3Seller(chain, clock, PACK3_PASS_BODY) }), { code: "REVEAL_UNCONFIRMED" });
  assert.deepEqual(loadJob(dir).record_before, AFTER_STEP3);
  chain.beforeSend = null;
  const landed = await chain.sendTx({ state: { account_id: BUYER }, methodName: "reveal", args: chain.sends[2].args });
  lines.length = 0;
  const r = await runHire({ ...deps, pack: "3", lookupTx: async ({ txHash }) => (txHash === "revealTx3" ? landed : null), pick: async () => assert.fail("an open pack-3 job is resumed, never re-picked") });
  const out = text(lines);
  assert.match(out, /Resuming the open pack-3 job 7/);
  assert.match(out, /Earlier reveal tx revealTx3 landed/);
  assert.match(out, /Next quote \(get_record\): 0\.040 -> 0\.040 NEAR/);
  assert.equal(r.step4.kind, "repeat");
  assert.equal(lines.at(-1), "SEE: step 4 PASS");
});

test("hire --pack 3 with no open job: runs pick 3 first (embedded, no SEE: step 2), then the whole hire on that job", async () => {
  const { dir, chain, clock, deps, lines, sealed } = step4Setup({ noJob: true });
  const picks = [];
  const pick = async (opts) => {
    picks.push(opts);
    // What `earned pick 3` leaves behind (the real runPick is covered in test/pick.test.js).
    saveJob(opts.dir, { version: 1, network: "testnet", contract: CONTRACT, buyer: BUYER, seller: DEMO_SELLER, pack_id: "pack-3", pack_hash: PACK3.hash, commit_hash: sealed.commit_hash, K: sealed.K, salt: sealed.salt, price_yocto: (40n * YOCTO_PER_MNEAR).toString(), status: "open", job_id: "7", create_tx: "CreateTx3" });
    opts.out("SEE-free pick output");
  };
  const r = await runHire({ ...deps, pack: "3", pick, makeSeller: pack3Seller(chain, clock, PACK3_PASS_BODY) });
  assert.equal(picks.length, 1);
  assert.deepEqual({ pack: picks[0].pack, dir: picks[0].dir, embedded: picks[0].embedded }, { pack: "3", dir, embedded: true });
  assert.match(text(lines), /No open job: opening a pack-3 job first \(as `earned pick 3`\)/);
  assert.equal(r.step4.kind, "repeat");
  assert.equal(lines.at(-1), "SEE: step 4 PASS");
  // A closed job before it (step 3's pack-2 job) is also a "no open job": pick runs.
  const s2 = setup({ status: "closed" });
  let picked = 0;
  await assert.rejects(runHire({ ...s2.deps, pack: "3", pick: async () => { picked++; throw new HireError("STOP", "stop after pick"); } }), { code: "STOP" });
  assert.equal(picked, 1);
});

test("hire --pack 3 refuses while a job for another pack is open (its salt is needed); nothing picked or sent", async () => {
  const { chain, deps } = setup(); // open pack-2 job
  let picked = 0;
  await assert.rejects(runHire({ ...deps, pack: "3", pick: async () => picked++ }), (e) => e.code === "OTHER_JOB_OPEN" && /for pack-2 is still open/.test(e.message) && /earned hire --pack 3/.test(e.message));
  assert.equal(picked, 0);
  assert.equal(chain.sends.length, 0);
  await assert.rejects(runHire({ ...deps, pack: "9" }), { code: "USAGE" });
});

test("step4 units: classifyClose reads paid/refunded from the outcome and counts_unique_buyer from the record delta", () => {
  const rec = (passes, fails, unique_buyers, jobs) => ({ passes, fails, unique_buyers, jobs });
  const b = rec(1, 0, 1, 1);
  assert.deepEqual(recordDelta(b, rec(2, 0, 1, 2)), { jobs: 1, passes: 1, fails: 0, unique_buyers: 0 });
  assert.equal(recordDelta(null, b), null);
  const settled = { kind: "settled" };
  const failed = { kind: "refunded_fail", refundYocto: "1" };
  assert.equal(classifyClose(settled, b, rec(2, 0, 1, 2)).kind, "repeat");
  assert.equal(classifyClose(settled, b, rec(2, 0, 2, 2)).kind, "first_pass");
  assert.equal(classifyClose(failed, b, rec(1, 1, 1, 2)).kind, "fail");
  // An event that disagrees with the record is never forced into a verdict.
  assert.equal(classifyClose(settled, b, rec(1, 1, 1, 2)).kind, "unclear");
  assert.equal(classifyClose(failed, b, rec(2, 0, 1, 2)).kind, "unclear");
  assert.equal(classifyClose(failed, b, rec(2, 1, 2, 3)).kind, "unclear", "a fail plus someone else's pass in the window");
  assert.equal(classifyClose(settled, b, rec(2, 0, 1, 1)).kind, "unclear", "jobs must move by exactly one");
  assert.match(classifyClose(settled, null, b).reason, /before the reveal/);
  assert.match(classifyClose(settled, b, null).reason, /after the close/);
  for (const kind of ["payout_failed_refunded", "timeout_refund", "timeout_refund_fail", "timeout_paid_seller"]) {
    const c = classifyClose({ kind }, b, rec(1, 0, 1, 1));
    assert.equal(c.kind, "other");
    assert.equal(c.paid_seller || c.refunded_buyer, false);
  }
  assert.equal(classifyClose(null, b, b).kind, "other");
});

test("step4 units: step4Report prints SEE-worthy pass only when regrade, escrow event, receipt and same-block quote all agree", () => {
  const before = { record: AFTER_STEP3, quoteMilli: 40 };
  const after = { record: { passes: 2, fails: 0, unique_buyers: 1, jobs: 2 }, quoteMilli: 40 };
  const okVerify = (passed) => ({ ok: true, checks: [{}, {}, {}, { ok: true, regrade: { passed } }] });
  const base = { outcome: { kind: "settled" }, txHash: "T", seller: DEMO_SELLER, priceYocto: (40n * YOCTO_PER_MNEAR).toString(), before, after, regrade: { passed: true }, escrowAgrees: true, verify: okVerify(true) };
  const good = step4Report(base);
  assert.equal(good.pass, true);
  assert.ok(good.lines.includes(FAIL_LINE));
  assert.equal(FAIL_LINE, "a fail subtracts 0.005 (see README step: contract test)");
  for (const bad of [{ escrowAgrees: false }, { regrade: null }, { regrade: { passed: false } }, { verify: null }, { verify: { ...okVerify(true), ok: false } }, { verify: okVerify(false) }, { after: { ...after, quoteMilli: 50 } }, { before: { ...before, quoteMilli: 30 } }]) {
    assert.equal(step4Report({ ...base, ...bad }).pass, false, JSON.stringify(bad));
  }
  // The fail branch: refund must be the full price from the event, quote must be the record's.
  const fb = { ...base, outcome: { kind: "refunded_fail", refundYocto: base.priceYocto }, after: { record: { passes: 1, fails: 1, unique_buyers: 1, jobs: 2 }, quoteMilli: 35 }, regrade: { passed: false }, verify: okVerify(false) };
  const f = step4Report(fb);
  assert.equal(f.kind, "fail");
  assert.equal(f.pass, true);
  assert.match(f.lines.join("\n"), /Refund: 0\.040 NEAR back to you[\s\S]*0\.040 -> 0\.035 NEAR/);
  for (const bad of [{ outcome: { kind: "refunded_fail", refundYocto: null } }, { regrade: { passed: true } }, { verify: okVerify(true) }, { after: { ...fb.after, quoteMilli: 40 } }]) {
    assert.equal(step4Report({ ...fb, ...bad }).pass, false, JSON.stringify(bad));
  }
  // No verdict lines and no pass for a non-graded close.
  const other = step4Report({ ...base, outcome: { kind: "timeout_paid_seller" } });
  assert.deepEqual([other.kind, other.lines, other.pass], ["other", [], false]);
});

test("earned hire: no --rigged flag anywhere in the CLI (S-023 AC3)", () => {
  for (const f of ["cli/earned.js", "cli/hire.js", "cli/step4.js", "cli/pick.js"]) {
    assert.ok(!/--rigged|rigged/i.test(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")), f);
  }
});

// --- T-032 review R-1 / sec L-3: the after-read must include this job's close --------------------

/** Another buyer's close for the same seller, applied on-chain right now (its own block). */
function otherClose(chain, kind) {
  if (kind === "first_pass") {
    chain.record.passes++;
    chain.record.unique_buyers++;
  } else if (kind === "repeat") chain.record.passes++;
  else chain.record.fails++;
  chain.record.jobs++;
  return chain.snap();
}

test("R-1 probe: ours is a repeat, a stale final view shows only another buyer's first pass -> never first_pass, unclear, no SEE", async () => {
  const { chain, clock, deps, lines } = step4Setup();
  chain.betweenCloseAndPayout = async () => {
    chain.staleFinal = otherClose(chain, "first_pass"); // final views stop here: theirs, not ours
  };
  const r = await runHire({ ...deps, makeSeller: pack3Seller(chain, clock, PACK3_PASS_BODY) });
  assert.notEqual(r.step4.kind, "first_pass");
  assert.equal(r.step4.kind, "unclear");
  assert.match(text(lines), /Step 4 can't attribute the quote change to this job: the seller's record moved by more than this job \(jobs \+2/);
  assert.equal(r.pass, false);
  assert.ok(!lines.includes("SEE: step 4 PASS"));
});

test("sec L-3 probe: ours is a first pass, a stale final view shows only another buyer's repeat -> no 'Repeat pass', no SEE", async () => {
  const { chain, clock, deps, lines } = step4Setup({ passBuyers: ["someone-else.testnet"] });
  chain.betweenCloseAndPayout = async () => {
    chain.staleFinal = otherClose(chain, "repeat");
  };
  const r = await runHire({ ...deps, makeSeller: pack3Seller(chain, clock, PACK3_PASS_BODY) });
  assert.equal(r.step4.kind, "unclear");
  assert.ok(!text(lines).includes("Repeat pass"));
  assert.ok(!lines.includes("SEE: step 4 PASS"));
});

test("R-1: final views lag behind our close the whole run -> the read pinned to the payout block still gives repeat + SEE", async () => {
  const { chain, clock, deps, lines } = step4Setup();
  chain.betweenCloseAndPayout = async () => {
    chain.staleFinal = chain.head; // final = before our record write, for every later read
  };
  const r = await runHire({ ...deps, makeSeller: pack3Seller(chain, clock, PACK3_PASS_BODY) });
  assert.equal(r.step4.kind, "repeat");
  assert.equal(lines.at(-1), "SEE: step 4 PASS");
});

test("R-1: the closing block is ahead of the RPC for a moment -> polled; never known -> unclear, no SEE", async () => {
  const a = step4Setup();
  a.chain.betweenCloseAndPayout = async () => {
    a.chain.unknownBlockReads = 2;
  };
  const r1 = await runHire({ ...a.deps, makeSeller: pack3Seller(a.chain, a.clock, PACK3_PASS_BODY) });
  assert.equal(r1.step4.kind, "repeat");
  assert.equal(a.lines.at(-1), "SEE: step 4 PASS");
  const b = step4Setup();
  b.chain.betweenCloseAndPayout = async () => {
    b.chain.unknownBlockReads = 1000;
  };
  const r2 = await runHire({ ...b.deps, makeSeller: pack3Seller(b.chain, b.clock, PACK3_PASS_BODY) });
  assert.equal(r2.step4.kind, "unclear");
  assert.match(text(b.lines), /could not be read at this job's closing block/);
  assert.ok(!b.lines.includes("SEE: step 4 PASS"));
});

test("R-1: get_job is not null at the pinned block (that state does not include our close) -> unclear, no SEE", async () => {
  const { chain, clock, deps, lines } = step4Setup();
  const sendTx = async (req) => {
    const o = await chain.sendTx(req);
    if (req.methodName === "reveal") {
      const at = o.receipts_outcome.at(-1).block_hash;
      chain.blocks.get(at).job = { id: "7" };
    }
    return o;
  };
  const r = await runHire({ ...deps, sendTx, makeSeller: pack3Seller(chain, clock, PACK3_PASS_BODY) });
  assert.equal(r.step4.kind, "unclear");
  assert.ok(!lines.includes("SEE: step 4 PASS"));
});

test("T-078 / review O-5: the RPC answers a pinned read from another block than asked -> never compared (unclear, no SEE)", async () => {
  const { chain, clock, deps, lines } = step4Setup();
  let swapped = 0;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const p = body.params;
    if (p.block_id !== undefined && p.method_name === "get_record" && chain.blocks.has(p.block_id)) {
      // Same state, but the node says it answered from another block (it echoes that block's hash).
      const other = `${p.block_id}-other`;
      chain.blocks.set(other, chain.blocks.get(p.block_id));
      swapped++;
      return chain.fetch(url, { ...init, body: JSON.stringify({ ...body, params: { ...p, block_id: other } }) });
    }
    return chain.fetch(url, init);
  };
  const r = await runHire({ ...deps, fetch, makeSeller: pack3Seller(chain, clock, PACK3_PASS_BODY) });
  assert.ok(swapped > 0, "the pinned read was answered from another block");
  assert.equal(r.step4.kind, "unclear");
  assert.ok(!lines.includes("SEE: step 4 PASS"));
});

test("R-1: a closing tx whose receipts carry no block_hash is never compared (unclear, no SEE)", async () => {
  const { chain, clock, deps, lines } = step4Setup();
  const sendTx = async (req) => {
    const o = await chain.sendTx(req);
    if (req.methodName === "reveal") for (const ro of o.receipts_outcome) delete ro.block_hash;
    return o;
  };
  const r = await runHire({ ...deps, sendTx, makeSeller: pack3Seller(chain, clock, PACK3_PASS_BODY) });
  assert.equal(r.step4.kind, "unclear");
  assert.ok(!lines.includes("SEE: step 4 PASS"));
});
