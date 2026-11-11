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
import { wasmInfo, base58 } from "../scripts/wasm-info.mjs";

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
        // `accounts` = answers in order (the last one repeats), e.g. before/after deploy.
        const seq = state.accounts ?? [state.account];
        const acct = seq[Math.min(state.accountReads++, seq.length - 1)];
        out = acct
          ? { result: acct }
          : { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } };
      } else if (state.failOnce?.delete(params.method_name)) {
        out = { error: { name: "HANDLER_ERROR", cause: { name: "NO_CONTRACT_CODE" } } };
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

// Smallest valid wasm module exporting empty functions with these names.
function fixtureWasm(names) {
  const n = names.length;
  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  bytes.push(0x01, 0x04, 0x01, 0x60, 0x00, 0x00); // type: () -> ()
  bytes.push(0x03, n + 1, n, ...names.map(() => 0)); // functions
  const exp = [n];
  names.forEach((name, i) => exp.push(name.length, ...Buffer.from(name), 0x00, i));
  bytes.push(0x07, exp.length, ...exp);
  const code = [n];
  for (let i = 0; i < n; i++) code.push(0x02, 0x00, 0x0b);
  bytes.push(0x0a, code.length, ...code);
  return Buffer.from(bytes);
}
const CONTRACT_EXPORTS = ["accept", "create", "decline", "get_job", "name", "next_job_id", "on_payout", "quote", "submit_review"];
const WASM = wasmInfo(fixtureWasm(CONTRACT_EXPORTS));

// near stub: `--version` answers like near-cli-rs (or `nearVersion`), every other call
// is logged; `create` prints `createOut` on stdout (default: job id "7" like near-cli-rs).
function sandbox(namesPatch = {}, { exports = CONTRACT_EXPORTS, nearVersion = "near-cli-rs 0.31.1", createOut = '"7"', cargo = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "earned-deploy-"));
  for (const d of ["scripts", "contract", "test-vectors", "bin"]) mkdirSync(join(dir, d));
  for (const f of ["scripts/deploy.sh", "scripts/testnet-view.mjs", "scripts/wasm-info.mjs", "test-vectors/commit.json"]) {
    copyFileSync(join(repo, f), join(dir, f));
  }
  chmodSync(join(dir, "scripts/deploy.sh"), 0o755);
  const names = { ...JSON.parse(readFileSync(join(repo, "names.json"), "utf8")), ...namesPatch };
  writeFileSync(join(dir, "names.json"), JSON.stringify(names));
  writeFileSync(join(dir, "fixture.wasm"), fixtureWasm(exports));
  writeFileSync(join(dir, "create.out"), `${createOut}\n`);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  // cargo stub: answers `cargo near --version`; a build logs and copies the fixture wasm
  // to where cargo near would write it.
  if (cargo) {
    writeFileSync(
      join(dir, "bin/cargo"),
      `#!/bin/sh\nif [ "$*" = "near --version" ]; then echo "cargo-near-near 0.23.0"; exit 0; fi\n` +
        `echo "cargo $*" >> "${log}"\nmkdir -p ../target/near\ncp "${dir}/fixture.wasm" ../target/near/earned_price.wasm\n`,
    );
    chmodSync(join(dir, "bin/cargo"), 0o755);
  }
  writeFileSync(
    join(dir, "bin/near"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${nearVersion}"; exit 0; fi\n` +
      `echo "near $*" >> "${log}"\ncase "$*" in *" create "*) cat "${dir}/create.out";; esac\n`,
  );
  chmodSync(join(dir, "bin/near"), 0o755);
  return { dir, calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
}

// A port nothing listens on: guard tests point here, so a regressed guard fails
// fast on connection refused and can never reach a real RPC.
const DEAD_PORT = await new Promise((resolve) => {
  const s = http.createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

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
          EARNED_RPC_URL: `http://127.0.0.1:${rpcPort ?? DEAD_PORT}`,
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
  status: "open",
});

async function withRpc(state, fn) {
  const full = { calls: [], accountReads: 0, views: { name: "Earned Price", quote: QUOTE, get_job: goodJob() }, ...state };
  const server = await fakeRpc(full);
  try {
    return await fn(server.address().port, full);
  } finally {
    server.close();
  }
}

const funded = { amount: "10000000000000000000000000", storage_usage: 182, code_hash: NO_CODE };
const deployed = { ...funded, code_hash: WASM.code_hash };
// First deploy: empty account, then the new code once the deploy lands.
const fresh = () => ({ accounts: [funded, deployed] });

// ---- guard: refuses before building or signing ------------------------------
for (const [label, patch, args, env, msg] of [
  ["names.json network mainnet", { network: "mainnet" }, [], {}, /names.json network is 'mainnet'/],
  ["--network mainnet", {}, ["--network", "mainnet"], {}, /--network 'mainnet' is not testnet/],
  ["--network=mainnet", {}, ["--network=mainnet"], {}, /not testnet/],
  ["NEAR_ENV=mainnet", {}, [], { NEAR_ENV: "mainnet" }, /NEAR_ENV is 'mainnet'/],
  ["NEAR_NETWORK=mainnet", {}, ["--dry-run"], { NEAR_NETWORK: "mainnet" }, /NEAR_NETWORK is 'mainnet'/],
  ["a .near account", { contract_account: "earned-price.near" }, [], {}, /not a valid \.testnet account/],
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
    const real = await run(box, [], { rpcPort: port });
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

test("deploy.sh deploys the pinned wasm, checks the on-chain code_hash, then smoke-calls name, quote, create, get_job", async () => {
  await withRpc(fresh(), async (port, rpc) => {
    const box = sandbox();
    const r = await run(box, [], { rpcPort: port });
    assert.equal(r.code, 0, r.stderr);
    const near = box.calls().filter((c) => c.startsWith("near"));
    assert.deepEqual(near, [
      "near contract deploy earned-price.testnet use-file target/near/earned_price.wasm without-init-call network-config testnet sign-with-keychain send",
      `near contract call-function as-transaction earned-price.testnet create json-args {"seller":"${SELLER}","commit_hash":"${vector.commit_hex}"} prepaid-gas 30 Tgas attached-deposit ${QUOTE} yoctoNEAR sign-as earned-price.testnet network-config testnet sign-with-keychain send`,
    ]);
    assert.deepEqual(rpc.calls, ["view_account", "view_account", "name", "quote", "get_job"]);
    assert.match(r.stdout, new RegExp(`deployed: on-chain code_hash ${WASM.code_hash} = base58\\(sha256 ${WASM.sha256}\\)`));
    assert.match(r.stdout, /smoke OK: name, quote, create \(job 7/);
    assert.ok(!existsSync(join(box.dir, "target/near/smoke-unconfirmed.txt")), "marker cleared once the job id is known");
  });
});

test("deploy.sh --signer legacy-keychain signs with the legacy key store", async () => {
  await withRpc(fresh(), async (port) => {
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
  ["a job with pre-T-022 status casing", { get_job: { ...goodJob(), status: "Open" } }, /SMOKE FAIL get_job.status/],
]) {
  test(`deploy.sh smoke fails (exit 5) on ${label}`, async () => {
    const state = { ...fresh(), views: { name: "Earned Price", quote: QUOTE, get_job: goodJob(), ...views } };
    await withRpc(state, async (port) => {
      const box = sandbox();
      const r = await run(box, [], { rpcPort: port });
      assert.equal(r.code, 5, r.stderr);
      assert.match(r.stderr, msg);
    });
  });
}

// ---- fix 1: pinned hash ------------------------------------------------------
test("wasm-info: base58 matches NEAR's empty code_hash and a known vector", () => {
  assert.equal(base58(Buffer.alloc(32)), NO_CODE);
  assert.equal(base58(Buffer.from("hello world")), "StV1DL6CwTryKyV");
  assert.equal(base58(Buffer.from([0, 0, 1])), "112");
});

test("deploy.sh fails (exit 6) when the on-chain code_hash is not base58(sha256(wasm)) after deploy", async () => {
  await withRpc({ accounts: [funded, { ...funded, code_hash: "WrongHashWrongHashWrongHashWrong" }] }, async (port, rpc) => {
    const box = sandbox();
    const r = await run(box, [], { rpcPort: port });
    assert.equal(r.code, 6, r.stderr);
    assert.match(r.stderr, new RegExp(`on-chain code_hash is WrongHash\\w+, expected ${WASM.code_hash}`));
    assert.ok(rpc.accountReads > 2, "retried before failing");
    assert.ok(!box.calls().some((c) => c.includes(" create ")), "no smoke create after a hash mismatch");
  });
});

test("deploy.sh refuses (exit 6) a wasm whose sha256 differs from --expect-sha, before any RPC or near call", async () => {
  await withRpc(fresh(), async (port, rpc) => {
    const box = sandbox();
    const r = await run(box, ["--expect-sha", "0".repeat(64)], { rpcPort: port });
    assert.equal(r.code, 6, r.stderr);
    assert.match(r.stderr, /does not match --expect-sha 0{64}/);
    assert.deepEqual(rpc.calls, []);
    assert.ok(!box.calls().some((c) => c.startsWith("near")));
  });
});

test("deploy.sh --skip-build is refused without --expect-sha, and works with the right one", async () => {
  await withRpc(fresh(), async (port, rpc) => {
    const box = sandbox();
    const bare = await run(box, ["--skip-build", "--dry-run"], { rpcPort: port });
    assert.equal(bare.code, 1);
    assert.match(bare.stderr, /--skip-build needs --expect-sha/);
    const bad = await run(box, ["--expect-sha", "abc", "--dry-run"], { rpcPort: port });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /64 lowercase hex/);
    await run(box, ["--dry-run"], { rpcPort: port }); // builds the fixture wasm
    const calls = box.calls().length;
    rpc.accountReads = 0; // the account is empty again for the real run
    const ok = await run(box, ["--skip-build", "--expect-sha", WASM.sha256, "--no-smoke"], { rpcPort: port });
    assert.equal(ok.code, 0, ok.stderr);
    const after = box.calls().slice(calls);
    assert.ok(!after.some((c) => c.startsWith("cargo")), "no build with --skip-build");
    assert.equal(after.filter((c) => c.startsWith("near contract deploy")).length, 1);
  });
});

test("deploy.sh refuses (exit 6) a wasm exporting test_pay_seller (sandbox-test build), before any RPC call", async () => {
  await withRpc(fresh(), async (port, rpc) => {
    const box = sandbox({}, { exports: [...CONTRACT_EXPORTS, "test_pay_seller"] });
    const r = await run(box, ["--dry-run"], { rpcPort: port });
    assert.equal(r.code, 6, r.stderr);
    assert.match(r.stderr, /exports test-only method\(s\) test_pay_seller/);
    assert.deepEqual(rpc.calls, []);
  });
});

test("deploy.sh refuses a file that is not a wasm module", async () => {
  await withRpc(fresh(), async (port) => {
    const box = sandbox();
    writeFileSync(join(box.dir, "fixture.wasm"), Buffer.alloc(1000));
    const r = await run(box, ["--dry-run"], { rpcPort: port });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /not a valid wasm module/);
  });
});

// ---- fix 2: no silent redeploy -----------------------------------------------
test("deploy.sh refuses (exit 7) to replace different live code without --redeploy; near never called", async () => {
  const old = "OLDhashOLDhashOLDhashOLDhashOLDh";
  await withRpc({ account: { ...funded, code_hash: old } }, async (port) => {
    const box = sandbox();
    for (const args of [[], ["--dry-run"]]) {
      const r = await run(box, args, { rpcPort: port });
      assert.equal(r.code, 7, r.stderr);
      assert.match(r.stderr, new RegExp(`different code is live on earned-price.testnet \\(${old} -> ${WASM.code_hash}\\)`));
      assert.match(r.stderr, /--redeploy/);
    }
    assert.ok(!box.calls().some((c) => c.startsWith("near")));
  });
});

test("deploy.sh --redeploy replaces different live code and prints old -> new", async () => {
  const old = "OLDhashOLDhashOLDhashOLDhashOLDh";
  await withRpc({ accounts: [{ ...funded, code_hash: old }, deployed] }, async (port) => {
    const box = sandbox();
    const r = await run(box, ["--redeploy", "--no-smoke"], { rpcPort: port });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`redeploy: ${old} -> ${WASM.code_hash}`));
    assert.equal(box.calls().filter((c) => c.startsWith("near contract deploy")).length, 1);
  });
});

test("deploy.sh skips the deploy when the live code already is this wasm, and still smokes", async () => {
  await withRpc({ account: deployed }, async (port) => {
    const box = sandbox();
    const r = await run(box, [], { rpcPort: port });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /live code already matches this wasm: skipping deploy/);
    const near = box.calls().filter((c) => c.startsWith("near"));
    assert.equal(near.length, 1);
    assert.match(near[0], / create /);
  });
});

// ---- fix 3: preflight --------------------------------------------------------
test("deploy.sh refuses a legacy JS 'near' (exit 2) before cargo runs; dry run only warns", async () => {
  await withRpc(fresh(), async (port) => {
    const box = sandbox({}, { nearVersion: "4.0.13" });
    const r = await run(box, [], { rpcPort: port });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /not near-cli-rs \(4\.0\.13\).*cargo install --locked near-cli-rs/);
    assert.deepEqual(box.calls(), [], "no build, no near call");
    const dry = await run(box, ["--dry-run"], { rpcPort: port });
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /warning: 'near' on PATH is not near-cli-rs/);
  });
});

