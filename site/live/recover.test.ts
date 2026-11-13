// [CTO] T-037 · review L-2: a reload mid-review loses the body; it is recovered from the seller's own submit_review tx
// args, kept only when it hashes to get_job's response_sha256, and revealed only through the gate (which checks again).
// node --test, no network: the RPC is a stub that serves blocks, the seller's access-key changes, tx lookups and views,
// and near-api-js is a fake that records what it was asked to sign.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { baseEncode } from "near-api-js";
import {
  AccountError, CONTRACT_ID, DEMO_SELLER, JOB_GAS_RESERVE_YOCTO, MAX_CLOSE_TRIES, REVEAL_GAS, loadJob, saveBuyer, saveJob, signJobAction,
} from "./account.js";
import type { Job, KV } from "./account.d.ts";
import { UNSEEN_ROUNDS } from "./job.js";
import { RECOVER_MAX_BLOCKS, loadReviewBody, loadReviewTx, recoverReviewBody, reviewMatches, saveReviewBody, submitReviewOf, txHeight } from "./review.js";
// @ts-expect-error plain module, no type declarations
import { canonicalJson, commit, sha256Hex } from "../../grader/grade.js";

const MILLI = 10n ** 21n;
const QUOTE = 40n * MILLI;
const ACCOUNT = "earned-price-web-a0a1a2a3a4a5.testnet";
const KEY3 = JSON.parse(readFileSync(new URL("../../packs/pack-3/answer-key.json", import.meta.url), "utf8"));
const K = canonicalJson(KEY3) as string;
const SALT = "cd".repeat(32);
const COMMIT = commit(KEY3, SALT) as string;
const JOB = "18";
const H = (n: number) => baseEncode(new Uint8Array(32).fill(n));
const BODY = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ findings: [{ file: "settlement.py", line: 12, category: "money" }] }) } }] });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const ev = (event: string, data: unknown) => `EVENT_JSON:${JSON.stringify({ standard: "earned_price", version: "1.0.0", event, data })}`;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const enc = (v: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(v)));
const memory = (): KV => {
  const m = new Map<string, string>();
  return { getItem: (k) => (m.has(k) ? m.get(k)! : null), setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

/** A seller tx outcome as the `tx` RPC returns it (transaction.actions with base64 args). */
function sellerTx(hash: string, opts: { method?: string; args?: Record<string, unknown>; signer?: string; receiver?: string; logs?: string[]; failure?: boolean; actions?: unknown[] } = {}) {
  const args = opts.args ?? { job_id: JOB, model: "m", request_sha256: "13".repeat(32), response_sha256: sha256Hex(BODY), signature: "0x" + "ab".repeat(65), signing_address: "0x" + "fe".repeat(20), response: BODY };
  return {
    status: opts.failure ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: nope" } } } } } : { SuccessValue: "" },
    transaction: {
      hash, signer_id: opts.signer ?? DEMO_SELLER, receiver_id: opts.receiver ?? CONTRACT_ID,
      actions: opts.actions ?? [{ FunctionCall: { method_name: opts.method ?? "submit_review", args: b64(args), gas: 300_000_000_000_000, deposit: "0" } }],
    },
    transaction_outcome: { id: hash, block_hash: `blk-${hash.slice(0, 6)}`, outcome: { executor_id: DEMO_SELLER, logs: [], tokens_burnt: "1" } },
    receipts_outcome: [{ id: `r-${hash.slice(0, 6)}`, block_hash: "rb", outcome: { executor_id: CONTRACT_ID, logs: opts.logs ?? (opts.failure ? [] : [ev("submit_review", { job_id: JOB, seller: DEMO_SELLER })]), tokens_burnt: "1" } }],
  };
}

/**
 * The RPC stub. `txs` maps a block height to the seller txs converted there; `head` is the chain head; `job` is what
 * get_job answers; `down` makes every call fail. `unexecuted` hides a tx from `tx` for its first N lookups.
 */
function rpc(opts: { txs?: Record<number, { hash: string; outcome: unknown }[]>; head?: number; job?: unknown; down?: boolean; unexecuted?: Record<string, number> } = {}) {
  const calls: string[] = [];
  const hidden = { ...(opts.unexecuted ?? {}) };
  const all = Object.values(opts.txs ?? {}).flat();
  const fn = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (opts.down) throw new Error("down");
    const { method, params } = JSON.parse(String(init?.body ?? "{}"));
    calls.push(method === "query" ? `query:${params.request_type === "call_function" ? params.method_name : params.request_type}` : method);
    if (method === "block") {
      const h = params.block_id === undefined ? opts.head ?? 1000 : typeof params.block_id === "number" ? params.block_id : 500;
      return json({ jsonrpc: "2.0", id: 1, result: { header: { height: h, hash: `bh${h}`, timestamp_nanosec: String(BigInt(h) * 10n ** 9n) } } });
    }
    if (method === "EXPERIMENTAL_changes") {
      const list = opts.txs?.[params.block_id] ?? [];
      return json({ jsonrpc: "2.0", id: 1, result: { changes: list.map((t) => ({ cause: { type: "transaction_processing", tx_hash: t.hash }, type: "access_key_update" })) } });
    }
    if (method === "tx") {
      if ((hidden[params.tx_hash] ?? 0) > 0) { hidden[params.tx_hash]--; return json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } } }); }
      const t = all.find((x) => x.hash === params.tx_hash);
      return json(t ? { jsonrpc: "2.0", id: 1, result: t.outcome } : { jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } } });
    }
    if (params.request_type === "view_access_key") return json({ jsonrpc: "2.0", id: 1, result: { nonce: 5, permission: "FullAccess", block_hash: "x", block_height: 1 } });
    const value = params.method_name === "get_job" ? opts.job ?? null : params.method_name === "get_record" ? { passes: 1, fails: 0, unique_buyers: 1, jobs: 1 } : String(QUOTE);
    return json({ jsonrpc: "2.0", id: 1, result: { result: enc(value), block_hash: "Bh", block_height: 1, logs: [] } });
  }) as typeof fetch;
  return { fn, calls };
}

