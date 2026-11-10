// earned init (S-020 / T-014). All network calls are fakes: no account, faucet or tx is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, chmodSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  FAUCET_URL,
  InitError,
  assertTestnetRpc,
  keyFilePath,
  loadState,
  runInit,
  stateDir,
} from "../cli/init.js";
import { SPEND_CAP_YOCTO, SpendCapError, assertCanSpend, recordSpend } from "../cli/spend-cap.js";

const PRIV = "ed25519:FAKEPRIVATEKEYdoNotUseAnywhere1111111111111111111111111111111111";
const PUB = "ed25519:FakePublicKey11111111111111111111111111111111";
const ROOT = new URL("..", import.meta.url).pathname;

function fakes({ exists = false, faucet = { status: { SuccessValue: "" }, transaction: { hash: "TXHASH1" } }, http = 200, rpcDown = false } = {}) {
  const calls = { faucet: [], view: 0, keyGen: 0 };
  let onChain = exists;
  const lines = [];
  return {
    calls,
    lines,
    deps: {
      cwd: mkdtempSync(join(tmpdir(), "earned-init-")),
      env: {},
      network: "testnet",
      keyGen: () => (calls.keyGen++, { publicKey: PUB, privateKey: PRIV }),
      randomBytes: () => Buffer.from([0xde, 0xad, 0xbe, 0xef]),
      now: () => new Date("2026-11-10T00:00:00Z"),
      packs: [
        { id: 1, hash: "a".repeat(64) },
        { id: 2, hash: "b".repeat(64) },
        { id: 3, hash: "c".repeat(64) },
      ],
      out: (l) => lines.push(l),
      provider: {
        viewAccount: async ({ accountId }) => {
          calls.view++;
          if (rpcDown) throw new Error("fetch failed");
          if (!onChain) throw new Error(`[-32000] Server error: account ${accountId} does not exist while viewing`);
          return { amount: "0" };
        },
      },
      fetch: async (url, init) => {
        calls.faucet.push({ url, body: JSON.parse(init.body) });
        if (http !== 200) return { ok: false, status: http, json: async () => ({}) };
        onChain = true;
        return { ok: true, status: 200, json: async () => faucet };
      },
    },
  };
}

test("fresh run creates a .testnet buyer via the faucet, sending only the public key", async () => {
  const f = fakes();
  const r = await runInit(f.deps);
  assert.equal(r.created, true);
  assert.equal(r.state.account_id, "earned-price-buyer-deadbeef.testnet");
  assert.equal(f.calls.faucet.length, 1);
  assert.equal(f.calls.faucet[0].url, FAUCET_URL);
  assert.deepEqual(f.calls.faucet[0].body, { newAccountId: "earned-price-buyer-deadbeef.testnet", newAccountPublicKey: PUB });
  assert.ok(!JSON.stringify(f.calls.faucet).includes(PRIV));
  assert.ok(f.lines.includes("SEE: step 1 PASS"));
  assert.ok(f.lines.some((l) => l.includes("TXHASH1")));
});

test("key file is 0600 in a 0700 self-gitignored folder; private key never printed", async () => {
  const f = fakes();
  await runInit(f.deps);
  const dir = stateDir(f.deps.cwd);
  assert.equal(statSync(keyFilePath(dir)).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "*\n");
  const saved = JSON.parse(readFileSync(keyFilePath(dir), "utf8"));
  assert.equal(saved.private_key, PRIV);
  assert.equal(saved.status, "created");
  assert.ok(!f.lines.join("\n").includes(PRIV));
  assert.ok(!f.lines.join("\n").includes("FAKEPRIVATEKEY"));
});

test("re-run reuses the local account: no new key, no faucet call", async () => {
  const f = fakes();
  await runInit(f.deps);
  f.lines.length = 0;
  const r = await runInit(f.deps);
  assert.equal(r.reused, true);
  assert.equal(r.created, false);
  assert.equal(f.calls.keyGen, 1);
  assert.equal(f.calls.faucet.length, 1);
  assert.match(f.lines[0], /^Reusing testnet buyer earned-price-buyer-deadbeef\.testnet$/);
});