test("deploy.sh refuses (exit 2) with an install hint when cargo-near is missing", async () => {
  await withRpc(fresh(), async (port) => {
    const box = sandbox();
    // cargo exists but `cargo near --version` fails, like a Rust install without cargo-near.
    writeFileSync(join(box.dir, "bin/cargo"), "#!/bin/sh\nexit 101\n");
    const r = await run(box, ["--dry-run"], { rpcPort: port });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /cargo-near not found\. Install it: cargo install --locked cargo-near/);
  });
});

// ---- fix 5: job id after create is sent ----------------------------------------
test("deploy.sh reads the job id from the last numeric line when near prints extra stdout", async () => {
  await withRpc(fresh(), async (port) => {
    const box = sandbox({}, { createOut: 'Logs:\n42\nlog: 12 things\nFunction execution return value (printed to stdout):\n"7"' });
    const r = await run(box, [], { rpcPort: port });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /create -> job 7/);
  });
});

test("deploy.sh: unreadable job id after create says the tx was sent, and blocks a blind rerun", async () => {
  await withRpc(fresh(), async (port) => {
    const box = sandbox({}, { createOut: "Transaction sent, outcome unknown" });
    const r = await run(box, [], { rpcPort: port });
    assert.equal(r.code, 5, r.stderr);
    assert.match(r.stderr, /ERROR: create tx was sent, but no job id was found.*before rerunning/);
    assert.doesNotMatch(r.stderr, /refusing| 5$/m);
    assert.ok(existsSync(join(box.dir, "target/near/smoke-unconfirmed.txt")));
    const creates = () => box.calls().filter((c) => c.includes(" create ")).length;
    assert.equal(creates(), 1);
    const again = await run(box, [], { rpcPort: port });
    assert.equal(again.code, 5, again.stderr);
    assert.match(again.stderr, /previous smoke create tx was sent but its job id was never confirmed/);
    assert.equal(creates(), 1, "the rerun never sends a second create");
    const noSmoke = await run(box, ["--no-smoke"], { rpcPort: port });
    assert.equal(noSmoke.code, 0, noSmoke.stderr);
  });
});

