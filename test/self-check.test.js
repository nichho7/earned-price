// scripts/self-check.mjs (T-041): the README Tier 1 self-check that T-065 / T-066 run on a clean
// machine. No network here: the offline steps run for real, the rest through a fake runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MACOS_SDK_HINT, STEPS, childEnv, formulaExplains, meetsBar, parseArgs, run, runSelfCheck, summaryLine, summaryMain, summaryMarkdown } from "../scripts/self-check-lib.mjs";

const README = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
const OFFLINE = ["node", "install", "cli", "verify-2", "verify-3", "tamper", "recorded"];

test("self-check: every step's 'do' command and 'see' line is in the README (script and README can't drift)", () => {
  assert.equal(new Set(STEPS.map((s) => s.id)).size, STEPS.length, "unique ids");
  for (const s of STEPS) {
    assert.ok(README.includes(s.do), `README is missing step ${s.id} do: ${s.do}`);
    assert.ok(README.includes(s.see), `README is missing step ${s.id} see: ${s.see}`);
  }
  assert.ok(README.includes("node scripts/self-check.mjs"), "README names the self-check");
  // Numbering too (code review O-4): README item n is STEPS[n-1], and the step counts match.
  const tier1 = README.slice(README.indexOf("The same steps by hand:"), README.indexOf("### Tier 2"));
  STEPS.forEach((st, i) => {
    const item = tier1.slice(tier1.indexOf(`\n${i + 1}. **`), i + 1 < STEPS.length ? tier1.indexOf(`\n${i + 2}. **`) : undefined);
    assert.ok(item.includes(st.do), `README item ${i + 1} is not step ${st.id}`);
  });
  const fast = STEPS.filter((st) => !st.slow).length;
  assert.ok(README.includes(`# all ${STEPS.length} steps`) && README.includes(`# ${fast} steps, leaves out`), "README step counts");
  assert.ok(README.includes(`SELF-CHECK: ${STEPS.length}/${STEPS.length} steps PASS (100%), 0 FAIL`));
  assert.ok(README.includes(`${fast}/${STEPS.length} steps PASS (${Math.floor((100 * fast) / STEPS.length)}%), 0 FAIL, ${STEPS.length - fast} not run (--quick)`));
});

test("self-check: the offline steps pass for real on this checkout", async () => {
  const only = OFFLINE.map((id) => STEPS.findIndex((s) => s.id === id) + 1);
  const s = await runSelfCheck({ only, runner: run });
  assert.deepEqual(s.steps.filter((r) => r.status !== "NOT RUN").map((r) => [r.id, r.status, r.detail]).filter(([, st]) => st !== "PASS"), []);
  assert.equal(s.pass, OFFLINE.length);
  assert.equal(s.ok, true);
  assert.equal(s.partial, true, "an --only run is partial");
  assert.equal(s.pct, Math.floor((100 * OFFLINE.length) / STEPS.length), "pct is over all steps");
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
  assert.deepEqual({ total: s.total, pass: s.pass, fail: s.fail, skip: s.skip, not_run: s.not_run, pct: s.pct, pct_of_run: s.pct_of_run, partial: s.partial, ok: s.ok }, { total: 3, pass: 1, fail: 1, skip: 1, not_run: 1, pct: 25, pct_of_run: 33, partial: true, ok: false });
  assert.equal(s.steps[2].detail, "error: boom");
  assert.equal(summaryLine(s), "SELF-CHECK (partial, not a north-star number): 1/4 steps PASS (25%), 1 FAIL, 1 SKIP (counted as not passing), 1 not run (--quick)");
  const quick = await runSelfCheck({ steps: [fake("a", { ok: true }), { ...fake("d", { ok: true }), slow: true }], quick: true });
  assert.deepEqual({ ok: quick.ok, partial: quick.partial, pct: quick.pct }, { ok: true, partial: true, pct: 50 }, "a green --quick run is never 100%");
  const all = await runSelfCheck({ steps: [fake("a", { ok: true }), { ...fake("d", { ok: true }), slow: true }] });
  assert.equal(summaryLine(all), "SELF-CHECK: 2/2 steps PASS (100%), 0 FAIL");
  assert.deepEqual({ ok: all.ok, partial: all.partial }, { ok: true, partial: false });
});

