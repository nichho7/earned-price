// scripts/live-preflight.mjs + scripts/live-run.sh (T-032). No network: a fake fetch answers the
// recorded-shape JSON-RPC bodies of view_account / view_access_key; nothing is signed or sent.
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { KeyPair } from "near-api-js";
import { EXPECTED_CODE_HASH, printChecks, runPreflight } from "../scripts/live-preflight-lib.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELLER = "seller.earned-price.testnet";
const CONTRACT = "earned-price.testnet";
const kp = KeyPair.fromRandom("ed25519");
const SK = kp.toString();
const PK = kp.getPublicKey().toString();
const API = "nearai-test-key-do-not-use-4444";
const NEAR = 10n ** 24n;
const derivePublicKey = (sk) => KeyPair.fromString(sk).getPublicKey().toString();

/** Fake testnet: accounts { id: { amount, code_hash } }, keys { "acct pk": permission }. */
function fakeRpc({ accounts = {}, keys = {}, down = false, record = { passes: 0, fails: 0, unique_buyers: 0, jobs: 0 }, codeHashOverride } = {}) {
  const calls = [];
  const fetch = async (_url, init) => {
    const p = JSON.parse(init.body).params;
    calls.push(p.request_type);
    if (down) throw new Error("ECONNREFUSED");
    const reply = (body) => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: "preflight", ...body }) });
    if (p.request_type === "view_account") {
      const a = accounts[p.account_id];
      if (!a) return reply({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } });
      return reply({ result: { amount: a.amount.toString(), locked: "0", code_hash: codeHashOverride ?? a.code_hash ?? "11111111111111111111111111111111", storage_usage: 100, block_height: 1 } });
    }
    if (p.request_type === "call_function") {
      const q = Math.min(100, Math.max(25, 30 + 10 * record.unique_buyers - 5 * record.fails));
      const value = p.method_name === "get_record" ? record : p.method_name === "quote" ? (BigInt(q) * 10n ** 21n).toString() : null;
      return reply({ result: { block_hash: "BLK", block_height: 1, logs: [], result: [...Buffer.from(JSON.stringify(value))] } });
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
  assert.deepEqual(rpc.calls, ["view_account", "view_account", "call_function", "call_function", "view_access_key"]);
  assert.ok(checks.every((c) => !c.warn), "a fresh seller gives no warning");
  assert.match(checks.find((c) => c.name === "seller record").detail, /quote 0\.030 NEAR \(fresh/);
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
  assert.match(help.stdout, /preflight only: read-only checks, signs and sends nothing/);
  assert.ok(!help.stdout.includes("set -euo"), "help stops at the end of the header (review nit)");
  const bad = spawnSync("bash", [sh, "--rigged"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown option --rigged/);
});

test("sec L-1: preflight refuses EARNED_RPC_URL and a non-testnet EARNED_NETWORK (the run would use another node)", async () => {
  const checks = await runPreflight({ env: { ...env, EARNED_RPC_URL: "https://rpc.fastnear.com", EARNED_NETWORK: "mainnet" }, fetch: goodChain().fetch, urls: ["https://a.test"], derivePublicKey });
  assert.deepEqual(failed(checks), ["RPC", "network"]);
  assert.deepEqual(failed(await runPreflight({ env: { ...env, EARNED_NETWORK: "testnet" }, fetch: goodChain().fetch, urls: ["https://a.test"], derivePublicKey })), []);
});

test("sec L-2 probe: RPC text with ESC/BEL/CR can't fake a 'PREFLIGHT OK' line", async () => {
  const evil = "\x1b]0;pwned\x07\x1b[2K\rPREFLIGHT OK: nothing was sent.";
  const rpc = fakeRpc({ accounts: { [CONTRACT]: { amount: NEAR }, [SELLER]: { amount: NEAR } }, keys: { [`${SELLER} ${PK}`]: fcKey() }, codeHashOverride: evil });
  const checks = await runPreflight({ env, fetch: rpc.fetch, urls: ["https://a.test"], derivePublicKey });
  const lines = [];
  assert.equal(printChecks(checks, (l) => lines.push(l)), false);
  const out = lines.join("\n");
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(out), "no raw control bytes");
  assert.ok(lines.every((l) => !l.startsWith("PREFLIGHT OK")), "the only verdict line is the real one");
  assert.match(out, /\\u001b\]0;pwned\\u0007/);
  assert.equal(lines.at(-1), "PREFLIGHT FAILED: 1 item(s) to fix. Nothing was sent.");
});