// ---- fix 6: hardening ------------------------------------------------------------
for (const acct of ["earned-price.testnet.near", "Earned-Price.testnet", "earned price.testnet", 'x".testnet', "-bad.testnet", "a..b.testnet", ".testnet"]) {
  test(`deploy.sh refuses the malformed account ${JSON.stringify(acct)}`, async () => {
    const box = sandbox({ contract_account: acct });
    const r = await run(box, ["--dry-run"]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /not a valid \.testnet account/);
    assert.deepEqual(box.calls(), []);
  });
}

test("deploy.sh retries a view that is not ready yet (code still settling)", async () => {
  await withRpc({ ...fresh(), failOnce: new Set(["name", "get_job"]) }, async (port, rpc) => {
    const box = sandbox();
    const r = await run(box, [], { rpcPort: port });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(rpc.calls.filter((c) => c === "name" || c === "get_job"), ["name", "name", "get_job", "get_job"]);
  });
});

for (const [label, args, msg] of [
  ["--network with no value", ["--network"], /--network needs a value/],
  ["an unknown option", ["--yolo"], /unknown option --yolo/],
]) {
  test(`deploy.sh refuses ${label}`, async () => {
    const box = sandbox();
    const r = await run(box, args);
    assert.equal(r.code, 1);
    assert.match(r.stderr, msg);
    assert.deepEqual(box.calls(), []);
  });
}

test("deploy.sh --help prints the usage without comment markers", async () => {
  const r = await run(sandbox(), ["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^Deploy the Earned Price escrow contract/);
  assert.doesNotMatch(r.stdout, /^#/m);
  assert.doesNotMatch(r.stdout, /set -euo/);
});

test("testnet-view refuses non-testnet accounts and RPCs", async () => {
  const { rpcUrls, assertTestnet } = await import("../scripts/testnet-view.mjs");
  assert.doesNotThrow(() => assertTestnet("smoke-seller.earned-price.testnet"));
  for (const bad of ["earned-price.testnet.near", "Earned.testnet", "a..b.testnet", 'x".testnet', `${"a".repeat(60)}.testnet`]) {
    assert.throws(() => assertTestnet(bad), /not a \.testnet account/);
  }
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
