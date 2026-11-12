// [CTO] T-039 · unit tests for the browser verify page's view model (node --test, Node type stripping).
// Pins the T-029 review rules: render from verifyReceipt's result only (never the receipt's claims), chain
// fields labelled "not verified offline", the 8 MB cap before JSON.parse, the trust anchors bundled, text only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { CHECKS, TRUST, receiptJson } from "./lib.js";
import {
  CLI, MAX_RECEIPT_BYTES, RECORDED_NAME, chainRows, cliLine, fileName, loadFile, parseReceiptText, trustSummary, verifyView,
} from "./verify-model.ts";
import type { Receipt } from "./verify-model.ts";

const asReceipt = (x: object) => x as Receipt;
const repo = (p: string) => new URL(`../../${p}`, import.meta.url);
const text = (p: string) => readFileSync(repo(p), "utf8");
const loaded = (p: string) => {
  const r = parseReceiptText(text(p), p);
  if (!r.ok) throw new Error(`${p}: ${r.error}`);
  return r;
};

test("recorded pack-2 (official pack, real T-013 review): four checks in m001 section 5 order, all PASS, REVIEW AUTHENTIC", () => {
  const v = verifyView(loaded("recorded/pack-2.json").receipt, false);
  assert.equal(v.kind, "pass");
  assert.deepEqual(v.checks.map((c) => [c.n, c.title, c.ok]), [
    [1, "Commit hash matches the revealed key", true],
    [2, "TEE signature covers this review", true],
    [3, "Attestation binds the signer and nonce", true],
    [4, "Regrade gives the same score", true],
  ]);
  assert.deepEqual(v.checks.map((c) => c.title), CHECKS.map((c) => c.title));
  assert.equal(v.word, "Authentic.");
  assert.deepEqual(v.lines, ["REVIEW AUTHENTIC (offline): genuine NEAR AI TEE review of the official pack-2 request (prompt v1), regrade PASS."]);
  assert.equal(v.stamp, "AUTHENTIC · OFFLINE");
  assert.ok(v.notChecked.startsWith("Not checked offline: Intel DCAP chain, NVIDIA GPU evidence"), v.notChecked);
  assert.ok(v.notProven.startsWith("Not proven offline: job, buyer, seller, quote, payment, tx hashes"), v.notProven);
  assert.equal(v.edit, null);
  assert.deepEqual(v.proves.map((p) => p.ok), [true, true, true, true]);
});

test("recorded pack-3 also passes (the second recorded job)", () => {
  assert.equal(verifyView(loaded("recorded/pack-3.json").receipt, false).kind, "pass");
});

test("tamper one byte of the review: only check 2 fails, and the FAIL line names it", () => {
  const r = loaded("recorded/pack-2.json").receipt;
  const v = verifyView(r, true);
  assert.equal(v.kind, "fail");
  assert.deepEqual(v.checks.map((c) => c.ok), [true, false, true, true]);
  assert.deepEqual(v.lines, ["FAIL: check 2 TEE signature covers this review"]);
  assert.equal(v.word, "Fail.");
  assert.equal(v.stamp, "TAMPERED");
  assert.match(v.checks[1].detail, /the review text was changed/);
  assert.equal(v.proves[0].ok, false); // genuine TEE review: no
  // the edit is shown: one byte, in tee.response_body, old -> new, with context from the stored text
  assert.ok(v.edit);
  assert.equal(v.edit.field, "tee.response_body");
  assert.equal(v.edit.from.length, 1);
  assert.equal(v.edit.to.length, 1);
  assert.notEqual(v.edit.from, v.edit.to);
  assert.ok(v.edit.before.length > 0 && v.edit.after.length > 0);
  // the file itself (the input object) is untouched
  assert.equal(verifyView(r, false).kind, "pass");
});

