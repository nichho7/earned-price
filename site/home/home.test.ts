// [CTO] T-098 · the home demo's data and words: derived from the recorded run, never typed; captions and labels are
// copy v2 verbatim (deliverables/cmo/site-copy-v2.md §5); the live-trial block never promises a live hire by default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RUNS } from "../data/runs.ts";
import { HERO } from "../data/hero.ts";
import { demoJobs } from "./jobs.ts";
import { answersHtml, esc, formula, postWords, srcAfter, stepText, txLink } from "./html.ts";
import { LIVE_TRIAL, trialCopy } from "./live-trial.ts";
import { tamperKey, tamperText } from "./tamper.ts";

const [J1, J2] = demoJobs(RUNS);

test("jobs come from the recorded events: fee, record, block, hashes, grades", () => {
  assert.equal(J1.fee, "0.030");
  assert.deepEqual(J1.before, { q: "0.030", P: 0, B: 0, F: 0 });
  assert.deepEqual(J1.after, { q: "0.040", P: 1, B: 1, F: 0 });
  assert.equal(J1.block, "277,368,644");
  assert.equal(J1.tx.reveal, "9ibVLq9bV3xPkKVjbdKcw4yuhh6FMLPrNAprmcrBuwmB");
  assert.equal(J1.tx.create, "CUuEWusixATkE8yybm9CAm22tt6QDAsHxWf9oQEExksm");
  assert.equal(J1.secs.lock, "1.18");
  assert.equal(J1.found, 5);
  assert.equal(J1.outcome, "earned");
  assert.equal(J2.fee, "0.040");
  assert.deepEqual(J2.after, { q: "0.040", P: 2, B: 1, F: 0 });
  assert.equal(J2.tx.reveal, "3skWKYL7tpPwtzgYcfrTkhgxDv4HaYdAMg9axFLNB5Rw");
  assert.equal(J2.found, 4);
  assert.equal(J2.outcome, "same");
  assert.deepEqual(J2.bugs.map((b) => b[1]), [true, true, true, true, false]);
  for (const J of [J1, J2]) for (const h of Object.values(J.tx)) assert.match(h, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
});

test("tab labels match each run's exam (copy v2 §5)", () => {
  assert.equal(RUNS[0].pack_id, "pack-2");
  assert.equal(RUNS[1].pack_id, "pack-3");
  assert.equal(`${J1.tab} · ${J1.tabSub}`, "Job 1 of 2 · Exam 2 · warehouse stock code");
  assert.equal(`${J2.tab} · ${J2.tabSub}`, "Job 2 of 2 · same buyer · Exam 3 · payments code");
});

test("captions are copy v2 §5 verbatim", () => {
  assert.deepEqual(J1.cap, {
    start: "Job 1. A first-time buyer hires the agent at its starting price, 0.030 test NEAR.",
    lock: "The buyer’s pay is held in escrow. The exam’s answers are locked in at the same time.",
    review: "The agent reviews the code inside secure hardware, which signs the review.",
    grade: "The buyer opens the locked answers. Plain code grades the review.",
    pass: "Passed: 5 of 5 bugs found. The agent is paid.",
    price: "A first-time buyer’s pass, so the price rose from 0.030 to 0.040.",
  });
  assert.deepEqual(J2.cap, {
    start: "Job 2. The same buyer hires the agent again, at 0.040 test NEAR.",
    lock: "The pay is held in escrow, with a new exam’s answers locked in.",
    review: "The agent reviews the new code inside secure hardware.",
    grade: "The buyer opens the locked answers. Plain code grades the review.",
    pass: "Passed: 4 of 5 bugs found, and 4 is enough. The agent is paid.",
    price: "Same buyer, so the price stays at 0.040. A repeat buyer can’t push it up.",
  });
});

test("demo slots: step statuses, formula, postmark words, links", () => {
  assert.equal(stepText(0, "done", J1).st, esc("0.030 test NEAR held · 1.18 s"));
  assert.equal(stepText(1, "done", J1).st, "Review signed and saved on the blockchain · 0.90 s");
  assert.equal(stepText(2, "on", J1).st, "Opening the answers and grading…");
  assert.equal(stepText(3, "done", J1).tx, "");
  assert.match(stepText(2, "done", J2).tx, /href="https:\/\/testnet\.nearblocks\.io\/txns\/3skWKYL7tpPwtzgYcfrTkhgxDv4HaYdAMg9axFLNB5Rw"/);
  assert.equal(formula(J1.after), "0.030 start + 0.010 × 1 buyers with a pass − 0.005 × 0 fails = 0.040");
  assert.deepEqual(postWords(J1), ["EARNED"]);
  assert.deepEqual(postWords(J2), ["PAID", "PRICE SAME"]); // T-097: never HELD on a paid-out job
  assert.match(srcAfter(J1), /block 277,368,644 · paid out: <a href/);
  assert.ok(!answersHtml(J1, false).includes("load_catalog"), "titles stay locked before the reveal");
  assert.match(txLink("<x>"), /&lt;x&gt;/);
});

test("problem section arithmetic: '4 in 5' and the never-hired count follow hero.json", () => {
  const never = HERO.agents - HERO.hired_once;
  assert.equal(Math.round((5 * never) / HERO.agents), 4);
});

test("tamper widget: Exam 2's function names from the revealed titles", () => {
  assert.deepEqual(tamperKey(J1).map((r) => r[1]), ["load_catalog", "save_snapshot", "write_off", "page", "is_expired"]);
  assert.equal(tamperText(tamperKey(J1)), "exam 2 answers: B1 load_catalog, B2 save_snapshot, B3 write_off, B4 page, B5 is_expired");
});

test("live trial: default never promises a live hire (A-032 honesty); full copy only behind the switch", () => {
  assert.equal(LIVE_TRIAL, "partial", "flip to full only with a real hire done on the deployed URL (see live-trial.ts)");
  const p = trialCopy("partial", "0.3");
  assert.match(p.body.join(" "), /isn’t online for public jobs yet/);
  assert.match(p.body.join(" "), /comes back after the deadline/);
  assert.doesNotMatch(p.primary, /hire|live/i);
  const f = trialCopy("full", "0.3");
  assert.match(f.body.join(" "), /price move on chain/);
  for (const c of [p, f]) assert.match(c.note, /won’t spend more than 0\.3 test NEAR/); // A-029 cap (T-104)
});
