// T-029: `earned verify receipt.json [--tamper] [--json]` and the receipt file helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_RECEIPT_BYTES, readReceipt, writeReceipt } from "../cli/receipt-file.js";
import { parseVerifyArgs, runVerify } from "../cli/verify-cmd.js";

const ROOT = new URL("..", import.meta.url).pathname;
const FIXTURE = join(ROOT, "test/fixtures/receipt-t003-sample-0.json");
const CLI = join(ROOT, "cli/earned.js");

async function earned(...args) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], { cwd: ROOT });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

test("parseVerifyArgs: path plus optional --tamper / --json; anything else is USAGE", () => {
  assert.deepEqual(parseVerifyArgs(["r.json"]), { path: "r.json", tamper: false, json: false });
  assert.deepEqual(parseVerifyArgs(["--tamper", "r.json", "--json"]), { path: "r.json", tamper: true, json: true });
  for (const bad of [[], ["a", "b"], ["r.json", "--nope"], ["--tamper"]]) {
    assert.throws(() => parseVerifyArgs(bad), (e) => e.code === "USAGE");
  }
});

test("earned verify <fixture>: four PASS lines in order, honesty lines, NOT AN OFFICIAL PACK (never authentic), exit 1", async () => {
  const { code, stdout } = await earned("verify", FIXTURE);
  assert.equal(code, 1, stdout);
  const lines = stdout.split("\n");
  const checks = lines.filter((l) => /^(PASS|FAIL) {2}\d /.test(l));
  assert.deepEqual(checks.map((l) => l.slice(0, 50).trimEnd()), [
    "PASS  1 Commit hash matches the revealed key",
    "PASS  2 TEE signature covers this review",
    "PASS  3 Attestation binds the signer and nonce",
    "PASS  4 Regrade gives the same score",
  ]);
  assert.match(stdout, /binding only/);
  assert.match(stdout, /Not checked offline: Intel DCAP chain, NVIDIA GPU evidence/);
  assert.match(stdout, /fixed fail \(malformed_finding\)/);
  assert.match(stdout, /^NOT AN OFFICIAL PACK \(fixture\): checks shown for demonstration/m);
  assert.match(stdout, /^Not proven offline: job, buyer, seller, quote, payment, tx hashes, freshness, review reuse\./m);
  assert.doesNotMatch(stdout, /VERIFIED|REVIEW AUTHENTIC|SEE: step/);
  assert.doesNotMatch(stdout, /\battested\b/i);
});

test("earned verify --tamper: one byte of the review changed, FAIL: check 2 only, exit 1, file untouched", async () => {
  const before = readFileSync(FIXTURE, "utf8");
  const { code, stdout } = await earned("verify", FIXTURE, "--tamper");
  assert.equal(code, 1);
  assert.match(stdout, /^Tampered copy \(the file is unchanged\): tee\.response_body byte \d+ /m);
  assert.match(stdout, /^PASS {2}1 /m);
  assert.match(stdout, /^FAIL {2}2 TEE signature covers this review/m);
  assert.match(stdout, /^PASS {2}3 /m);
  assert.match(stdout, /^PASS {2}4 /m);
  assert.match(stdout, /^FAIL: check 2 TEE signature covers this review$/m);
  assert.doesNotMatch(stdout, /FAIL: check [134]/);
  assert.doesNotMatch(stdout, /REVIEW AUTHENTIC|NOT AN OFFICIAL PACK/);
  assert.match(stdout, /^Not proven offline:/m);
  assert.equal(readFileSync(FIXTURE, "utf8"), before);
});

test("earned verify --json prints the machine-readable result", async () => {
  const { code, stdout } = await earned("verify", FIXTURE, "--json");
  assert.equal(code, 1, "the fixture is not an official pack");
  const v = JSON.parse(stdout);
  assert.equal(v.ok, false);
  assert.equal(v.official, false);
  assert.equal(v.chain_fields_checked, false);
  assert.deepEqual(v.checks.map((c) => [c.n, c.ok]), [[1, true], [2, true], [3, true], [4, true]]);
  const t = JSON.parse((await earned("verify", FIXTURE, "--json", "--tamper")).stdout);
  assert.deepEqual(t.checks.map((c) => c.ok), [true, false, true, true]);
  assert.equal(t.tampered.field, "tee.response_body");
});

