import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { canonicalJson, commit, verifyReveal, grade } from "../grader/grade.js";

const fixture = (p) => new URL(`./fixtures/sample-pack/${p}`, import.meta.url).pathname;
const load = (p) => JSON.parse(readFileSync(fixture(p), "utf8"));
const CLI = new URL("../grader/cli.js", import.meta.url).pathname;

const key = load("answer-key.json");
const reveal = load("reveal.json");

test("canonicalJson sorts keys at every depth and drops whitespace", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 0 }], c: "x" } }), '{"a":{"c":"x","d":[2,{"y":0,"z":1}]},"b":1}');
});

test("commit is sha256 hex of canonical {key, salt} and is stable", () => {
  const c = commit(key, reveal.salt);
  assert.match(c, /^[0-9a-f]{64}$/);
  assert.equal(c, commit(JSON.parse(JSON.stringify(key)), reveal.salt));
});

test("reveal verifies against the committed hash; tampering fails", () => {
  const c = commit(key, reveal.salt);
  assert.equal(verifyReveal(c, key, reveal.salt), true);
  assert.equal(verifyReveal(c, key, reveal.salt + "0"), false);
  const tampered = structuredClone(key);
  tampered.pass_min = 1;
  assert.equal(verifyReveal(c, tampered, reveal.salt), false);
});

test("grade counts planted bugs found by file + line window, each finding used once", () => {
  const r = grade(key, load("findings-pass.json"));
  assert.equal(r.total, 3);
  assert.equal(r.found, 3);
  assert.equal(r.passed, true);
  const fail = grade(key, load("findings-fail.json"));
  assert.equal(fail.found, 1);
  assert.equal(fail.passed, false);
});

test("duplicate findings on one bug count once; false positives are reported", () => {
  const r = grade(key, [
    { file: "cart.js", line: 4 },
    { file: "cart.js", line: 4 },
    { file: "nope.js", line: 1 },
  ]);
  assert.equal(r.found, 1);
  assert.equal(r.false_positives, 2);
});

test("finding order does not change the result", () => {
  const f = load("findings-pass.json");
  assert.deepEqual(grade(key, f), grade(key, [...f].reverse()));
});

test("malformed findings are rejected, not guessed at", () => {
  assert.throws(() => grade(key, [{ file: "cart.js" }]), /line/);
  assert.throws(() => grade(key, "not a list"), /array/);
});

test("CLI output is byte-identical over 10 separate runs (spike part b)", () => {
  const args = [CLI, fixture("answer-key.json"), fixture("reveal.json"), fixture("findings-pass.json"), "--commitment", commit(key, reveal.salt)];
  const outs = Array.from({ length: 10 }, () => execFileSync("node", args, { encoding: "utf8" }));
  assert.equal(new Set(outs).size, 1);
  const parsed = JSON.parse(outs[0]);
  assert.equal(parsed.commitment_ok, true);
  assert.equal(parsed.result.found, 3);
});
