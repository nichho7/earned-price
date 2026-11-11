// T-026 seller quote module. No live RPC: every response below is a recorded-shape
// nearcore JSON-RPC body (call_function result / HANDLER_ERROR), served by a fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BASE_MNEAR, CAP_MNEAR, FAIL_MNEAR, FLOOR_MNEAR, PASS_MNEAR, YOCTO_PER_MNEAR,
  evaluateOffer, fetchQuote, formatMilli, formulaLine, parseNearToMilli, parseRecord,
  quoteLines, quoteMilli, viewFunction,
} from "../cli/quote.js";
import { quoteRpcUrls, runQuote } from "../cli/quote-cmd.js";
import { RPC_URLS } from "../cli/init.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const VECTORS = JSON.parse(read("../test-vectors/quote.json")).vectors;
const CONTRACT = "earned-price.testnet";
const SELLER = "seller-agent.testnet";
const URLS = ["https://a.test.example", "https://b.test.example"];

// ---- formula vs contract ----

test("JS constants equal contract/src/quote.rs constants", () => {
  const rs = read("../contract/src/quote.rs");
  const c = (name) => Number(new RegExp(`pub const ${name}: i64 = (\\d+);`).exec(rs)[1]);
  assert.deepEqual(
    [BASE_MNEAR, PASS_MNEAR, FAIL_MNEAR, FLOOR_MNEAR, CAP_MNEAR],
    [c("BASE_MNEAR"), c("PASS_MNEAR"), c("FAIL_MNEAR"), c("FLOOR_MNEAR"), c("CAP_MNEAR")],
  );
  assert.match(rs, /BASE_MNEAR \+ PASS_MNEAR \* r\.unique_buyers as i64 - FAIL_MNEAR \* r\.fails as i64/);
  assert.match(rs, /raw\.clamp\(FLOOR_MNEAR, CAP_MNEAR\)/);
  assert.match(rs, /include_str!\("\.\.\/\.\.\/test-vectors\/quote\.json"\)/, "Rust reads the same vectors");
});

test("shared vectors (also run by cargo test): quote and printed formula", () => {
  assert.ok(VECTORS.length >= 10);
  for (const v of VECTORS) {
    const r = { ...v, jobs: v.passes + v.fails };
    assert.equal(quoteMilli(r), v.quote_mnear, v.name);
    assert.equal(formulaLine(r), v.formula, v.name);
  }
});

test("matches a BigInt i64 reference of the contract over a grid and the u32 edges", () => {
  const ref = (p, f) => {
    const raw = 30n + 10n * BigInt(p) - 5n * BigInt(f);
    return Number(raw < 25n ? 25n : raw > 100n ? 100n : raw);
  };
  const edges = [0, 1, 2, 6, 7, 8, 13, 14, 15, 2 ** 31, 0xffffffff];
  for (let p = 0; p <= 20; p++) for (let f = 0; f <= 40; f++) assert.equal(quoteMilli({ unique_buyers: p, fails: f }), ref(p, f));
  for (const p of edges) for (const f of edges) assert.equal(quoteMilli({ unique_buyers: p, fails: f }), ref(p, f), `${p},${f}`);
});

test("P is unique_buyers, not passes; a fail drops the quote; rise per pass is capped at 0.010", () => {
  assert.equal(quoteMilli({ passes: 50, unique_buyers: 1, fails: 0 }), 40);
  const before = { unique_buyers: 2, fails: 1 };
  assert.equal(quoteMilli(before) - quoteMilli({ ...before, fails: 2 }), 5);
  for (let p = 0; p < 12; p++) assert.ok(quoteMilli({ unique_buyers: p + 1, fails: 0 }) - quoteMilli({ unique_buyers: p, fails: 0 }) <= 10);
});

// ---- formatting, parsing, offers ----

