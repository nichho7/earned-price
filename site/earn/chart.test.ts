// [CTO] T-038 / S-010 · the plain quote chart and the TESTNET honesty chip (node --test, Node type stripping).
// AC 2 (chip text + attestation link), AC 4 (one step per settle/refund event, labelled with its tx; the Quote figure
// moves only on events, never through a value that didn't exist), AC 5 (server final state carries chart + chip),
// and AC 3's reach: every link the chart and chip add is a hash the ship-mode data gate resolves on testnet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { LabEvent, LabFixture } from "../stage/schema.ts";
import { buildStory, chipsOf, finalIndex, recLabel, storyStateAt } from "./earn-core.js";
import { chartHTML, chartOf } from "./earn-chart.js";
import { renderStage, slotsOf } from "./earn-view.js";
import { RUNS } from "../data/runs.ts";
// @ts-expect-error plain .mjs build script, no type declarations
import { linkedTxs } from "../../scripts/site-data-gate-lib.mjs";

const fixture = (name: string): LabFixture =>
  JSON.parse(readFileSync(new URL(`../fixtures/fixture-${name}.json`, import.meta.url), "utf8"));
const SETTLE_1 = "9ibVLq9bV3xPkKVjbdKcw4yuhh6FMLPrNAprmcrBuwmB";
const SETTLE_2 = "3skWKYL7tpPwtzgYcfrTkhgxDv4HaYdAMg9axFLNB5Rw";
const ATTESTED = (r: LabFixture) => r.events.find((e) => e.type === "attested")!.tx_hash as string;
const finalView = (runs: readonly LabFixture[]) => { const st = buildStory(runs); return storyStateAt(st, finalIndex(st)); };
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

test("AC 4: the final chart of the recorded log steps once per settle, each step labelled with its settle tx", () => {
  const c = chartOf(finalView(RUNS));
  assert.deepEqual(c.points.map((p) => [p.kind, p.mnear, p.tx]), [["start", 30, null], ["settle", 40, SETTLE_1], ["settle", 40, SETTLE_2]]);
  assert.equal(c.quote, 40);
  assert.deepEqual(c.pass, { pct: 100, passes: 2, jobs: 2 });
  const html = chartHTML(c);
  assert.match(html, /data-qc-steps="2"/);
  for (const [n, tx] of [[1, SETTLE_1], [2, SETTLE_2]] as const) {
    const li = new RegExp(`<li data-qc-slot="${n}" data-qc-step="${n}">.*?</li>`).exec(html)?.[0] ?? "";
    assert.ok(li.includes(`href="https://testnet.nearblocks.io/txns/${tx}"`), `step ${n} links its settle tx`);
  }
  assert.match(html, /Run 1 · settle<\/b><span>0\.030 → 0\.040/);
  assert.match(html, /Run 2 · settle<\/b><span>0\.040 holds/);
  assert.match(html, /<b data-qc-quote>0\.040<\/b>/);
  assert.match(html, /<b data-qc-pass>100%<\/b><span>2 of 2 graded jobs/);
});

test("AC 4: the line is a pure step (horizontal then vertical), never a slope between two values", () => {
  const html = chartHTML(chartOf(finalView(RUNS)));
  const d = /class="qc-line" d="([^"]*)"/.exec(html)?.[1] ?? "";
  assert.match(d, /^M[\d.]+ [\d.]+( H[\d.]+ V[\d.]+)+$/, d);
});

test("AC 4: over the whole replay the Quote figure changes only on a step that carries a quote event, and only to that event's value", () => {
  const story = buildStory(RUNS);
  const quoteValues = new Set(RUNS.flatMap((r) => r.events.filter((e) => e.type === "quote").map((e) => (e as Extract<LabEvent, { type: "quote" }>).data.quote_mnear)));
  let prev: number | null | undefined, steps = 0, changes = 0;
  for (let k = 0; k <= finalIndex(story); k++) {
    const v = storyStateAt(story, k), c = chartOf(v);
    for (const p of c.points) assert.ok(quoteValues.has(p.mnear), `step ${k}: point ${p.mnear} is not a value any quote event carried`);
    if (prev !== undefined && c.quote !== prev) {
      changes++;
      const q = v.step?.group.find((e) => e.type === "quote") as Extract<LabEvent, { type: "quote" }> | undefined;
      assert.ok(q, `step ${k}: the quote moved ${prev} -> ${c.quote} without a quote event`);
      assert.equal(c.quote, q.data.quote_mnear);
    }
    const n = c.points.filter((p) => p.kind === "settle" || p.kind === "refund").length;
    assert.ok(n === steps || n === steps + 1, `step ${k}: the chart gained ${n - steps} steps at once`);
    if (n === steps + 1) assert.ok(v.step?.group.some((e) => e.type === "quote" && e.data.phase === "after"), `step ${k}: a chart step without its quote(after) read`);
    steps = n;
    prev = c.quote;
  }
  assert.equal(changes, 1, "0.030 -> 0.040 once; run 2 holds");
  assert.equal(steps, 2);
});

