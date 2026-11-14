// earned pick N (S-021 / T-030). No live chain calls: views are recorded-shape nearcore
// JSON-RPC bodies from a fake fetch, and the create tx goes to a fake sender that returns
// recorded-shape FinalExecutionOutcome bodies.
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  CREATE_GAS,
  DEMO_SELLER,
  LOCK_FILE_NAME,
  REUSABLE_STATUSES,
  OPENING_OFFER_MILLI,
  assertKeyMatchesPack,
  haggle,
  jobFilePath,
  loadJob,
  parseCreateOutcome,
  defaultPickDeps,
  isRejectedBeforeInclusion,
  parsePickArgs,
  runPick,
  saveJob,
  sealPick,
  sendCreateTx,
  signedTxHash,
} from "../cli/pick.js";
import * as near from "near-api-js";
import * as rpcErrors from "near-api-js/rpc-errors";
import { keyFilePath, loadState, saveState } from "../cli/init.js";
import { YOCTO_PER_MNEAR } from "../cli/quote.js";
import { loadPack } from "../packs/packs.js";
import { verifyReveal } from "../grader/grade.js";
import { requestSha256 } from "../seller/review-prompt.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PINS = JSON.parse(readFileSync(join(ROOT, "test-vectors/review-pins.json"), "utf8"));
const CONTRACT = "earned-price.testnet";
const URLS = ["https://a.test.example"];
const PRIV = "ed25519:FAKEPRIVATEKEYdoNotUseAnywhere1111111111111111111111111111111111";
const BUYER = "earned-price-buyer-deadbeef.testnet";
const SALT = "ab".repeat(32);

const b64 = (s) => Buffer.from(s).toString("base64");
const bytes = (v) => [...Buffer.from(JSON.stringify(v))];
const callResult = (value) => ({ jsonrpc: "2.0", id: "earned", result: { block_hash: "BLOCK1", block_height: 1, logs: [], result: bytes(value) } });