const view = (body: string, over: Record<string, unknown> = {}) => ({
  id: JOB, buyer: ACCOUNT, seller: DEMO_SELLER, price: String(QUOTE), commit_hash: COMMIT, pack_id: "pack-3", status: "accepted",
  created_at_ns: "1", accept_by_ns: "2", review_by_ns: "3", reveal_deadline_ns: "4", accepted_at_ns: "1",
  review: { model: "m", request_sha256: "13".repeat(32), response_sha256: sha256Hex(body), signed_text: "t", signature: "0x" + "ab".repeat(65), signing_address: "0x" + "fe".repeat(20) },
  ...over,
});
const noSleep = async () => {};
/** A sleep that counts its calls (review MUST-1: noSleep can't see a spin). */
const counting = () => { const c = { n: 0, fn: async () => { c.n++; } }; return c; };

/* ---------- submitReviewOf: only the seller's own successful submit_review for THIS job ---------- */

test("L-2 submitReviewOf: reads `response` from the seller's submit_review args; refuses any other signer, receiver, method, job, shape or a failed tx", () => {
  assert.deepEqual(submitReviewOf(sellerTx(H(3)), JOB), { responseBody: BODY, txHash: H(3) });
  const refused: [string, unknown][] = [
    ["another signer", sellerTx(H(3), { signer: ACCOUNT })],
    ["another receiver", sellerTx(H(3), { receiver: "evil.testnet" })],
    ["accept, not submit_review", sellerTx(H(3), { method: "accept" })],
    ["another job's review", sellerTx(H(3), { args: { job_id: "17", response: BODY } })],
    ["this job's args but another job's event", sellerTx(H(3), { logs: [ev("submit_review", { job_id: "17" })] })],
    ["no event", sellerTx(H(3), { logs: [] })],
    ["the tx failed", sellerTx(H(3), { failure: true })],
    ["empty response", sellerTx(H(3), { args: { job_id: JOB, response: "" } })],
    ["response over the escrow's 128 KB", sellerTx(H(3), { args: { job_id: JOB, response: "x".repeat(128 * 1024 + 1) } })],
    ["two actions", sellerTx(H(3), { actions: [{ FunctionCall: { method_name: "submit_review", args: b64({ job_id: JOB, response: BODY }) } }, { Transfer: { deposit: "1" } }] })],
    ["args not base64 JSON", sellerTx(H(3), { actions: [{ FunctionCall: { method_name: "submit_review", args: "%%%" } }] })],
    ["no outcome", null],
  ];
  for (const [why, o] of refused) assert.equal(submitReviewOf(o, JOB), null, why);
});

/* ---------- recoverReviewBody: find the tx on chain, keep the body only when it hashes to get_job's ---------- */

