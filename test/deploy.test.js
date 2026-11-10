// scripts/deploy.sh (T-021, S-001 AC3): testnet-only guard, dry run, account
// checks and smoke calls, run against stub `cargo` / `near` binaries and a fake
// local RPC. No network, no keys, nothing signed.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = new URL("..", import.meta.url).pathname;
const vector = JSON.parse(readFileSync(join(repo, "test-vectors/commit.json"), "utf8"));
const QUOTE = "30000000000000000000000";
const SELLER = "smoke-seller.earned-price.testnet";
const NO_CODE = "11111111111111111111111111111111";

// Fake NEAR RPC. `state` controls the answers.
function fakeRpc(state) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { params } = JSON.parse(body);
      state.calls.push(params.request_type === "call_function" ? params.method_name : params.request_type);
      let out;
      if (params.request_type === "view_account") {
        out = state.account
          ? { result: state.account }
          : { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } };
      } else {
        const v = state.views[params.method_name];
        out = { result: { result: [...Buffer.from(JSON.stringify(v))] } };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: "earned", ...out }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function sandbox(namesPatch = {}) {
  const dir = mkdtempSync(join(tmpdir(), "earned-deploy-"));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "contract"));
  mkdirSync(join(dir, "test-vectors"));
  mkdirSync(join(dir, "bin"));
  for (const f of ["scripts/deploy.sh", "scripts/testnet-view.mjs", "test-vectors/commit.json"]) {
    copyFileSync(join(repo, f), join(dir, f));
  }
  chmodSync(join(dir, "scripts/deploy.sh"), 0o755);
  const names = { ...JSON.parse(readFileSync(join(repo, "names.json"), "utf8")), ...namesPatch };
  writeFileSync(join(dir, "names.json"), JSON.stringify(names));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  // cargo stub: logs and writes a 1000-byte fake wasm where cargo near would.
  writeFileSync(
    join(dir, "bin/cargo"),
    `#!/bin/sh\necho "cargo $*" >> "${log}"\nmkdir -p ../target/near\nhead -c 1000 /dev/zero > ../target/near/earned_price.wasm\n`,
  );
  // near stub: logs; `create` returns job id "7" on stdout like near-cli-rs.
  writeFileSync(
    join(dir, "bin/near"),
    `#!/bin/sh\necho "near $*" >> "${log}"\ncase "$*" in *" create "*) echo '"7"';; esac\n`,
  );
  chmodSync(join(dir, "bin/cargo"), 0o755);
  chmodSync(join(dir, "bin/near"), 0o755);
  return { dir, calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
}

function run(box, args, { rpcPort, env = {} } = {}) {
  const base = { ...process.env };
  delete base.NEAR_ENV;
  delete base.NEAR_NETWORK;
  delete base.EARNED_RPC_URL;
  return new Promise((resolve) => {
    execFile(
      join(box.dir, "scripts/deploy.sh"),
      args,
      {
        env: {
          ...base,
          PATH: `${join(box.dir, "bin")}:${process.env.PATH}`,
          EARNED_RETRY_SLEEP: "0",
          ...(rpcPort ? { EARNED_RPC_URL: `http://127.0.0.1:${rpcPort}` } : {}),
          ...env,
        },
      },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
}

const goodJob = () => ({
  id: "7",
  buyer: "earned-price.testnet",
  seller: SELLER,
  price: QUOTE,
  commit_hash: vector.commit_hex,
  reveal_deadline_ns: "1",
  status: "Open",
});

async function withRpc(state, fn) {
  const full = { calls: [], views: { name: "Earned Price", quote: QUOTE, get_job: goodJob() }, ...state };
  const server = await fakeRpc(full);
  try {
    return await fn(server.address().port, full);
  } finally {
    server.close();
  }
}

const funded = { amount: "10000000000000000000000000", storage_usage: 182, code_hash: NO_CODE };

// ---- guard: refuses before building or signing ------------------------------
for (const [label, patch, args, env, msg] of [
  ["names.json network mainnet", { network: "mainnet" }, [], {}, /names.json network is 'mainnet'/],
  ["--network mainnet", {}, ["--network", "mainnet"], {}, /--network 'mainnet' is not testnet/],
  ["--network=mainnet", {}, ["--network=mainnet"], {}, /not testnet/],
  ["NEAR_ENV=mainnet", {}, [], { NEAR_ENV: "mainnet" }, /NEAR_ENV is 'mainnet'/],
  ["NEAR_NETWORK=mainnet", {}, ["--dry-run"], { NEAR_NETWORK: "mainnet" }, /NEAR_NETWORK is 'mainnet'/],
  ["a .near account", { contract_account: "earned-price.near" }, [], {}, /not a .testnet account/],
  ["a mainnet RPC", {}, ["--dry-run"], { EARNED_RPC_URL: "https://rpc.mainnet.near.org" }, /not a known testnet RPC/],
  ["an unpinned wasm path", { wasm_path: "other.wasm" }, [], {}, /not the pinned/],
  ["an unknown signer", {}, ["--signer", "plaintext-private-key"], {}, /--signer must be/],
]) {
  test(`deploy.sh refuses ${label} and builds/signs nothing`, async () => {
    const box = sandbox(patch);
    const r = await run(box, args, { env });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, msg);
    assert.deepEqual(box.calls(), [], "no cargo or near call before the guard passes");
  });
}

test("deploy.sh dry run builds and checks but never calls near", async () => {
  await withRpc({ account: funded }, async (port, rpc) => {
    const box = sandbox();
    const r = await run(box, ["--dry-run"], { rpcPort: port });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /dry run OK: nothing signed, nothing sent/);
    assert.match(r.stdout, /sha256 [0-9a-f]{64}/);
    assert.deepEqual(box.calls(), ["cargo near build non-reproducible-wasm --out-dir ../target/near"]);
    assert.deepEqual(rpc.calls, ["view_account"]);
  });
});

test("deploy.sh stops with the faucet command when the account is missing (exit 3, no near call)", async () => {
  await withRpc({ account: null }, async (port) => {
    const box = sandbox();
    const r = await run(box, ["--skip-build"], { rpcPort: port, env: {} });
    // --skip-build needs a wasm on disk
    assert.equal(r.code, 1);
    await run(box, ["--dry-run"], { rpcPort: port }); // builds the fake wasm
    const real = await run(box, ["--skip-build"], { rpcPort: port });
    assert.equal(real.code, 3, real.stderr);
    assert.match(real.stderr, /near account create-account sponsor-by-faucet-service earned-price\.testnet/);
    assert.ok(!box.calls().some((c) => c.startsWith("near")), "never signs");
  });
});

test("deploy.sh dry run with a missing account exits 0 and signs nothing", async () => {
  await withRpc({ account: null }, async (port) => {
    const box = sandbox();
    const r = await run(box, ["--dry-run"], { rpcPort: port });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /stopping before deploy \(account missing\)/);
    assert.ok(!box.calls().some((c) => c.startsWith("near")));
  });
});

