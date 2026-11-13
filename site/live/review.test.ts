// [CTO] T-036 · beat 3 helpers: the review function client, the checks, the stage countdown, and the beat-3 bus events
// against T-038's real bus (and the chart step 0.030 -> 0.040 they drive). node --test, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { baseEncode } from "near-api-js";
import {
  MAX_RESPONSE_BYTES, REPLAY_REASONS, REVIEW_FN_MAX_MS, REVIEW_URL, checksOf, findingsCount, loadReviewBody, normaliseAnswer,
  requestReview, reviewMatches, saveReviewBody, stageOf,
} from "./review.js";
import { CONTRACT_ID, DEMO_SELLER } from "./account.js";
import { liveRun } from "./live-bus.ts";
import { createBus } from "../bus/bus.ts";
import { chartOf } from "../earn/earn-chart.js";
import { buildStory, finalIndex, storyStateAt } from "../earn/earn-core.js";
import { recordedInfo } from "./recorded-info.ts";
// @ts-expect-error plain module, no type declarations
import { REPLAY_REASONS as FN_REASONS, MAX_DURATION_MS } from "../../site-api/review.js";
// @ts-expect-error plain module, no type declarations
import { canonicalJson, findingsFromResponse, sha256Hex } from "../../grader/grade.js";
// @ts-expect-error plain CLI module, no type declarations
import { formulaLine } from "../../cli/quote.js";
// @ts-expect-error plain CLI module, no type declarations
import { classifyClose } from "../../cli/step4.js";
// @ts-expect-error plain CLI module, no type declarations
import { outcomeOf, parseTxOutcome } from "../../cli/tx.js";

const H = (n: number) => baseEncode(new Uint8Array(32).fill(n));
const BUYER = "earned-price-web-a0a1a2a3a4a5.testnet";
const KEY2 = JSON.parse(readFileSync(new URL("../../packs/pack-2/answer-key.json", import.meta.url), "utf8"));
const K = canonicalJson(KEY2) as string;
const hitAll = KEY2.bugs.map((b: { file: string; line_start: number; category: string }) => ({ file: b.file, line: b.line_start, category: b.category }));
const bodyOf = (findings: unknown) => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ findings }) } }] });
const BODY = bodyOf(hitAll);
const AUTH = { job_id: "7", pack_id: "pack-2", public_key: "ed25519:x", signature: "s", expires_ms: "1800000000000" };
const json = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const liveAnswer = { mode: "live", job_id: "7", pack_id: "pack-2", seller: DEMO_SELLER, accept_tx: H(2), submit: { status: "landed", tx_hash: H(3) }, review_submitted: true, review: { response_body: BODY, findings: hitAll } };

test("drift: the client's replay reasons and the 300 s limit are the T-028 function's (site-api/review.js)", () => {
  assert.deepEqual([...REPLAY_REASONS].filter((r) => r !== "review_down"), FN_REASONS);
  assert.equal(REVIEW_FN_MAX_MS, MAX_DURATION_MS);
  assert.equal(REVIEW_URL, "/api/review");
});

test("requestReview: POSTs the gate's auth fields only; a live answer gives the body + submit tx; 401 AUTH_EXPIRED re-signs once", async () => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  let signs = 0;
  const answers = [json(401, { mode: "error", code: "AUTH_EXPIRED" }), json(200, liveAnswer)];
  const fetchFn = (async (url: string, init?: RequestInit) => { sent.push({ url, body: JSON.parse(String(init?.body)) }); return answers.shift()!; }) as unknown as typeof fetch;
  const a = await requestReview({ fetch: fetchFn, jobId: "7", sign: async () => { signs++; return AUTH; } });
  assert.deepEqual(a, { mode: "live", acceptTx: H(2), submitTx: H(3), submitLanded: true, responseBody: BODY });
  assert.equal(signs, 2);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, "/api/review");
  assert.deepEqual(Object.keys(sent[0].body).sort(), ["expires_ms", "job_id", "pack_id", "public_key", "signature"]);
});

