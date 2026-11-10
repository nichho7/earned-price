import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  canonicalJson,
  commit,
  verifyReveal,
  grade,
  validateKey,
  sha256Hex,
  CATEGORIES,
  MAX_FINDINGS,
} from "../grader/grade.js";

const fixture = (p) => new URL(`./fixtures/${p}`, import.meta.url).pathname;
const load = (p) => JSON.parse(readFileSync(fixture(p), "utf8"));
const CLI = new URL("../grader/cli.js", import.meta.url).pathname;
const GRADER_SRC = readFileSync(new URL("../grader/grade.js", import.meta.url), "utf8");

const key = load("sample-pack/answer-key.json");
const reveal = load("sample-pack/reveal.json");
const golden = load("grader-golden.json");
const withKey = (patch) => ({ ...structuredClone(key), ...patch });
const withBug = (i, patch) => {
  const k = structuredClone(key);
  Object.assign(k.bugs[i], patch);
  return k;
};

test("canonicalJson sorts keys at every depth and drops whitespace", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 0 }], c: "x" } }), '{"a":{"c":"x","d":[2,{"y":0,"z":1}]},"b":1}');
});

test("noble sha256 matches node:crypto (browser-safe hash, same bytes)", () => {
  for (const s of ["", "abc", "héllo ✓", canonicalJson(key)]) {
    assert.equal(sha256Hex(s), createHash("sha256").update(s, "utf8").digest("hex"));
  }
});

test("golden commitment: sha256 of canonical {key, salt}", () => {
  assert.equal(commit(key, reveal.salt), golden.commitment.expected);
  assert.equal(commit(JSON.parse(JSON.stringify(key)), reveal.salt), golden.commitment.expected);
});

test("reveal verifies against the committed hash; tampering fails", () => {
  const c = commit(key, reveal.salt);
  assert.equal(verifyReveal(c, key, reveal.salt), true);
  assert.equal(verifyReveal(c, key, reveal.salt + "0"), false);
  assert.equal(verifyReveal(c, withBug(0, { title: "Off-by-one in totals" }), reveal.salt), false);
});

for (const c of golden.cases) {
  test(`golden: ${c.name}`, () => {
    const out = grade(c.key ?? key, c.findings);
    assert.deepEqual(out, c.expected);
    assert.equal(canonicalJson(out), canonicalJson(c.expected));
  });
}

test("finding order does not change the result (every golden case, reversed and rotated)", () => {
  for (const c of golden.cases) {
    const k = c.key ?? key;
    const f = c.findings;
    const rotated = f.length ? [...f.slice(1), f[0]] : f;
    assert.equal(canonicalJson(grade(k, [...f].reverse())), canonicalJson(c.expected), c.name);
    assert.equal(canonicalJson(grade(k, rotated)), canonicalJson(c.expected), c.name);
  }
});

test("extra finding fields (notes) never change the result", () => {
  const f = load("sample-pack/findings-pass.json");
  const bare = f.map(({ file, line, category }) => ({ file, line, category }));
  assert.equal(canonicalJson(grade(key, f)), canonicalJson(grade(key, bare)));
});

test("fixed policy: the key cannot loosen pass_min, tolerance or bug count", () => {
  assert.throws(() => grade(withKey({ pass_min: 1 }), []), /pass_min must be 4/);
  assert.throws(() => grade(withKey({ line_tolerance: 50 }), []), /line_tolerance must be 3/);
  assert.throws(() => grade(withKey({ bugs: key.bugs.slice(0, 4) }), []), /exactly 5 bugs/);
  assert.throws(() => grade(withKey({ version: 2 }), []), /version/);
});

test("key bugs need an id, a title and a category from the fixed list", () => {
  assert.throws(() => validateKey(withBug(0, { title: undefined })), /title/);
  assert.throws(() => validateKey(withBug(0, { title: "   " })), /title/);
  assert.throws(() => validateKey(withBug(0, { title: "x".repeat(81) })), /title/);
  assert.throws(() => validateKey(withBug(0, { category: "typo" })), /not in CATEGORIES/);
  assert.throws(() => validateKey(withBug(1, { id: "B1" })), /duplicate/);
  assert.throws(() => validateKey(withBug(0, { line_start: 6, line_end: 5 })), /line_start/);
  assert.doesNotThrow(() => validateKey(key));
});

test("category list is fixed, unique, lowercase kebab-case and frozen", () => {
  assert.equal(Object.isFrozen(CATEGORIES), true);
  assert.equal(new Set(CATEGORIES).size, CATEGORIES.length);
  for (const c of CATEGORIES) assert.match(c, /^[a-z]+(-[a-z]+)*$/);
});

test("malformed or oversized findings are rejected, not guessed at", () => {
  assert.throws(() => grade(key, [{ file: "cart.js", category: "off-by-one" }]), /line/);
  assert.throws(() => grade(key, [{ file: "cart.js", line: 4 }]), /category/);
  assert.throws(() => grade(key, [{ line: 4, category: "off-by-one" }]), /file/);
  assert.throws(() => grade(key, "not a list"), /array/);
  const many = Array.from({ length: MAX_FINDINGS + 1 }, (_, i) => ({ file: "cart.js", line: i + 1, category: "off-by-one" }));
  assert.throws(() => grade(key, many), /too many findings/);
});

test("pure: no LLM, no network, no clock, no randomness, no node: imports", () => {
  const imports = [...GRADER_SRC.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["@noble/hashes/sha2.js", "@noble/hashes/utils.js"]);
  for (const banned of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /Date\b/, /Math\.random/, /performance\./, /process\./, /require\(/, /import\(/]) {
    assert.doesNotMatch(GRADER_SRC, banned, `grade.js must not use ${banned}`);
  }
});

test("CLI output is byte-identical over 10 separate runs", () => {
  const args = [CLI, fixture("sample-pack/answer-key.json"), fixture("sample-pack/reveal.json"), fixture("sample-pack/findings-pass.json"), "--commitment", golden.commitment.expected];
  const outs = Array.from({ length: 10 }, () => execFileSync("node", args, { encoding: "utf8" }));
  assert.equal(new Set(outs).size, 1);
  const parsed = JSON.parse(outs[0]);
  assert.equal(parsed.commitment_ok, true);
  assert.equal(parsed.result.found, 4);
  assert.equal(parsed.result.passed, true);
});
