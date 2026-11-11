// T-014 change request: RPC failover must treat "account does not exist" as an answer.
// Uses the real near-api-js 7.4.0 JsonRpcProvider / FailoverRpcProvider against local
// fake RPC servers (127.0.0.1 only), so the error shapes come from the library itself.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FailoverRpcProvider, JsonRpcProvider } from "near-api-js";
import { RPC_URLS, RPC_RETRIES, accountExists, defaultDeps } from "../cli/init.js";

// Byte-for-byte shapes seen from test.rpc.fastnear.com and neart.lava.build on 2026-11-11.
const UNKNOWN_ACCOUNT = {
  jsonrpc: "2.0",
  error: {
    name: "HANDLER_ERROR",
    cause: { info: { block_hash: "x", block_height: 1, requested_account_id: "a.testnet" }, name: "UNKNOWN_ACCOUNT" },
    code: -32000,
    message: "Server error",
    data: "account a.testnet does not exist while viewing",
  },
  id: "1",
};
const DISCONTINUED = { error: "This endpoint has been discontinued.", message: "For an up to date list of available endpoints, visit https://gateway.lavanet.xyz" };
const ACCOUNT = {
  jsonrpc: "2.0",
  result: { amount: "1", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 182, storage_paid_at: 0, block_height: 1, block_hash: "x" },
  id: "1",
};

const servers = [];
after(() => servers.forEach((s) => s.close()));

/** A fake RPC answering every request with `body`; `hits` counts requests. */
async function fakeRpc(body, status = 200) {
  const rpc = { hits: 0 };
  const server = http.createServer((req, res) => {
    rpc.hits++;
    req.resume();
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  rpc.provider = new JsonRpcProvider({ url: `http://127.0.0.1:${server.address().port}` }, { retries: 1 });
  return rpc;
}

const quietly = async (fn) => {
  const orig = console.error; // FailoverRpcProvider logs every failed attempt
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
};

test("regression: real FailoverRpcProvider error (primary UNKNOWN_ACCOUNT, backup discontinued) means not found", async () => {
  const primary = await fakeRpc(UNKNOWN_ACCOUNT);
  const backup = await fakeRpc(DISCONTINUED, 404);
  const failover = new FailoverRpcProvider([primary.provider, backup.provider]);
  // Confirm the library really produces the wrapped shape from Nicho's live run.
  const err = await quietly(() => failover.viewAccount({ accountId: "a.testnet" }).catch((e) => e));
  assert.equal(err.name, "FailoverRpcError");
  assert.deepEqual(err.errors.map((e) => e.name), ["AccountDoesNotExistError", "RpcError"]);
  assert.equal(await quietly(() => accountExists(failover, "a.testnet")), false);
});

test("provider list: UNKNOWN_ACCOUNT on the primary is final; the backup is never asked", async () => {
  const primary = await fakeRpc(UNKNOWN_ACCOUNT);
  const backup = await fakeRpc(DISCONTINUED, 404);
  assert.equal(await accountExists([primary.provider, backup.provider], "a.testnet"), false);
  assert.equal(primary.hits, 1);
  assert.equal(backup.hits, 0);
});

test("provider list: a dead primary fails over to a backup that answers", async () => {
  const dead = await fakeRpc(DISCONTINUED, 404);
  const missing = await fakeRpc(UNKNOWN_ACCOUNT);
  const found = await fakeRpc(ACCOUNT);
  assert.equal(await accountExists([dead.provider, missing.provider], "a.testnet"), false);
  assert.equal(await accountExists([dead.provider, found.provider], "a.testnet"), true);
});

test("provider list: every RPC dead is RPC_UNAVAILABLE", async () => {
  const a = await fakeRpc(DISCONTINUED, 404);
  const b = await fakeRpc(DISCONTINUED, 404);
  await assert.rejects(
    accountExists([a.provider, b.provider], "a.testnet"),
    (e) => e.code === "RPC_UNAVAILABLE" && Array.isArray(e.cause) && e.cause.length === 2,
  );
});

const throwing = (message, name = "Error") => ({
  viewAccount: async () => {
    const e = new Error(message);
    e.name = name;
    throw e;
  },
});

test("not-found matching is account-specific: other 'does not exist' errors fail over", async () => {
  // Both near-api-js account phrasings mean not found.
  assert.equal(await accountExists(throwing("account a.testnet does not exist while viewing"), "a.testnet"), false);
  assert.equal(await accountExists(throwing("Account a.testnet doesn't exist"), "a.testnet"), false);
  // Unrelated "does not exist" messages are outages, not answers.
  for (const msg of ["access key ed25519:x does not exist while viewing", "Block 123 does not exist", "method does not exist"]) {
    await assert.rejects(accountExists(throwing(msg), "a.testnet"), (e) => e.code === "RPC_UNAVAILABLE", msg);
  }
  // ...and fail over to a backup that does answer.
  const found = { viewAccount: async () => ({}) };
  assert.equal(await accountExists([throwing("Block 123 does not exist"), found], "a.testnet"), true);
});

test("defaultDeps: RPC providers retry 3 times, not the library default 12", async () => {
  const deps = await defaultDeps({});
  assert.equal(RPC_RETRIES, 3);
  assert.equal(deps.provider.length, 2);
  for (const p of deps.provider) assert.equal(p.options.retries, 3);
});

test("RPC_URLS: no discontinued endpoints; two https testnet RPCs", () => {
  assert.deepEqual(RPC_URLS, ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"]);
  assert.ok(!RPC_URLS.some((u) => /lava\.build|pagoda\.co/.test(u)));
});