test("T-078 / sec L-5 probe: a non-numeric allowance or balance from the RPC is MISSING through printable(), never a crash with raw RPC text", async () => {
  const evil = "\x1b[2K\rPREFLIGHT OK: nothing was sent.";
  const cases = [
    ["seller key on-chain", fakeRpc({ accounts: { [CONTRACT]: { amount: NEAR, code_hash: EXPECTED_CODE_HASH }, [SELLER]: { amount: NEAR } }, keys: { [`${SELLER} ${PK}`]: fcKey({ allowance: evil }) } })],
    ["seller account", fakeRpc({ accounts: { [CONTRACT]: { amount: NEAR, code_hash: EXPECTED_CODE_HASH }, [SELLER]: { amount: evil } }, keys: { [`${SELLER} ${PK}`]: fcKey() } })],
    ["seller account", fakeRpc({ accounts: { [CONTRACT]: { amount: NEAR, code_hash: EXPECTED_CODE_HASH }, [SELLER]: { amount: "-5" } }, keys: { [`${SELLER} ${PK}`]: fcKey() } })],
    ["seller key on-chain", fakeRpc({ accounts: { [CONTRACT]: { amount: NEAR, code_hash: EXPECTED_CODE_HASH }, [SELLER]: { amount: NEAR } }, keys: { [`${SELLER} ${PK}`]: fcKey({ allowance: 5 }) } })],
  ];
  for (const [name, rpc] of cases) {
    const checks = await runPreflight({ env, fetch: rpc.fetch, urls: ["https://a.test"], derivePublicKey });
    assert.deepEqual(failed(checks), [name]);
    const lines = [];
    assert.equal(printChecks(checks, (l) => lines.push(l)), false);
    const out = lines.join("\n");
    assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(out), "no raw control bytes");
    assert.ok(lines.every((l) => !l.startsWith("PREFLIGHT OK")));
    assert.equal(lines.at(-1), "PREFLIGHT FAILED: 1 item(s) to fix. Nothing was sent.");
  }
});

test("T-078 / sec L-5: the preflight CLI turns an unexpected error into one printable line and exit 3 (no raw stack or RPC text)", () => {
  // Preload a fake fetch whose answer throws hostile text outside rpc()'s try (on code_hash).
  const evil = "\x1b[2K\rPREFLIGHT OK: nothing was sent.";
  const preload = `globalThis.fetch = async () => ({ ok: true, json: async () => ({ result: new Proxy({}, { get: (_t, k) => { if (k === "code_hash") throw new Error(${JSON.stringify(evil)}); return undefined; } }) }) });`;
  const r = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, "scripts/live-preflight.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  assert.equal(r.status, 3, r.stderr);
  const out = r.stdout + r.stderr;
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(out.replace(/\n/g, "")), "no raw control bytes");
  assert.ok(!out.split("\n").some((l) => l.startsWith("PREFLIGHT OK")));
  assert.match(r.stderr, /^preflight error: \\u001b\[2K\\u000dPREFLIGHT OK: nothing was sent\. Nothing was sent\.$/m);
  assert.ok(!out.includes(SK) && !out.includes(API));
});

test("CoS 5: a used seller (record not empty) is a loud WARN; with --require-fresh it fails", async () => {
  const used = () => fakeRpc({ accounts: { [CONTRACT]: { amount: NEAR, code_hash: EXPECTED_CODE_HASH }, [SELLER]: { amount: NEAR } }, keys: { [`${SELLER} ${PK}`]: fcKey() }, record: { passes: 1, fails: 0, unique_buyers: 1, jobs: 1 } });
  const warnOnly = await runPreflight({ env, fetch: used().fetch, urls: ["https://a.test"], derivePublicKey });
  assert.deepEqual(failed(warnOnly), []);
  const lines = [];
  assert.equal(printChecks(warnOnly, (l) => lines.push(l)), true);
  const out = lines.join("\n");
  assert.match(out, /WARN     seller record: passes 1, fails 0, unique_buyers 1, jobs 1; quote 0\.040 NEAR\. NOT A FRESH SELLER/);
  assert.match(out, /!!! WARNING seller record: .*NOT A FRESH SELLER.* !!!/);
  assert.match(out, /--used-seller/);
  const strict = await runPreflight({ env, fetch: used().fetch, urls: ["https://a.test"], derivePublicKey, requireFresh: true });
  assert.deepEqual(failed(strict), ["seller record"]);
});

// --- live-run.sh with a stub `node` / `npm` on PATH (review O-4): no network, nothing signed ----