test("deploy.sh refuses a first deploy the balance cannot cover (exit 4)", async () => {
  await withRpc({ account: { ...funded, amount: "100000000000000000000000" } }, async (port) => {
    const box = sandbox();
    const r = await run(box, [], { rpcPort: port });
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /needed for code storage \+ gas/);
    assert.ok(!box.calls().some((c) => c.startsWith("near")));
  });
});

test("deploy.sh deploys the pinned wasm, then smoke-calls name, quote, create, get_job", async () => {
  await withRpc({ account: funded }, async (port, rpc) => {
    const box = sandbox();
    const r = await run(box, [], { rpcPort: port });
    assert.equal(r.code, 0, r.stderr);
    const near = box.calls().filter((c) => c.startsWith("near"));
    assert.deepEqual(near, [
      "near contract deploy earned-price.testnet use-file target/near/earned_price.wasm without-init-call network-config testnet sign-with-keychain send",
      `near contract call-function as-transaction earned-price.testnet create json-args {"seller":"${SELLER}","commit_hash":"${vector.commit_hex}"} prepaid-gas 30 Tgas attached-deposit ${QUOTE} yoctoNEAR sign-as earned-price.testnet network-config testnet sign-with-keychain send`,
    ]);
    assert.deepEqual(rpc.calls, ["view_account", "name", "quote", "get_job"]);
    assert.match(r.stdout, /smoke OK: name, quote, create \(job 7/);
  });
});

test("deploy.sh --signer legacy-keychain signs with the legacy key store", async () => {
  await withRpc({ account: funded }, async (port) => {
    const box = sandbox();
    const r = await run(box, ["--signer", "legacy-keychain", "--no-smoke"], { rpcPort: port });
    assert.equal(r.code, 0, r.stderr);
    const near = box.calls().filter((c) => c.startsWith("near"));
    assert.equal(near.length, 1);
    assert.match(near[0], /sign-with-legacy-keychain send$/);
  });
});

for (const [label, views, msg] of [
  ["wrong name", { name: "Other" }, /SMOKE FAIL name/],
  ["wrong quote", { quote: "1" }, /SMOKE FAIL quote/],
  ["a job with the wrong price", { get_job: { ...goodJob(), price: "1" } }, /SMOKE FAIL get_job.price/],
  ["a job with the wrong commit", { get_job: { ...goodJob(), commit_hash: "00" } }, /SMOKE FAIL get_job.commit_hash/],
  ["a missing job", { get_job: null }, /SMOKE FAIL get_job.id/],
]) {
  test(`deploy.sh smoke fails (exit 5) on ${label}`, async () => {
    const state = { account: funded, calls: [], views: { name: "Earned Price", quote: QUOTE, get_job: goodJob(), ...views } };
    await withRpc(state, async (port) => {
      const box = sandbox();
      const r = await run(box, [], { rpcPort: port });
      assert.equal(r.code, 5, r.stderr);
      assert.match(r.stderr, msg);
    });
  });
}

test("testnet-view refuses non-testnet accounts and RPCs", async () => {
  const { rpcUrls } = await import("../scripts/testnet-view.mjs");
  assert.deepEqual(rpcUrls({}), ["https://test.rpc.fastnear.com", "https://neart.lava.build"]);
  assert.deepEqual(rpcUrls({ EARNED_RPC_URL: "http://127.0.0.1:1234" }), ["http://127.0.0.1:1234"]);
  assert.throws(() => rpcUrls({ EARNED_RPC_URL: "https://rpc.mainnet.near.org" }), /not a known testnet RPC/);
  assert.throws(() => rpcUrls({ EARNED_RPC_URL: "http://127.0.0.1.evil.com:1/" }), /not a known testnet RPC/);
  const r = await new Promise((resolve) =>
    execFile("node", [join(repo, "scripts/testnet-view.mjs"), "account", "earned-price.near"], (err, _o, stderr) =>
      resolve({ code: err?.code, stderr }),
    ),
  );
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a \.testnet account/);
  assert.ok(existsSync(join(repo, "scripts/deploy.sh")));
});
