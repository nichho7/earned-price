// [CTO] T-035 · beat 2 chain reads + the bus adapter (node --test, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { baseEncode } from "near-api-js";
import { CONTRACT_ID, DEMO_SELLER } from "./account.js";
import {
  DEADLINE_MARGIN_MS, OPENING_OFFER_MILLI, RPC_FAILS_BEFORE_DOWN, createEventOf, mmss, sealPack, sellerMove, sellerTxsAt, watchSeller,
} from "./job.js";
import { liveRun, pendingBus, type BusLike } from "./live-bus.ts";
// @ts-expect-error plain module, no type declarations
import { canonicalJson, commit } from "../../grader/grade.js";
// @ts-expect-error plain CLI module, no type declarations
import { evaluateOffer, formulaLine } from "../../cli/quote.js";
// @ts-expect-error plain CLI module, no type declarations
import { OPENING_OFFER_MILLI as CLI_OPENING } from "../../cli/pick.js";
// @ts-expect-error plain CLI module, no type declarations
import { DEADLINE_MARGIN_MS as CLI_MARGIN } from "../../cli/hire.js";
// @ts-expect-error plain CLI module, no type declarations
import { parseTxOutcome } from "../../cli/tx.js";

const BUYER = "earned-price-web-a0a1a2a3a4a5.testnet";
const H = (n: number) => baseEncode(new Uint8Array(32).fill(n));
const KEY2 = JSON.parse(readFileSync(new URL("../../packs/pack-2/answer-key.json", import.meta.url), "utf8"));
const ev = (event: string, data: unknown) => `EVENT_JSON:${JSON.stringify({ standard: "earned_price", version: "0.1.0", event, data })}`;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const sellerTx = (hash: string, logs: string[], signer = DEMO_SELLER, receiver = CONTRACT_ID, failure = false) => ({
  status: failure ? { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: late" } } } } } : { SuccessValue: "" },
  transaction: { hash, signer_id: signer, receiver_id: receiver },
  transaction_outcome: { id: hash, outcome: { executor_id: signer, logs: [] } },
  receipts_outcome: [{ block_hash: "AcceptBlock", outcome: { executor_id: receiver, logs } }],
});
const acceptLog = (job = "7") => ev("accept", { job_id: job, seller: DEMO_SELLER, accepted_at_ns: "1794489860965883335" });
const declineLog = (job = "7") => ev("decline", { job_id: job, seller: DEMO_SELLER, buyer: BUYER, refunded: "30000000000000000000000" });

test("drift: the opening offer and the deadline margin are the CLI's", () => {
  assert.equal(OPENING_OFFER_MILLI, CLI_OPENING);
  assert.equal(DEADLINE_MARGIN_MS, CLI_MARGIN);
});

test("sealPack is the CLI seal: canonical K, 32-byte hex salt, commit = grader commit(key, salt)", () => {
  const s = sealPack(KEY2, (n) => Uint8Array.from({ length: n }, (_, i) => i));
  assert.equal(s.pack_id, "pack-2");
  assert.equal(s.K, canonicalJson(KEY2));
  assert.match(s.salt, /^[0-9a-f]{64}$/);
  assert.equal(s.commit_hash, commit(KEY2, s.salt));
});

test("haggle = cli/quote.js evaluateOffer (what cli/pick.js haggle() calls): 0.020 refused below the floor, 0.030 accepted", () => {
  const refused = evaluateOffer(OPENING_OFFER_MILLI, 30);
  assert.equal(refused.accept, false);
  assert.match(refused.reason, /below my cost floor 0\.025/);
  const deal = evaluateOffer(30, 30);
  assert.deepEqual([deal.accept, deal.priceMilli], [true, 30]);
  assert.equal(formulaLine({ unique_buyers: 0, fails: 0 }), "0.030 + 0.010×0 − 0.005×0 = 0.030 NEAR");
});

test("sellerTxsAt: tx hashes from the seller's access-key changes (transaction_processing only); a skipped block is []", async () => {
  const fetchFn = (async (_u: unknown, init?: RequestInit) => {
    const { params } = JSON.parse(String(init!.body));
    if (params.block_id === 2) return json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" } } });
    assert.deepEqual([params.changes_type, params.account_ids], ["all_access_key_changes", [DEMO_SELLER]]);
    return json({ jsonrpc: "2.0", id: 1, result: { changes: [
      { cause: { type: "transaction_processing", tx_hash: H(1) } },
      { cause: { type: "receipt_processing", receipt_hash: H(2) } },
      { cause: { type: "transaction_processing", tx_hash: "not a hash!" } },
    ] } });
  }) as typeof fetch;
  assert.deepEqual(await sellerTxsAt(fetchFn, 1), [H(1)]);
  assert.deepEqual(await sellerTxsAt(fetchFn, 2), []);
});

test("sellerMove: only DEMO_SELLER -> CONTRACT_ID, only this job, only a landed accept / decline", () => {
  assert.equal(sellerMove(sellerTx(H(1), [acceptLog()]), "7", BUYER)?.kind, "accepted");
  assert.equal(sellerMove(sellerTx(H(1), [acceptLog("8")]), "7", BUYER), null, "another job");
  assert.equal(sellerMove(sellerTx(H(1), [acceptLog()], "evil.testnet"), "7", BUYER), null, "not the seller");
  assert.equal(sellerMove(sellerTx(H(1), [acceptLog()], DEMO_SELLER, "evil.testnet"), "7", BUYER), null, "not the escrow");
  assert.equal(sellerMove(sellerTx(H(1), [acceptLog()], DEMO_SELLER, CONTRACT_ID, true), "7", BUYER), null, "refused accept");
  const d = sellerMove(sellerTx(H(2), [declineLog()]), "7", BUYER);
  assert.equal(d?.kind, "declined");
  assert.equal(d && "closed" in d ? d.closed.refundYocto : null, "30000000000000000000000");
});

/** A tiny scripted chain for watchSeller: head moves one block per round; seller txs live at given heights. */
function scripted(opts: { start: number; txAt: Record<number, string>; outcomes: Record<string, unknown>; headTimeNs?: (h: number) => bigint; jobStatus?: string | null; down?: boolean; notYet?: Set<string> }) {
  let head = opts.start;
  const calls: string[] = [];
  const fn = (async (_u: unknown, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init!.body));
    calls.push(method);
    if (opts.down) throw new Error("down");
    if (method === "block") { const h = head++; return json({ jsonrpc: "2.0", id: 1, result: { header: { height: h, hash: H(9), timestamp_nanosec: String(opts.headTimeNs?.(h) ?? 1000n) } } }); }
    if (method === "EXPERIMENTAL_changes") {
      const tx = opts.txAt[params.block_id];
      return json({ jsonrpc: "2.0", id: 1, result: { changes: tx ? [{ cause: { type: "transaction_processing", tx_hash: tx } }] : [] } });
    }
    if (method === "tx") {
      if (opts.notYet?.has(params.tx_hash)) { opts.notYet.delete(params.tx_hash); return json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } } }); }
      return json({ jsonrpc: "2.0", id: 1, result: opts.outcomes[params.tx_hash] });
    }
    if (method === "query") {
      const v = opts.jobStatus === null ? null : { status: opts.jobStatus ?? "open", accept_by_ns: "5" };
      return json({ jsonrpc: "2.0", id: 1, result: { result: Array.from(new TextEncoder().encode(JSON.stringify(v))), block_hash: "x" } });
    }
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;
  return { fn, calls };
}
const noSleep = async () => {};

