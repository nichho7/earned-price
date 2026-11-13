// [CTO] T-035: the pieces the /live page now shares with the CLI (no fork): tx outcome parsing,
// the decline outcome, the signer helpers, recordBurn / releaseSpend. They must stay browser-safe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { outcomeOf, parseTxOutcome, txHashOf } from "../cli/tx.js";
import { SPEND_CAP_YOCTO, SpendCapError, recordBurn, recordSpend, releaseSpend } from "../cli/spend-cap.js";
import * as pick from "../cli/pick.js";
import * as hire from "../cli/hire.js";
import * as tx from "../cli/tx.js";
import * as cap from "../cli/spend-cap.js";

const CONTRACT = "earned-price.testnet";
const BUYER = "earned-price-web-a0a1a2a3a4a5.testnet";
const ev = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: "earned_price", version: "0.1.0", event, data })}`;
const outcome = (logs, executor = CONTRACT) => ({
  status: { SuccessValue: "" },
  transaction: { hash: "2HdWusixATkE8yybm9CAm22tt6QDAsHxWf9oQEExk5Rf" },
  transaction_outcome: { id: "2HdWusixATkE8yybm9CAm22tt6QDAsHxWf9oQEExk5Rf", outcome: { executor_id: "seller.earned-price.testnet", logs: [] } },
  receipts_outcome: [{ block_hash: "Bh1", outcome: { executor_id: executor, logs } }],
});

test("browser-safe: tx.js, spend-cap.js and quote.js import nothing from node: (the /live bundle uses them)", () => {
  for (const f of ["cli/tx.js", "cli/spend-cap.js", "cli/quote.js"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /from\s+["']node:/, f);
    assert.doesNotMatch(src, /from\s+["']\.\/(pick|hire|init)\.js["']/, `${f} must not pull a node-only module`);
  }
});

test("moved, not forked: pick.js / hire.js re-export the same bindings", () => {
  assert.equal(pick.sendCreateTx, tx.sendCreateTx);
  assert.equal(pick.signedTxHash, tx.signedTxHash);
  assert.equal(pick.isRejectedBeforeInclusion, tx.isRejectedBeforeInclusion);
  assert.equal(pick.txHashOf, tx.txHashOf);
  assert.equal(pick.releaseSpend, cap.releaseSpend);
  assert.equal(hire.outcomeOf, tx.outcomeOf);
});

test("outcomeOf: a decline is a refund to this buyer, record unchanged, for this job only", () => {
  const p = parseTxOutcome(outcome([ev("decline", { job_id: "7", seller: "seller.earned-price.testnet", buyer: BUYER, refunded: "30000000000000000000000" })]), CONTRACT);
  const o = outcomeOf(p.events, "7", BUYER);
  assert.equal(o.kind, "declined");
  assert.equal(o.refundYocto, "30000000000000000000000");
  assert.equal(o.graded, false);
  assert.match(o.line, /declined.*doesn't change the seller's record/);
  assert.equal(outcomeOf(p.events, "8", BUYER), null, "another job's decline is not ours");
  assert.equal(outcomeOf(p.events, "7", "someone-else.testnet").refundYocto, null, "never credits another buyer");
  // A decline log from any account other than the escrow is ignored.
  const forged = parseTxOutcome(outcome([ev("decline", { job_id: "7", buyer: BUYER, refunded: "1" })], "evil.testnet"), CONTRACT);
  assert.equal(outcomeOf(forged.events, "7", BUYER), null);
});

test("outcomeOf: timeout not_accepted = refund, record unchanged (unchanged behaviour)", () => {
  const p = parseTxOutcome(outcome([ev("timeout", { job_id: "7", reason: "not_accepted" }), ev("refund", { job_id: "7", buyer: BUYER, seller: "s.testnet", amount: "30000000000000000000000", reason: "not_accepted", record: "unchanged" })]), CONTRACT);
  const o = outcomeOf(p.events, "7", BUYER);
  assert.equal(o.kind, "timeout_refund");
  assert.equal(o.refundYocto, "30000000000000000000000");
  assert.equal(txHashOf(outcome([])), "2HdWusixATkE8yybm9CAm22tt6QDAsHxWf9oQEExk5Rf");
});

test("recordBurn adds an amount already spent and never refuses past the cap (security M-2 / review O-2)", () => {
  const near = SPEND_CAP_YOCTO - 1n;
  const s = { spent_yocto: near.toString() };
  assert.throws(() => recordSpend(s, 2n), SpendCapError, "the pre-check still refuses");
  assert.equal(recordBurn(s, 2n).spent_yocto, (SPEND_CAP_YOCTO + 1n).toString(), "the truth is recorded");
  assert.equal(recordBurn(s, "5").spent_yocto, (near + 5n).toString());
  assert.throws(() => recordBurn(s, -1n), SpendCapError);
  assert.throws(() => recordBurn(s, "1.5"), SpendCapError);
  assert.throws(() => recordBurn({ spent_yocto: "x" }, 1n), SpendCapError);
});

test("releaseSpend never goes below 0 and ignores a non-digit amount (moved from pick.js)", () => {
  assert.equal(releaseSpend({ spent_yocto: "10" }, "4").spent_yocto, "6");
  assert.equal(releaseSpend({ spent_yocto: "10" }, 40n).spent_yocto, "0");
  assert.equal(releaseSpend({ spent_yocto: "10" }, "x").spent_yocto, "10");
});