/** Recorded-shape create outcomes (near-api-js signAndSendTransaction with throwOnFailure: false). */
const okOutcome = (jobId = "0", hash = "CreateTxHash111") => ({
  status: { SuccessValue: b64(JSON.stringify(jobId)) },
  transaction: { hash },
  transaction_outcome: { id: hash, block_hash: "B" },
  receipts_outcome: [],
});
const panicOutcome = (msg, hash = "FailedTxHash222") => ({
  status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${msg}` } } } } },
  transaction: { hash },
  transaction_outcome: { id: hash, block_hash: "B" },
  receipts_outcome: [],
});

function buyerHome(spent = "0") {
  const dir = mkdtempSync(join(tmpdir(), "earned-pick-"));
  saveState(dir, {
    version: 1,
    network: "testnet",
    account_id: BUYER,
    public_key: "ed25519:FakePublicKey11111111111111111111111111111111",
    private_key: PRIV,
    status: "created",
    spent_yocto: spent,
    created_at: "2026-11-12T00:00:00Z",
  });
  return dir;
}

function fakes({ record = { passes: 0, fails: 0, unique_buyers: 0, jobs: 0 }, quoteYocto, pins = PINS, outcome = okOutcome(), sendThrows, onSend, dir = buyerHome() } = {}) {
  const calls = { views: [], sends: [] };
  const lines = [];
  const q = quoteYocto ?? (BigInt(Math.min(100, Math.max(25, 30 + 10 * record.unique_buyers - 5 * record.fails))) * YOCTO_PER_MNEAR).toString();
  const deps = {
    dir,
    env: {},
    network: "testnet",
    urls: URLS,
    contractId: CONTRACT,
    seller: DEMO_SELLER,
    salt: SALT,
    out: (l) => lines.push(l),
    fetch: async (_url, init) => {
      const p = JSON.parse(init.body).params;
      const method = p.method_name;
      calls.views.push(method);
      if (method === "get_record") return { ok: true, json: async () => callResult(record) };
      if (method === "quote") return { ok: true, json: async () => callResult(q) };
      if (method === "review_pins") return { ok: true, json: async () => callResult(pins) };
      throw new Error(`unexpected view ${method}`);
    },
    sendCreate: async (req) => {
      calls.sends.push(req);
      if (onSend) await onSend(req);
      if (sendThrows) throw sendThrows;
      return outcome;
    },
  };
  return { deps, calls, lines, dir };
}

// ---- args ----

test("parsePickArgs: pack 1-3, optional --offer and --seller; anything else is USAGE", () => {
  assert.deepEqual(parsePickArgs(["2"]), { pack: "2", offer: undefined, seller: undefined, yes: false });
  assert.deepEqual(parsePickArgs(["3", "--offer", "0.027", "--seller", "s.testnet"]), { pack: "3", offer: "0.027", seller: "s.testnet", yes: false });
  assert.deepEqual(parsePickArgs(["1", "--seller", "s.testnet", "--yes"]), { pack: "1", offer: undefined, seller: "s.testnet", yes: true });
  assert.throws(() => parsePickArgs(["1", "--yes", "--yes"]), { code: "USAGE" });
  for (const bad of [[], ["0"], ["4"], ["02"], ["pack-2"], ["2", "3"], ["2", "--bogus"], ["--offer", "0.02"]]) {
    assert.throws(() => parsePickArgs(bad), { code: "USAGE" }, JSON.stringify(bad));
  }
  assert.throws(() => parsePickArgs(["2", "--offer"]), { code: "BAD_OFFER" });
  assert.throws(() => parsePickArgs(["2", "--offer", "--seller"]), { code: "BAD_OFFER" });
  assert.throws(() => parsePickArgs(["2", "--offer", "0.02", "--offer", "0.03"]), { code: "USAGE" });
  assert.throws(() => parsePickArgs(["2", "--seller"]), { code: "USAGE" });
});

// ---- seal + L-1 ----

test("sealPick: real packs 1-3 seal to a commit the grader verifies; pack_id comes from the key", () => {
  for (const n of ["1", "2", "3"]) {
    const pack = loadPack(n);
    const s = sealPick(pack, n, SALT);
    assert.equal(s.pack_id, `pack-${n}`);
    assert.equal(s.salt, SALT);
    assert.match(s.commit_hash, /^[0-9a-f]{64}$/);
    assert.ok(verifyReveal(s.commit_hash, JSON.parse(s.K), s.salt), `pack ${n} commit verifies`);
  }
  const a = sealPick(loadPack("2"), "2");
  const b = sealPick(loadPack("2"), "2");
  assert.match(a.salt, /^[0-9a-f]{64}$/);
  assert.notEqual(a.salt, b.salt, "fresh salt per pick");
  assert.notEqual(a.commit_hash, b.commit_hash);
});

test("L-1: the sealed key's pack_id must equal the picked pack, else refused", () => {
  const k2 = JSON.stringify({ pack_id: "pack-2" });
  assert.equal(assertKeyMatchesPack(k2, "pack-2"), "pack-2");
  assert.throws(() => assertKeyMatchesPack(k2, "pack-1"), (e) => e.code === "KEY_PACK_MISMATCH" && /pack-2/.test(e.message) && /pack-1/.test(e.message));
  assert.throws(() => assertKeyMatchesPack("not json", "pack-2"), { code: "KEY_PACK_MISMATCH" });
  assert.throws(() => assertKeyMatchesPack(JSON.stringify({}), "pack-2"), { code: "KEY_PACK_MISMATCH" });
  // A loaded pack whose key is for another pack (e.g. a swapped answer-key.json) cannot be sealed for this pick.
  const pack2 = loadPack("2");
  const swapped = { ...pack2, key: loadPack("1").key };
  assert.throws(() => sealPick(swapped, "2", SALT), { code: "KEY_PACK_MISMATCH" });
});

// ---- haggle ----

test("haggle: 0.02 refused below floor then 0.03 accepted; between floor and quote refused; opening at quote accepted", () => {
  assert.equal(OPENING_OFFER_MILLI, 20);
  const [r1, r2] = haggle(30, 20);
  assert.equal(r1.offerMilli, 20);
  assert.equal(r1.accept, false);
  assert.match(r1.reason, /below my cost floor 0\.025/);
  assert.equal(r2.offerMilli, 30);
  assert.equal(r2.accept, true);
  assert.equal(r2.priceMilli, 30);

  const between = haggle(30, 27);
  assert.equal(between[0].accept, false);
  assert.match(between[0].reason, /below my quote 0\.030/);
  assert.equal(between[1].accept, true);

  const proven = haggle(40, 20);
  assert.deepEqual(proven.map((r) => [r.offerMilli, r.accept, r.priceMilli]), [[20, false, 40], [40, true, 40]]);

  const generous = haggle(30, 50);
  assert.equal(generous.length, 1, "no counteroffer when the opening offer meets the quote");
  assert.equal(generous[0].priceMilli, 30, "always priced at the quote, never the offer");

  assert.throws(() => haggle(24, 20), { code: "BAD_QUOTE" });
});

// ---- create outcome parsing ----

test("parseCreateOutcome: job id from SuccessValue; panic = CREATE_FAILED with the contract's message", () => {
  assert.deepEqual(parseCreateOutcome(okOutcome("7", "H1")), { jobId: "7", txHash: "H1" });
  assert.throws(
    () => parseCreateOutcome(panicOutcome("Earned Price: deposit 0.03 NEAR is below s's current quote 0.04 NEAR. No funds moved.")),
    (e) => e.code === "CREATE_FAILED" && /below s's current quote 0\.04 NEAR/.test(e.message) && e.txHash === "FailedTxHash222",
  );
  assert.throws(() => parseCreateOutcome({ status: { Failure: { InvalidTxError: "x" } }, transaction: { hash: "H" } }), { code: "CREATE_FAILED" });
  assert.throws(() => parseCreateOutcome({ status: { SuccessValue: b64('"x1"') }, transaction: { hash: "H" } }), { code: "BAD_CREATE_RESULT" });
  assert.throws(() => parseCreateOutcome({ status: "Started", transaction: { hash: "H" } }), { code: "BAD_CREATE_RESULT" });
  assert.throws(() => parseCreateOutcome(null), { code: "BAD_CREATE_RESULT" });
});

// ---- runPick ----

test("pick 2 on a fresh seller: prints quote + formula, 0.02 refused, 0.03 accepted, create tx + commit, ends PASS", async () => {
  const f = fakes();
  const r = await runPick({ ...f.deps, pack: "2" });
  const text = f.lines.join("\n");

  assert.match(text, /Quote: 0\.030 NEAR/);
  assert.match(text, /formula: 0\.030 \+ 0\.010×0 − 0\.005×0 = 0\.030 NEAR/);
  assert.match(text, /Buyer offers 0\.020 NEAR/);
  assert.match(text, /Refused 0\.020 NEAR: below my cost floor 0\.025 NEAR/);
  assert.match(text, /Buyer offers 0\.030 NEAR/);
  assert.match(text, /Accepted: price 0\.030 NEAR/);
  assert.match(text, /create tx: CreateTxHash111/);
  assert.match(text, new RegExp(`commit: +${r.job.commit_hash}`));
  assert.match(text, /matches the contract's pack-2 pin/);
  assert.equal(f.lines.at(-1), "SEE: step 2 PASS");

  // Exactly one create, with pack_id from the key and deposit = the on-chain quote.
  assert.equal(f.calls.sends.length, 1);
  const s = f.calls.sends[0];
  assert.equal(s.contractId, CONTRACT);
  assert.equal(s.methodName, "create");
  assert.deepEqual(s.args, { seller: DEMO_SELLER, commit_hash: r.job.commit_hash, pack_id: "pack-2" });
  assert.equal(s.depositYocto, 30n * YOCTO_PER_MNEAR);
  assert.equal(s.gas, CREATE_GAS);
  assert.equal(s.state.account_id, BUYER);
  // The pin check and the quote reads all happen before the create.
  assert.deepEqual(f.calls.views, ["review_pins", "get_record", "quote"]);

  // Spend recorded against the 0.3 NEAR cap.
  assert.equal(loadState(f.dir).spent_yocto, (30n * YOCTO_PER_MNEAR).toString());

  // Job file keeps K + salt byte-for-byte for the reveal, 0600.
  const job = loadJob(f.dir);
  assert.equal(job.status, "open");
  assert.equal(job.job_id, "0");
  assert.equal(job.create_tx, "CreateTxHash111");
  assert.equal(job.pack_id, "pack-2");
  assert.equal(job.seller, DEMO_SELLER);
  assert.equal(job.contract, CONTRACT);
  assert.equal(job.buyer, BUYER);
  assert.equal(job.price_yocto, (30n * YOCTO_PER_MNEAR).toString());
  assert.equal(job.salt, SALT);
  assert.equal(job.K, sealPick(loadPack("2"), "2", SALT).K);
  assert.ok(verifyReveal(job.commit_hash, JSON.parse(job.K), job.salt));
  assert.equal(statSync(jobFilePath(f.dir)).mode & 0o777, 0o600);

  assert.ok(!text.includes(PRIV), "private key never printed");
  assert.ok(!JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).includes(PRIV), "private key not in the return value");
});

test("pick after a pass: quote 0.040 is what gets locked (deposit from the chain's quote)", async () => {
  const f = fakes({ record: { passes: 1, fails: 0, unique_buyers: 1, jobs: 1 } });
  await runPick({ ...f.deps, pack: "3" });
  assert.equal(f.calls.sends[0].depositYocto, 40n * YOCTO_PER_MNEAR);
  assert.equal(f.calls.sends[0].args.pack_id, "pack-3");
  assert.match(f.lines.join("\n"), /Refused 0\.020 NEAR[\s\S]*Accepted: price 0\.040 NEAR/);
});

test("--offer between floor and quote is refused, then the quote is paid", async () => {
  const f = fakes();
  await runPick({ ...f.deps, pack: "2", offer: "0.027" });
  assert.match(f.lines.join("\n"), /Refused 0\.027 NEAR: below my quote 0\.030 NEAR/);
  assert.equal(f.calls.sends[0].depositYocto, 30n * YOCTO_PER_MNEAR);
});

test("L-1 in runPick: a key for another pack is refused before any network call, spend or job file", async () => {
  const f = fakes();
  const wrong = (id) => ({ ...loadPack(id), key: loadPack("1").key });
  await assert.rejects(runPick({ ...f.deps, pack: "2", loadPack: wrong }), (e) => e.code === "KEY_PACK_MISMATCH" && /pack-1/.test(e.message) && /pack-2/.test(e.message));
  assert.equal(f.calls.views.length, 0);
  assert.equal(f.calls.sends.length, 0);
  assert.equal(existsSync(jobFilePath(f.dir)), false);
  assert.equal(loadState(f.dir).spent_yocto, "0");
});

test("pin pre-flight: local review request differs from the live pin -> refused, nothing sent", async () => {
  const pins = { ...PINS, packs: PINS.packs.map((p) => (p.pack_id === "pack-2" ? { ...p, request_sha256: "0".repeat(64) } : p)) };
  const f = fakes({ pins });
  await assert.rejects(runPick({ ...f.deps, pack: "2" }), (e) => e.code === "PIN_MISMATCH" && /pack-2/.test(e.message));
  assert.equal(f.calls.sends.length, 0);
  assert.equal(loadState(f.dir).spent_yocto, "0");

  const g = fakes({ pins: { ...PINS, packs: PINS.packs.filter((p) => p.pack_id !== "pack-2") } });
  await assert.rejects(runPick({ ...g.deps, pack: "2" }), { code: "PIN_MISMATCH" });
  const h = fakes({ pins: { nope: true } });
  await assert.rejects(runPick({ ...h.deps, pack: "2" }), { code: "PIN_MISMATCH" });
  // Sanity: the shared vector really is our local request hash.
  assert.equal(PINS.packs.find((p) => p.pack_id === "pack-2").request_sha256, requestSha256(loadPack("2")));
});

test("spend cap: a create that would pass 0.3 NEAR is refused before sending", async () => {
  const f = fakes({ dir: buyerHome((280n * YOCTO_PER_MNEAR).toString()) }); // 0.280 + quote 0.030 > 0.3
  await assert.rejects(runPick({ ...f.deps, pack: "2" }), { code: "SPEND_CAP" });
  assert.equal(f.calls.sends.length, 0);
  assert.equal(existsSync(jobFilePath(f.dir)), false);
  assert.equal(loadState(f.dir).spent_yocto, (280n * YOCTO_PER_MNEAR).toString());
});

test("create refused by the contract: CREATE_FAILED, spend released, job marked failed, a new pick is allowed", async () => {
  const f = fakes({ outcome: panicOutcome("Earned Price: deposit 0.03 NEAR is below x's current quote 0.04 NEAR. No funds moved.") });
  await assert.rejects(runPick({ ...f.deps, pack: "2" }), (e) => e.code === "CREATE_FAILED" && /No funds moved/.test(e.message));
  assert.equal(loadState(f.dir).spent_yocto, "0");
  assert.equal(loadJob(f.dir).status, "failed");
  assert.equal(loadJob(f.dir).create_tx, "FailedTxHash222");

  const g = fakes({ dir: f.dir });
  await runPick({ ...g.deps, pack: "2" });
  assert.equal(loadJob(f.dir).status, "open");
});

test("create outcome unknown (RPC dropped): CREATE_UNCONFIRMED, spend stays counted, next pick refused without network", async () => {
  const f = fakes({ sendThrows: new Error("fetch failed") });
  await assert.rejects(runPick({ ...f.deps, pack: "2" }), { code: "CREATE_UNCONFIRMED" });
  assert.equal(loadState(f.dir).spent_yocto, (30n * YOCTO_PER_MNEAR).toString(), "cap errs on the safe side");
  const job = loadJob(f.dir);
  assert.equal(job.status, "unconfirmed");
  assert.match(job.salt, /^[0-9a-f]{64}$/, "salt kept: the create may have landed");

  const g = fakes({ dir: f.dir });
  await assert.rejects(runPick({ ...g.deps, pack: "2" }), { code: "JOB_IN_PROGRESS" });
  assert.equal(g.calls.views.length, 0);
});

test("an open job is never overwritten (its salt is needed for the reveal)", async () => {
  const f = fakes();
  await runPick({ ...f.deps, pack: "2" });
  const before = readFileSync(jobFilePath(f.dir), "utf8");
  const g = fakes({ dir: f.dir });
  await assert.rejects(runPick({ ...g.deps, pack: "1" }), (e) => e.code === "JOB_IN_PROGRESS" && /earned hire/.test(e.message));
  assert.equal(readFileSync(jobFilePath(f.dir), "utf8"), before);
  assert.equal(g.calls.views.length + g.calls.sends.length, 0);
});

test("no buyer yet: NO_BUYER tells the user to run earned init", async () => {
  const f = fakes({ dir: mkdtempSync(join(tmpdir(), "earned-pick-empty-")) });
  await assert.rejects(runPick({ ...f.deps, pack: "2" }), (e) => e.code === "NO_BUYER" && /earned init/.test(e.message));
  assert.equal(f.calls.views.length, 0);
});

test("quote the contract can't explain (QUOTE_MISMATCH) stops the pick before create", async () => {
  const f = fakes({ quoteYocto: (31n * YOCTO_PER_MNEAR).toString() });
  await assert.rejects(runPick({ ...f.deps, pack: "2" }), { code: "QUOTE_MISMATCH" });
  assert.equal(f.calls.sends.length, 0);
  assert.equal(loadState(f.dir).spent_yocto, "0");
});

test("mainnet and non-testnet sellers are refused", async () => {
  const f = fakes();
  await assert.rejects(runPick({ ...f.deps, pack: "2", network: "mainnet" }), { code: "MAINNET_REFUSED" });
  await assert.rejects(runPick({ ...f.deps, pack: "2", seller: "seller.near" }), { code: "NOT_TESTNET" });
  assert.equal(f.calls.sends.length, 0);
});

test("buyer key file stays where init put it (pick never rewrites the key)", async () => {
  const f = fakes();
  await runPick({ ...f.deps, pack: "2" });
  assert.equal(loadState(f.dir).private_key, PRIV);
  assert.equal(statSync(keyFilePath(f.dir)).mode & 0o777, 0o600);
});

// ---- CLI wiring (no network: both fail before any call) ----

test("earned pick: usage error and NO_BUYER exit 1 without touching the network", () => {
  const home = mkdtempSync(join(tmpdir(), "earned-pick-cli-"));
  const env = { ...process.env, EARNED_HOME: home, EARNED_RPC_URL: "https://127.0.0.1.invalid" };
  const usage = spawnSync(process.execPath, [join(ROOT, "cli/earned.js"), "pick"], { env, encoding: "utf8" });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /error USAGE: usage: earned pick <1\|2\|3>/);
  const nobuyer = spawnSync(process.execPath, [join(ROOT, "cli/earned.js"), "pick", "2"], { env, encoding: "utf8" });
  assert.equal(nobuyer.status, 1);
  assert.match(nobuyer.stderr, /error NO_BUYER: .*earned init/);
  const help = spawnSync(process.execPath, [join(ROOT, "cli/earned.js")], { env, encoding: "utf8" });
  assert.match(help.stdout, /earned pick <1\|2\|3>/);
});

// ---- review fixes (code review M-1/M-2/S-1/S-2/S-3, security M-1/L-1/L-2) ----

test("M-1: a send that never reached the chain (notSent) releases the spend, marks the job failed, and the next pick runs", async () => {
  const f = fakes({ sendThrows: Object.assign(new Error("Failed to fetch access key from https://test.rpc.fastnear.com"), { notSent: true }) });
  await assert.rejects(runPick({ ...f.deps, pack: "2" }), (e) => e.code === "CREATE_NOT_SENT" && /No funds moved/.test(e.message) && /released/.test(e.message));
  assert.equal(loadState(f.dir).spent_yocto, "0");
  assert.equal(loadJob(f.dir).status, "failed");

  const g = fakes({ dir: f.dir });
  await runPick({ ...g.deps, pack: "2" });
  assert.equal(loadJob(f.dir).status, "open");
  assert.equal(loadState(f.dir).spent_yocto, (30n * YOCTO_PER_MNEAR).toString(), "only the live job is counted");
});

test("M-2: any status other than failed/closed blocks a new pick and leaves K + salt untouched", async () => {
  assert.deepEqual([...REUSABLE_STATUSES].sort(), ["closed", "failed"]);
  for (const status of ["open", "sending", "unconfirmed", "accepted", "reviewed", "revealing", "reveal_failed", "settled", "Closed", "typo"]) {
    const dir = buyerHome();
    saveJob(dir, { version: 1, status, pack_id: "pack-1", job_id: "4", K: "{\"pack_id\":\"pack-1\"}", salt: "cd".repeat(32) });
    const before = readFileSync(jobFilePath(dir), "utf8");
    const f = fakes({ dir });
    await assert.rejects(runPick({ ...f.deps, pack: "2" }), { code: "JOB_IN_PROGRESS" }, status);
    assert.equal(readFileSync(jobFilePath(dir), "utf8"), before, status);
    assert.equal(f.calls.sends.length, 0, status);
  }
});

test("M-2: a failed or closed job is archived to .earned/jobs/, never overwritten", async () => {
  for (const status of ["failed", "closed"]) {
    const dir = buyerHome();
    const old = { version: 1, status, pack_id: "pack-1", job_id: status === "closed" ? "4" : null, K: "{\"pack_id\":\"pack-1\"}", salt: "cd".repeat(32) };
    saveJob(dir, old);
    const before = readFileSync(jobFilePath(dir), "utf8");
    const f = fakes({ dir });
    await runPick({ ...f.deps, pack: "2" });
    assert.equal(loadJob(dir).status, "open");
    assert.equal(loadJob(dir).salt, SALT);
    const archived = readdirSync(join(dir, "jobs"));
    assert.equal(archived.length, 1, status);
    assert.match(archived[0], status === "closed" ? /pack-1-4-/ : /pack-1-unsent-/);
    assert.equal(readFileSync(join(dir, "jobs", archived[0]), "utf8"), before, "old K + salt kept byte-for-byte");
    assert.equal(statSync(join(dir, "jobs")).mode & 0o777, 0o700);
    assert.match(f.lines.join("\n"), new RegExp(`previous ${status} job file archived`));
  }
});

test("S-1: K + salt are on disk (status sending) and the spend is reserved before create is sent; tx hash saved before broadcast", async () => {
  let atSend;
  const f = fakes({
    onSend: async (req) => {
      atSend = { job: loadJob(f.dir), spent: loadState(f.dir).spent_yocto };
      req.onSigned("SignedTxHashBeforeBroadcast");
      atSend.afterSign = loadJob(f.dir);
    },
    sendThrows: new Error("socket hang up"),
  });
  await assert.rejects(runPick({ ...f.deps, pack: "2" }), (e) => e.code === "CREATE_UNCONFIRMED" && /SignedTxHashBeforeBroadcast/.test(e.message));
  assert.equal(atSend.job.status, "sending");
  assert.equal(atSend.job.salt, SALT);
  assert.equal(atSend.job.K, sealPick(loadPack("2"), "2", SALT).K);
  assert.equal(atSend.spent, (30n * YOCTO_PER_MNEAR).toString());
  assert.equal(atSend.afterSign.create_tx, "SignedTxHashBeforeBroadcast");
  const job = loadJob(f.dir);
  assert.equal(job.status, "unconfirmed");
  assert.equal(job.create_tx, "SignedTxHashBeforeBroadcast");
});

function unconfirmedHome() {
  const dir = buyerHome((30n * YOCTO_PER_MNEAR).toString());
  saveJob(dir, {
    version: 1, status: "unconfirmed", contract: CONTRACT, buyer: BUYER, pack_id: "pack-1", job_id: null,
    K: "{\"pack_id\":\"pack-1\"}", salt: "cd".repeat(32), price_yocto: (30n * YOCTO_PER_MNEAR).toString(), create_tx: "LostTxHash333",
  });
  return dir;
}

test("S-2: an unconfirmed create that landed is found by tx hash -> job open, new pick refused", async () => {
  const dir = unconfirmedHome();
  const f = fakes({ dir });
  const looked = [];
  const lookupCreate = async (q) => (looked.push(q), okOutcome("9", "LostTxHash333"));
  await assert.rejects(runPick({ ...f.deps, pack: "2", lookupCreate }), (e) => e.code === "JOB_IN_PROGRESS" && /job 9/.test(e.message));
  assert.deepEqual(looked, [{ txHash: "LostTxHash333", accountId: BUYER }]);
  assert.equal(loadJob(dir).status, "open");
  assert.equal(loadJob(dir).job_id, "9");
  assert.equal(loadJob(dir).salt, "cd".repeat(32));
  assert.equal(loadState(dir).spent_yocto, (30n * YOCTO_PER_MNEAR).toString());
  assert.equal(f.calls.sends.length, 0);
});

test("S-2: an unconfirmed create that was refused -> failed, reservation released, the new pick runs", async () => {
  const dir = unconfirmedHome();
  const f = fakes({ dir });
  await runPick({ ...f.deps, pack: "2", lookupCreate: async () => panicOutcome("Earned Price: bad deposit. No funds moved.", "LostTxHash333") });
  assert.equal(loadJob(dir).status, "open");
  assert.equal(loadState(dir).spent_yocto, (30n * YOCTO_PER_MNEAR).toString(), "old 0.030 released, new 0.030 reserved");
  assert.match(f.lines.join("\n"), /LostTxHash333 was refused/);
  assert.equal(readdirSync(join(dir, "jobs")).length, 1);
});

test("S-2: still unknown (lookup null or throws) -> refused with the explorer link and the exact mv command", async () => {
  for (const lookupCreate of [async () => null, async () => { throw new Error("UNKNOWN_TRANSACTION"); }, undefined]) {
    const dir = unconfirmedHome();
    const f = fakes({ dir });
    await assert.rejects(
      runPick({ ...f.deps, pack: "2", lookupCreate }),
      (e) => {
        const target = e.message.match(/mv -n (\S+) (\S+)$/);
        return e.code === "JOB_IN_PROGRESS" && e.message.includes("https://testnet.nearblocks.io/txns/LostTxHash333") &&
          target?.[1] === jobFilePath(dir) && target[2].startsWith(join(dir, "jobs", "unsent-")) && target[2].endsWith(".json");
      },
    );
    assert.equal(loadJob(dir).status, "unconfirmed");
    assert.equal(loadState(dir).spent_yocto, (30n * YOCTO_PER_MNEAR).toString());
  }
});

test("L-1 lock: a second concurrent pick is refused before any network call; the lock is released after a run", async () => {
  const f = fakes();
  writeFileSync(join(f.dir, LOCK_FILE_NAME), "");
  await assert.rejects(runPick({ ...f.deps, pack: "2" }), (e) => e.code === "PICK_LOCKED" && /delete that file/.test(e.message));
  assert.equal(f.calls.views.length, 0);
  assert.equal(existsSync(jobFilePath(f.dir)), false);

  const g = fakes();
  await runPick({ ...g.deps, pack: "2" });
  assert.equal(existsSync(join(g.dir, LOCK_FILE_NAME)), false);
  const h = fakes({ dir: g.dir });
  await assert.rejects(runPick({ ...h.deps, pack: "1" }), { code: "JOB_IN_PROGRESS" });
  assert.equal(existsSync(join(g.dir, LOCK_FILE_NAME)), false, "released on error too");
});

test("O-2: each recovery mv targets a fresh timestamped name, never overwriting an earlier one", async () => {
  const targets = [];
  for (let i = 0; i < 2; i++) {
    const dir = unconfirmedHome();
    const f = fakes({ dir });
    await assert.rejects(runPick({ ...f.deps, pack: "2" }), (e) => (targets.push(e.message.match(/mv -n \S+ (\S+)$/)?.[1]), true));
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(targets.every(Boolean));
  const names = targets.map((t) => t.split("/").at(-1));
  assert.notEqual(names[0], names[1]);
});

test("N-1 stale lock: a lock left by a dead pid is removed and the pick runs", async () => {
  const dead = spawnSync(process.execPath, ["-e", ""]).pid; // already exited
  const f = fakes();
  writeFileSync(join(f.dir, LOCK_FILE_NAME), String(dead));
  const res = await runPick({ ...f.deps, pack: "2" });
  assert.equal(res.job.status, "open");
  assert.match(f.lines.join("\n"), new RegExp(`removed a stale lock from pid ${dead}`));
  assert.equal(existsSync(join(f.dir, LOCK_FILE_NAME)), false, "our own lock released after the run");
});

test("N-1 stale lock: a lock held by a live pid (ours) still gives PICK_LOCKED and is kept", async () => {
  const f = fakes();
  const lock = join(f.dir, LOCK_FILE_NAME);
  writeFileSync(lock, String(process.pid));
  await assert.rejects(runPick({ ...f.deps, pack: "2" }), { code: "PICK_LOCKED" });
  assert.equal(readFileSync(lock, "utf8"), String(process.pid));
  assert.equal(f.calls.views.length, 0);
});

test("N-1 stale lock: an empty or unparseable lock older than 2 min is removed; a fresh one is not", async () => {
  for (const body of ["", "not-a-pid"]) {
    const f = fakes();
    const lock = join(f.dir, LOCK_FILE_NAME);
    writeFileSync(lock, body);
    await assert.rejects(runPick({ ...f.deps, pack: "2" }), { code: "PICK_LOCKED" }, `fresh ${JSON.stringify(body)}`);
    const old = new Date(Date.now() - 3 * 60 * 1000);
    utimesSync(lock, old, old);
    const res = await runPick({ ...f.deps, pack: "2" });
    assert.equal(res.job.status, "open");
    assert.match(f.lines.join("\n"), /removed a stale lock/);
  }
});

test("N-1 lock file: our pid, mode 0600", async () => {
  const f = fakes();
  let seen;
  const res = await runPick({
    ...f.deps,
    pack: "2",
    sendCreate: async (req) => {
      const lock = join(f.dir, LOCK_FILE_NAME);
      seen = { body: readFileSync(lock, "utf8"), mode: statSync(lock).mode & 0o777 };
      return f.deps.sendCreate(req);
    },
  });
  assert.equal(res.job.status, "open");
  assert.deepEqual(seen, { body: String(process.pid), mode: 0o600 });
});

test("L-2: the seller and its source are shown; a non-demo seller needs --yes", async () => {
  const f = fakes();
  await runPick({ ...f.deps, pack: "2" });
  assert.match(f.lines.join("\n"), new RegExp(`Seller: ${DEMO_SELLER.replace(/\./g, "\\.")} \\(demo default\\)`));

  const g = fakes();
  await assert.rejects(runPick({ ...g.deps, pack: "2", seller: "other.testnet" }), (e) => e.code === "SELLER_NOT_CONFIRMED" && /--yes/.test(e.message));
  assert.equal(g.calls.views.length, 0);
  await runPick({ ...g.deps, pack: "2", seller: "other.testnet", yes: true });
  assert.match(g.lines.join("\n"), /Seller: other\.testnet \(from --seller, not the demo seller; confirmed with --yes\)/);
  assert.equal(g.calls.sends[0].args.seller, "other.testnet");
});

test("S-3: defaultPickDeps: demo seller by default, EARNED_SELLER ignored, a mainnet EARNED_RPC_URL refused", async () => {
  const d = await defaultPickDeps({});
  assert.equal(d.seller, DEMO_SELLER);
  assert.equal(typeof d.sendCreate, "function");
  assert.equal(typeof d.lookupCreate, "function");
  assert.equal((await defaultPickDeps({ EARNED_SELLER: "attacker.testnet" })).seller, DEMO_SELLER);
  await assert.rejects(defaultPickDeps({ EARNED_RPC_URL: "https://rpc.mainnet.near.org" }));
});

// ---- sendCreateTx: real near-api-js 7.4.0 types, fake accounts (no network) ----

const KP = near.KeyPair.fromRandom("ed25519");
const SIGNER = new near.KeyPairSigner(KP);
async function signTx(nonce = 5n) {
  const tx = near.createTransaction(BUYER, KP.getPublicKey(), CONTRACT, nonce, [near.actions.functionCall("create", { a: 1 }, CREATE_GAS, 1n)], new Uint8Array(32));
  return SIGNER.signTransaction(tx);
}

function fakeAccounts(script) {
  const log = { made: [], broadcasts: [] };
  let i = 0;
  const makeAccount = (url) => {
    const step = script[i++] ?? {};
    log.made.push(url);
    return {
      createSignedTransaction: async () => {
        if (step.signThrows) throw step.signThrows;
        return (await signTx(step.nonce)).signedTransaction;
      },
      provider: {
        viewTransactionStatus: async (q) => {
          if (!step.viewTx) throw new Error("UNKNOWN_TRANSACTION");
          return step.viewTx(q);
        },
        sendTransactionUntil: async (signed, waitUntil) => {
          log.broadcasts.push({ url, waitUntil, nonce: signed.transaction.nonce });
          if (step.sendThrows) throw step.sendThrows;
          return okOutcome("1", "H");
        },
      },
    };
  };
  return { makeAccount, log };
}

const sendReq = (makeAccount, onSigned) => ({
  urls: ["https://a.test", "https://b.test"], makeAccount, near, rpcErrors, onSigned,
  state: { account_id: BUYER }, contractId: CONTRACT, methodName: "create", args: { a: 1 }, depositYocto: 1n, gas: CREATE_GAS,
});

test("signedTxHash is the signer's own sha256 tx hash in base58", async () => {
  const { txHash, signedTransaction } = await signTx();
  assert.equal(signedTxHash(signedTransaction, near), near.baseEncode(txHash));
});

test("sendCreateTx: signs on the first RPC that answers, reports the hash, then broadcasts on that RPC", async () => {
  const { makeAccount, log } = fakeAccounts([{ signThrows: new Error("fetch failed") }, {}]);
  const hashes = [];
  const out = await sendCreateTx(sendReq(makeAccount, (h) => hashes.push(h)));
  assert.equal(out.status.SuccessValue, b64('"1"'));
  assert.deepEqual(log.made, ["https://a.test", "https://b.test"]);
  assert.deepEqual(log.broadcasts.map((b) => [b.url, b.waitUntil]), [["https://b.test", "EXECUTED_OPTIMISTIC"]]);
  assert.equal(hashes.length, 1);
  assert.equal(hashes[0], signedTxHash((await signTx()).signedTransaction, near));
});

test("sendCreateTx: signing fails everywhere -> notSent, nothing broadcast, no hash reported", async () => {
  const { makeAccount, log } = fakeAccounts([{ signThrows: new Error("fetch failed") }, { signThrows: new Error("fetch failed") }]);
  let signed = 0;
  await assert.rejects(sendCreateTx(sendReq(makeAccount, () => signed++)), (e) => e.notSent === true);
  assert.equal(log.broadcasts.length, 0);
  assert.equal(signed, 0);
});

test("sendCreateTx: RPC rejects the tx before inclusion (InvalidTx) -> notSent", async () => {
  for (const err of [new rpcErrors.NotEnoughBalanceError(1n, 2n, BUYER, "", ""), new rpcErrors.TransactionExpiredError("", ""), new rpcErrors.InvalidTransactionError()]) {
    const { makeAccount } = fakeAccounts([{ sendThrows: err }]);
    await assert.rejects(sendCreateTx(sendReq(makeAccount)), (e) => e.notSent === true, err.constructor.name);
  }
});

test("sendCreateTx: InvalidNonce once -> re-signed with a fresh account and sent; twice -> notSent", async () => {
  const nonceErr = () => new rpcErrors.InvalidNonceError(9n, 5n, "", "");
  const a = fakeAccounts([{ sendThrows: nonceErr() }, { nonce: 10n }]);
  const hashes = [];
  await sendCreateTx(sendReq(a.makeAccount, (h) => hashes.push(h)));
  assert.equal(a.log.broadcasts.length, 2);
  assert.equal(a.log.broadcasts[1].nonce, 10n);
  assert.equal(hashes.length, 2, "the re-signed tx hash replaces the first");
  assert.notEqual(hashes[0], hashes[1]);

  const b = fakeAccounts([{ sendThrows: nonceErr() }, { sendThrows: nonceErr() }]);
  await assert.rejects(sendCreateTx(sendReq(b.makeAccount)), (e) => e.notSent === true);
});

test("O-1: InvalidNonce, but the first tx is found on chain -> its outcome is returned, no second create", async () => {
  const nonceErr = new rpcErrors.InvalidNonceError(9n, 5n, "", "");
  const lookups = [];
  const a = fakeAccounts([{ sendThrows: nonceErr, viewTx: (q) => (lookups.push(q), okOutcome("7", "FirstHash")) }, {}]);
  const out = await sendCreateTx(sendReq(a.makeAccount));
  assert.equal(out.status.SuccessValue, b64('"7"'));
  assert.equal(a.log.broadcasts.length, 1, "not re-signed");
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].txHash, signedTxHash((await signTx()).signedTransaction, near));
  assert.equal(lookups[0].accountId, BUYER);
});

test("sendCreateTx: timeout or a dropped connection after broadcast is an unknown outcome (not notSent)", async () => {
  for (const err of [new rpcErrors.TransactionTimeoutError(), new Error("socket hang up"), new rpcErrors.ActionExecutionError("x", 0, "", "")]) {
    const { makeAccount } = fakeAccounts([{ sendThrows: err }]);
    await assert.rejects(sendCreateTx(sendReq(makeAccount)), (e) => e === err && !e.notSent, err.constructor.name);
  }
  assert.equal(isRejectedBeforeInclusion(new Error("x"), rpcErrors), false);
});

test("earned pick CLI: --seller needs --yes; EARNED_SELLER does not change the seller (no network)", () => {
  const home = mkdtempSync(join(tmpdir(), "earned-pick-cli-seller-"));
  const env = { ...process.env, EARNED_HOME: home, EARNED_RPC_URL: "https://127.0.0.1.invalid" };
  const run = (args, extra = {}) => spawnSync(process.execPath, [join(ROOT, "cli/earned.js"), "pick", ...args], { env: { ...env, ...extra }, encoding: "utf8" });
  const noYes = run(["2", "--seller", "other.testnet"]);
  assert.equal(noYes.status, 1);
  assert.match(noYes.stderr, /error SELLER_NOT_CONFIRMED: .*--yes/);
  assert.match(run(["2", "--seller", "other.testnet", "--yes"]).stderr, /error NO_BUYER/);
  // If EARNED_SELLER were honoured, this would be SELLER_NOT_CONFIRMED.
  assert.match(run(["2"], { EARNED_SELLER: "other.testnet" }).stderr, /error NO_BUYER/);
});

test("embedded pick (from `earned hire --pack 3`, T-032): same create, but no 'Next:' and no 'SEE: step 2 PASS' line", async () => {
  const f = fakes({ record: { passes: 1, fails: 0, unique_buyers: 1, jobs: 1 } });
  const r = await runPick({ ...f.deps, pack: "3", embedded: true });
  assert.equal(f.calls.sends.length, 1);
  assert.equal(f.calls.sends[0].depositYocto, 40n * YOCTO_PER_MNEAR);
  assert.equal(r.job.status, "open");
  assert.ok(!f.lines.some((l) => l.startsWith("SEE:") || l.startsWith("Next:")));
  assert.match(f.lines.at(-1), /key \+ salt kept in /);
});