test("watchSeller: finds the seller's accept a few blocks after create, ignoring other jobs' txs; a not-yet-executed tx is re-read", async () => {
  const other = H(3);
  const mine = H(4);
  const c = scripted({ start: 100, txAt: { 101: other, 103: mine }, outcomes: { [other]: sellerTx(other, [acceptLog("6")]), [mine]: sellerTx(mine, [acceptLog()]) }, notYet: new Set([mine]) });
  const ticks: bigint[] = [];
  const r = await watchSeller({ fetch: c.fn, jobId: "7", buyer: BUYER, fromHeight: 100, acceptByNs: "999999999999", sleep: noSleep, onTick: (t) => ticks.push(t.chainNowNs) });
  assert.equal(r.kind, "accepted");
  assert.equal("parsed" in r ? r.parsed.txHash : null, mine);
  assert.ok(ticks.length >= 2);
});

test("watchSeller: a decline is found the same way (outcome from its EVENT_JSON)", async () => {
  const d = H(5);
  const c = scripted({ start: 10, txAt: { 11: d }, outcomes: { [d]: sellerTx(d, [declineLog()]) } });
  const r = await watchSeller({ fetch: c.fn, jobId: "7", buyer: BUYER, fromHeight: 10, acceptByNs: "999999999999", sleep: noSleep });
  assert.equal(r.kind, "declined");
});

test("watchSeller: accept_by + margin passed (chain time) and get_job still open = deadline (the page then signs timeout)", async () => {
  const acceptBy = 5_000_000_000n;
  const c = scripted({ start: 1, txAt: {}, outcomes: {}, headTimeNs: (h) => (h >= 3 ? acceptBy + BigInt(DEADLINE_MARGIN_MS) * 1_000_000n + 1n : 1n) });
  const r = await watchSeller({ fetch: c.fn, jobId: "7", buyer: BUYER, fromHeight: 1, acceptByNs: String(acceptBy), sleep: noSleep });
  assert.equal(r.kind, "deadline");
  // Before the margin, never: the first rounds (chain time 1 ns) read no get_job at all.
  assert.equal(c.calls.filter((m) => m === "query").length, 1);
});

