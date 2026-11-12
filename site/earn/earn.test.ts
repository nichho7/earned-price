// [CTO] S-028 · unit tests for the ported T-070 module (node --test, Node type stripping, no extra deps).
// Ports the stage-1 reducer cases and the pure parts of the Designer's verify.mjs (checks 3, 4, 5, 10), and
// pins every review fix: H-2 (counted once from the chain), H-3 / M-1 / M-2 (escaping, links), L-5, plus the
// recorded T-064 run (real data, no placeholders) and the page model's ship-build refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { LabEvent, LabFixture } from "../stage/schema.ts";
import {
  acctUrl, buildStory, findPlaceholders, finalIndex, foldRun, groupsOf, headlineOf, isPlaceholderRun, isRepeatPass,
  outcomeOf, storyStateAt, txUrl,
} from "./earn-core.js";
import { renderStage, slotsOf } from "./earn-view.js";
import { slimRun } from "./slim.ts";
import { finalModel } from "../view/model.ts";
import { RUNS } from "../data/runs.ts";

const fixture = (name: string): LabFixture =>
  JSON.parse(readFileSync(new URL(`../fixtures/fixture-${name}.json`, import.meta.url), "utf8"));
const fold = (f: LabFixture, upTo = f.events.length) => foldRun(f, f.events.slice(0, upTo));
const withEvents = (f: LabFixture, map: (e: LabEvent) => LabEvent): LabFixture => ({ ...f, events: f.events.map(map) });
const finalHTML = (runs: LabFixture[], opts = {}) => { const st = buildStory(runs); return renderStage(storyStateAt(st, finalIndex(st)), { odometer: true, ...opts }); };

/* ---------- the recorded T-064 run (what the page ships) ---------- */

test("recorded run: two real testnet runs, no placeholder anywhere, run 1 earns 0.030 -> 0.040, run 2 holds", () => {
  assert.equal(RUNS.length, 2);
  for (const r of RUNS) {
    assert.deepEqual(findPlaceholders(r), [], r.pack_id);
    assert.equal(isPlaceholderRun(r), false);
    assert.equal(r.network, "testnet");
    assert.equal(r.mode, "recorded");
  }
  const [a, b] = RUNS.map((r) => foldRun(r, r.events));
  assert.equal(outcomeOf(a), "earned");
  assert.equal(a.qb?.quote_mnear, 30);
  assert.equal(a.qa?.quote_mnear, 40);
  assert.equal(outcomeOf(b), "holds");
  assert.equal(b.qa?.quote_mnear, 40);
  assert.deepEqual([...a.mismatch, ...b.mismatch], []);
  assert.equal(RUNS[1].buyer, RUNS[0].buyer);
});

test("recorded run: every tx hash matches the T-064 receipts byte for byte", () => {
  for (const [i, file] of ["pack-2", "pack-3"].entries()) {
    const rc = JSON.parse(readFileSync(new URL(`../../recorded/${file}.json`, import.meta.url), "utf8"));
    const run = RUNS[i];
    for (const action of ["create", "accept", "submit_review", "reveal"]) {
      const hashes = new Set(run.events.filter((e) => "tx_hash" in e && (e as { data: { action?: string } }).data.action === action).map((e) => (e as { tx_hash: string }).tx_hash));
      assert.deepEqual([...hashes], [rc.txs[action]], `${file} ${action}`);
    }
    const grade = run.events.find((e) => e.type === "settled")!;
    assert.equal((grade as { data: { grade: { found: number } } }).data.grade.found, rc.grade.found);
    assert.equal(run.events.find((e) => e.type === "tx_confirmed")!.job_id, rc.job_id);
  }
});

test("recorded run: one push per observed tx outcome (all of a tx's derived events share one t_ms; quote(after) is its own group)", () => {
  for (const r of RUNS) {
    const groups = groupsOf(r.events);
    for (const g of groups) {
      const txs = new Set(g.filter((e) => e.type !== "quote" && e.type !== "tx_submitted").map((e) => (e as { tx_hash: string }).tx_hash));
      assert.ok(txs.size <= 1, `a group mixes txs: ${[...txs].join(",")}`);
      assert.ok(!(g.some((e) => e.type === "quote") && g.length > 1), "a quote read shares a group");
    }
    const reveal = groups.find((g) => g.some((e) => e.type === "settled"))!;
    assert.deepEqual(reveal.map((e) => e.type), ["tx_confirmed", "check_graded", "check_graded", "check_graded", "check_graded", "check_graded", "settled"]);
  }
});

