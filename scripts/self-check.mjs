#!/usr/bin/env node
// README Tier 1 self-check (T-041): runs every keyless "do X, see Y" step of the README and prints
// PASS / FAIL / SKIP per step plus the pass percentage (the north-star number, T-065 / T-066).
//
//   node scripts/self-check.mjs              all Tier 1 steps (about 5-10 min: npm test + Rust contract test)
//   node scripts/self-check.mjs --quick      leaves out the 2 slow steps (npm test, contract test)
//   node scripts/self-check.mjs --only 4,11  just those steps (numbers as printed)
//   node scripts/self-check.mjs --json       one JSON summary on stdout instead of the table
//
// Keyless and read-only: no account, no key, no transaction, no NEAR AI call, writes nothing outside
// the repo's own build folders. Steps 9-11 read testnet through the public RPCs (or EARNED_RPC_URL,
// which the tools only accept from their testnet allowlist). A step whose tool is missing (python3,
// cargo, cargo-near) is a SKIP, and a SKIP counts as not passing.
// Exit code: 0 when every step that ran passed and none was skipped, 1 otherwise, 2 on bad usage.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXPECTED_CODE_HASH } from "./live-preflight.mjs"; // the approved deploy (2026-11-12)

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELLER = "seller.earned-price.testnet";
const CONTRACT = "earned-price.testnet";
const LOG = "recorded/live-run-2026-11-12.log";
const MIN = 60_000;

const authentic = (pack) =>
  `REVIEW AUTHENTIC (offline): genuine NEAR AI TEE review of the official ${pack} request (prompt v1), regrade PASS.`;
const lines = (s) => String(s ?? "").split(/\r?\n/);
const has = (out, line) => lines(out).some((l) => l.trim() === line);
const fail = (detail) => ({ ok: false, detail });
const pass = (detail) => ({ ok: true, detail });
const tail = (r) => lines(`${r.stdout ?? ""}\n${r.stderr ?? ""}`).filter(Boolean).slice(-3).join(" | ");

/** Default runner: a child process in the repo root, output captured. Injected in tests. */
export function run(cmd, args, { timeout = 2 * MIN } = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024, env: process.env });
  if (r.error?.code === "ENOENT") return { missing: true, status: null, stdout: "", stderr: "" };
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: r.error?.code === "ETIMEDOUT" };
}

function verifyStep(r, pack) {
  if (r.status !== 0) return fail(`exit ${r.status}: ${tail(r)}`);
  const checks = lines(r.stdout).filter((l) => /^(PASS|FAIL) {2}\d /.test(l));
  if (checks.join("|") !== "PASS  1 Commit hash matches the revealed key|PASS  2 TEE signature covers this review|PASS  3 Attestation binds the signer and nonce|PASS  4 Regrade gives the same score") {
    return fail(`checks: ${checks.join(" / ") || "none printed"}`);
  }
  return has(r.stdout, authentic(pack)) ? pass("PASS 1-4, REVIEW AUTHENTIC (offline), exit 0") : fail("no REVIEW AUTHENTIC line");
}