test("requestReview: every answer that isn't the contract's live shape plays RECORDED (replay reasons kept, everything else review_down)", async () => {
  const cases: [Response | Error, unknown][] = [
    [json(200, { mode: "replay", label: "RECORDED", reason: "cap_daily", job_state: "declined", review_submitted: false }), { mode: "replay", reason: "cap_daily", jobState: "declined" }],
    [json(200, { mode: "replay", reason: "<script>", job_state: "weird" }), { mode: "replay", reason: "review_failed", jobState: "unknown" }],
    [json(404, "<html>not found</html>"), { mode: "replay", reason: "review_down", jobState: "unknown" }],
    [json(504, { mode: "replay", reason: "timeout" }), { mode: "replay", reason: "review_down", jobState: "unknown" }],
    [json(409, { mode: "error", code: "ALREADY_REVIEWED" }), { mode: "replay", reason: "review_down", jobState: "unknown" }],
    [json(200, "not json"), { mode: "replay", reason: "review_down", jobState: "unknown" }],
    [json(200, { ...liveAnswer, job_id: "8" }), { mode: "replay", reason: "review_down", jobState: "unknown" }],
    [json(200, { ...liveAnswer, review: { response_body: "x".repeat(MAX_RESPONSE_BYTES + 1) } }), { mode: "replay", reason: "review_down", jobState: "unknown" }],
    [new TypeError("network"), { mode: "replay", reason: "review_down", jobState: "unknown" }],
  ];
  for (const [res, want] of cases) {
    const fetchFn = (async () => { if (res instanceof Error) throw res; return res; }) as unknown as typeof fetch;
    assert.deepEqual(await requestReview({ fetch: fetchFn, jobId: "7", sign: async () => AUTH }), want);
  }
  // a bad tx hash is dropped, not rendered
  assert.equal((normaliseAnswer({ ...liveAnswer, submit: { status: "unknown", tx_hash: "<img>" } }, "7") as { submitTx: string | null }).submitTx, null);
  // the gate refusing to sign: nothing is sent, RECORDED plays
  let calls = 0;
  const r = await requestReview({ fetch: (async () => { calls++; return json(200, liveAnswer); }) as unknown as typeof fetch, jobId: "7", sign: async () => { throw new Error("NO_JOB"); } });
  assert.equal(r.mode, "replay");
  assert.equal(calls, 0);
});

