// T-028 seller chain adapter (site-api/chain.js) and env wiring (site-api/vercel.js depsFromEnv).
// Views run on a mocked JSON-RPC fetch; txs on a fake sendCreateTx-shaped `send`. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyPair } from "near-api-js";
import { ACCEPT_GAS, SUBMIT_GAS, SELLER_KEY_METHODS, classifyOutcome, sellerChain, sellerKeyScope, viewAccessKey } from "../site-api/chain.js";
import { memoryStore } from "../site-api/caps.js";
import { depsFromEnv, liveAllowed } from "../site-api/vercel.js";
import { fcKeyCommand } from "../scripts/seller-fc-key.mjs";

const CONTRACT = "earned-price.testnet";
const SELLER = "seller.earned-price.testnet";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

function rpc(valueByMethod) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const args = JSON.parse(Buffer.from(body.params.args_base64, "base64").toString());
    calls.push({ url, method: body.params.method_name, args, account: body.params.account_id });
    const v = valueByMethod[body.params.method_name];
    const result = [...Buffer.from(JSON.stringify(v))];
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: "earned", result: { result, block_hash: "h" } }) };
  };
  return { fetch, calls };
}

test("views: get_job {id}, signers {}, get_record {seller} on the escrow contract", async () => {
  const r = rpc({ get_job: { id: "7", status: "open" }, signers: ["0xabc"], get_record: { passes: 1, fails: 2, jobs: 3 } });
  const c = sellerChain({ fetch: r.fetch, urls: ["https://rpc.test"], contractId: CONTRACT, sellerId: SELLER, send: async () => ({}) });
  assert.deepEqual(await c.getJob("7"), { id: "7", status: "open" });
  assert.deepEqual(await c.signers(), ["0xabc"]);
  assert.deepEqual(await c.getRecord(SELLER), { passes: 1, fails: 2, jobs: 3 });
  assert.deepEqual(r.calls.map((x) => [x.method, x.args, x.account]), [
    ["get_job", { id: "7" }, CONTRACT],
    ["signers", {}, CONTRACT],
    ["get_record", { seller: SELLER }, CONTRACT],
  ]);
});

test("txs: accept/decline 30 Tgas, submit_review 300 Tgas, no deposit, exact args", async () => {
  const sent = [];
  const send = async (req) => {
    sent.push(req);
    req.onSigned("HASH1");
    return { status: { SuccessValue: "" }, transaction: { hash: "HASH1" } };
  };
  const c = sellerChain({ fetch: null, urls: [], contractId: CONTRACT, sellerId: SELLER, send });
  assert.deepEqual(await c.accept("7"), { status: "landed", txHash: "HASH1" });
  await c.decline("8");
  const args = { job_id: "7", model: "m", request_sha256: "a", response_sha256: "b", signature: "s", signing_address: "0x1", response: "{}" };
  await c.submitReview(args);
  assert.deepEqual(sent.map((s) => [s.methodName, s.args, s.gas, s.depositYocto, s.contractId]), [
    ["accept", { job_id: "7" }, ACCEPT_GAS, 0n, CONTRACT],
    ["decline", { job_id: "8" }, ACCEPT_GAS, 0n, CONTRACT],
    ["submit_review", args, SUBMIT_GAS, 0n, CONTRACT],
  ]);
  assert.equal(ACCEPT_GAS, 30_000_000_000_000n);
  assert.equal(SUBMIT_GAS, 300_000_000_000_000n);
});

test("txs never throw: notSent -> not_sent, landedFailure -> failed, anything else -> unknown (hash kept)", async () => {
  const mk = (err) =>
    sellerChain({
      urls: [],
      contractId: CONTRACT,
      sellerId: SELLER,
      send: async (req) => {
        req.onSigned("H");
        throw err;
      },
    });
  assert.deepEqual(await mk(Object.assign(new Error("x"), { notSent: true })).accept("1"), { status: "not_sent", txHash: "H" });
  assert.deepEqual(await mk(Object.assign(new Error("x"), { landedFailure: true })).accept("1"), { status: "failed", txHash: "H", message: "refused on-chain" });
  assert.deepEqual(await mk(new Error("socket hang up ed25519:SECRET")).accept("1"), { status: "unknown", txHash: "H" });
});