test("formatMilli and parseNearToMilli", () => {
  assert.equal(formatMilli(30), "0.030");
  assert.equal(formatMilli(25), "0.025");
  assert.equal(formatMilli(1000), "1.000");
  assert.equal(formatMilli(0), "0.000");
  assert.equal(formatMilli(-20), "-0.020");
  for (const [s, m] of [["0.02", 20], ["0.020", 20], [".02", 20], ["0.025", 25], ["1", 1000], ["0.0300", 30], [" 0.03 ", 30]]) {
    assert.equal(parseNearToMilli(s), m, s);
  }
  for (const s of ["", ".", "abc", "-0.02", "0.0251", "1e-2", "0,02", "0x1", "99999999999999999"]) {
    assert.throws(() => parseNearToMilli(s), { code: "BAD_OFFER" }, s);
  }
});

test("offers: below floor refused with floor shown; below quote refused; at or above quote accepted at quote", () => {
  const low = evaluateOffer(20, 30);
  assert.equal(low.accept, false);
  assert.match(low.reason, /^Refused 0\.020 NEAR: below my cost floor 0\.025 NEAR\. My price is 0\.030 NEAR\.$/);
  assert.equal(evaluateOffer(24, 25).accept, false);
  assert.match(evaluateOffer(0, 25).reason, /cost floor 0\.025/);
  const mid = evaluateOffer(25, 30);
  assert.equal(mid.accept, false);
  assert.match(mid.reason, /below my quote 0\.030 NEAR/);
  assert.deepEqual(evaluateOffer(25, 25), { accept: true, priceMilli: 25, reason: "Accepted: price 0.025 NEAR." });
  assert.deepEqual(evaluateOffer(30, 30), { accept: true, priceMilli: 30, reason: "Accepted: price 0.030 NEAR." });
  assert.equal(evaluateOffer(50, 30).priceMilli, 30, "never charges more than the quote");
  assert.throws(() => evaluateOffer(-1, 30), { code: "BAD_OFFER" });
  assert.throws(() => evaluateOffer(1.5, 30), { code: "BAD_OFFER" });
});

test("quoteLines: demo text, repeat-buyer label, deterministic", () => {
  const r = { passes: 1, fails: 1, unique_buyers: 1, jobs: 2 };
  assert.deepEqual(quoteLines(r), [
    "Quote: 0.035 NEAR (testnet)",
    "  formula: 0.030 + 0.010×1 − 0.005×1 = 0.035 NEAR",
    "  P = 1 unique buyers with a pass, F = 1 fails, 2 graded jobs",
    "  rule: 0.030 + 0.010×P − 0.005×F, clamped to 0.025..0.100 NEAR",
  ]);
  assert.deepEqual(quoteLines(r), quoteLines({ ...r }));
  assert.match(quoteLines({ passes: 3, fails: 0, unique_buyers: 1, jobs: 3 })[2], /\(3 passes, 1 counted: one per buyer\)/);
});

test("parseRecord rejects bad shapes", () => {
  assert.deepEqual(parseRecord({ passes: 1, fails: 0, unique_buyers: 1, jobs: 1 }), { passes: 1, fails: 0, unique_buyers: 1, jobs: 1 });
  for (const bad of [null, {}, { passes: "1", fails: 0, unique_buyers: 0, jobs: 0 }, { passes: -1, fails: 0, unique_buyers: 0, jobs: 0 },
    { passes: 1.5, fails: 0, unique_buyers: 0, jobs: 0 }, { passes: 2 ** 32, fails: 0, unique_buyers: 0, jobs: 0 }, { passes: 0, fails: 0, unique_buyers: 1, jobs: 0 }]) {
    assert.throws(() => parseRecord(bad), { code: "BAD_RECORD" }, JSON.stringify(bad));
  }
});