test("self-check: the live steps read the output they claim to (fake runner, no network)", async () => {
  const byId = (id) => STEPS.find((s) => s.id === id);
  const out = (stdout, status = 0) => () => ({ status, stdout, stderr: "" });
  const quote = "Quote: 0.045 NEAR (testnet)\n  formula: 0.030 + 0.010×2 − 0.005×1 = 0.045 NEAR\nRefused 0.020 NEAR: below my cost floor 0.025 NEAR. My price is 0.045 NEAR.\n";
  assert.equal(byId("quote").check({ run: out(quote) }).ok, true, "a moved quote still passes when the formula explains it");
  assert.equal(byId("quote").check({ run: out(quote.replace("= 0.045", "= 0.040")) }).ok, false, "formula must equal the quote");
  const floor = "Quote: 0.025 NEAR (testnet)\n  formula: 0.030 + 0.010×0 − 0.005×2 = 0.020 → floor 0.025 NEAR\nRefused 0.020 NEAR: below my cost floor 0.025 NEAR. My price is 0.025 NEAR.\n";
  assert.equal(byId("quote").check({ run: out(floor) }).ok, true, "a clamped quote at the floor is explained (code review O-2)");
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
  const linkFail = (cmd, args) => (args[0] === "test" ? { status: 101, stdout: "", stderr: "error: linking with `cc` failed: exit status: 1\n  = note: ld: tapi error: unknown architecture arm64e.x1\n" } : { status: 0, stdout: "ok" });
  const r = ct.check({ run: linkFail });
  assert.equal(r.ok, false);
  assert.equal(r.hint, MACOS_SDK_HINT, "the macOS SDK hint on that linker error");
  assert.match(MACOS_SDK_HINT, /SDKROOT=/);
  assert.equal(ct.check({ run: (c, a) => (a[0] === "test" ? { status: 101, stdout: "", stderr: "other error" } : { status: 0 }) }).hint, undefined);
  const npmOut = "ℹ tests 10\nℹ pass 8\nℹ fail 0\nℹ skipped 2\n";
  assert.match(byId("npm-test").check({ run: out(npmOut) }).detail, /^8 pass, 0 fail, 2 skipped \(skips include the headless-Chrome tests/, "step 12 shows skips (code review O-3)");
});

test("self-check: formulaExplains accepts the plain sum and a named floor or cap, nothing else", () => {
  assert.equal(formulaExplains("  formula: 0.030 + 0.010×1 − 0.005×0 = 0.040 NEAR", "0.040"), true);
  assert.equal(formulaExplains("  formula: 0.030 + 0.010×8 − 0.005×0 = 0.110 → cap 0.100 NEAR", "0.100"), true);
  assert.equal(formulaExplains("  formula: 0.030 + 0.010×0 − 0.005×2 = 0.020 → floor 0.025 NEAR", "0.025"), true);
  assert.equal(formulaExplains("  formula: 0.030 + 0.010×1 − 0.005×0 = 0.050 NEAR", "0.050"), false, "wrong arithmetic");
  assert.equal(formulaExplains("  formula: 0.030 + 0.010×0 − 0.005×0 = 0.030 → floor 0.025 NEAR", "0.025"), false, "a floor that isn't needed");
  assert.equal(formulaExplains("  formula: 0.030 + 0.010×1 − 0.005×0 = 0.040 NEAR", "0.045"), false);
});

test("self-check: child commands get no key variables and no EARNED_* overrides (sec L-1, L-2)", () => {
  const env = childEnv({ PATH: "/bin", HOME: "/h", LC_ALL: "C", SDKROOT: "/sdk", REQUIRE_BROWSER: "1", NEAR_AI_API_KEY: "k", EARNED_SELLER_PRIVATE_KEY: "ed25519:x", EARNED_RPC_URL: "http://127.0.0.1:1", EARNED_NETWORK: "mainnet", EARNED_HOME: "/x", NODE_OPTIONS: "--require evil.js", AWS_SECRET_ACCESS_KEY: "s" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LC_ALL", "PATH", "REQUIRE_BROWSER", "SDKROOT"]);
});

test("self-check: argument parsing", () => {
  assert.deepEqual(parseArgs([]), { quick: false, json: false, only: null });
  assert.deepEqual(parseArgs(["--quick", "--json", "--only", "4,11"]), { quick: true, json: true, only: [4, 11] });
  assert.throws(() => parseArgs(["--only", "0"]), /step numbers/);
  assert.throws(() => parseArgs(["--live"]), /unknown argument/);
});

// T-089 (S-025 AC2): the Tier 1 CI job writes this summary and fails below 13/13.
test("self-check summary (CI job): 13/13 passes; any FAIL, SKIP, partial run or missing JSON fails the job", async () => {
  const all = (status) => async () => (status === "SKIP" ? { skip: "tool missing" } : status === "PASS" ? { ok: true, detail: "ok | fine" } : { ok: false, detail: "bad" });
  const steps = (status13) => STEPS.map((st, i) => ({ ...st, check: all(i === 12 ? status13 : "PASS") }));
  const full = await runSelfCheck({ steps: steps("PASS") });
  assert.equal(meetsBar(full), true);
  const md = summaryMarkdown(full);
  assert.match(md, /^## README Tier 1 self-check: 13\/13 steps PASS \(100%\)\n/);
  assert.ok(md.includes("`SELF-CHECK: 13/13 steps PASS (100%), 0 FAIL`"));
  assert.ok(md.includes(`| 13 | ${STEPS[12].title} | PASS | ok \\| fine |`), "titles from STEPS; a | in the detail is escaped");
  for (const [s, why] of [
    [await runSelfCheck({ steps: steps("FAIL") }), "a FAIL"],
    [await runSelfCheck({ steps: steps("SKIP") }), "a SKIP (missing Rust)"],
    [await runSelfCheck({ steps: steps("PASS"), quick: true }), "--quick"],
    [await runSelfCheck({ steps: steps("PASS"), only: [1] }), "--only"],
  ]) {
    assert.equal(meetsBar(s), false, why);
    assert.match(summaryMarkdown(s), /\(below 13\/13: FAIL\)/, why);
  }
  assert.match(summaryMarkdown(await runSelfCheck({ steps: steps("SKIP") })), /\| 13 \| .* \| \*\*SKIP\*\* \| tool missing \|/);
  let out = "";
  assert.equal(summaryMain(["x.json"], { read: () => JSON.stringify(full), write: (t) => (out += t) }), 0);
  assert.ok(out.startsWith("## README Tier 1 self-check: 13/13"));
  for (const read of [() => "", () => "not json", () => { throw new Error("ENOENT"); }, () => "{}"]) {
    out = "";
    assert.equal(summaryMain(["x.json"], { read, write: (t) => (out += t) }), 1);
    assert.match(out, /NO RESULT/);
  }
});