test("classifyOutcome: Failure keeps only the contract's panic text; unreadable = unknown", () => {
  const fail = { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: Earned Price: the review deadline has passed" } } } } }, transaction: { hash: "T" } };
  assert.deepEqual(classifyOutcome(fail), { status: "failed", txHash: "T", message: "Earned Price: the review deadline has passed" });
  assert.deepEqual(classifyOutcome({ status: { Failure: { InvalidTxError: {} } } }, "S"), { status: "failed", txHash: "S", message: "refused on-chain" });
  assert.deepEqual(classifyOutcome({ status: { SuccessValue: "" }, transaction_outcome: { id: "O" } }), { status: "landed", txHash: "O" });
  assert.deepEqual(classifyOutcome({ status: "Started" }, "S"), { status: "unknown", txHash: "S" });
  assert.deepEqual(classifyOutcome(undefined, null), { status: "unknown", txHash: null });
});

test("depsFromEnv: keys only from env, seller key needs the ed25519: prefix, blank key = not set, secrets not exposed", () => {
  const env = { NEAR_AI_API_KEY: "  sk-live-DO-NOT-LEAK  ", EARNED_SELLER_PRIVATE_KEY: "ed25519:SELLER-DO-NOT-LEAK", VISITOR_HASH_SECRET: "v" };
  const d = depsFromEnv(env, async () => {
    throw new Error("no network in tests");
  });
  assert.equal(d.apiKey, "sk-live-DO-NOT-LEAK");
  assert.equal(d.sellerKeyConfigured, true);
  assert.equal(d.sellerId, SELLER);
  assert.equal(d.store.kind, "memory");
  assert.ok(!JSON.stringify(d.chain).includes("SELLER-DO-NOT-LEAK"), "seller key only inside closures");
  assert.equal(depsFromEnv({ NEAR_AI_API_KEY: "   " }).apiKey, undefined);
  assert.equal(depsFromEnv({ EARNED_SELLER_PRIVATE_KEY: "SELLER" }).sellerKeyConfigured, false);
  assert.match(depsFromEnv({}).visitorSecret, /^[0-9a-f]{64}$/, "random per instance when unset");
});

// ---- view_access_key (M-1 buyer binding, M-2 seller key scope) ----
const PK = "ed25519:3drrS8iDwsEFZ5jyJYY4ZbzR6uj8fP9ebuQ1ysysyYSV";
const FC = { FunctionCall: { allowance: "5000000000000000000000000", receiver_id: CONTRACT, method_names: ["accept", "decline", "submit_review"] } };

/** JSON-RPC fetch that answers each URL in turn with the given replies (an Error = network failure). */
function akRpc(...replies) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, params: JSON.parse(init.body).params });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    return { ok: true, status: 200, json: async () => r };
  };
  return { fetch, calls };
}
const okKey = (permission) => ({ jsonrpc: "2.0", id: "earned", result: { nonce: 5, permission, block_height: 1, block_hash: "h" } });

test("viewAccessKey: query view_access_key at final; returns the permission (FullAccess / FunctionCall)", async () => {
  const r = akRpc(okKey("FullAccess"));
  assert.equal(await viewAccessKey({ fetch: r.fetch, urls: ["https://a"], accountId: "judge1.testnet", publicKey: PK }), "FullAccess");
  assert.deepEqual(r.calls[0].params, { request_type: "view_access_key", finality: "final", account_id: "judge1.testnet", public_key: PK });
  assert.deepEqual(await viewAccessKey({ fetch: akRpc(okKey(FC)).fetch, urls: ["https://a"], accountId: SELLER, publicKey: PK }), FC);
});

test("viewAccessKey: an unknown key or account is null (no failover); RPC errors fail over, then throw", async () => {
  const unknownKey = { jsonrpc: "2.0", id: "earned", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY", info: { public_key: PK } } } };
  const unknownAcct = { jsonrpc: "2.0", id: "earned", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} } } };
  const legacy = { jsonrpc: "2.0", id: "earned", result: { error: `access key ${PK} does not exist while viewing`, logs: [], block_height: 1, block_hash: "h" } };
  for (const reply of [unknownKey, unknownAcct, legacy]) {
    const r = akRpc(reply);
    assert.equal(await viewAccessKey({ fetch: r.fetch, urls: ["https://a", "https://b"], accountId: "x.testnet", publicKey: PK }), null);
    assert.equal(r.calls.length, 1);
  }
  const internal = { jsonrpc: "2.0", id: "earned", error: { name: "HANDLER_ERROR", cause: { name: "INTERNAL_ERROR" } } };
  const r = akRpc(new Error("down"), internal, okKey("FullAccess"));
  assert.equal(await viewAccessKey({ fetch: r.fetch, urls: ["https://a", "https://b", "https://c"], accountId: "x.testnet", publicKey: PK }), "FullAccess");
  assert.deepEqual(r.calls.map((c) => c.url), ["https://a", "https://b", "https://c"]);
  await assert.rejects(viewAccessKey({ fetch: akRpc(new Error("down")).fetch, urls: ["https://a", "https://b"], accountId: "x.testnet", publicKey: PK }));
});

test("chain.hasAccessKey: true when the key is on the account, false when not", async () => {
  const yes = sellerChain({ fetch: akRpc(okKey("FullAccess")).fetch, urls: ["https://a"], contractId: CONTRACT, sellerId: SELLER, send: async () => ({}) });
  assert.equal(await yes.hasAccessKey("judge1.testnet", PK), true);
  const no = sellerChain({ fetch: akRpc({ jsonrpc: "2.0", id: "e", error: { cause: { name: "UNKNOWN_ACCESS_KEY" } } }).fetch, urls: ["https://a"], contractId: CONTRACT, sellerId: SELLER, send: async () => ({}) });
  assert.equal(await no.hasAccessKey("judge1.testnet", PK), false);
});