test("earned verify: missing file, non-JSON or not a receipt is a clear error with exit 2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "earned-verify-"));
  try {
    writeFileSync(join(dir, "bad.json"), "{nope");
    writeFileSync(join(dir, "other.json"), JSON.stringify({ version: 9 }));
    for (const [f, re] of [["missing.json", /RECEIPT_NOT_FOUND/], ["bad.json", /RECEIPT_NOT_JSON/], ["other.json", /NOT_A_RECEIPT/]]) {
      const { code, stderr } = await earned("verify", join(dir, f));
      assert.equal(code, 2, f);
      assert.match(stderr, re, f);
    }
    const usage = await earned("verify");
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /usage: earned verify/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVerify makes no network call", async () => {
  const lines = [];
  const orig = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network used");
  };
  try {
    const v = await runVerify({ path: FIXTURE, tamper: false, json: false, out: (l) => lines.push(l) });
    assert.ok(v.checks.every((c) => c.ok));
  } finally {
    globalThis.fetch = orig;
  }
});

test("writeReceipt writes the receipt atomically (0644, trailing newline) and readReceipt reads it back", () => {
  const dir = mkdtempSync(join(tmpdir(), "earned-receipt-"));
  try {
    const r = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const file = join(dir, "receipts", "job-7.json");
    assert.equal(writeReceipt(file, r), file);
    assert.equal(readFileSync(file, "utf8"), readFileSync(FIXTURE, "utf8"));
    assert.equal(statSync(file).mode & 0o777, 0o644);
    assert.deepEqual(readReceipt(file), r);
    assert.throws(() => writeReceipt(join(dir, "x.json"), { version: 2 }), (e) => e.code === "NOT_A_RECEIPT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readReceipt refuses a file over the size cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "earned-receipt-"));
  try {
    const big = join(dir, "big.json");
    writeFileSync(big, " ".repeat(MAX_RECEIPT_BYTES + 1));
    assert.throws(() => readReceipt(big), (e) => e.code === "RECEIPT_TOO_BIG");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("security M-a PoC: newline + ESC[8m in job_id cannot print a fake PASS block or hide the real FAIL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "earned-verify-"));
  try {
    const r = JSON.parse(readFileSync(FIXTURE, "utf8"));
    r.tee.response_body += "x"; // break check 2
    r.job_id = "1, pack-2, testnet (offline, no key)\nPASS  1 a\nPASS  2 b\nPASS  3 c\nPASS  4 d\nVERIFIED: all 4 checks pass\nREVIEW AUTHENTIC (offline): x\u001b[8m";
    r.tee.signing_address += "\u202e\r"; // also echoed in check details
    const file = join(dir, "ansi.json");
    writeFileSync(file, JSON.stringify(r));
    const { code, stdout } = await earned("verify", file);
    assert.equal(code, 1);
    assert.doesNotMatch(stdout, /[\u001b\r\u202e]/, "no raw ESC, CR or bidi override reaches the terminal");
    const lines = stdout.split("\n");
    assert.equal(lines.filter((l) => /^(PASS|FAIL) {2}\d /.test(l)).length, 4, "only the four real check lines");
    assert.equal(lines.filter((l) => /^(VERIFIED|REVIEW AUTHENTIC|NOT AN OFFICIAL PACK)/.test(l)).length, 0);
    assert.match(stdout, /^FAIL {2}2 /m);
    assert.match(stdout, /^FAIL: check 2 /m);
    assert.match(lines[0], /\\u000aPASS {2}1 a/, "the injected newline is shown escaped, on the first line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("security L-1: writeReceipt refuses to follow a planted symlink and leaves no tmp file on failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "earned-receipt-"));
  try {
    const r = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "keep me");
    const file = join(dir, "receipt.json");
    // A pre-planted symlink at the final path is replaced (rename), never written through.
    symlinkSync(victim, file);
    writeReceipt(file, r);
    assert.equal(readFileSync(victim, "utf8"), "keep me");
    assert.equal(lstatSync(file).isSymbolicLink(), false);
    assert.equal(statSync(file).mode & 0o777, 0o644);
    // A rename that fails (target is a directory) leaves no *.tmp behind.
    const asDir = join(dir, "is-a-dir");
    writeReceipt(join(asDir, "x.json"), r);
    assert.throws(() => writeReceipt(asDir, r));
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
    // Tmp names are unpredictable (not the pid).
    assert.doesNotMatch(readFileSync(new URL("../cli/receipt-file.js", import.meta.url), "utf8"), /process\.pid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