test("READY (replay start): one point, quote 0.030 from get_record, Pass % '—' before any graded job", () => {
  const c = chartOf(storyStateAt(buildStory(RUNS), 0));
  assert.deepEqual(c.points.map((p) => p.mnear), [30]);
  const html = chartHTML(c);
  assert.match(html, /<b data-qc-quote>0\.030<\/b>/);
  assert.match(html, /<b data-qc-pass>—<\/b><span>no graded jobs yet/);
  assert.match(html, /data-qc-steps="0"/);
  assert.match(html, /Run 2<\/b><span>not played yet/);
});

test("refund (README contract test): the step goes down, labelled refund, and a sandbox tx never links", () => {
  const c = chartOf(finalView([fixture("fail")]));
  const last = c.points[c.points.length - 1];
  assert.equal(last.kind, "refund");
  assert.ok(last.mnear < c.points[0].mnear);
  const html = chartHTML(c);
  assert.match(html, /Run 1 · refund/);
  assert.equal(hrefs(html).length, 0);
});

test("placeholder runs: chart marks the tx PLACEHOLDER with no link; the chip drops 'verified live' and the attestation", () => {
  const runs = [fixture("pass"), fixture("repeat")];
  const html = chartHTML(chartOf(finalView(runs)));
  assert.equal(hrefs(html).length, 0);
  assert.match(html, /class="ph">PLACEHOLDER/);
  const chips = chipsOf(buildStory(runs), false);
  assert.ok(!chips[0].text.includes("verified live"), chips[0].text);
  assert.equal(chips[0].att, null);
  assert.ok(chips.some((c) => c.kind === "ph"));
});

test("chart escapes what it prints: a hostile tx hash or value never reaches the HTML raw", () => {
  const bad = JSON.parse(JSON.stringify(RUNS)) as LabFixture[];
  for (const e of bad[0].events) if (e.type === "settled") (e as { tx_hash: string }).tx_hash = '"><img src=x onerror=alert(1)>';
  const html = chartHTML(chartOf(finalView(bad)));
  assert.ok(!html.includes("<img"), "raw markup in the chart");
  assert.ok(!hrefs(html).some((h) => h.includes("onerror")));
});

test("AC 2: RECORDED chip reads 'TESTNET · RECORDED <time> · verified live' with the latest attestation tx as a link", () => {
  const story = buildStory(RUNS);
  const [chip] = chipsOf(story, false);
  assert.equal(chip.text, "TESTNET · RECORDED 12 NOV 13:25 UTC · verified live");
  assert.equal(chip.att?.tx, ATTESTED(RUNS[1]));
  const html = slotsOf(storyStateAt(story, 0)).slots.chips;
  assert.ok(html.includes(`href="https://testnet.nearblocks.io/txns/${ATTESTED(RUNS[1])}"`), "attestation link");
  assert.ok(html.includes(`data-chip-att="${ATTESTED(RUNS[1])}"`));
  // the chip describes the whole log, so it is identical at every replay step (no layout shift)
  for (let k = 0; k <= finalIndex(story); k++) assert.equal(slotsOf(storyStateAt(story, k)).slots.chips, html);
  assert.equal(recLabel(null), "");
  assert.equal(recLabel("not a date"), "");
});

test("AC 2: LIVE chip reads 'TESTNET · LIVE' and claims no recording", () => {
  const story = buildStory(RUNS, { mode: "live" });
  const [chip] = chipsOf(story, true);
  assert.equal(chip.text, "TESTNET · LIVE");
  assert.equal(chip.att, undefined);
  assert.match(slotsOf(storyStateAt(story, 0), { live: true }).slots.chips, /data-chip="net">TESTNET · LIVE<\/span>/);
});

test("AC 5: the server's final stage HTML carries the chart (both steps, links, quote, Pass %) and the chip", () => {
  const html = renderStage(finalView(RUNS), { odometer: true });
  for (const s of ["QUOTE CHART", 'data-qc-steps="2"', "<b data-qc-quote>0.040</b>", "<b data-qc-pass>100%</b>", "TESTNET · RECORDED 12 NOV 13:25 UTC · verified live",
    `data-qc-tx="${SETTLE_1}"`, `data-qc-tx="${SETTLE_2}"`, `data-chip-att="${ATTESTED(RUNS[1])}"`])
    assert.ok(html.includes(s), `missing ${s}`);
});

test("AC 3 reach: every explorer link the chart and chip add is a hash the ship-mode data gate resolves", () => {
  const { txs } = linkedTxs(RUNS) as { txs: Map<string, unknown> };
  const v = finalView(RUNS);
  const { slots } = slotsOf(v);
  const links = [...hrefs(slots.chart), ...hrefs(slots.chips)];
  assert.equal(links.length, 3); // 2 settle tx + 1 attestation tx
  for (const h of links) {
    const m = /^https:\/\/testnet\.nearblocks\.io\/txns\/([1-9A-HJ-NP-Za-km-z]{43,44})$/.exec(h);
    assert.ok(m, h);
    assert.ok(txs.has(m[1]), `${m[1]} is not in the gate's RPC check`);
  }
});