test("sellerKeyScope: only a function-call key for the escrow's accept/decline/submit_review is ok", () => {
  assert.deepEqual(SELLER_KEY_METHODS, ["accept", "decline", "submit_review"]);
  assert.equal(sellerKeyScope(FC, CONTRACT), "ok");
  assert.equal(sellerKeyScope({ FunctionCall: { ...FC.FunctionCall, method_names: ["submit_review"] } }, CONTRACT), "ok", "narrower is fine");
  assert.equal(sellerKeyScope("FullAccess", CONTRACT), "full_access");
  assert.equal(sellerKeyScope(null, CONTRACT), "missing");
  assert.equal(sellerKeyScope({ FunctionCall: { ...FC.FunctionCall, method_names: [] } }, CONTRACT), "wrong_scope", "empty list = any method");
  assert.equal(sellerKeyScope({ FunctionCall: { ...FC.FunctionCall, method_names: ["accept", "settle"] } }, CONTRACT), "wrong_scope");
  assert.equal(sellerKeyScope({ FunctionCall: { ...FC.FunctionCall, receiver_id: "other.testnet" } }, CONTRACT), "wrong_scope");
  assert.equal(sellerKeyScope({ weird: 1 }, CONTRACT), "wrong_scope");
});

test("depsFromEnv sellerKeyCheck: derives the public key, reads it on the seller account once per instance", async () => {
  const kp = KeyPair.fromRandom("ed25519"); // test-only key
  const r = akRpc(okKey("FullAccess"));
  const d = depsFromEnv({ EARNED_SELLER_PRIVATE_KEY: kp.toString() }, r.fetch);
  assert.equal(await d.sellerKeyCheck(), "full_access");
  assert.equal(await d.sellerKeyCheck(), "full_access");
  assert.equal(r.calls.length, 1, "verdict cached per instance");
  assert.deepEqual([r.calls[0].params.account_id, r.calls[0].params.public_key], [SELLER, kp.getPublicKey().toString()]);
  const d2 = depsFromEnv({ EARNED_SELLER_PRIVATE_KEY: kp.toString() }, akRpc(okKey(FC)).fetch);
  assert.equal(await d2.sellerKeyCheck(), "ok");
});

// ---- H-1 / L-2: live reviews need a durable store and a real visitor secret ----
test("liveAllowed: memory store never in production; Upstash needs VISITOR_HASH_SECRET >= 32 chars", () => {
  const mem = memoryStore();
  const up = { kind: "upstash" };
  const secret = "s".repeat(32);
  assert.equal(liveAllowed({}, mem), false, "memory store = not configured");
  assert.equal(liveAllowed({ EARNED_ALLOW_MEMORY_CAPS: "1" }, mem), true, "local dev opt-in");
  assert.equal(liveAllowed({ EARNED_ALLOW_MEMORY_CAPS: "1", VERCEL_ENV: "production" }, mem), false, "opt-in ignored in production");
  assert.equal(liveAllowed({ VISITOR_HASH_SECRET: secret }, up), true);
  assert.equal(liveAllowed({ VISITOR_HASH_SECRET: "short" }, up), false);
  assert.equal(liveAllowed({}, up), false);
});

test("depsFromEnv: liveEnabled false without Upstash env, true with Upstash + secret", () => {
  const noNet = async () => {
    throw new Error("no network in tests");
  };
  assert.equal(depsFromEnv({ NEAR_AI_API_KEY: "k", EARNED_SELLER_PRIVATE_KEY: "ed25519:x" }, noNet).liveEnabled, false);
  const env = { UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t", VISITOR_HASH_SECRET: "v".repeat(40) };
  assert.equal(depsFromEnv(env, noNet).liveEnabled, true);
});

// ---- M-2 deploy helper ----
test("seller-fc-key: near CLI command adds a function-call key for the escrow's 3 methods, testnet only", () => {
  const argv = fcKeyCommand(PK);
  const at = (flag) => argv[argv.indexOf(flag) + 1];
  assert.deepEqual(argv.slice(0, 5), ["near", "account", "add-key", SELLER, "grant-function-call-access"]);
  assert.equal(at("--contract-account-id"), CONTRACT);
  assert.equal(at("--function-names"), "accept, decline, submit_review");
  assert.equal(at("--allowance"), "5 NEAR");
  assert.equal(at("use-manually-provided-public-key"), PK);
  assert.ok(!argv.includes("grant-full-access"));
  assert.equal(at("network-config"), "testnet");
  assert.throws(() => fcKeyCommand(PK, { seller: "seller.near" }), /testnet/);
});
