// T-029: `earned verify receipt.json [--tamper] [--json]` and the receipt file helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

test("earned verify <real receipt>: four PASS lines in order, the honesty line, SEE: step 5 PASS, exit 0", async () => {
  const { code, stdout } = await earned("verify", FIXTURE);
  assert.equal(code, 0, stdout);
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
  assert.match(stdout, /^VERIFIED: all 4 checks pass$/m);
  assert.match(stdout, /^SEE: step 5 PASS$/m);
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
  assert.doesNotMatch(stdout, /SEE: step 5 PASS/);
  assert.equal(readFileSync(FIXTURE, "utf8"), before);
});

test("earned verify --json prints the machine-readable result", async () => {
  const { code, stdout } = await earned("verify", FIXTURE, "--json");
  assert.equal(code, 0);
  const v = JSON.parse(stdout);
  assert.equal(v.ok, true);
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
    assert.equal(v.ok, true);
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