test("recorded run: settled carries no counts_unique_buyer (the contract never emits it); holds is derived from get_record (H-2)", () => {
  const settled = RUNS[1].events.find((e) => e.type === "settled")!;
  assert.equal("counts_unique_buyer" in settled.data, false);
  const s = foldRun(RUNS[1], RUNS[1].events);
  assert.equal(isRepeatPass(s), true);
  const html = finalHTML([...RUNS]);
  for (const must of ["Holds.", "counted once", "COUNTED ONCE", "NOT COUNTED", 'data-postmark="COUNTED"'])
    assert.ok(html.includes(must), must);
});

test("recorded run: real explorer links for every settle tx; no PLACEHOLDER chip", () => {
  const html = finalHTML([...RUNS], { repoUrl: "https://github.com/nicho/earned-price" });
  for (const r of RUNS) {
    const settle = r.events.find((e) => e.type === "settled") as { tx_hash: string };
    assert.ok(html.includes(`href="https://testnet.nearblocks.io/txns/${settle.tx_hash}"`), settle.tx_hash);
  }
  assert.ok(!html.includes("PLACEHOLDER"));
  assert.match(html, /data-chip="net">TESTNET · RECORDED/);
});

/* ---------- reducer (stage-1 cases, ported) ---------- */

test("pass fixture folds to Earned 0.030 -> 0.040; fail fixture to Refunded 0.040 -> 0.035", () => {
  const p = fold(fixture("pass"));
  assert.equal(outcomeOf(p), "earned");
  assert.deepEqual(headlineOf(p), { t: "Earned.", wait: false });
  const f = fold(fixture("fail"));
  assert.equal(outcomeOf(f), "refunded");
  assert.equal(f.qa?.quote_mnear, 35);
});

test("H-2: a repeat pass is 'holds' with or without the fixture field; a new buyer at the cap is 'paid-flat'", () => {
  const rep = fixture("repeat");
  assert.equal(outcomeOf(fold(rep)), "holds");
  const noField = withEvents(rep, (e) => (e.type === "settled" ? { ...e, data: (({ counts_unique_buyer: _c, ...d }) => d)(e.data) } : e) as LabEvent);
  assert.equal(outcomeOf(fold(noField)), "holds");
  // the field, when present, must agree with the chain; if it doesn't, the run is a mismatch (and the data gate fails)
  const lying = withEvents(rep, (e) => (e.type === "settled" ? { ...e, data: { ...e.data, counts_unique_buyer: true } } : e) as LabEvent);
  assert.match(fold(lying).mismatch.join(), /counts_unique_buyer=true but get_record/);
  // capped: unique buyers went up but the quote is already at 100
  const capped = withEvents(rep, (e) => {
    if (e.type !== "quote") return e;
    const after = e.data.phase === "after";
    const record = after ? { passes: 15, fails: 0, unique_buyers: 8, jobs: 15 } : { passes: 14, fails: 0, unique_buyers: 7, jobs: 14 };
    return { ...e, data: { ...e.data, record, quote_mnear: 100, ...(after ? { prev_quote_mnear: 100, delta_mnear: 0 } : {}) } } as LabEvent;
  });
  const cs = withEvents(capped, (e) => (e.type === "settled" ? { ...e, data: (({ counts_unique_buyer: _c, ...d }) => d)(e.data) } : e) as LabEvent);
  assert.equal(outcomeOf(fold(cs)), "paid-flat");
});

test("waiting headlines follow the open tx; Grading after the reveal lands", () => {
  const f = fixture("pass");
  assert.deepEqual(headlineOf(fold(f, 1)), { t: "Hire.", wait: false });
  assert.deepEqual(headlineOf(fold(f, 2)), { t: "Locking.", wait: true });
  assert.deepEqual(headlineOf(fold(f, 10)), { t: "Revealing.", wait: true });
  assert.deepEqual(headlineOf(fold(f, 17)), { t: "Grading.", wait: true });
});

test("a failed tx stops the run: 'Not locked.', outcome tx-failed", () => {
  const f = fixture("pass");
  const ev = f.events.slice(0, 3).map((e) => (e.type === "tx_confirmed" ? { ...e, data: { ...e.data, status: "failure", error: "deposit too low" } } : e)) as LabEvent[];
  const s = foldRun(f, ev);
  assert.equal(outcomeOf(s), "tx-failed");
  assert.equal(headlineOf(s).t, "Not locked.");
});