test("faucet failure keeps the saved key; the retry reuses the same account id and key", async () => {
  const f = fakes({ http: 503 });
  await assert.rejects(runInit(f.deps), (e) => e.code === "FAUCET_HTTP" && !e.message.includes(PRIV));
  const pending = loadState(stateDir(f.deps.cwd));
  assert.equal(pending.status, "pending");
  const g = fakes();
  g.deps.cwd = f.deps.cwd;
  const r = await runInit(g.deps);
  assert.equal(g.calls.keyGen, 0);
  assert.equal(r.state.account_id, pending.account_id);
  assert.equal(r.state.status, "created");
});

test("crash after faucet success: pending file + account on chain is marked created without a second faucet call", async () => {
  const f = fakes({ http: 503 });
  await assert.rejects(runInit(f.deps));
  const g = fakes({ exists: true });
  g.deps.cwd = f.deps.cwd;
  const r = await runInit(g.deps);
  assert.equal(g.calls.faucet.length, 0);
  assert.equal(r.state.status, "created");
});

test("mainnet is refused before anything is written", async () => {
  for (const network of ["mainnet", "", "betanet"]) {
    const f = fakes();
    await assert.rejects(runInit({ ...f.deps, network }), (e) => e.code === "MAINNET_REFUSED");
    assert.equal(existsSync(stateDir(f.deps.cwd)), false);
    assert.equal(f.calls.faucet.length, 0);
  }
  assert.throws(() => assertTestnetRpc("https://rpc.mainnet.near.org"), (e) => e.code === "MAINNET_REFUSED");
  assert.throws(() => assertTestnetRpc("http://test.rpc.fastnear.com"), (e) => e.code === "MAINNET_REFUSED");
  assert.doesNotThrow(() => assertTestnetRpc("https://test.rpc.fastnear.com"));
});

test("a key file naming a non-testnet account is refused", async () => {
  const f = fakes();
  await runInit(f.deps);
  const file = keyFilePath(stateDir(f.deps.cwd));
  const s = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...s, account_id: "victim.near" }), { mode: 0o600 });
  await assert.rejects(runInit(f.deps), (e) => e.code === "KEY_FILE_CORRUPT");
});

test("clear error states: loose perms, symlink, corrupt file, RPC down, faucet refused / failed / bad body", async () => {
  const f = fakes();
  await runInit(f.deps);
  const dir = stateDir(f.deps.cwd);
  const file = keyFilePath(dir);
  chmodSync(file, 0o644);
  await assert.rejects(runInit(f.deps), (e) => e.code === "KEY_FILE_PERMS" && e.message.includes("chmod 600"));
  chmodSync(file, 0o600);

  const s = fakes();
  const sdir = stateDir(s.deps.cwd);
  await runInit({ ...s.deps, out: () => {} });
  const target = keyFilePath(sdir) + ".real";
  writeFileSync(target, readFileSync(keyFilePath(sdir)), { mode: 0o600 });
  const { rmSync } = await import("node:fs");
  rmSync(keyFilePath(sdir));
  symlinkSync(target, keyFilePath(sdir));
  await assert.rejects(runInit(s.deps), (e) => e.code === "KEY_FILE_UNSAFE");

  writeFileSync(file, "{not json", { mode: 0o600 });
  await assert.rejects(runInit(f.deps), (e) => e.code === "KEY_FILE_CORRUPT");

  await assert.rejects(runInit(fakes({ rpcDown: true }).deps), (e) => e.code === "RPC_UNAVAILABLE");
  await assert.rejects(runInit(fakes({ faucet: { status: { SuccessValue: "ZmFsc2U=" } } }).deps), (e) => e.code === "FAUCET_REFUSED");
  await assert.rejects(runInit(fakes({ faucet: { status: { Failure: { ActionError: {} } } } }).deps), (e) => e.code === "FAUCET_TX_FAILED");
  await assert.rejects(runInit(fakes({ faucet: { nope: 1 } }).deps), (e) => e.code === "FAUCET_BAD_RESPONSE");
  await assert.rejects(runInit(fakes({ http: 429 }).deps), (e) => e.code === "FAUCET_HTTP" && /rate limited/.test(e.message));
  const unreachable = fakes();
  unreachable.deps.fetch = async () => { throw new Error("ENOTFOUND"); };
  await assert.rejects(runInit(unreachable.deps), (e) => e.code === "FAUCET_UNREACHABLE");
  assert.ok(new InitError("X", "y") instanceof Error);
});