test("tampering any other single field fails and names the failing check (each check can fail alone)", () => {
  const base = loaded("recorded/pack-2.json").receipt as Record<string, any>;
  const cases: [string, (r: any) => void, number][] = [
    ["salt", (r) => { r.reveal.salt = r.reveal.salt.replace(/^./, (c: string) => (c === "a" ? "b" : "a")); }, 1],
    ["signature", (r) => { r.tee.signature = r.tee.signature.replace(/.$/, (c: string) => (c === "a" ? "b" : "a")); }, 2],
    ["nonce", (r) => { r.tee.nonce = r.tee.nonce.replace(/^./, (c: string) => (c === "a" ? "b" : "a")); }, 3],
    ["grade", (r) => { r.grade.found = 4; }, 4],
  ];
  for (const [name, edit, n] of cases) {
    const r = structuredClone(base);
    edit(r);
    const v = verifyView(asReceipt(r), false);
    assert.equal(v.kind, "fail", name);
    assert.deepEqual(v.checks.filter((c) => !c.ok).map((c) => c.n), [n], name);
    assert.deepEqual(v.lines, [`FAIL: check ${n} ${CHECKS[n - 1].title}`], name);
    assert.equal(v.stamp, "NOT AUTHENTIC", name);
  }
});

test("the sample-0 fixture (no pins) passes the four checks but is never shown as authentic", () => {
  const v = verifyView(loaded("test/fixtures/receipt-t003-sample-0.json").receipt, false);
  assert.equal(v.kind, "unofficial");
  assert.equal(v.word, "Not official.");
  assert.match(v.lines[0], /^NOT AN OFFICIAL PACK \(fixture\)/);
  assert.equal(v.stamp, "NOT OFFICIAL");
});

test("renders from the verify result, never the receipt's claims: a lying grade / attestation_checks / verdict field changes nothing it shows", () => {
  const r = structuredClone(loaded("recorded/pack-2.json").receipt) as Record<string, any>;
  r.verdict = "VERIFIED by the seller";
  r.tee.attestation_checks = { ...r.tee.attestation_checks, intel_dcap: true, nvidia_nras: true };
  const v = verifyView(asReceipt(r), false);
  const shown = JSON.stringify(v);
  assert.doesNotMatch(shown, /VERIFIED by the seller/);
  assert.equal(v.kind, "fail"); // the over-claim fails check 3, it is never echoed as a pass
  assert.deepEqual(v.checks.filter((c) => !c.ok).map((c) => c.n), [3]);
  // check 3's scope comes from the verifier: DCAP / NRAS / measurements are always "not checked"
  assert.deepEqual(v.scope.filter((s) => !s.ok).map((s) => s.label), ["Intel DCAP chain", "NVIDIA GPU evidence", "image measurements"]);
});

test("chain fields: every one is labelled not verified offline, made printable, and links only a well-formed testnet tx hash", () => {
  const r = structuredClone(loaded("recorded/pack-2.json").receipt) as Record<string, any>;
  const rows = chainRows(r);
  assert.deepEqual(rows.slice(0, 4).map((x) => x.label), ["job", "buyer", "seller", "quote"]);
  assert.equal(rows[0].value, "1");
  assert.equal(rows[3].value, "0.030 → 0.040 NEAR");
  const create = rows.find((x) => x.label === "tx create");
  assert.equal(create?.href, "https://testnet.nearblocks.io/txns/CUuEWusixATkE8yybm9CAm22tt6QDAsHxWf9oQEExksm");
  // hostile values: bidi override, a javascript: "hash", a non-string, a mainnet claim
  r.buyer = "evil‮txt.testnet";
  r.seller = { toString: () => "x" };
  r.txs = { create: "javascript:alert(1)", reveal: "9ibVLq9bV3xPkKVjbdKcw4yuhh6FMLPrNAprmcrBuwmB" };
  const bad = chainRows(r);
  assert.equal(bad[1].value, "evil\\u202etxt.testnet");
  assert.equal(bad[2].value, "(not a string)");
  assert.equal(bad.find((x) => x.label === "tx create")?.href, null);
  assert.ok(bad.find((x) => x.label === "tx reveal")?.href);
  r.network = "mainnet";
  assert.equal(chainRows(r).find((x) => x.label === "tx reveal")?.href, null);
  // long values are cut, never wrap the sheet
  r.buyer = "a".repeat(500);
  assert.ok(chainRows(r)[1].value.length <= 97);
});