test("buyer's view: a seller tx can confirm with no prior submit", () => {
  const f = fixture("pass");
  const ev = f.events.filter((e) => !(e.type === "tx_submitted" && e.data.actor === "seller"));
  const s = foldRun(f, ev.slice(0, 4));
  assert.equal(s.rows.accept?.st, "ok");
});

test("cross-checks: quote vs get_record, jobs = passes + fails, delta = quote - prev, prev = quote(before)", () => {
  const f = fixture("pass");
  const set = (patch: object) => withEvents(f, (e) => (e.type === "quote" && e.data.phase === "after" ? { ...e, data: { ...e.data, ...patch } } : e) as LabEvent);
  assert.match(fold(set({ quote_mnear: 50 })).mismatch.join(), /get_record gives 40, quote says 50/);
  assert.match(fold(set({ record: { passes: 1, fails: 0, unique_buyers: 1, jobs: 3 } })).mismatch.join(), /jobs 3 != passes 1 \+ fails 0/);
  assert.match(fold(set({ delta_mnear: 20 })).mismatch.join(), /delta 20 != quote 40 - prev 30/);
  assert.match(fold(set({ prev_quote_mnear: 35, delta_mnear: 5 })).mismatch.join(), /prev_quote 35 != quote\(before\) 30/);
});

test("findPlaceholders refuses every T-051 fixture (none may ship)", () => {
  for (const n of ["pass", "repeat", "fail"]) assert.ok(findPlaceholders(fixture(n)).length > 0, n);
});

/* ---------- view: honesty + escaping ---------- */

