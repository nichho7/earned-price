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
  MAX_BUG_SPAN,
} from "../grader/grade.js";

const fixture = (p) => new URL(`./fixtures/${p}`, import.meta.url).pathname;
const load = (p) => JSON.parse(readFileSync(fixture(p), "utf8"));
const CLI = new URL("../grader/cli.js", import.meta.url).pathname;
const GRADER_SRC = readFileSync(new URL("../grader/grade.js", import.meta.url), "utf8");
const CLI_SRC = readFileSync(CLI, "utf8");
const VECTOR = JSON.parse(readFileSync(new URL("../test-vectors/commit.json", import.meta.url), "utf8"));

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

// Independent reference for the pinned format, using node:crypto (not the grader's noble code).
const refCommit = (k, saltHex) => {
  const K = Buffer.from(canonicalJson(k), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(K.length);
  return createHash("sha256").update(Buffer.concat([len, K, Buffer.from(saltHex, "hex")])).digest("hex");
};

test("shared test vector (test-vectors/commit.json): grader commit() reproduces commit_hex", () => {
  assert.equal(canonicalJson(VECTOR.key), VECTOR.key_canonical);
  assert.equal(Buffer.byteLength(VECTOR.key_canonical, "utf8"), VECTOR.key_len);
  assert.equal(commit(VECTOR.key, VECTOR.salt_hex), VECTOR.commit_hex);
  assert.equal(verifyReveal(VECTOR.commit_hex, VECTOR.key, VECTOR.salt_hex), true);
});

test("golden commitment: sha256(u32_be(len K) || K || salt32), matches a node:crypto reference", () => {
  assert.equal(commit(key, reveal.salt), golden.commitment.expected);
  assert.equal(refCommit(key, reveal.salt), golden.commitment.expected);
  assert.equal(commit(JSON.parse(JSON.stringify(key)), reveal.salt), golden.commitment.expected);
});

test("reveal verifies against the committed hash; tampering fails", () => {
  const c = commit(key, reveal.salt);
  assert.equal(verifyReveal(c, key, reveal.salt), true);
  assert.equal(verifyReveal(c, key, reveal.salt + "0"), false);
  assert.equal(verifyReveal(c, withBug(0, { title: "Off-by-one in totals" }), reveal.salt), false);
});

test("verifyReveal: a different valid salt or a wrong commitment returns false", () => {
  const c = commit(key, reveal.salt);
  const otherSalt = "0".repeat(63) + "1";
  assert.equal(verifyReveal(c, key, otherSalt), false);
  assert.equal(verifyReveal(commit(key, otherSalt), key, reveal.salt), false);
  assert.equal(verifyReveal("ff".repeat(32), key, reveal.salt), false);
  assert.equal(verifyReveal(c.toUpperCase(), key, reveal.salt), false);
  assert.equal(verifyReveal(null, key, reveal.salt), false);
  assert.equal(verifyReveal(c, { junk: 1 }, reveal.salt), false);
});

test("commit() rejects uppercase, short or long salts and invalid keys", () => {
  assert.throws(() => commit(key, reveal.salt.toUpperCase()), /salt/);
  assert.throws(() => commit(key, reveal.salt.slice(2)), /salt/);
  assert.throws(() => commit(key, reveal.salt + "00"), /salt/);
  assert.throws(() => commit(key, 42), /salt/);
  assert.throws(() => commit({ junk: 1 }, reveal.salt), /key/);
  assert.throws(() => commit(withKey({ pass_min: 1 }), reveal.salt), /pass_min/);
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

test("two findings in one bug window give the same matched line in either order", () => {
  const a = { file: "cart.js", line: 6, category: "off-by-one" };
  const b = { file: "cart.js", line: 4, category: "off-by-one" };
  for (const f of [[a, b], [b, a]]) {
    const out = grade(key, f);
    assert.deepEqual(out.matched, [{ bug: "B1", line: 4 }]);
    assert.equal(out.false_positives, 1);
  }
});

test("key.bugs in any order grade the same (bugs visited in id order)", () => {
  const f = load("sample-pack/findings-pass.json");
  const expected = canonicalJson(grade(key, f));
  const reversed = withKey({ bugs: [...key.bugs].reverse() });
  const rotated = withKey({ bugs: [...key.bugs.slice(2), ...key.bugs.slice(0, 2)] });
  assert.equal(canonicalJson(grade(reversed, f)), expected);
  assert.equal(canonicalJson(grade(rotated, f)), expected);
  // Overlapping-window case: order of key bugs must not change which bug a finding goes to.
  const k = withBug(1, { file: "cart.js", line_start: 6, line_end: 6, category: "off-by-one" });
  const ff = [{ file: "cart.js", line: 5, category: "off-by-one" }];
  assert.equal(canonicalJson(grade(withKey({ bugs: [...k.bugs].reverse() }), ff)), canonicalJson(grade(k, ff)));
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
  assert.doesNotThrow(() => validateKey(withBug(0, { title: "x".repeat(80) })));
  for (const id of ["B0", "B6", "B10", "b1", "B", " B1", 1]) {
    assert.throws(() => validateKey(withBug(0, { id })), /id must be one of B1, B2, B3, B4, B5/, String(id));
  }
  assert.doesNotThrow(() => validateKey(key));
});

test("a sealed key cannot loosen grading: bug span capped, overlapping bugs rejected", () => {
  // Reviewer probe: five copies of one bug with a 1..1e9 window.
  const probe = withKey({
    bugs: ["B1", "B2", "B3", "B4", "B5"].map((id) => ({ id, title: "x", file: "cart.js", line_start: 1, line_end: 1e9, category: "off-by-one" })),
  });
  assert.throws(() => validateKey(probe), /spans more than 10 lines/);
  assert.throws(() => commit(probe, reveal.salt), /spans more than 10 lines/);
  assert.doesNotThrow(() => validateKey(withBug(0, { line_start: 4, line_end: 4 + MAX_BUG_SPAN })));
  assert.throws(() => validateKey(withBug(0, { line_start: 4, line_end: 5 + MAX_BUG_SPAN })), /spans more than 10/);
  // Same file + category with overlapping lines, identical or partial: rejected.
  const dup = withBug(1, { file: "cart.js", line_start: 4, line_end: 5, category: "off-by-one" });
  assert.throws(() => validateKey(dup), /B1 and B2 overlap/);
  assert.throws(() => validateKey(withBug(1, { file: "cart.js", line_start: 5, line_end: 9, category: "off-by-one" })), /overlap/);
  // Adjacent (no shared line), other category or other file: allowed.
  assert.doesNotThrow(() => validateKey(withBug(1, { file: "cart.js", line_start: 6, line_end: 6, category: "off-by-one" })));
  assert.doesNotThrow(() => validateKey(withBug(1, { file: "cart.js", line_start: 4, line_end: 5, category: "missing-check" })));
  assert.doesNotThrow(() => validateKey(withBug(1, { file: "util.js", line_start: 4, line_end: 5, category: "off-by-one" })));
});

test("category list is fixed, unique, lowercase kebab-case and frozen", () => {
  assert.equal(Object.isFrozen(CATEGORIES), true);
  assert.equal(new Set(CATEGORIES).size, CATEGORIES.length);
  for (const c of CATEGORIES) assert.match(c, /^[a-z]+(-[a-z]+)*$/);
});

const failResult = (error) => ({
  pack_id: "sample-0", total: 5, found: 0, pass_min: 4, passed: false,
  matched: [], missed: ["B1", "B2", "B3", "B4", "B5"], false_positives: 0, error,
});

test("bad seller output is a fixed FAIL, never a throw, never truncated or dropped", () => {
  const good = load("sample-pack/findings-pass.json");
  const malformed = [
    [{ file: "cart.js", category: "off-by-one" }],
    [{ file: "cart.js", line: 4 }],
    [{ line: 4, category: "off-by-one" }],
    [{ file: "", line: 4, category: "off-by-one" }],
    [{ file: "cart.js", line: 0, category: "off-by-one" }],
    [{ file: "cart.js", line: 4.5, category: "off-by-one" }],
    [{ file: "cart.js", line: 4, category: 7 }],
    [null],
    [["cart.js", 4, "off-by-one"]],
    [...good, "junk"],
  ];
  for (const f of malformed) assert.deepEqual(grade(key, f), failResult("malformed_finding"), JSON.stringify(f));
  for (const f of ["not a list", null, undefined, { file: "cart.js" }]) {
    assert.deepEqual(grade(key, f), failResult("malformed_finding"), String(f));
  }
  const many = Array.from({ length: MAX_FINDINGS + 1 }, (_, i) => ({ file: "cart.js", line: i + 1, category: "off-by-one" }));
  assert.deepEqual(grade(key, many), failResult("too_many_findings"));
  assert.equal(grade(key, many.slice(0, MAX_FINDINGS)).error, undefined, "exactly 10 is accepted");
  assert.equal("error" in grade(key, good), false, "no error field on a normal grade");
  // An invalid KEY is our fault: it still throws.
  assert.throws(() => grade({ junk: 1 }, good), /key/);
});

test("caller contract: a FAIL result leads to refund like any grade below 4/5", () => {
  // The escrow settles on result.passed only (PRD R2): passed=false -> refund buyer, fail on record.
  const settle = (result) => (result.passed ? "pay_seller" : "refund_buyer");
  const many = Array.from({ length: 11 }, (_, i) => ({ file: "cart.js", line: i + 1, category: "off-by-one" }));
  assert.equal(settle(grade(key, many)), "refund_buyer");
  assert.equal(settle(grade(key, [{ file: "cart.js", line: "4", category: "off-by-one" }])), "refund_buyer");
  assert.equal(settle(grade(key, load("sample-pack/findings-pass.json"))), "pay_seller");
});

test("path form is exact: no leading ./, no prefix, case-sensitive", () => {
  for (const file of ["./cart.js", "src/cart.js", "Cart.js"]) {
    assert.equal(grade(key, [{ file, line: 4, category: "off-by-one" }]).found, 0, file);
  }
  assert.match(GRADER_SRC, /repo-relative/);
  assert.match(GRADER_SRC, /no leading "\.\/"/);
});

test("canonicalJson refuses values JSON cannot hold", () => {
  assert.throws(() => canonicalJson([1, undefined]), /undefined/);
  assert.throws(() => canonicalJson([() => 1]), /function/);
  assert.throws(() => canonicalJson(1n), /bigint/);
  assert.throws(() => canonicalJson(NaN), /non-finite/);
});

test("pure: no LLM, no network, no clock, no randomness, no node: imports", () => {
  // Every module specifier in the file, single- or multi-line, static or re-export.
  const specifiers = [...GRADER_SRC.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(specifiers.sort(), ["@noble/hashes/sha2.js", "@noble/hashes/utils.js"]);
  assert.doesNotMatch(GRADER_SRC, /^\s*import\s*["']/m, "no side-effect imports");
  assert.doesNotMatch(GRADER_SRC, /["']node:/, "no node: modules");
  assert.doesNotMatch(GRADER_SRC, /export\s*\*\s*from/, "no export * from");
  for (const banned of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /Date\b/, /Math\.random/, /crypto\./, /performance\./, /process\./, /globalThis/, /require\(/, /import\(/, /\beval\b/, /Function\(/]) {
    assert.doesNotMatch(GRADER_SRC, banned, `grade.js must not use ${banned}`);
  }
  // The CLI is Node-only by design, but imports only fs and the grader.
  const cliSpecifiers = [...CLI_SRC.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(cliSpecifiers.sort(), ["./grade.js", "node:fs"]);
  assert.doesNotMatch(CLI_SRC, /\bfetch\s*\(|Math\.random|Date\b|import\(/);
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

test("CLI prints result:null and exits 1 when the commitment does not match", () => {
  const args = [CLI, fixture("sample-pack/answer-key.json"), fixture("sample-pack/reveal.json"), fixture("sample-pack/findings-pass.json"), "--commitment", "ff".repeat(32)];
  let out;
  let status = 0;
  try {
    out = execFileSync("node", args, { encoding: "utf8" });
  } catch (e) {
    out = e.stdout;
    status = e.status;
  }
  assert.equal(status, 1);
  const parsed = JSON.parse(out);
  assert.equal(parsed.commitment_ok, false);
  assert.equal(parsed.result, null);
  assert.equal(parsed.result_sha256, null);
});