test("watchSeller: RPC down for several rounds = RPC_UNAVAILABLE (the page offers RECORDED)", async () => {
  const c = scripted({ start: 1, txAt: {}, outcomes: {}, down: true });
  await assert.rejects(watchSeller({ fetch: c.fn, jobId: "7", buyer: BUYER, fromHeight: 1, acceptByNs: "1", sleep: noSleep }), (e: { code?: string }) => e.code === "RPC_UNAVAILABLE");
  assert.ok(c.calls.length >= RPC_FAILS_BEFORE_DOWN);
});

test("mmss + createEventOf", () => {
  assert.equal(mmss(108_000), "1:48");
  assert.equal(mmss(-5), "0:00");
  assert.equal(mmss(1), "0:01");
  const p = parseTxOutcome({ status: { SuccessValue: "" }, transaction: { hash: H(1) }, receipts_outcome: [{ block_hash: "b", outcome: { executor_id: CONTRACT_ID, logs: [ev("create", { job_id: "7", buyer: BUYER, commit_hash: "c" })] } }] }, CONTRACT_ID);
  assert.equal(createEventOf(p, BUYER, "c")?.job_id, "7");
  assert.equal(createEventOf(p, BUYER, "d"), null);
});

/* ---------- the bus adapter: one observed tx outcome = one publish, one t_ms ---------- */

const record = { passes: 0, fails: 0, unique_buyers: 0, jobs: 0 };
const createParsed = parseTxOutcome({ status: { SuccessValue: "" }, transaction: { hash: H(1) }, receipts_outcome: [{ block_hash: "b", outcome: { executor_id: CONTRACT_ID, logs: [ev("create", {
  job_id: "7", buyer: BUYER, seller: DEMO_SELLER, price: "30000000000000000000000", excess_refunded: "0", commit_hash: "ab".repeat(32), pack_id: "pack-2",
  created_at_ns: "1794489856066800093", accept_by_ns: "1794489976066800093", review_by_ns: "1794490276066800093", reveal_deadline_ns: "1794490576066800093",
})] } }] }, CONTRACT_ID);
const acceptParsed = parseTxOutcome(sellerTx(H(2), [acceptLog()]), CONTRACT_ID);

/** Runs a full beat-2 sequence through `bus`, with a clock that can stand still (two moments in one ms). */
function beat2(bus: BusLike) {
  let t = 1_000;
  const clock = () => t;
  const run = liveRun(bus, { buyer: BUYER, contract: CONTRACT_ID, seller: DEMO_SELLER, pack_id: "pack-2" }, clock);
  const out = [run.quote({ record, quoteMilli: 30, formula: formulaLine(record) })];
  out.push(run.createSubmitted(H(1), 30n * 10n ** 21n)); // same ms: still a later t_ms
  t += 1200;
  out.push(run.createConfirmed(createParsed, { height: 277368595, timestampNs: 1794489856066800093n }));
  t += 5000;
  out.push(run.accepted(acceptParsed, { height: 277368604, timestampNs: 1794489861442459754n }, "1794489860965883335"));
  return { run, out };
}

test("bus adapter: quote, tx_submitted, tx_confirmed(create), tx_confirmed(accept)+accepted; seq continuous, t_ms strictly rising", () => {
  const bus = pendingBus();
  const { out } = beat2(bus);
  assert.ok(out.every((r) => r.ok));
  assert.deepEqual(bus.batches.map((b) => b.map((e) => e.type)), [["quote"], ["tx_submitted"], ["tx_confirmed"], ["tx_confirmed", "accepted"]]);
  const all = bus.batches.flat();
  assert.deepEqual(all.map((e) => e.seq), [0, 1, 2, 3, 4]);
  const ts = bus.batches.map((b) => b[0].t_ms);
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] > ts[i - 1], `t_ms rises (${ts})`);
  for (const b of bus.batches) assert.equal(new Set(b.map((e) => e.t_ms)).size, 1, "one publish = one t_ms");
  assert.ok(all.every((e) => e.recorded && !e.placeholder));
  const created = all[2] as { job_id: string | null; data: Record<string, unknown> };
  assert.equal(created.job_id, "7");
  assert.deepEqual([created.data.price_mnear, created.data.accept_by_ns], [30, "1794489976066800093"]);
  assert.equal((all[4] as { tx_hash: string }).tx_hash, H(2));
  assert.equal(bus.headers[0].buyer, BUYER);
});

test("bus adapter: decline / timeout outcomes are NOT guessed into schema v1 (pending the T-038 fix round)", () => {
  const bus = pendingBus();
  const { run } = beat2(bus);
  const r = run.closed("timeout_refund");
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.pending ?? "", /T-038/);
  assert.equal(bus.batches.length, 4);
});

const realBus = new URL("../bus/bus.ts", import.meta.url);
test("bus adapter against T-038's real bus (runs once site/bus/bus.ts is on this branch)", { skip: !existsSync(realBus) && "site/bus/bus.ts not merged yet (T-038)" }, async () => {
  const { createBus } = await import(realBus.href);
  const bus = createBus();
  const { out } = beat2(bus);
  assert.deepEqual(out.map((r) => r.ok), [true, true, true, true], JSON.stringify(out));
  assert.equal(bus.runs[0].events.length, 5);
});