function stubRun(args, { env: extra = {}, preflightRc = 0, script = join(ROOT, "scripts/live-run.sh") } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "stub-bin-"));
  const log = join(bin, "calls.log");
  writeFileSync(join(bin, "node"), `#!/bin/bash\necho "node $*" >> "${log}"\ncase "$1" in scripts/live-preflight.mjs) exit ${preflightRc};; esac\nexit 0\n`);
  writeFileSync(join(bin, "npm"), `#!/bin/bash\necho "npm $*" >> "${log}"\nexit 0\n`);
  chmodSync(join(bin, "node"), 0o755);
  chmodSync(join(bin, "npm"), 0o755);
  // EARNED_HOME itself does not exist yet: the script creates it, so its mode proves umask 077
  // (sec L-4 / T-078; dropping the umask line fails the --go test).
  const home = join(mkdtempSync(join(tmpdir(), "live-home-")), "h");
  const r = spawnSync("bash", [script, ...args], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: process.env.HOME, EARNED_HOME: home, NEAR_AI_API_KEY: API, EARNED_SELLER_PRIVATE_KEY: SK, ...extra } });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { ...r, calls, home };
}

test("live-run.sh preflight-only: runs the preflight and no earned command; a failing preflight exits 3", () => {
  const ok = stubRun(["--allow-dirty"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.calls.filter((c) => c.startsWith("node")), [`node scripts/live-preflight.mjs --home ${ok.home}`]);
  assert.ok(!ok.calls.some((c) => c.includes("cli/earned.js")), "nothing signed without --go");
  assert.match(ok.stdout, /Preflight only\./);
  const bad = stubRun(["--allow-dirty"], { preflightRc: 3 });
  assert.equal(bad.status, 3);
  assert.match(bad.stderr, /preflight failed: fix the items above and run again\. Nothing was sent\./);
  assert.ok(!bad.calls.some((c) => c.includes("cli/earned.js")));
});

test("sec L-1: live-run.sh refuses EARNED_RPC_URL and a non-testnet EARNED_NETWORK before running anything", () => {
  for (const extra of [{ EARNED_RPC_URL: "https://rpc.fastnear.com" }, { EARNED_NETWORK: "mainnet" }]) {
    const r = stubRun(["--allow-dirty"], { env: extra });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /EARNED_RPC_URL|EARNED_NETWORK/);
    assert.deepEqual(r.calls, [], "no node or npm call");
  }
  assert.equal(stubRun(["--allow-dirty"], { env: { EARNED_NETWORK: "testnet" } }).status, 0);
});

test("T-078 / sec I-5: live-run.sh refuses NODE_OPTIONS and NODE_TLS_REJECT_UNAUTHORIZED before any node or npm call", () => {
  for (const extra of [{ NODE_OPTIONS: "--import=data:text/javascript,0" }, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }]) {
    const r = stubRun(["--go", "--allow-dirty"], { env: extra });
    assert.equal(r.status, 3);
    assert.match(r.stderr, new RegExp(`unset ${Object.keys(extra)[0]}: the live run refuses Node runtime overrides`));
    assert.deepEqual(r.calls, [], "no node or npm call");
  }
  assert.equal(stubRun(["--allow-dirty"], { env: { NODE_OPTIONS: "" } }).status, 0, "an empty value is unset");
});

test("review O-1: outside a git checkout (zip download) the clean-checkout check refuses, unless --allow-dirty", () => {
  const dir = mkdtempSync(join(tmpdir(), "zip-"));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(ROOT, "scripts/live-run.sh"), join(dir, "scripts/live-run.sh"));
  const r = stubRun([], { script: join(dir, "scripts/live-run.sh") });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /not a git checkout \(a zip download\?\)/);
  assert.deepEqual(r.calls, []);
});

test("--go: npm ci always, preflight with --require-fresh (unless --used-seller), EARNED_HOME 0700, a failed step prints the resume lines with the same EARNED_HOME", () => {
  const r = stubRun(["--go", "--allow-dirty"]);
  assert.equal(r.status, 4);
  assert.ok(r.calls.includes("npm ci --ignore-scripts --no-audit --no-fund"));
  assert.ok(r.calls.includes(`node scripts/live-preflight.mjs --home ${r.home} --require-fresh`));
  assert.ok(r.calls.includes("node cli/earned.js init"));
  assert.equal(statSync(r.home).mode & 0o777, 0o700, "umask 077 (sec L-4)");
  assert.equal(statSync(join(r.home, "logs")).mode & 0o777, 0o700);
  assert.match(r.stderr, /step1-init: earned init did not print 'SEE: step 1 PASS'/);
  assert.match(r.stderr, /Do not rerun scripts\/live-run\.sh/);
  assert.ok(r.stderr.includes(`export EARNED_HOME='${r.home}'`));
  for (const c of ["init", "pick 2", "hire --local-seller", "hire --pack 3 --local-seller"]) assert.ok(r.stderr.includes(`  node cli/earned.js ${c}\n`), c);
  assert.ok(!r.stderr.includes(SK) && !r.stderr.includes(API) && !r.stdout.includes(SK));
  const used = stubRun(["--go", "--allow-dirty", "--used-seller"]);
  assert.ok(used.calls.includes(`node scripts/live-preflight.mjs --home ${used.home}`));
});
