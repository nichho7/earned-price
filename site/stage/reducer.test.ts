// [CTO] T-033 · reducer + format unit tests (node --test, Node type stripping; no extra deps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { LabEvent, LabFixture } from "./schema.ts";
import { findPlaceholders } from "./schema.ts";
import { apply, fold, groupsOf, headlineOf, initState, outcomeOf } from "./reducer.ts";
import { nearOf, postmarkDate, quoteOf, rawQuoteOf, shortHash, signedNear } from "./format.ts";

const load = (name: string): LabFixture =>
  JSON.parse(readFileSync(new URL(`../fixtures/fixture-${name}.json`, import.meta.url), "utf8"));

test("pass fixture folds to Earned 0.030 -> 0.040", () => {
  const s = fold(load("pass"));
  assert.equal(outcomeOf(s), "earned");
  assert.deepEqual(headlineOf(s), { text: "Earned.", waiting: false });
  assert.equal(s.quoteBefore?.quote_mnear, 30);
  assert.equal(s.quoteAfter?.quote_mnear, 40);
  assert.equal(s.settled?.outcome, "paid_seller");
  assert.equal(s.checks.filter((c) => c?.hit).length, 5);
  assert.deepEqual(s.mismatch, []);
});

test("repeat fixture folds to Holds 0.040, counted once", () => {
  const s = fold(load("repeat"));
  assert.equal(outcomeOf(s), "holds");
  assert.equal(headlineOf(s).text, "Holds.");
  assert.equal(s.quoteAfter?.quote_mnear, 40);
  assert.equal(s.quoteAfter?.delta_mnear, 0);
  assert.equal(s.settled?.counts_unique_buyer, false);
  assert.equal(s.checks.filter((c) => c && !c.hit).length, 1);
});

test("fail fixture folds to Refunded 0.040 -> 0.035", () => {
  const s = fold(load("fail"));
  assert.equal(outcomeOf(s), "refunded");
  assert.equal(headlineOf(s).text, "Refunded.");
  assert.equal(s.quoteAfter?.quote_mnear, 35);
});

test("a paid run that adds a new buyer but cannot raise the quote (cap) is 'paid-flat', not 'holds'", () => {
  const f = load("repeat");
  const ev = f.events.map((e) => (e.type === "settled" ? { ...e, data: { ...e.data, counts_unique_buyer: true } } : e)) as LabEvent[];
  assert.equal(outcomeOf(fold({ ...f, events: ev })), "paid-flat");
});

test("group rule: 18 events make 10 chain moments; the reveal group carries confirm + 5 grades + settle", () => {
  const g = groupsOf(load("pass").events);
  assert.equal(g.length, 10);
  assert.deepEqual(g[8].map((e) => e.type), ["tx_confirmed", "check_graded", "check_graded", "check_graded", "check_graded", "check_graded", "settled"]);
});

test("waiting headlines follow the open tx; Grading after the reveal lands", () => {
  const f = load("pass");
  assert.deepEqual(headlineOf(fold(f, 1)), { text: "Hire.", waiting: false });
  assert.deepEqual(headlineOf(fold(f, 2)), { text: "Locking.", waiting: true });
  assert.deepEqual(headlineOf(fold(f, 10)), { text: "Revealing.", waiting: true });
  assert.deepEqual(headlineOf(fold(f, 17)), { text: "Grading.", waiting: true });
});

test("a failed tx stops the run: 'Not locked.', nothing locked, outcome tx-failed", () => {
  const f = load("pass");
  const ev = f.events.slice(0, 3).map((e) =>
    e.type === "tx_confirmed" ? { ...e, data: { ...e.data, status: "failure", error: "Smart contract panicked: deposit too low" } } : e,
  ) as LabEvent[];
  const s = fold({ ...f, events: ev });
  assert.equal(outcomeOf(s), "tx-failed");
  assert.equal(headlineOf(s).text, "Not locked.");
  assert.equal(s.lockedMnear, 0);
  assert.equal(s.rows.create?.status, "bad");
});

test("buyer's view: a seller tx can confirm with no prior submit", () => {
  const f = load("pass");
  const ev = f.events.filter((e) => !(e.type === "tx_submitted" && e.data.actor === "seller"));
  const s = fold({ ...f, events: ev }, 4); // quote, submit create, confirm create, confirm accept
  assert.equal(s.rows.accept?.status, "ok");
  assert.equal(s.rows.accept?.actor, "seller");
});

test("a quote that disagrees with get_record is recorded as a mismatch", () => {
  const f = load("pass");
  const bad = f.events.map((e) => (e.type === "quote" && e.data.phase === "after" ? { ...e, data: { ...e.data, quote_mnear: 50 } } : e)) as LabEvent[];
  assert.match(fold({ ...f, events: bad }).mismatch[0], /get_record gives 40, quote says 50/);
});

test("apply is pure", () => {
  const f = load("pass");
  const s0 = initState(f);
  const snapshot = JSON.stringify(s0);
  apply(s0, f.events[0]);
  apply(s0, f.events[1]);
  assert.equal(JSON.stringify(s0), snapshot);
});

test("findPlaceholders refuses every T-051 fixture (none may ship)", () => {
  for (const n of ["pass", "repeat", "fail"]) assert.ok(findPlaceholders(load(n)).length > 0, n);
});

test("format helpers", () => {
  assert.equal(nearOf(40), "0.040");
  assert.equal(signedNear(10), "+0.010");
  assert.equal(signedNear(-5), "−0.005");
  assert.equal(signedNear(0), "±0.000");
  assert.equal(shortHash("7uwCauCSYDtgzz4daymrcZDh7mEo3dUYa26JLenyE28W"), "7uwC…E28W");
  assert.equal(quoteOf({ unique_buyers: 0, fails: 2 }), 25);
  assert.equal(rawQuoteOf({ unique_buyers: 0, fails: 2 }), 20);
  assert.equal(quoteOf({ unique_buyers: 9, fails: 0 }), 100);
  assert.equal(postmarkDate("2026-11-13T10:02:00Z"), "13 NOV 2026 UTC");
  assert.equal(postmarkDate("nope"), "");
});

test("a quote(after) whose delta, prev or jobs disagree is a mismatch (code review L-2)", () => {
  for (const name of ["pass", "repeat", "fail"]) assert.deepEqual(fold(load(name)).mismatch, [], name);
  const f = load("pass");
  const i = f.events.findIndex((e) => e.type === "quote" && e.data.phase === "after");
  const bad = (patch: object) => {
    const g = structuredClone(f);
    const e = g.events[i] as Extract<LabEvent, { type: "quote" }>;
    Object.assign(e.data, patch);
    return fold(g).mismatch;
  };
  assert.match(bad({ delta_mnear: 15 }).join(), /delta 15 != quote/);
  assert.match(bad({ prev_quote_mnear: 35, delta_mnear: 5 }).join(), /prev_quote 35 != quote\(before\) 30/);
  const e = f.events[i] as Extract<LabEvent, { type: "quote" }>;
  assert.match(bad({ record: { ...e.data.record, jobs: e.data.record.jobs + 1 } }).join(), /record jobs/);
});