test("requestReview: a function that never answers is cut at the client timeout (RECORDED), not left hanging", async () => {
  const fetchFn = ((_u: string, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
  const t0 = Date.now();
  const r = await requestReview({ fetch: fetchFn, jobId: "7", sign: async () => AUTH, timeoutMs: 50 });
  assert.equal(r.mode, "replay");
  assert.ok(Date.now() - t0 < 2000);
});

test("checksOf: 'Check 1..5' and no titles until the reveal; then the grader's grade with each finding next to the key", () => {
  const sealed = checksOf(null, null);
  assert.deepEqual(sealed.rows.map((r) => r.title), ["Check 1", "Check 2", "Check 3", "Check 4", "Check 5"]);
  assert.equal(JSON.stringify(sealed).includes(KEY2.bugs[0].title), false, "no title leaks before the reveal");
  assert.equal(sealed.grade, null);
  const open = checksOf(K, findingsFromResponse(BODY));
  assert.equal(open.grade!.found, 5);
  assert.equal(open.grade!.passed, true);
  assert.deepEqual(open.rows.map((r) => r.bug_id), ["B1", "B2", "B3", "B4", "B5"]);
  assert.ok(open.rows.every((r) => r.hit && r.finding && !r.sealed && r.title.length > 0));
  const four = checksOf(K, hitAll.slice(0, 4));
  assert.deepEqual([four.grade!.found, four.grade!.passed, four.rows[4].hit, four.rows[4].finding], [4, true, false, null]);
  assert.equal(checksOf(K, null).grade!.error, "malformed_finding");
});

test("the RECORDED run's key + findings (build time, recorded/pack-2.json) regrade to 5/5, as /verify and the escrow did", () => {
  const r = recordedInfo(new URL("../../recorded/pack-2.json", import.meta.url).pathname);
  assert.equal(r.job_id, "1");
  const g = checksOf(r.K, r.findings);
  assert.deepEqual([g.grade!.found, g.grade!.total, g.grade!.passed, g.grade!.false_positives], [5, 5, true, 1]);
  assert.ok(r.findings.every((f) => Object.keys(f).sort().join() === "category,file,line"));
});

test("T-037 step 4 RECORDED: job 2 (recorded/pack-3.json) regrades 4/5 with B5 missed; run-2's settle + get_record reads classify as the repeat pass, quote held 0.040", () => {
  const r = recordedInfo(new URL("../../recorded/pack-3.json", import.meta.url).pathname);
  assert.deepEqual([r.job_id, r.pack_id], ["2", "pack-3"]);
  const g = checksOf(r.K, r.findings);
  assert.deepEqual([g.grade!.found, g.grade!.total, g.grade!.passed], [4, 5, true]);
  assert.deepEqual(g.rows.map((x) => [x.bug_id, x.hit]), [["B1", true], ["B2", true], ["B3", true], ["B4", true], ["B5", false]]);
  const run2 = JSON.parse(readFileSync(new URL("../data/recorded/run-2.json", import.meta.url), "utf8"));
  const ev = (type: string, phase?: string) => run2.events.find((e: { type: string; data: { phase?: string } }) => e.type === type && (!phase || e.data.phase === phase));
  const settled = ev("settled");
  const before = ev("quote", "before").data;
  const after = ev("quote", "after").data;
  // the receipt's txs are the replay's txs (review L-8, for job 2)
  assert.equal(run2.events.find((e: { type: string; data: { action?: string } }) => e.type === "tx_confirmed" && e.data.action === "reveal").tx_hash, r.txs.reveal);
  assert.equal(settled.data.outcome, "paid_seller");
  const close = classifyClose({ kind: "settled" }, before.record, after.record);
  assert.deepEqual([close.kind, close.counts_unique_buyer], ["repeat", false]);
  assert.deepEqual([before.quote_mnear, after.quote_mnear], [40, 40]);
  assert.equal(formulaLine(after.record), "0.030 + 0.010×1 − 0.005×0 = 0.040 NEAR");
  // a refund is the fail state, never the repeat state; a first pass from a new buyer is not a repeat
  assert.equal(classifyClose({ kind: "refunded_fail" }, after.record, { ...after.record, fails: 1, jobs: 3 }).kind, "fail");
  assert.equal(classifyClose({ kind: "settled" }, before.record, { ...after.record, unique_buyers: 2 }).kind, "first_pass");
  assert.equal(classifyClose({ kind: "settled" }, before.record, { ...after.record, jobs: 3 }).kind, "unclear");
});

test("reviewMatches / stageOf / findingsCount / the review cache", () => {
  const view = (over: Record<string, unknown>) => ({ status: "accepted", accept_by_ns: "1", review_by_ns: "2", reveal_deadline_ns: "3", review: null, ...over }) as never;
  assert.equal(reviewMatches(view({ review: { response_sha256: sha256Hex(BODY) } }), BODY), true);
  assert.equal(reviewMatches(view({ review: { response_sha256: "0x" + sha256Hex(BODY).toUpperCase() } }), BODY), true);
  assert.equal(reviewMatches(view({ review: { response_sha256: sha256Hex("other") } }), BODY), false);
  assert.equal(reviewMatches(view({}), BODY), false);
  assert.deepEqual(stageOf(view({ status: "open" })), { stage: "accept", deadlineNs: "1" });
  assert.deepEqual(stageOf(view({})), { stage: "review", deadlineNs: "2" });
  assert.deepEqual(stageOf(view({ review: { response_sha256: "x" } })), { stage: "reveal", deadlineNs: "3" });
  assert.equal(stageOf(null), null);
  assert.equal(findingsCount(BODY), 5);
  assert.equal(findingsCount("nope"), null);
  const m = new Map<string, string>();
  const kv = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  saveReviewBody(kv, "7", BODY);
  assert.equal(loadReviewBody(kv, "7"), BODY);
  assert.equal(loadReviewBody(kv, "8"), null);
});

/* ---------- beat 3 on T-038's real bus: every event accepted, and the chart steps 0.030 -> 0.040 ---------- */

const ev = (event: string, data: unknown) => `EVENT_JSON:${JSON.stringify({ standard: "earned_price", version: "0.1.0", event, data })}`;
const tx = (hash: string, signer: string, logs: string[]) => ({
  status: { SuccessValue: "" }, transaction: { hash, signer_id: signer, receiver_id: CONTRACT_ID },
  receipts_outcome: [{ block_hash: "b", outcome: { executor_id: CONTRACT_ID, logs } }],
});
const PRICE = "30000000000000000000000";
const r0 = { passes: 0, fails: 0, unique_buyers: 0, jobs: 0 };
const r1 = { passes: 1, fails: 0, unique_buyers: 1, jobs: 1 };
const ATT = { model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", signing_address: "0x" + "fe".repeat(20), request_sha256: "a".repeat(64), response_sha256: sha256Hex(BODY), signed_text: "m:a:b", signature: "0x" + "ab".repeat(65) };

function beat3(close: "pass" | "no_review" | "no_reveal") {
  const bus = createBus();
  let t = 1_000;
  const run = liveRun(bus, { buyer: BUYER, contract: CONTRACT_ID, seller: DEMO_SELLER, pack_id: "pack-2" }, () => t);
  const out = [run.quote({ record: r0, quoteMilli: 30, formula: formulaLine(r0) })];
  out.push(run.createSubmitted(H(1), 30n * 10n ** 21n));
  t += 1200;
  out.push(run.createConfirmed(parseTxOutcome(tx(H(1), BUYER, [ev("create", {
    job_id: "7", buyer: BUYER, seller: DEMO_SELLER, price: PRICE, excess_refunded: "0", commit_hash: "ab".repeat(32), pack_id: "pack-2",
    created_at_ns: "1794489856066800093", accept_by_ns: "1794489976066800093", review_by_ns: "1794490276066800093", reveal_deadline_ns: "1794490576066800093",
  })]), CONTRACT_ID), { height: 10, timestampNs: 1794489856066800093n }));
  t += 5000;
  out.push(run.accepted(parseTxOutcome(tx(H(2), DEMO_SELLER, [ev("accept", { job_id: "7", seller: DEMO_SELLER, accepted_at_ns: "1794489860965883335" })]), CONTRACT_ID), { height: 12, timestampNs: 1794489861442459754n }, "1794489860965883335"));
  t += 14000;
  if (close !== "no_review") {
    out.push(run.reviewLanded(parseTxOutcome(tx(H(3), DEMO_SELLER, [ev("submit_review", { job_id: "7", seller: DEMO_SELLER })]), CONTRACT_ID), { height: 40, timestampNs: 1794489875974169516n }, ATT, 5));
  }
  t += 4000;
  if (close === "pass") {
    out.push(run.revealSubmitted(H(4), "1794490576066800093"));
    t += 2000;
    const p = parseTxOutcome({ ...tx(H(4), BUYER, [ev("reveal", { job_id: "7", buyer: BUYER, seller: DEMO_SELLER, found: 5, total: 5, pass_min: 4, passed: true, outcome: "pass" })]),
      receipts_outcome: [
        { block_hash: "b", outcome: { executor_id: CONTRACT_ID, logs: [ev("reveal", { job_id: "7", buyer: BUYER, seller: DEMO_SELLER, found: 5, total: 5, pass_min: 4, passed: true, outcome: "pass" })] } },
        { block_hash: "c", outcome: { executor_id: CONTRACT_ID, logs: [ev("payout", { job_id: "7", buyer: BUYER, seller: DEMO_SELLER, amount: PRICE, kind: "settle" })] } },
      ] }, CONTRACT_ID);
    assert.equal(outcomeOf(p.events, "7", BUYER).kind, "settled");
    const rows = checksOf(K, findingsFromResponse(BODY)).rows.map((r) => ({ bug_id: r.bug_id!, title: r.title, hit: Boolean(r.hit) }));
    out.push(run.revealed(p, { height: 50, timestampNs: 1794489882133064468n }, rows, "settle", PRICE, { found: 5, total: 5, pass_min: 4, passed: true, error: null }));
    t += 600;
    out.push(run.quoteAfter({ record: r1, quoteMilli: 40, formula: formulaLine(r1), blockHeight: null, prevMilli: 30 }));
  } else {
    out.push(run.timeoutSubmitted(H(5), close === "no_review" ? "1794490276066800093" : "1794490576066800093"));
    t += 2000;
    const logs = close === "no_review"
      ? [ev("timeout", { job_id: "7", reason: "no_review" }), ev("refund", { job_id: "7", buyer: BUYER, seller: DEMO_SELLER, amount: PRICE, reason: "no_review", record: "fail" })]
      : [ev("timeout", { job_id: "7", reason: "no_reveal" }), ev("payout", { job_id: "7", buyer: BUYER, seller: DEMO_SELLER, amount: PRICE, kind: "timeout" })];
    const p = parseTxOutcome(tx(H(5), BUYER, logs), CONTRACT_ID);
    out.push(run.closedByTimeout(p, { height: 60, timestampNs: 1794490580000000000n }, close, PRICE));
    t += 600;
    const after = close === "no_review" ? { passes: 0, fails: 1, unique_buyers: 0, jobs: 1 } : r0;
    out.push(run.quoteAfter({ record: after, quoteMilli: close === "no_review" ? 25 : 30, formula: formulaLine(after), blockHeight: null, prevMilli: 30 }));
  }
  return { bus, out };
}

test("beat 3 on the real bus: submit_review + attested, reveal submitted, reveal + 5 check_graded + settled (one moment), quote(after); chart 0.030 -> 0.040", () => {
  const { bus, out } = beat3("pass");
  assert.ok(out.every((r) => r.ok), JSON.stringify(out));
  const ev3 = bus.runs[0].events.slice(5);
  assert.deepEqual(ev3.map((e) => e.type), ["tx_confirmed", "attested", "tx_submitted", "tx_confirmed", "check_graded", "check_graded", "check_graded", "check_graded", "check_graded", "settled", "quote"]);
  const reveal = ev3.slice(3, 10);
  assert.equal(new Set(reveal.map((e) => e.t_ms)).size, 1, "the reveal's moment is one publish, one t_ms");
  assert.ok(reveal.every((e) => (e as { tx_hash: string }).tx_hash === H(4)));
  const settled = ev3[9] as { data: Record<string, unknown> };
  assert.deepEqual(settled.data, { outcome: "paid_seller", amount_mnear: 30, to: DEMO_SELLER, reason: "settle", record_change: "pass", grade: { found: 5, total: 5, pass_min: 4, passed: true, error: null } });
  const story = buildStory(bus.runs);
  const c = chartOf(storyStateAt(story, finalIndex(story)));
  assert.deepEqual(c.points.map((p) => [p.kind, p.mnear]), [["start", 30], ["settle", 40]]);
  assert.equal(c.points[1].tx, H(4));
  assert.equal(c.quote, 40);
});

test("beat 3 on the real bus: timeout outcomes no_review (refund + fail, 0.030 -> 0.025) and no_reveal (seller paid, quote holds)", () => {
  for (const close of ["no_review", "no_reveal"] as const) {
    const { bus, out } = beat3(close);
    assert.ok(out.every((r) => r.ok), `${close}: ${JSON.stringify(out)}`);
    const last = bus.runs[0].events.slice(-3);
    assert.deepEqual(last.map((e) => e.type), ["tx_confirmed", "settled", "quote"]);
    const s = last[1] as { data: Record<string, unknown> };
    assert.deepEqual([s.data.reason, s.data.outcome, s.data.record_change, s.data.grade], close === "no_review" ? ["no_review", "refunded_buyer", "fail", null] : ["no_reveal", "paid_seller", "none", null]);
    const story = buildStory(bus.runs);
    const c = chartOf(storyStateAt(story, finalIndex(story)));
    assert.deepEqual(c.points.map((p) => p.mnear), close === "no_review" ? [30, 25] : [30, 30]);
  }
});
