// T-013 calibration spend accounting (scripts/review-spend.mjs, used by scripts/measure-packs.mjs).
// Every request that may have been billed must count toward --max-usd: its usage when the body
// reports one, otherwise the per-run reserve, never $0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chargeFor, usageCost, worstRunUsd } from "../scripts/review-spend.mjs";
import { PACKS_DIR, loadPack } from "../packs/packs.js";
import { MAX_TOKENS, buildReviewRequest } from "../seller/review-prompt.js";

const PRICE = { in: 0.3e-6, out: 1.2e-6 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test("usageCost: usage tokens x price", () => {
  close(usageCost(JSON.stringify({ usage: { prompt_tokens: 2000, completion_tokens: 100 } }), PRICE), 2000 * 0.3e-6 + 100 * 1.2e-6);
});

test("usageCost: null when the body is unreadable or has no usage", () => {
  assert.equal(usageCost("<html>502</html>", PRICE), null);
  assert.equal(usageCost("", PRICE), null);
  assert.equal(usageCost(JSON.stringify({ choices: [] }), PRICE), null);
  assert.equal(usageCost(JSON.stringify({ usage: null }), PRICE), null);
  assert.equal(usageCost("null", PRICE), null);
});

test("chargeFor: a 200 with an unreadable body or no usage costs the reserve, not $0", () => {
  assert.equal(chargeFor("not json", PRICE, 0.004), 0.004);
  assert.equal(chargeFor(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), PRICE, 0.004), 0.004);
  close(chargeFor(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 1 } }), PRICE, 0.004), 10 * 0.3e-6 + 1.2e-6);
});

test("worstRunUsd: covers prompt bytes + chat-template margin + MAX_TOKENS of output", () => {
  const body = buildReviewRequest(loadPack("3").reviewFiles);
  const bound = worstRunUsd(body, PRICE);
  assert.ok(bound >= Buffer.byteLength(body) * PRICE.in + MAX_TOKENS * PRICE.out, String(bound));
  assert.ok(bound < 0.01, `bound ${bound} should be tighter than the old flat $0.01`);
});

test("worstRunUsd: never below the logged cost of any real review (rounds 1-3 raw bodies)", () => {
  const resultsDir = join(PACKS_DIR, "results");
  let checked = 0;
  for (const round of readdirSync(resultsDir).filter((d) => d.startsWith("round-"))) {
    for (const file of readdirSync(join(resultsDir, round, "raw"))) {
      const raw = JSON.parse(readFileSync(join(resultsDir, round, "raw", file), "utf8"));
      const cost = usageCost(raw.response_body, PRICE);
      assert.notEqual(cost, null, `${round}/${file} has no usage`);
      assert.ok(cost <= worstRunUsd(raw.request_body, PRICE), `${round}/${file}`);
      checked++;
    }
  }
  assert.ok(checked >= 40, `only ${checked} raw reviews checked`);
});