test("verify 3: earn odometer has one column holding only [3,4]; the repeat run has none", () => {
  const story = buildStory([...RUNS]);
  const earnStep = story.steps.findIndex((st) => st.run === 0 && st.group.some((e) => e.type === "quote" && e.data.phase === "after"));
  const q1 = slotsOf(storyStateAt(story, earnStep), { odometer: true }).slots.q;
  assert.deepEqual([...q1.matchAll(/class="col"><span>(\d)<\/span><span>(\d)<\/span>/g)].map((m) => m[1] + m[2]), ["34"]);
  const q2 = slotsOf(storyStateAt(story, finalIndex(story)), { odometer: true }).slots.q;
  assert.equal((q2.match(/class="flip/g) ?? []).length, 0);
});

test("verify 4: every hold names the REAL wait, and says when replay shortens it", () => {
  const story = buildStory([...RUNS]);
  for (let k = 0; k < story.steps.length; k++) {
    const v = storyStateAt(story, k);
    const note = slotsOf(v).slots.note;
    if (!/data-k="(tx|seller|buyer|view)"/.test(note) || !v.next || v.next.kind !== "group") continue;
    assert.match(note, /<b>\+\d+\.\d s( on chain| TEE review \(seller side\)| seller side| to read get_record)?<\/b>/, note);
    if (v.next.shortened) assert.match(note, /replay holds 1\.1 s|replay holds 0\.4 s/);
  }
});

test("verify 5 + L-5: sandbox run says CONTRACT TEST, never TESTNET, no explorer links; lede derived from the events", () => {
  const sbx = { ...fixture("fail"), mode: "contract-test", network: "sandbox" } as LabFixture;
  const html = finalHTML([sbx]);
  assert.match(html, /CONTRACT TEST · LOCAL SANDBOX/);
  assert.doesNotMatch(html, />TESTNET · /);
  assert.doesNotMatch(html, /nearblocks/);
  assert.match(html, /the fail costs the seller 0\.005/);
  assert.doesNotMatch(html, /on chain from lock to settle/);
});

test("refund at the floor: the Designer's QA-loop-2 lede, and no 'drops' wording", () => {
  const floor = withEvents({ ...fixture("fail"), mode: "recorded", network: "testnet" } as LabFixture, (e) => {
    if (e.type !== "quote") return e;
    const after = e.data.phase === "after";
    const record = after ? { passes: 0, fails: 2, unique_buyers: 0, jobs: 2 } : { passes: 0, fails: 1, unique_buyers: 0, jobs: 1 };
    return { ...e, data: { ...e.data, record, quote_mnear: 25, ...(after ? { prev_quote_mnear: 25, delta_mnear: 0 } : {}) } } as LabEvent;
  });
  const s = fold(floor);
  assert.equal(outcomeOf(s), "refund-flat");
  const html = finalHTML([floor]);
  assert.ok(html.includes("The grade failed, so the buyer gets the escrow back. The quote stays: it’s already at the contract’s floor."));
});

test("H-3 / M-1 / M-2: hostile values never break out of an attribute, never link, never inject markup", () => {
  const evil = `x" onmouseover="alert(1)`;
  const f = withEvents(fixture("pass"), (e) => {
    if (e.type === "attested") return { ...e, data: { ...e.data, model: `<img src=x onerror=alert(1)>`, signing_address: evil, findings_count: "<b>9</b>" as unknown as number } } as LabEvent;
    if (e.type === "settled") return { ...e, tx_hash: evil } as LabEvent;
    return e;
  });
  const html = finalHTML([{ ...f, pack_id: `<script>alert(1)</script>` }]);
  assert.doesNotMatch(html, /<img src=x|<script>|onmouseover="alert/);
  assert.doesNotMatch(html, /nearblocks\.io\/address\/(0x|%3Cimg|<img)/, "model / signer must never link as an account (M-1)");
  assert.equal(txUrl(evil, fixture("pass")), null);
  assert.equal(acctUrl("UPPER.testnet", { ...fixture("pass"), network: "testnet", mode: "recorded" }), null);
  assert.equal(txUrl("9ibVLq9bV3xPkKVjbdKcw4yuhh6FMLPrNAprmcrBuwmB", RUNS[0]), "https://testnet.nearblocks.io/txns/9ibVLq9bV3xPkKVjbdKcw4yuhh6FMLPrNAprmcrBuwmB");
  assert.equal(acctUrl("earned-price-buyer-09552fb0.testnet", RUNS[0]), "https://testnet.nearblocks.io/address/earned-price-buyer-09552fb0.testnet");
});

test("REAL ACCOUNT title comes from buyer_proof (date + tx), not a literal", () => {
  const html = finalHTML([...RUNS]);
  assert.match(html, /class="real" title="Created on testnet 2026-11-12 in tx CbXuiUougakPpWtFJPCaXxo4r7UV5JB6YgQWur5UY1h9">REAL ACCOUNT/);
});

test("closer: links only a github.com repo URL; anything else is a marked placeholder", () => {
  assert.match(finalHTML([...RUNS], { repoUrl: "https://github.com/nicho/earned-price" }), /<a class="lnk" href="https:\/\/github\.com\/nicho\/earned-price">/);
  const bad = finalHTML([...RUNS], { repoUrl: `javascript:alert(1)` });
  assert.doesNotMatch(bad, /javascript:/);
  assert.match(bad, /PLACEHOLDER URL/);
});

test("slimRun keeps every field the view reads: same final HTML from slim and full runs", () => {
  assert.equal(finalHTML(RUNS.map(slimRun)), finalHTML([...RUNS]));
  const fat = JSON.stringify(RUNS).length, slim = JSON.stringify(RUNS.map(slimRun)).length;
  assert.ok(slim < fat, `slim ${slim} vs full ${fat}`);
});

/* ---------- page model ---------- */

test("page model: recorded runs are not placeholders, so the PLACEHOLDER DATA chip goes away; fixtures still are", () => {
  assert.equal(finalModel(RUNS, {}).placeholder, false);
  assert.equal(finalModel(RUNS, { VERCEL: "1" }).placeholder, false);
  assert.equal(finalModel([fixture("pass"), fixture("repeat")], {}).placeholder, true);
});

test("ship build (VERCEL=1 or EARNED_SHIP=1): placeholder fixtures throw, even when flagged recorded", () => {
  const runs = [fixture("pass"), fixture("repeat")];
  assert.throws(() => finalModel(runs, { VERCEL: "1" }), /placeholder run data in a ship build/);
  assert.throws(() => finalModel(runs, { EARNED_SHIP: "1" }), /placeholder run data in a ship build/);
  assert.throws(() => finalModel(runs.map((f) => ({ ...f, placeholder: false, recorded: true })), { VERCEL: "1" }), /placeholder run data/);
});

test("R7 fall frame: a real fail shows Refunded and the REFUNDED stamp, never EARNED, a postmark or an odometer rise", () => {
  const fail = { ...fixture("fail"), mode: "recorded", network: "testnet" } as LabFixture;
  const html = finalHTML([fail]);
  assert.match(html, /data-stage-state="refunded"/);
  assert.match(html, /<span class="h-b" data-slot="hd">Refunded\.<\/span>/);
  assert.match(html, /class="stamp sR">REFUNDED</);
  assert.doesNotMatch(html, /data-postmark=|Earned\.|class="flip up"/);
  assert.match(html, /class="flip dn"/);
});