test("L-2 recover: scans the seller's access-key changes from the accept's block, skips other txs, returns the body whose sha256 is get_job's", async () => {
  const net = rpc({
    head: 520,
    txs: {
      503: [{ hash: H(9), outcome: sellerTx(H(9), { method: "accept", logs: [ev("accept", { job_id: JOB })] }) }],
      507: [{ hash: H(8), outcome: sellerTx(H(8), { args: { job_id: "16", response: "{}" }, logs: [ev("submit_review", { job_id: "16" })] }) }],
      511: [{ hash: H(3), outcome: sellerTx(H(3)) }],
    },
  });
  const r = await recoverReviewBody({ fetch: net.fn, jobId: JOB, fromHeight: 500, wantSha256: "0x" + sha256Hex(BODY).toUpperCase(), sleep: noSleep });
  assert.deepEqual(r, { ok: true, responseBody: BODY, txHash: H(3) });
  assert.ok(net.calls.filter((c) => c === "EXPERIMENTAL_changes").length === 12, "blocks 500..511, then stops");
  assert.equal(reviewMatches(view(BODY) as never, r.ok ? r.responseBody : null), true);
});

test("L-2 recover: tampered args (a lying RPC) -> mismatch, the body is dropped; a tx not executed yet is read again", async () => {
  const tampered = BODY.replace("12", "13");
  const net = rpc({ head: 510, txs: { 505: [{ hash: H(3), outcome: sellerTx(H(3), { args: { job_id: JOB, response: tampered } }) }] }, unexecuted: { [H(3)]: 2 } });
  const sleeps = counting();
  const r = await recoverReviewBody({ fetch: net.fn, jobId: JOB, fromHeight: 500, wantSha256: sha256Hex(BODY), sleep: sleeps.fn });
  assert.deepEqual(r, { ok: false, reason: "mismatch", txHash: H(3) });
  assert.ok(net.calls.filter((c) => c === "tx").length === 3, "looked up again until executed");
  assert.equal(sleeps.n, 2, "one sleep after each round stuck on the unexecuted tx (review MUST-1)");
});

test("L-2 recover (review MUST-1): a listed tx the RPC never returns -> one sleep per stuck round, then RPC_UNAVAILABLE after UNSEEN_ROUNDS; no spin", async () => {
  const net = rpc({ head: 510, txs: { 505: [{ hash: H(3), outcome: sellerTx(H(3)) }] }, unexecuted: { [H(3)]: Number.MAX_SAFE_INTEGER } });
  const sleeps = counting();
  await assert.rejects(recoverReviewBody({ fetch: net.fn, jobId: JOB, fromHeight: 500, wantSha256: sha256Hex(BODY), sleep: sleeps.fn }),
    (e: unknown) => e instanceof AccountError && e.code === "RPC_UNAVAILABLE");
  const rounds = net.calls.filter((c) => c === "tx").length;
  assert.equal(rounds, UNSEEN_ROUNDS, "bounded: one lookup per round");
  assert.equal(sleeps.n, UNSEEN_ROUNDS - 1, "a sleep after every stuck round but the last (which gives up)");
  assert.ok(net.calls.length < 100, `bounded RPC calls (${net.calls.length})`);
});

test("L-2 recover (review L-11): transient errors spread over a long scan don't add up once the cursor moves on", async () => {
  let n = 0;
  const base = rpc({ head: 700, txs: { 690: [{ hash: H(3), outcome: sellerTx(H(3)) }] } });
  const flaky = (async (u: string | URL | Request, init?: RequestInit) => {
    if (JSON.parse(String(init?.body ?? "{}")).method === "EXPERIMENTAL_changes" && ++n % 40 === 0) throw new Error("blip");
    return base.fn(u, init);
  }) as typeof fetch;
  const r = await recoverReviewBody({ fetch: flaky, jobId: JOB, fromHeight: 500, wantSha256: sha256Hex(BODY), sleep: counting().fn });
  assert.ok(r.ok, "4+ one-off errors across ~190 blocks still find the review");
});