test("quote.js is browser-safe (no node: imports) for the website", () => {
  assert.doesNotMatch(read("../cli/quote.js"), /from\s+["']node:|require\(/);
});

// ---- RPC (recorded shapes, fake fetch) ----

const bytes = (v) => [...Buffer.from(JSON.stringify(v))];
const callResult = (value, block_hash = "BLOCK1") => ({ jsonrpc: "2.0", id: "earned", result: { block_hash, block_height: 1, logs: [], result: bytes(value) } });
// Byte-for-byte bodies recorded 2026-11-11 (rpc.testnet.near.org / test.rpc.fastnear.com, call_function get_record).
const UNKNOWN_ACCOUNT = {"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{"block_hash":"FUPuAsGBuXmXdmGPkPf7vS7zjVeQP6gkX76JC1DHpV9m","block_height":277215074,"requested_account_id":"earned-price.testnet"},"name":"UNKNOWN_ACCOUNT"},"code":-32000,"message":"Server error","data":"account earned-price.testnet does not exist while viewing"},"id":"earned"};
const NO_CODE = {"jsonrpc":"2.0","result":{"block_hash":"EjgQD7KyUEQ9RELUaMpfmPueoC3o5oij7199sSvAG891","block_height":277215067,"error":"wasm execution failed with error: CompilationError(CodeDoesNotExist { account_id: \"earned-price-buyer-8fb0be6e.testnet\" })","logs":[]},"id":"earned"};
const METHOD_NOT_FOUND = { jsonrpc: "2.0", id: "earned", result: { block_hash: "B", block_height: 1, logs: [], error: "wasm execution failed with error: MethodResolveError(MethodNotFound)" } };

/** Fake fetch. `routes(url, params)` returns a body object, a number (HTTP status) or throws. Records calls. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const params = JSON.parse(init.body).params;
    calls.push({ url, params, args: JSON.parse(Buffer.from(params.args_base64, "base64").toString()) });
    const r = routes(url, params);
    if (typeof r === "number") return { ok: false, status: r, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r };
  };
  fn.calls = calls;
  return fn;
}

const record = (passes, fails, unique_buyers) => ({ passes, fails, unique_buyers, jobs: passes + fails });
/** A healthy RPC for one seller record, with the contract's own quote. */
const healthy = (rec, quoteYocto = String(BigInt(quoteMilli(rec)) * YOCTO_PER_MNEAR)) => (_url, p) =>
  callResult(p.method_name === "get_record" ? rec : quoteYocto);

test("viewFunction: sends a keyless call_function with base64 args at final finality", async () => {
  const f = fakeFetch(() => callResult({ ok: 1 }));
  assert.deepEqual(await viewFunction({ fetch: f, urls: URLS, contractId: CONTRACT, method: "get_record", args: { seller: SELLER } }), { ok: 1 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].params.request_type, "call_function");
  assert.equal(f.calls[0].params.finality, "final");
  assert.equal(f.calls[0].params.method_name, "get_record");
  assert.deepEqual(f.calls[0].args, { seller: SELLER });
});

test("viewFunction: fails over on network error, HTTP error, junk body and RPC internal errors", async () => {
  for (const bad of [() => { throw new Error("ECONNRESET"); }, () => 503, () => ({ nope: 1 }),
    () => ({ jsonrpc: "2.0", error: { name: "INTERNAL_ERROR", cause: { name: "INTERNAL_ERROR" }, code: -32000 } }),
    () => ({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" }, code: -32000 } })]) {
    const f = fakeFetch((url) => (url === URLS[0] ? bad() : callResult(7)));
    assert.equal(await viewFunction({ fetch: f, urls: URLS, contractId: CONTRACT, method: "m" }), 7);
    assert.deepEqual(f.calls.map((c) => c.url), URLS);
  }
});

test("viewFunction: account missing and contract errors are final answers (no failover)", async () => {
  let f = fakeFetch(() => UNKNOWN_ACCOUNT);
  await assert.rejects(viewFunction({ fetch: f, urls: URLS, contractId: CONTRACT, method: "quote" }), { code: "CONTRACT_MISSING" });
  assert.equal(f.calls.length, 1);
  f = fakeFetch(() => METHOD_NOT_FOUND);
  await assert.rejects(viewFunction({ fetch: f, urls: URLS, contractId: CONTRACT, method: "quote" }), { code: "VIEW_FAILED", message: /MethodNotFound/ });
  assert.equal(f.calls.length, 1);
  f = fakeFetch(() => NO_CODE);
  await assert.rejects(viewFunction({ fetch: f, urls: URLS, contractId: CONTRACT, method: "quote" }), { code: "CONTRACT_MISSING" });
  assert.equal(f.calls.length, 1);
  f = fakeFetch(() => ({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "NO_CONTRACT_CODE" }, code: -32000 } }));
  await assert.rejects(viewFunction({ fetch: f, urls: URLS, contractId: CONTRACT, method: "quote" }), { code: "CONTRACT_MISSING" });
});

test("viewFunction: all RPCs down gives RPC_UNAVAILABLE with per-RPC causes; non-testnet contract refused before any call", async () => {
  const f = fakeFetch(() => { throw new Error("down"); });
  const err = await viewFunction({ fetch: f, urls: URLS, contractId: CONTRACT, method: "m" }).catch((e) => e);
  assert.equal(err.code, "RPC_UNAVAILABLE");
  assert.deepEqual(err.cause.map((c) => c.url), URLS);
  await assert.rejects(viewFunction({ fetch: f, urls: URLS, contractId: "earned-price.near", method: "m" }), { code: "NOT_TESTNET" });
  assert.equal(f.calls.length, 2);
});

test("fetchQuote: demo path 0.030 -> 0.040 -> 0.035 from recorded records; quote read at the record's block", async () => {
  const path = [];
  for (const rec of [record(0, 0, 0), record(1, 0, 1), record(1, 1, 1)]) {
    const f = fakeFetch(healthy(rec));
    const q = await fetchQuote({ fetch: f, urls: URLS, contractId: CONTRACT, seller: SELLER });
    path.push(formatMilli(q.quoteMilli));
    assert.equal(q.lines[0], `Quote: ${formatMilli(q.quoteMilli)} NEAR (testnet)`);
    assert.deepEqual(f.calls.map((c) => c.params.method_name), ["get_record", "quote"]);
    assert.equal(f.calls[1].params.block_id, "BLOCK1");
    assert.equal(f.calls[1].params.finality, undefined);
  }
  assert.deepEqual(path, ["0.030", "0.040", "0.035"]);
});

test("fetchQuote: refuses when the on-chain quote disagrees with the formula", async () => {
  const f = fakeFetch(healthy(record(1, 0, 1), String(30n * YOCTO_PER_MNEAR)));
  await assert.rejects(fetchQuote({ fetch: f, urls: URLS, contractId: CONTRACT, seller: SELLER }), { code: "QUOTE_MISMATCH" });
  const g = fakeFetch(healthy(record(0, 0, 0), 30));
  await assert.rejects(fetchQuote({ fetch: g, urls: URLS, contractId: CONTRACT, seller: SELLER }), { code: "VIEW_FAILED" });
  await assert.rejects(fetchQuote({ fetch: g, urls: URLS, contractId: CONTRACT, seller: "bob.near" }), { code: "NOT_TESTNET" });
});

test("runQuote: prints quote, formula, inputs and refuses 0.02 below the floor", async () => {
  const lines = [];
  const res = await runQuote({ seller: SELLER, offer: "0.02", fetch: fakeFetch(healthy(record(0, 0, 0))), urls: URLS, out: (l) => lines.push(l) });
  assert.deepEqual(lines, [
    `Seller ${SELLER} on ${CONTRACT}`,
    "Quote: 0.030 NEAR (testnet)",
    "  formula: 0.030 + 0.010×0 − 0.005×0 = 0.030 NEAR",
    "  P = 0 unique buyers with a pass, F = 0 fails, 0 graded jobs",
    "  rule: 0.030 + 0.010×P − 0.005×F, clamped to 0.025..0.100 NEAR",
    "Refused 0.020 NEAR: below my cost floor 0.025 NEAR. My price is 0.030 NEAR.",
  ]);
  assert.equal(res.offer.accept, false);
});

test("runQuote: bad offer or missing seller fails before any network call; RPC list is the T-014 list", async () => {
  const f = fakeFetch(() => { throw new Error("must not be called"); });
  await assert.rejects(runQuote({ seller: SELLER, offer: "abc", fetch: f, urls: URLS, out: () => {} }), { code: "BAD_OFFER" });
  await assert.rejects(runQuote({ seller: undefined, fetch: f, urls: URLS, out: () => {} }), { code: "USAGE" });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(quoteRpcUrls({}), RPC_URLS);
  assert.deepEqual(quoteRpcUrls({ EARNED_RPC_URL: "https://test.rpc.fastnear.com" }), ["https://test.rpc.fastnear.com"]);
  assert.throws(() => quoteRpcUrls({ EARNED_RPC_URL: "https://rpc.mainnet.near.org" }), { code: "MAINNET_REFUSED" });
});
