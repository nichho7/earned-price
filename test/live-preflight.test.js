// scripts/live-preflight.mjs + scripts/live-run.sh (T-032). No network: a fake fetch answers the
// recorded-shape JSON-RPC bodies of view_account / view_access_key; nothing is signed or sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { KeyPair } from "near-api-js";
import { EXPECTED_CODE_HASH, printChecks, runPreflight } from "../scripts/live-preflight.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const SELLER = "seller.earned-price.testnet";
const CONTRACT = "earned-price.testnet";
const kp = KeyPair.fromRandom("ed25519");
const SK = kp.toString();
const PK = kp.getPublicKey().toString();
const API = "nearai-test-key-do-not-use-4444";
const NEAR = 10n ** 24n;
const derivePublicKey = (sk) => KeyPair.fromString(sk).getPublicKey().toString();

/** Fake testnet: accounts { id: { amount, code_hash } }, keys { "acct pk": permission }. */
function fakeRpc({ accounts = {}, keys = {}, down = false } = {}) {
  const calls = [];
  const fetch = async (_url, init) => {
    const p = JSON.parse(init.body).params;
    calls.push(p.request_type);
    if (down) throw new Error("ECONNREFUSED");
    const reply = (body) => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: "preflight", ...body }) });
    if (p.request_type === "view_account") {
      const a = accounts[p.account_id];
      if (!a) return reply({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } });
      return reply({ result: { amount: a.amount.toString(), locked: "0", code_hash: a.code_hash ?? "11111111111111111111111111111111", storage_usage: 100, block_height: 1 } });
    }
    if (p.request_type === "view_access_key") {
      const perm = keys[`${p.account_id} ${p.public_key}`];
      if (!perm) return reply({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY" } } });
      return reply({ result: { nonce: 1, permission: perm, block_height: 1 } });
    }
    throw new Error(`unexpected ${p.request_type}`);
  };
  return { fetch, calls };
}

const fcKey = (over = {}) => ({ FunctionCall: { allowance: (5n * NEAR).toString(), receiver_id: CONTRACT, method_names: ["accept", "decline", "submit_review"], ...over } });
const goodChain = (perm = fcKey()) =>
  fakeRpc({
    accounts: { [CONTRACT]: { amount: 9n * NEAR, code_hash: EXPECTED_CODE_HASH }, [SELLER]: { amount: NEAR } },
    keys: { [`${SELLER} ${PK}`]: perm },
  });
const env = { NEAR_AI_API_KEY: API, EARNED_SELLER_PRIVATE_KEY: SK };
const failed = (checks) => checks.filter((c) => !c.ok).map((c) => c.name);

test("preflight: everything in place (function-call seller key) -> all OK, only views, secrets never printed", async () => {
  const rpc = goodChain();
  const checks = await runPreflight({ env, fetch: rpc.fetch, urls: ["https://a.test"], derivePublicKey, home: mkdtempSync(join(tmpdir(), "live-")) });
  assert.deepEqual(failed(checks), []);
  assert.deepEqual(rpc.calls, ["view_account", "view_account", "view_access_key"]);
  const lines = [];
  assert.equal(printChecks(checks, (l) => lines.push(l)), true);
  const out = lines.join("\n");
  assert.match(out, /PREFLIGHT OK: nothing was sent\./);
  assert.ok(!out.includes(SK) && !out.includes(API), "no secret in the output");
});

test("preflight: missing env vars, missing seller account, wrong code hash -> each named with its fix; exit path false", async () => {
  const rpc = fakeRpc({ accounts: { [CONTRACT]: { amount: NEAR, code_hash: "OtherHash111" } } });
  const checks = await runPreflight({ env: {}, fetch: rpc.fetch, urls: ["https://a.test"], derivePublicKey });
  assert.deepEqual(failed(checks), ["NEAR AI key", "seller key", "escrow contract", "seller account"]);
  const lines = [];
  assert.equal(printChecks(checks, (l) => lines.push(l)), false);
  const out = lines.join("\n");
  assert.match(out, /export NEAR_AI_API_KEY/);
  assert.match(out, /export EARNED_SELLER_PRIVATE_KEY/);
  assert.match(out, /seller\.earned-price\.testnet does not exist[\s\S]*fix: create seller\.earned-price\.testnet/);
  assert.match(out, /expected 3j1YYcy6bDSMyN2bUEnE8uQc4s3HbHWfc4dAs3NC9byG/);
  assert.match(out, /PREFLIGHT FAILED: 4 item\(s\) to fix\. Nothing was sent\./);
});

test("preflight: the seller key must be on the seller account and able to call accept + submit_review", async () => {
  const run = (perm, e = env) => runPreflight({ env: e, fetch: (perm === null ? fakeRpc({ accounts: { [CONTRACT]: { amount: NEAR, code_hash: EXPECTED_CODE_HASH }, [SELLER]: { amount: NEAR } } }) : goodChain(perm)).fetch, urls: ["https://a.test"], derivePublicKey });
  assert.deepEqual(failed(await run(null)), ["seller key on-chain"], "key not added to the seller");
  assert.deepEqual(failed(await run(fcKey({ receiver_id: "other.testnet" }))), ["seller key on-chain"]);
  assert.deepEqual(failed(await run(fcKey({ method_names: ["accept"] }))), ["seller key on-chain"]);
  assert.deepEqual(failed(await run(fcKey({ allowance: "1" }))), ["seller key on-chain"]);
  assert.deepEqual(failed(await run(fcKey({ method_names: [], allowance: null }))), [], "any method, unlimited allowance");
  assert.deepEqual(failed(await run("FullAccess")), []);
  assert.deepEqual(failed(await run(fcKey(), { ...env, EARNED_SELLER_PRIVATE_KEY: "not-a-key" })), ["seller key"]);
});

test("preflight: a low seller balance, an open job in EARNED_HOME and a down RPC are refused", async () => {
  const low = fakeRpc({ accounts: { [CONTRACT]: { amount: NEAR, code_hash: EXPECTED_CODE_HASH }, [SELLER]: { amount: 10n ** 22n } }, keys: { [`${SELLER} ${PK}`]: fcKey() } });
  assert.deepEqual(failed(await runPreflight({ env, fetch: low.fetch, urls: ["https://a.test"], derivePublicKey })), ["seller account"]);
  const home = mkdtempSync(join(tmpdir(), "live-"));
  writeFileSync(join(home, "job.json"), JSON.stringify({ status: "reviewed" }));
  const checks = await runPreflight({ env, fetch: goodChain().fetch, urls: ["https://a.test"], derivePublicKey, home });
  assert.deepEqual(failed(checks), ["buyer home"]);
  assert.match(checks.at(-1).fix, /still reviewed/);
  writeFileSync(join(home, "job.json"), JSON.stringify({ status: "closed" }));
  assert.deepEqual(failed(await runPreflight({ env, fetch: goodChain().fetch, urls: ["https://a.test"], derivePublicKey, home })), []);
  const down = fakeRpc({ down: true });
  assert.deepEqual(failed(await runPreflight({ env, fetch: down.fetch, urls: ["https://a.test"], derivePublicKey })), ["escrow contract", "seller account"]);
});

test("live-run.sh: valid bash; --help and bad options exit before any network call", () => {
  const sh = join(ROOT, "scripts/live-run.sh");
  assert.equal(spawnSync("bash", ["-n", sh]).status, 0);
  const help = spawnSync("bash", [sh, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /preflight only: checks everything, signs and sends nothing/);
  const bad = spawnSync("bash", [sh, "--rigged"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown option --rigged/);
});