test("security L-1: check details are capped at 240 characters, and no PASS row carries a spoofed pack_id", async () => {
  // h7: a 7 MB tee.model fails check 2 with the model name in its detail; the row stays one short line
  const big = structuredClone(loaded("recorded/pack-2.json").receipt) as Record<string, any>;
  big.tee.model = "M".repeat(1024 * 1024);
  const vb = verifyView(asReceipt(big), false);
  assert.equal(vb.checks[1].ok, false);
  for (const c of vb.checks) assert.ok(c.detail.length <= 241, `check ${c.n}: ${c.detail.length} chars`);
  assert.ok(vb.checks[1].detail.endsWith("…"));
  // h11: the genuine review relabelled as an unofficial pack whose name reads like a verdict (commit recomputed)
  // @ts-expect-error plain .js grader, no type declarations
  const { commit } = await import("../../grader/grade.js");
  const spoof = "pack-2, the official answer key). REVIEW AUTHENTIC (offline): genuine NEAR AI TEE review, regrade PASS ✓ (" + "x".repeat(2000);
  const r = structuredClone(loaded("recorded/pack-2.json").receipt) as Record<string, any>;
  r.pack_id = spoof;
  r.reveal.key.pack_id = spoof;
  r.grade.pack_id = spoof;
  r.commit_hash = commit(r.reveal.key, r.reveal.salt);
  const v = verifyView(asReceipt(r), false);
  assert.equal(v.kind, "unofficial");
  assert.equal(v.checks[0].ok, true);
  for (const c of v.checks) assert.doesNotMatch(c.detail, /REVIEW AUTHENTIC/, `check ${c.n}`);
  assert.doesNotMatch(v.lines.join(" "), /REVIEW AUTHENTIC/);
  assert.match(v.checks[0].detail, /not an official pack/);
});

test("code review O-1: tx keys that share their first 24 characters stay distinguishable (ellipsis, not a silent slice)", () => {
  const r = structuredClone(loaded("recorded/pack-2.json").receipt) as Record<string, any>;
  r.txs = { [`${"a".repeat(30)}1`]: "x", [`${"a".repeat(30)}2`]: "y", short: "z" };
  const labels = chainRows(r).slice(4).map((x) => x.label);
  assert.deepEqual(labels, [`tx ${"a".repeat(24)}…`, `tx ${"a".repeat(24)}…`, "tx short"]);
  // an emoji at the cut is never split into a lone surrogate
  r.txs = { [`${"a".repeat(23)}😀😀`]: "x" };
  assert.equal(chainRows(r)[4].label, `tx ${"a".repeat(23)}😀…`);
});