/** The Tier 1 steps, in README order. `do` and `see` are what the README prints for each. */
export const STEPS = [
  {
    id: "node", title: "Node.js 20 or newer",
    do: "node --version", see: "v20 or newer",
    check: () => {
      const major = Number(process.versions.node.split(".")[0]);
      return major >= 20 ? pass(`v${process.versions.node}`) : fail(`v${process.versions.node}: install Node 20+`);
    },
  },
  {
    id: "install", title: "Dependencies installed at the pinned versions",
    do: "npm ci", see: "no npm error; node_modules holds near-api-js 7.4.0, @noble/curves 2.4.0, @noble/hashes 2.4.0",
    check: () => {
      const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
      const bad = Object.entries(pkg.dependencies).filter(([name, want]) => {
        const f = join(ROOT, "node_modules", name, "package.json");
        return !existsSync(f) || JSON.parse(readFileSync(f, "utf8")).version !== want;
      });
      return bad.length ? fail(`missing or wrong version: ${bad.map(([n, v]) => `${n}@${v}`).join(", ")}: run npm ci`) : pass(Object.entries(pkg.dependencies).map(([n, v]) => `${n}@${v}`).join(", "));
    },
  },
  {
    id: "cli", title: "The earned CLI runs",
    do: "node cli/earned.js", see: "Earned Price (earned)  contract earned-price.testnet on testnet",
    check: ({ run }) => {
      const r = run(process.execPath, ["cli/earned.js"]);
      return r.status === 0 && lines(r.stdout)[0] === "Earned Price (earned)  contract earned-price.testnet on testnet"
        ? pass("usage printed, exit 0") : fail(`exit ${r.status}: ${tail(r)}`);
    },
  },
  {
    id: "verify-2", title: "Offline verify: the recorded pack-2 receipt (job 1, 5/5)",
    do: "node cli/earned.js verify recorded/pack-2.json", see: authentic("pack-2"),
    check: ({ run }) => verifyStep(run(process.execPath, ["cli/earned.js", "verify", "recorded/pack-2.json"]), "pack-2"),
  },
  {
    id: "verify-3", title: "Offline verify: the recorded pack-3 receipt (job 2, 4/5)",
    do: "node cli/earned.js verify recorded/pack-3.json", see: authentic("pack-3"),
    check: ({ run }) => verifyStep(run(process.execPath, ["cli/earned.js", "verify", "recorded/pack-3.json"]), "pack-3"),
  },
  {
    id: "tamper", title: "Offline verify: one changed byte fails check 2 only",
    do: "node cli/earned.js verify recorded/pack-2.json --tamper", see: "FAIL: check 2 TEE signature covers this review",
    check: ({ run }) => {
      const r = run(process.execPath, ["cli/earned.js", "verify", "recorded/pack-2.json", "--tamper"]);
      const fails = lines(r.stdout).filter((l) => /^FAIL {2}\d /.test(l));
      if (r.status !== 1) return fail(`exit ${r.status} (want 1): ${tail(r)}`);
      if (fails.join("|") !== "FAIL  2 TEE signature covers this review") return fail(`failed checks: ${fails.join(" / ") || "none"}`);
      return has(r.stdout, "FAIL: check 2 TEE signature covers this review") ? pass("check 2 FAIL, checks 1, 3, 4 PASS, exit 1") : fail("no 'FAIL: check 2' verdict line");
    },
  },
  {
    id: "recorded", title: "The recorded live run: steps 1-4 PASS, quote 0.030 -> 0.040, then held",
    do: `grep -E '^(SEE:|Next quote|Quote held)' ${LOG}`,
    see: "SEE: step 1..4 PASS, Next quote (get_record): 0.030 -> 0.040 NEAR, Quote held: 0.040 -> 0.040 NEAR",
    check: () => {
      const log = readFileSync(join(ROOT, LOG), "utf8");
      const got = lines(log).filter((l) => /^(SEE:|Next quote|Quote held)/.test(l));
      const want = ["SEE: step 1 PASS", "SEE: step 2 PASS", "Next quote (get_record): 0.030 -> 0.040 NEAR", "SEE: step 3 PASS", "Next quote (get_record): 0.040 -> 0.040 NEAR"];
      const missing = want.filter((w) => !got.includes(w));
      if (!got.some((l) => l.startsWith("Quote held: 0.040 -> 0.040 NEAR"))) missing.push("Quote held: 0.040 -> 0.040 NEAR");
      if (!got.includes("SEE: step 4 PASS")) missing.push("SEE: step 4 PASS");
      if (missing.length) return fail(`missing: ${missing.join(" / ")}`);
      // The log and the receipts must name the same settle txs (one run, not two stories).
      for (const p of ["pack-2", "pack-3"]) {
        const tx = JSON.parse(readFileSync(join(ROOT, "recorded", `${p}.json`), "utf8")).txs?.reveal;
        if (!tx || !log.includes(`settle tx (the settle runs inside reveal): ${tx}`)) return fail(`${p} settle tx not in the log`);
      }
      return pass("4 SEE lines, 0.030 -> 0.040 -> 0.040; settle txs match the receipts");
    },
  },
  {
    id: "packs", title: "Exam packs: 5 planted bugs each, every test fails as designed", needs: "python3",
    do: "python3 packs/check_packs.py", see: "pack 1: OK (16 tests; 5 planted-bug tests fail as designed; ...), same for packs 2 and 3",
    check: ({ run }) => {
      const r = run("python3", ["packs/check_packs.py"]);
      if (r.missing) return { skip: "python3 not found" };
      const ok = [1, 2, 3].filter((n) => lines(r.stdout).some((l) => l.startsWith(`pack ${n}: OK (`) && l.includes("5 planted-bug tests fail as designed")));
      return r.status === 0 && ok.length === 3 ? pass("packs 1-3 OK") : fail(`exit ${r.status}, packs OK: ${ok.join(",") || "none"}: ${tail(r)}`);
    },
  },
  {
    id: "contract", title: "Live testnet: the escrow is deployed with the approved code", network: true,
    do: `node scripts/testnet-view.mjs account ${CONTRACT}`, see: `"code_hash":"${EXPECTED_CODE_HASH}"`,
    check: ({ run }) => {
      const r = run(process.execPath, ["scripts/testnet-view.mjs", "account", CONTRACT]);
      if (r.status !== 0) return fail(`exit ${r.status}: ${tail(r)}`);
      let acct;
      try { acct = JSON.parse(r.stdout); } catch { return fail(`unreadable: ${tail(r)}`); }
      if (acct.code_hash !== EXPECTED_CODE_HASH) return fail(`code_hash ${acct.code_hash}, want ${EXPECTED_CODE_HASH}`);
      const n = run(process.execPath, ["scripts/testnet-view.mjs", "call", CONTRACT, "name", "{}"]);
      return n.status === 0 && n.stdout.trim() === '"Earned Price"' ? pass(`code_hash ${EXPECTED_CODE_HASH.slice(0, 8)}…, name "Earned Price"`) : fail(`name view: ${tail(n)}`);
    },
  },
  {
    id: "record", title: "Live testnet: the seller's record holds the recorded run", network: true,
    do: `node scripts/testnet-view.mjs call ${CONTRACT} get_record '{"seller":"${SELLER}"}'`,
    see: '{"passes":2,"fails":0,"unique_buyers":1,"jobs":2} on 2026-11-12; later jobs only add to passes, fails and jobs',
    check: ({ run }) => {
      const r = run(process.execPath, ["scripts/testnet-view.mjs", "call", CONTRACT, "get_record", JSON.stringify({ seller: SELLER })]);
      if (r.status !== 0) return fail(`exit ${r.status}: ${tail(r)}`);
      let rec;
      try { rec = JSON.parse(r.stdout); } catch { return fail(`unreadable: ${tail(r)}`); }
      const ok = rec && rec.passes >= 2 && rec.unique_buyers >= 1 && rec.jobs >= 2 && rec.jobs === rec.passes + rec.fails;
      return ok ? pass(JSON.stringify(rec)) : fail(`record ${JSON.stringify(rec)}: want passes >= 2, jobs = passes + fails`);
    },
  },
  {
    id: "quote", title: "Live testnet: the quote follows the formula; 0.020 is refused", network: true,
    do: `node cli/earned.js quote ${SELLER} --offer 0.02`,
    see: "Quote: 0.040 NEAR (testnet) on 2026-11-12 (moves with the record), the formula line with its inputs, Refused 0.020 NEAR: below my cost floor 0.025 NEAR.",
    check: ({ run }) => {
      const r = run(process.execPath, ["cli/earned.js", "quote", SELLER, "--offer", "0.02"]);
      if (r.status !== 0) return fail(`exit ${r.status}: ${tail(r)}`);
      const q = lines(r.stdout).map((l) => l.match(/^Quote: (0\.\d{3}) NEAR \(testnet\)$/)).find(Boolean)?.[1];
      if (!q) return fail(`no 'Quote: 0.0NN NEAR (testnet)' line: ${tail(r)}`);
      if (!lines(r.stdout).some((l) => /^ {2}formula: 0\.030 \+ 0\.010×\d+ − 0\.005×\d+ = /.test(l) && l.endsWith(`= ${q} NEAR`))) return fail("formula line missing or does not equal the quote");
      return has(r.stdout, `Refused 0.020 NEAR: below my cost floor 0.025 NEAR. My price is ${q} NEAR.`) ? pass(`quote ${q} NEAR, formula matches, 0.020 refused`) : fail("no 'Refused 0.020 NEAR' line");
    },
  },
  {
    id: "npm-test", title: "Unit and integration tests (no network, no keys)", slow: true,
    do: "npm test", see: "ℹ fail 0",
    check: ({ run }) => {
      const r = run(process.platform === "win32" ? "npm.cmd" : "npm", ["test"], { timeout: 15 * MIN });
      if (r.missing) return { skip: "npm not found" };
      const count = (k) => lines(r.stdout).map((l) => l.match(new RegExp(`^ℹ ${k} (\\d+)$`))).find(Boolean)?.[1];
      return r.status === 0 && count("fail") === "0" ? pass(`${count("pass")} pass, 0 fail`) : fail(`exit ${r.status}${r.timedOut ? " (timed out)" : ""}, fail ${count("fail") ?? "?"}`);
    },
  },
  {
    id: "contract-test", title: "Contract test on a local sandbox chain: a fail refunds the buyer, quote 0.040 -> 0.035", slow: true, needs: "cargo + cargo-near (Rust)",
    do: "cargo test -p earned-price --features sandbox-test --test sandbox balances_follow_the_escrow_rules -- --nocapture",
    see: "fail + refund: quote 0.040 -> 0.035 (buyer refunded 0.040 NEAR in full)",
    check: ({ run }) => {
      for (const tool of [["cargo", ["--version"]], ["cargo", ["near", "--version"]]]) {
        const t = run(...tool);
        if (t.missing || t.status !== 0) return { skip: `${tool[1][0] === "near" ? "cargo-near" : "cargo"} not found (install Rust: see Prerequisites)` };
      }
      const r = run("cargo", ["test", "-p", "earned-price", "--features", "sandbox-test", "--test", "sandbox", "balances_follow_the_escrow_rules", "--", "--nocapture"], { timeout: 30 * MIN });
      const out = `${r.stdout}\n${r.stderr}`;
      const want = [
        "repeat pass (same buyer): seller paid, quote 0.040 -> 0.040",
        "fail + refund: quote 0.040 -> 0.035 (buyer refunded 0.040 NEAR in full)",
        "test balances_follow_the_escrow_rules ... ok",
      ];
      const missing = want.filter((w) => !has(out, w));
      return r.status === 0 && !missing.length ? pass("repeat pass 0.040 -> 0.040; fail + refund 0.040 -> 0.035; ok") : fail(`exit ${r.status}${r.timedOut ? " (timed out)" : ""}; missing: ${missing.join(" / ") || "none"}: ${tail(r)}`);
    },
  },
];

