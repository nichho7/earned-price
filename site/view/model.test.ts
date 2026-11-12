// [CTO] T-033 · page model: a ship build refuses placeholder data inside `next build` (code review M-1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { LabFixture } from "../stage/schema.ts";
import { finalModel, isRefund, ledeKeyOf, registerMoveOf } from "./model.ts";

const load = (name: string): LabFixture =>
  JSON.parse(readFileSync(new URL(`../fixtures/fixture-${name}.json`, import.meta.url), "utf8"));
const runs = [load("pass"), load("repeat")];

test("local build: placeholder fixtures render, marked as placeholder", () => {
  const m = finalModel(runs, {});
  assert.equal(m.placeholder, true);
  assert.equal(m.last.outcome, "holds");
});

test("ship build (VERCEL=1 or EARNED_SHIP=1): placeholder fixtures throw", () => {
  assert.throws(() => finalModel(runs, { VERCEL: "1" }), /placeholder run data in a ship build/);
  assert.throws(() => finalModel(runs, { EARNED_SHIP: "1" }), /placeholder run data in a ship build/);
});

test("ship build: a single placeholder value is enough to refuse, even if the fixture is flagged recorded", () => {
  const flaggedReal = runs.map((f) => ({ ...f, placeholder: false, recorded: true })); // values are still PLACEHOLDER_*
  assert.throws(() => finalModel(flaggedReal, { VERCEL: "1" }), /placeholder run data/);
});

test("refund at the floor (refunded-flat) gets refund copy, not 'the quote drops' (code review L-6)", () => {
  assert.equal(registerMoveOf("refunded-flat", { quote_mnear: 25, prev_quote_mnear: 25 }), "0.025 holds · refunded");
  assert.equal(registerMoveOf("refunded", { quote_mnear: 35, prev_quote_mnear: 40 }), "0.040 → 0.035 · refunded");
  assert.equal(registerMoveOf("earned", { quote_mnear: 40, prev_quote_mnear: 30 }), "0.030 → 0.040");
  assert.equal(registerMoveOf("holds", { quote_mnear: 40, prev_quote_mnear: 40 }), "0.040 holds · counted once");
  assert.equal(isRefund("refunded-flat"), true);
  assert.equal(isRefund("holds"), false);
  const m = finalModel(runs, {});
  assert.equal(ledeKeyOf({ ...m.last, outcome: "refunded-flat" }), "refunded-flat");
  assert.equal(ledeKeyOf(m.last), "holds");
});