test("L-2 recover: bounded (not_found after maxBlocks), no_review without a hash, RPC_UNAVAILABLE after repeated failures, AbortError on abort", async () => {
  assert.equal(RECOVER_MAX_BLOCKS, 900);
  const empty = rpc({ head: 2000 });
  assert.deepEqual(await recoverReviewBody({ fetch: empty.fn, jobId: JOB, fromHeight: 500, wantSha256: sha256Hex(BODY), maxBlocks: 20, sleep: noSleep }), { ok: false, reason: "not_found" });
  assert.equal(empty.calls.filter((c) => c === "EXPERIMENTAL_changes").length, 21);
  assert.deepEqual(await recoverReviewBody({ fetch: empty.fn, jobId: JOB, fromHeight: 500, wantSha256: null, sleep: noSleep }), { ok: false, reason: "no_review" });
  await assert.rejects(recoverReviewBody({ fetch: rpc({ down: true }).fn, jobId: JOB, fromHeight: 500, wantSha256: sha256Hex(BODY), sleep: noSleep }), (e: unknown) => e instanceof AccountError && e.code === "RPC_UNAVAILABLE");
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(recoverReviewBody({ fetch: empty.fn, jobId: JOB, fromHeight: 500, wantSha256: sha256Hex(BODY), signal: ctl.signal, sleep: noSleep }), (e: unknown) => (e as Error).name === "AbortError");
  // the start block comes from the accept tx (its transaction_outcome block)
  const withAccept = rpc({ txs: { 1: [{ hash: H(9), outcome: sellerTx(H(9), { method: "accept" }) }] } });
  assert.equal(await txHeight(withAccept.fn, H(9), DEMO_SELLER), 500);
  assert.equal(await txHeight(withAccept.fn, H(10), DEMO_SELLER), null);
});

test("L-2 cache: the recovered body is kept with its submit tx (review L-7), per job", () => {
  const s = memory();
  saveReviewBody(s, JOB, BODY, H(3));
  assert.equal(loadReviewBody(s, JOB), BODY);
  assert.equal(loadReviewTx(s, JOB), H(3));
  assert.equal(loadReviewTx(s, "17"), null);
  saveReviewBody(s, JOB, BODY, "not a hash");
  assert.equal(loadReviewTx(s, JOB), null);
});

/* ---------- the whole reload path through the gate (fake near-api-js) ---------- */