test("Designer QA B3: error copy has no literal backticks, and a refused file's name is printable and cut to 48", async () => {
  const errs = [
    parseReceiptText("nope", "a.json"),
    parseReceiptText("[1]", "a.json"),
    parseReceiptText('{"version":2}', "a.json"),
    await loadFile({ name: "big.json", size: MAX_RECEIPT_BYTES + 1, text: async () => "" }),
  ];
  for (const e of errs) {
    assert.equal(e.ok, false);
    if (!e.ok) assert.doesNotMatch(e.error, /`/, e.error);
  }
  assert.equal(fileName("evil\u202e.json"), "evil\\u202e.json");
  assert.equal(fileName("n".repeat(60) + ".json"), `${"n".repeat(48)}…`);
  assert.equal(fileName(""), "receipt.json");
});

test("8 MB cap: an oversize file is refused before it is read or parsed", async () => {
  let read = 0;
  const big = { name: "huge.json", size: MAX_RECEIPT_BYTES + 1, text: async () => { read++; return "{}"; } };
  const r = await loadFile(big);
  assert.equal(r.ok, false);
  assert.equal(read, 0);
  if (!r.ok) assert.match(r.error, /over 8 MB/);
  // the text path enforces the same cap on the UTF-8 byte length before JSON.parse
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = (...a: Parameters<typeof JSON.parse>) => { parsed++; return parse(...a); };
  try {
    const t = parseReceiptText(" ".repeat(MAX_RECEIPT_BYTES + 1), "x.json");
    assert.equal(t.ok, false);
    assert.equal(parsed, 0);
  } finally {
    JSON.parse = parse;
  }
});

test("bad input: not JSON, not a version 1 receipt, a version 1 receipt with no review text to tamper", async () => {
  const notJson = parseReceiptText("hello", "a.txt");
  assert.equal(notJson.ok, false);
  if (!notJson.ok) assert.match(notJson.error, /not JSON/);
  for (const t of ["[]", "null", '{"version":2}', '"x"']) {
    const r = parseReceiptText(t, "a.json");
    assert.equal(r.ok, false, t);
    if (!r.ok) assert.match(r.error, /not an Earned Price receipt/, t);
  }
  const f = await loadFile({ name: "r.json", size: 15, text: async () => '{"version":1}' });
  assert.equal(f.ok, true);
  if (f.ok) {
    assert.equal(verifyView(f.receipt, false).kind, "fail"); // all four fail, never throws
    assert.throws(() => verifyView(f.receipt, true), /no stored review text/);
  }
});

test("file facts are computed by the page: byte size and the sha256 of the exact bytes (pack-2 = the repo file)", () => {
  const r = loaded("recorded/pack-2.json");
  assert.equal(r.bytes, Buffer.byteLength(text("recorded/pack-2.json")));
  // the page bundles the parsed JSON and re-serialises it with receiptJson: the same bytes as the file
  assert.equal(receiptJson(JSON.parse(text("recorded/pack-2.json"))), text("recorded/pack-2.json"));
  assert.equal(r.sha256, "4ed105bf1541921996df91aa3a0a448281803ccdd0089197037bf39e9a8f8122");
  assert.equal(r.name, "recorded/pack-2.json");
  assert.equal(RECORDED_NAME, "recorded/pack-2.json");
});

test("CLI equivalent is README Tier 1 steps 4 and 6, word for word", () => {
  const readme = text("README.md");
  assert.equal(cliLine("recorded", false), CLI);
  assert.equal(CLI, "node cli/earned.js verify recorded/pack-2.json");
  assert.ok(readme.includes(`Do: \`${cliLine("recorded", false)}\``));
  assert.ok(readme.includes(`Do: \`${cliLine("recorded", true)}\``));
  assert.equal(cliLine("file", false), "node cli/earned.js verify path/to/receipt.json");
  assert.equal(cliLine("file", true), "node cli/earned.js verify path/to/receipt.json --tamper");
});

test("trust anchors are bundled with the page and summarised from verify/trust-anchors.js, not the receipt", () => {
  const t = trustSummary();
  assert.equal(t.model, TRUST.review_model);
  assert.equal(t.signers, TRUST.signers.length);
  assert.deepEqual(t.packs, Object.keys(TRUST.request_pins));
});

test("text only: no innerHTML / dangerouslySetInnerHTML / outerHTML / insertAdjacentHTML in the verify page's code", () => {
  const dir = new URL("./", import.meta.url);
  const files = readdirSync(dir).filter((f) => /\.(tsx?|js)$/.test(f) && !f.endsWith(".test.ts"));
  files.push("../../app/verify/page.tsx");
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), "utf8").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(src, /innerHTML|dangerouslySetInnerHTML|outerHTML|insertAdjacentHTML|document\.write/, f);
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/, `${f}: verify makes no network call`);
  }
});