export function parseArgs(argv) {
  const opts = { quick: false, json: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--quick") opts.quick = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--only" && argv[i + 1]) {
      opts.only = argv[++i].split(",").map((s) => Number(s.trim()));
      if (opts.only.some((n) => !Number.isInteger(n) || n < 1 || n > STEPS.length)) throw new Error(`--only takes step numbers 1-${STEPS.length}`);
    } else throw new Error(`unknown argument ${a}; usage: node scripts/self-check.mjs [--quick] [--only 4,11] [--json]`);
  }
  return opts;
}

/** Runs the steps and returns the summary; `say` gets one line per step (not called for --json). */
export async function runSelfCheck({ steps = STEPS, quick = false, only = null, runner = run, say = () => {}, now = () => Date.now() } = {}) {
  const results = [];
  for (const [i, step] of steps.entries()) {
    const n = i + 1;
    if (only ? !only.includes(n) : quick && step.slow) {
      results.push({ n, id: step.id, status: "NOT RUN", detail: only ? "not in --only" : "--quick", ms: 0 });
      continue;
    }
    const t0 = now();
    let r;
    try {
      r = await step.check({ run: runner });
    } catch (err) {
      r = fail(`error: ${err?.message ?? err}`);
    }
    const status = r.skip ? "SKIP" : r.ok ? "PASS" : "FAIL";
    const res = { n, id: step.id, status, detail: r.skip ?? r.detail, ms: now() - t0 };
    results.push(res);
    say(`[${String(n).padStart(2)}/${steps.length}] ${status.padEnd(4)}  ${step.title}\n         do:  ${step.do}\n         see: ${step.see}\n         got: ${res.detail}`);
  }
  const ran = results.filter((r) => r.status !== "NOT RUN");
  const count = (s) => ran.filter((r) => r.status === s).length;
  const summary = {
    version: 1,
    at: new Date(now()).toISOString(),
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    quick,
    total: ran.length,
    pass: count("PASS"),
    fail: count("FAIL"),
    skip: count("SKIP"),
    not_run: results.length - ran.length,
    steps: results,
  };
  summary.pct = summary.total ? Math.floor((100 * summary.pass) / summary.total) : 0;
  summary.ok = summary.total > 0 && summary.pass === summary.total;
  return summary;
}

export function summaryLine(s) {
  const extra = [s.skip ? `${s.skip} SKIP (counted as not passing)` : "", s.not_run ? `${s.not_run} not run (${s.quick ? "--quick" : "--only"})` : ""].filter(Boolean).join(", ");
  return `SELF-CHECK: ${s.pass}/${s.total} steps PASS (${s.pct}%), ${s.fail} FAIL${extra ? `, ${extra}` : ""}`;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (!opts.json) console.log(`Earned Price README self-check, Tier 1 (keyless, read-only): ${STEPS.length} steps${opts.quick ? ", --quick" : ""}\n`);
  const s = await runSelfCheck({ ...opts, say: opts.json ? () => {} : (l) => console.log(l) });
  if (opts.json) console.log(JSON.stringify(s, null, 2));
  else console.log(`\n${summaryLine(s)}`);
  return s.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
