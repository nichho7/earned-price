// scripts/self-check.mjs (T-041): the README Tier 1 self-check that T-065 / T-066 run on a clean
// machine. No network here: the offline steps run for real, the rest through a fake runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STEPS, parseArgs, run, runSelfCheck, summaryLine } from "../scripts/self-check.mjs";

const README = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
const OFFLINE = ["node", "install", "cli", "verify-2", "verify-3", "tamper", "recorded"];

test("self-check: every step's 'do' command and 'see' line is in the README (script and README can't drift)", () => {
  assert.equal(new Set(STEPS.map((s) => s.id)).size, STEPS.length, "unique ids");
  for (const s of STEPS) {
    assert.ok(README.includes(s.do), `README is missing step ${s.id} do: ${s.do}`);
    assert.ok(README.includes(s.see), `README is missing step ${s.id} see: ${s.see}`);
  }
  assert.ok(README.includes("node scripts/self-check.mjs"), "README names the self-check");
});

test("self-check: the offline steps pass for real on this checkout", async () => {
  const only = OFFLINE.map((id) => STEPS.findIndex((s) => s.id === id) + 1);
  const s = await runSelfCheck({ only, runner: run });
  assert.deepEqual(s.steps.filter((r) => r.status !== "NOT RUN").map((r) => [r.id, r.status, r.detail]).filter(([, st]) => st !== "PASS"), []);
  assert.equal(s.pass, OFFLINE.length);
  assert.equal(s.ok, true);
});

const fake = (id, r) => ({ id, title: id, do: id, see: id, check: () => r });

test("self-check: SKIP counts as not passing; --quick leaves slow steps out of the total; a throw is a FAIL", async () => {
  const steps = [
    fake("a", { ok: true, detail: "x" }),
    fake("b", { skip: "python3 not found" }),
    { ...fake("c", null), check: () => { throw new Error("boom"); } },
    { ...fake("d", { ok: true }), slow: true },
  ];
  const s = await runSelfCheck({ steps, quick: true });
  assert.deepEqual(s.steps.map((r) => r.status), ["PASS", "SKIP", "FAIL", "NOT RUN"]);
  assert.deepEqual({ total: s.total, pass: s.pass, fail: s.fail, skip: s.skip, not_run: s.not_run, pct: s.pct, ok: s.ok }, { total: 3, pass: 1, fail: 1, skip: 1, not_run: 1, pct: 33, ok: false });
  assert.equal(s.steps[2].detail, "error: boom");
  assert.equal(summaryLine(s), "SELF-CHECK: 1/3 steps PASS (33%), 1 FAIL, 1 SKIP (counted as not passing), 1 not run (--quick)");
  const all = await runSelfCheck({ steps: [fake("a", { ok: true }), { ...fake("d", { ok: true }), slow: true }] });
  assert.equal(summaryLine(all), "SELF-CHECK: 2/2 steps PASS (100%), 0 FAIL");
  assert.equal(all.ok, true);
});

test("self-check: the live steps read the output they claim to (fake runner, no network)", async () => {
  const byId = (id) => STEPS.find((s) => s.id === id);
  const out = (stdout, status = 0) => () => ({ status, stdout, stderr: "" });
  const quote = "Quote: 0.045 NEAR (testnet)\n  formula: 0.030 + 0.010×2 − 0.005×1 = 0.045 NEAR\nRefused 0.020 NEAR: below my cost floor 0.025 NEAR. My price is 0.045 NEAR.\n";
  assert.equal(byId("quote").check({ run: out(quote) }).ok, true, "a moved quote still passes when the formula explains it");
  assert.equal(byId("quote").check({ run: out(quote.replace("= 0.045", "= 0.040")) }).ok, false, "formula must equal the quote");
  assert.equal(byId("record").check({ run: out('{"passes":3,"fails":1,"unique_buyers":2,"jobs":4}') }).ok, true);
  assert.equal(byId("record").check({ run: out('{"passes":1,"fails":0,"unique_buyers":1,"jobs":1}') }).ok, false, "fewer passes than the recorded run");
  const acct = (h) => (cmd, args) => (args[1] === "account" ? { status: 0, stdout: JSON.stringify({ exists: true, code_hash: h }) } : { status: 0, stdout: '"Earned Price"\n' });
  assert.equal(byId("contract").check({ run: acct("3j1YYcy6bDSMyN2bUEnE8uQc4s3HbHWfc4dAs3NC9byG") }).ok, true);
  assert.equal(byId("contract").check({ run: acct("11111111111111111111111111111111") }).ok, false, "other live code fails");
  const ct = byId("contract-test");
  assert.deepEqual(ct.check({ run: () => ({ missing: true }) }), { skip: "cargo not found (install Rust: see Prerequisites)" });
  const cargoOut = "repeat pass (same buyer): seller paid, quote 0.040 -> 0.040\nfail + refund: quote 0.040 -> 0.035 (buyer refunded 0.040 NEAR in full)\ntest balances_follow_the_escrow_rules ... ok\n";
  assert.equal(ct.check({ run: out(cargoOut) }).ok, true);
  assert.equal(ct.check({ run: out(cargoOut.replace("0.035", "0.040")) }).ok, false);
});

test("self-check: argument parsing", () => {
  assert.deepEqual(parseArgs([]), { quick: false, json: false, only: null });
  assert.deepEqual(parseArgs(["--quick", "--json", "--only", "4,11"]), { quick: true, json: true, only: [4, 11] });
  assert.throws(() => parseArgs(["--only", "0"]), /step numbers/);
  assert.throws(() => parseArgs(["--live"]), /unknown argument/);
});