test("without frozen packs init says PARTIAL, never a false PASS", async () => {
  const f = fakes();
  await runInit({ ...f.deps, packs: [] });
  assert.ok(f.lines.includes("SEE: step 1 PARTIAL (account ready; packs pending)"));
  assert.ok(!f.lines.includes("SEE: step 1 PASS"));
});

test("EARNED_HOME overrides the key folder", async () => {
  const f = fakes();
  const home = join(mkdtempSync(join(tmpdir(), "earned-home-")), "k");
  await runInit({ ...f.deps, env: { EARNED_HOME: home } });
  assert.equal(statSync(join(home, "buyer.json")).mode & 0o777, 0o600);
});

test("spend cap: 0.2 NEAR enforced in code, file cannot raise it", () => {
  const s = { spent_yocto: "0" };
  assert.equal(SPEND_CAP_YOCTO, 200000000000000000000000n);
  const s1 = recordSpend(s, 150000000000000000000000n); // 0.15
  assert.equal(s1.spent_yocto, "150000000000000000000000");
  assert.doesNotThrow(() => assertCanSpend(s1, 50000000000000000000000n)); // exactly 0.2
  assert.throws(() => assertCanSpend(s1, 50000000000000000000001n), SpendCapError);
  assert.throws(() => assertCanSpend({ spent_yocto: "0", spend_cap_yocto: "999" + "0".repeat(24) }, 3n * 10n ** 23n), SpendCapError);
  assert.throws(() => assertCanSpend({ spent_yocto: "-1" }, 1n), SpendCapError);
  assert.throws(() => assertCanSpend(s, -1n), SpendCapError);
  assert.throws(() => assertCanSpend(s, 0.1), SpendCapError);
});

test("CLI: `earned init --network mainnet` refuses and exits 1 without touching disk", () => {
  const cwd = mkdtempSync(join(tmpdir(), "earned-cli-"));
  let code = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [join(ROOT, "cli/earned.js"), "init", "--network", "mainnet"], { cwd, stdio: "pipe", env: { PATH: process.env.PATH } });
  } catch (e) {
    code = e.status;
    stderr = e.stderr.toString();
  }
  assert.equal(code, 1);
  assert.match(stderr, /MAINNET_REFUSED/);
  assert.equal(existsSync(join(cwd, ".earned")), false);
});

test("repo ships no key material and ignores .earned/", () => {
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT }).toString().split("\n").filter(Boolean);
  assert.ok(!files.some((f) => f.startsWith(".earned/") || f.endsWith("buyer.json")));
  assert.match(readFileSync(join(ROOT, ".gitignore"), "utf8"), /^\.earned\/$/m);
  // No real-looking NEAR private key (ed25519: + 80+ base58 chars) in tracked text files.
  const re = /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/;
  for (const f of files) {
    if (/\.(js|mjs|json|md|rs|toml|sh|py)$/.test(f) && existsSync(join(ROOT, f))) {
      assert.ok(!re.test(readFileSync(join(ROOT, f), "utf8")), `possible private key in ${f}`);
    }
  }
});