class TransactionExecutionError extends Error {}
class ActionExecutionError extends TransactionExecutionError {}
class InvalidTransactionError extends Error {}
class InvalidNonceError extends InvalidTransactionError {}
function fakeNear(send: () => unknown) {
  const seen = { signed: [] as { receiverId: string; actions: { methodName: string; args: Record<string, string>; gas: bigint; deposit: bigint }[] }[] };
  class JsonRpcProvider { constructor(_o: { url: string }) {} async sendTransactionUntil() { return send(); } async viewTransactionStatus() { throw new Error("unknown"); } }
  class Account {
    id: string; provider: JsonRpcProvider;
    constructor(id: string, provider: JsonRpcProvider) { this.id = id; this.provider = provider; }
    async createSignedTransaction({ receiverId, actions }: { receiverId: string; actions: never[] }) { const transaction = { signerId: this.id, receiverId, actions }; seen.signed.push(transaction); return { transaction }; }
  }
  const near = {
    Account, JsonRpcProvider, baseEncode,
    actions: { functionCall: (methodName: string, args: unknown, gas: bigint, deposit: bigint) => ({ methodName, args, gas, deposit }) },
    encodeTransaction: (t: unknown) => new TextEncoder().encode(JSON.stringify(t, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
  };
  return { seen, loadNear: async () => ({ near, rpcErrors: { TransactionExecutionError, ActionExecutionError, InvalidTransactionError, InvalidNonceError } }) };
}
const revealOk = (hash: string) => ({
  status: { SuccessValue: "" },
  transaction: { hash },
  transaction_outcome: { id: hash, outcome: { executor_id: ACCOUNT, logs: [], tokens_burnt: "1" } },
  receipts_outcome: [
    { block_hash: "B3", outcome: { executor_id: CONTRACT_ID, tokens_burnt: "1", logs: [ev("reveal", { job_id: JOB, buyer: ACCOUNT, seller: DEMO_SELLER, pack_id: "pack-3", found: 4, total: 5, pass_min: 4, passed: true, outcome: "pass" })] } },
    { block_hash: "B4", outcome: { executor_id: CONTRACT_ID, tokens_burnt: "0", logs: [ev("payout", { job_id: JOB, buyer: ACCOUNT, seller: DEMO_SELLER, amount: String(QUOTE), kind: "settle" })] } },
  ],
});
/** A reloaded tab: the buyer and its accepted pack-3 job are in storage, the review body is NOT (the POST never answered). */
function reloadedTab() {
  const storage = memory();
  saveBuyer(storage, {
    version: 1, network: "testnet", account_id: ACCOUNT, public_key: "ed25519:8DR15Yje" + "1".repeat(36), private_key: "ed25519:" + "3".repeat(88),
    status: "created", spent_yocto: String(QUOTE + JOB_GAS_RESERVE_YOCTO), created_at: "2026-11-13T09:00:00.000Z",
  });
  const job: Job = {
    version: 1, network: "testnet", contract: CONTRACT_ID, buyer: ACCOUNT, seller: DEMO_SELLER, pack_id: "pack-3", commit_hash: COMMIT, K, salt: SALT,
    price_yocto: String(QUOTE), reserve_yocto: String(JOB_GAS_RESERVE_YOCTO), burnt_yocto: "0", status: "accepted", job_id: JOB, create_tx: H(1), accept_tx: H(9), close_txs: [],
  };
  saveJob(storage, job);
  assert.equal(loadReviewBody(storage, JOB), null);
  return storage;
}
const revealReq = (response: string) => ({ method: "reveal" as const, args: { job_id: JOB, key: K, salt: SALT, response }, depositYocto: 0n });

test("L-2 reload mid-review -> body recovered from the submit_review args -> the gate reveals it (hash matches), with every M-2 rule intact", async () => {
  const storage = reloadedTab();
  const net = rpc({ head: 515, job: view(BODY), txs: { 1: [{ hash: H(9), outcome: sellerTx(H(9), { method: "accept" }) }], 506: [{ hash: H(3), outcome: sellerTx(H(3)) }] } });
  const from = await txHeight(net.fn, loadJob(storage)!.accept_tx!, DEMO_SELLER);
  const r = await recoverReviewBody({ fetch: net.fn, jobId: JOB, fromHeight: from!, wantSha256: (view(BODY).review as { response_sha256: string }).response_sha256, sleep: noSleep });
  assert.ok(r.ok);
  saveReviewBody(storage, JOB, r.responseBody, r.txHash);
  const fake = fakeNear(() => revealOk(H(51)));
  const out = await signJobAction({ storage, nav: undefined, fetch: net.fn, loadNear: fake.loadNear }, revealReq(loadReviewBody(storage, JOB)!));
  assert.equal(fake.seen.signed.length, 1);
  const tx = fake.seen.signed[0];
  assert.equal(tx.receiverId, CONTRACT_ID);
  assert.deepEqual(tx.actions, [{ methodName: "reveal", args: { job_id: JOB, key: K, salt: SALT, response: BODY }, gas: REVEAL_GAS, deposit: 0n }]);
  assert.equal(out.closed?.kind, "settled");
  assert.equal(loadJob(storage)!.close_txs.length, 1);
  assert.ok(MAX_CLOSE_TRIES === 3);
});

test("L-2 tampered args -> refused: recovery drops the body, and the gate refuses a tampered body with nothing signed and nothing booked", async () => {
  const storage = reloadedTab();
  const tampered = BODY.replace("money", "logic");
  const net = rpc({ head: 515, job: view(BODY), txs: { 506: [{ hash: H(3), outcome: sellerTx(H(3), { args: { job_id: JOB, response: tampered } }) }] } });
  const r = await recoverReviewBody({ fetch: net.fn, jobId: JOB, fromHeight: 500, wantSha256: sha256Hex(BODY), sleep: noSleep });
  assert.deepEqual(r, { ok: false, reason: "mismatch", txHash: H(3) });
  assert.equal(loadReviewBody(storage, JOB), null, "nothing cached");
  // even if a caller skipped the recovery check, the gate re-reads get_job and refuses: the key stays sealed
  const before = storage.getItem("earned-price.buyer.v1");
  const fake = fakeNear(() => assert.fail("must not broadcast"));
  await assert.rejects(signJobAction({ storage, nav: undefined, fetch: net.fn, loadNear: fake.loadNear }, revealReq(tampered)),
    (e: unknown) => e instanceof AccountError && e.code === "BAD_SIGN_REQUEST" && /doesn't hash/.test(e.message));
  assert.equal(fake.seen.signed.length, 0);
  assert.equal(storage.getItem("earned-price.buyer.v1"), before, "no gas booked");
  assert.equal(loadJob(storage)!.close_txs.length, 0, "no try used");
});
